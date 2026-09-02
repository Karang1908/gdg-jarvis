'use strict';

/**
 * JARVIS's microphone.
 *
 * On the machine that runs Core — the same one that thinks and speaks. The phone is a
 * remote control: its mic button opens and closes *this* microphone, and never captures
 * anything itself.
 *
 *   Kali mic ──► capture one utterance ──► transcribe ──► intent? ──► act
 *                                                          └─ no ──► agy ──► MCP ──► act
 *
 * Two provider chains, for the same reason voice.js has one: what is installed varies, and
 * the failure should name itself rather than produce silence.
 *
 *   capture     sox, then arecord, then ffmpeg
 *   transcribe  whisper.cpp, then whisper, then Gemini
 *
 * Capture waits for a pause rather than recording fixed windows, so a sentence ends when
 * the speaker stops rather than when a timer does. A presenter who has to talk in
 * five-second slices is a presenter who will stop using it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const log = require('./log');

/**
 * Longest single utterance.
 *
 * Also the worst case when the silence gate misjudges the room: everything past the end of
 * the sentence is dead time the presenter waits through, and then more time transcribing
 * it. Eight seconds is longer than any command in the run of show.
 */
const MAX_UTTERANCE_S = 8;

/**
 * Silence that ends an utterance.
 *
 * Paid on every single thing anyone says, command or question, so it is the largest fixed
 * cost on the fast path — a spoken command is about two seconds end to end and this is most
 * of the part that is not the recogniser.
 *
 * 0.8s rather than 1.2s. Short enough to feel prompt, long enough to survive the pause
 * somebody takes in the middle of "identify... device two". Below about 0.6s it starts
 * cutting people off mid-sentence, which costs far more than it saves.
 */
const SILENCE_S = 0.8;

let config = {};
let capture = null;
/** Asked before acting on a transcript: was JARVIS talking while this was recorded? */
let isSelf = () => false;
let transcriber = null;
let listening = false;
/** Finishing the sentence that was already in progress when the microphone was closed. */
let draining = false;
let current = null;
let onTranscript = null;
let workDir = null;

function have(command) {
  // spawnSync is fine here: this runs once, at startup, before anything is serving.
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

/**
 * Run a command without stopping the world.
 *
 * spawnSync is shorter and is what this used to use, but it blocks Node's event loop for
 * the whole run. Transcription takes seconds, and during those seconds Core served nothing
 * at all — no event stream, no commands, no health check. Measured at a 2.5 second freeze
 * per utterance, on every utterance.
 */
function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ status: -1, stdout: '', stderr: err.message });
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 64_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += chunk;
    });

    const guard = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, timeoutMs);
    guard.unref();

    const settle = (result) => {
      clearTimeout(guard);
      resolve(result);
    };

    child.on('error', (err) => settle({ status: -1, stdout, stderr: err.message }));
    child.on('exit', (status) => settle({ status, stdout, stderr }));
  });
}

/* ------------------------------------------------------------------------------------
 * Capture
 * --------------------------------------------------------------------------------- */

const CAPTURE = [
  {
    name: 'sox',
    command: 'rec',
    available: () => have('rec'),
    /**
     * `silence 1 0.1 3% 1 1.2 3%` means: start when sound rises above 3%, stop after 1.2
     * seconds below it. That is the whole reason sox is preferred — it is the only one of
     * these that ends an utterance when the speaker does.
     */
    /**
     * Two thresholds, not one.
     *
     * sox takes them separately and they want different values. The first decides that
     * someone has started talking; it has to be low, because a sentence begins quietly and
     * a threshold set for the middle of it eats the first word — measured, an 18% gate on
     * both turned "Jarvis, show me the architecture" into "only the architecture", losing
     * the wake word and with it the whole command.
     *
     * The second decides they have stopped. It can sit higher, because the level has
     * dropped back toward the room by then, and a higher one stops promptly rather than
     * waiting for a perfect hush that a real room never gives.
     */
    args: (file) => [
      '-q', '-c', '1', '-r', '16000', '-b', '16', file,
      'silence', '1', '0.1', startThreshold(), '1', String(SILENCE_S), stopThreshold(),
      'trim', '0', String(MAX_UTTERANCE_S),
    ],
  },
  {
    name: 'arecord',
    command: 'arecord',
    available: () => have('arecord'),
    // No silence detection, so a fixed window. Workable, but it clips people mid-sentence
    // and waits through pauses, which is why sox is worth installing.
    args: (file) => ['-q', '-f', 'S16_LE', '-c', '1', '-r', '16000', '-d', String(MAX_UTTERANCE_S), file],
    fixedWindow: true,
  },
  {
    name: 'ffmpeg',
    command: 'ffmpeg',
    available: () => have('ffmpeg'),
    args: (file) => [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', process.platform === 'darwin' ? 'avfoundation' : 'alsa',
      '-i', process.platform === 'darwin' ? ':default' : 'default',
      '-t', String(MAX_UTTERANCE_S), '-ac', '1', '-ar', '16000', file,
    ],
    fixedWindow: true,
  },
];

/* ------------------------------------------------------------------------------------
 * Transcription
 * --------------------------------------------------------------------------------- */

const TRANSCRIBE = [
  {
    /**
     * whisper.cpp with the model already loaded.
     *
     * The CLI below re-reads the model from disk for every utterance. That is a fixed cost
     * on every single thing anyone says, and it grows with the model — the whole reason a
     * bigger, more accurate model is unaffordable. A resident server pays it once.
     *
     * Core starts it, so there is nothing extra to remember at the venue.
     */
    name: 'whisper.cpp-server',
    available: () => Boolean(serverUrl()),
    async run(file) {
      const body = new FormData();
      body.append('file', new Blob([fs.readFileSync(file)]), 'utterance.wav');
      body.append('response_format', 'json');
      body.append('temperature', '0.0');

      const response = await postWithRetry(`${serverUrl()}/inference`, body);

      if (!response.ok) {
        throw new Error(`whisper-server ${response.status}: ${(await response.text()).slice(0, 160)}`);
      }

      // The server's README documents the request but not the response shape, so this
      // accepts either the OpenAI-style {text} or plain text, rather than guessing one.
      const raw = await response.text();
      try {
        const parsed = JSON.parse(raw);
        return parsed.text || findText(parsed) || '';
      } catch {
        return raw;
      }
    },
  },
  {
    name: 'whisper.cpp',
    available: () => Boolean(whisperCppBinary()) && Boolean(modelPath()),
    async run(file) {
      // Resolved once at startup rather than probed per utterance — `command -v` is a
      // synchronous spawn, and this path runs on every single thing anyone says.
      const result = await runCommand(
        whisperCppBinary(),
        ['-m', modelPath(), '-f', file, '-nt', '-l', 'en', '-t', String(threads())],
        30_000
      );
      if (result.status !== 0) throw new Error(String(result.stderr || '').slice(0, 160));
      return result.stdout;
    },
  },
  {
    name: 'whisper',
    available: () => have('whisper'),
    async run(file) {
      // The Python CLI writes next to the input rather than to stdout.
      const out = path.dirname(file);
      const result = await runCommand(
        'whisper',
        [file, '--model', whisperSize(), '--language', 'en',
         '--output_format', 'txt', '--output_dir', out, '--fp16', 'False'],
        60_000
      );
      if (result.status !== 0) throw new Error(String(result.stderr || '').slice(0, 160));
      const txt = file.replace(/\.wav$/, '.txt');
      try {
        const text = fs.readFileSync(txt, 'utf8');
        fs.unlinkSync(txt);
        return text;
      } catch {
        return result.stdout;
      }
    },
  },
  {
    name: 'gemini',
    available: () => Boolean(apiKey()),
    /**
     * One call per utterance, not a stream — so this costs about what the speech synthesis
     * does and stays inside the same free tier.
     *
     * The model must be one that accepts audio input. An unknown or non-audio model is a
     * 404 from this endpoint, which is how the first version of this failed: it named a
     * model that does not exist, and every utterance died with a bare status code.
     */
    async run(file) {
      const audio = fs.readFileSync(file).toString('base64');
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/interactions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey() },
          body: JSON.stringify({
            model: sttModel(),
            input: [
              { type: 'text', text: 'Transcribe this audio exactly. Reply with only the words spoken, nothing else.' },
              { type: 'audio', mime_type: 'audio/wav', data: audio },
            ],
          }),
          signal: AbortSignal.timeout(20_000),
        }
      );

      if (!response.ok) {
        // Carry what Google actually said. A bare "gemini 404" names neither the model nor
        // the reason, which is worth exactly nothing to whoever has to fix it.
        const detail = await response.text().catch(() => '');
        const said = (() => {
          try {
            return JSON.parse(detail).error.message;
          } catch {
            return detail.slice(0, 160);
          }
        })();
        throw new Error(`gemini ${response.status} (model ${sttModel()}): ${said}`);
      }

      const payload = await response.json();
      // Documented location first; the walker is insurance against the field moving.
      return payload.output_text || findText(payload) || '';
    },
  },
];

function apiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

/**
 * Where whisper.cpp's model file is.
 *
 * It has no default worth guessing — distributions put it in different places, and a wrong
 * path makes whisper.cpp fail in a way that reads like a broken microphone. With nothing
 * set, whisper.cpp is skipped and the next transcriber is used instead.
 */
function modelPath() {
  return config.whisperCppModel || process.env.JARVIS_WHISPER_MODEL || '';
}

/* ------------------------------------------------------------------------------------
 * The resident transcriber
 * --------------------------------------------------------------------------------- */

let serverProcess = null;
let serverOrigin = '';

/** Where the resident transcriber is, if there is one. */
function serverUrl() {
  if (process.env.JARVIS_WHISPER_SERVER === 'off') return '';
  return process.env.JARVIS_WHISPER_SERVER || serverOrigin || '';
}

/**
 * Start whisper-server, if this machine can.
 *
 * Needs the binary and a model. With an explicit JARVIS_WHISPER_SERVER the operator is
 * pointing at one they run themselves, so nothing is started here.
 */
function startServer() {
  // An explicit "off" keeps the resident transcriber out of the way — for a machine where
  // it misbehaves, and for tests that need to exercise the command-line path deliberately
  // rather than whichever path happens to be installed.
  if (process.env.JARVIS_WHISPER_SERVER === 'off') return;

  if (process.env.JARVIS_WHISPER_SERVER) {
    log.info('using the whisper server you configured', { url: process.env.JARVIS_WHISPER_SERVER });
    return;
  }
  const port = Number(process.env.JARVIS_WHISPER_PORT) || 8910;
  const origin = `http://127.0.0.1:${port}`;

  // Two ways to have a resident whisper, and the second is the one that works on a machine
  // where the distribution ships libwhisper but not the tools.
  let command;
  let args;

  if (have('whisper-server') && modelPath()) {
    command = 'whisper-server';
    args = ['-m', modelPath(), '--port', String(port), '--host', '127.0.0.1', '-t', String(threads())];
  } else {
    const python = pythonWithFasterWhisper();
    const script = path.join(__dirname, '..', '..', 'scripts', 'whisper-server.py');
    if (!python || !fs.existsSync(script)) return;
    command = python;
    args = [
      script,
      '--model', whisperSize(),
      '--port', String(port),
      '--host', '127.0.0.1',
      '--threads', String(threads()),
      '--download-dir', path.join(__dirname, '..', 'config', 'whisper'),
    ];
  }

  try {
    serverProcess = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    log.warn('could not start whisper-server; falling back to the command line', {
      error: err.message,
    });
    return;
  }

  serverProcess.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    // Its startup chatter is not a problem; only say something if it fails outright.
    if (/error|failed/i.test(text)) log.warn('whisper-server', { said: text.slice(0, 160) });
  });

  serverProcess.on('exit', (code) => {
    if (serverProcess) log.warn('whisper-server exited', { code });
    serverProcess = null;
    serverOrigin = '';
  });

  serverOrigin = origin;
  log.good('whisper model stays loaded', {
    model: whisperSize(),
    at: origin,
    note: 'the model is no longer re-read for every utterance',
  });
}

/**
 * A python that can run the resident transcriber.
 *
 * The repo's own virtualenv first: on a Debian-family machine that is where faster-whisper
 * can actually be installed without fighting the system package manager, so it is where it
 * will be. Falls back to whatever python3 is on PATH.
 */
function pythonWithFasterWhisper() {
  const candidates = [
    process.env.JARVIS_WHISPER_PYTHON,
    path.join(__dirname, '..', '..', '.venv', 'bin', 'python'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'import faster_whisper'], { stdio: 'ignore' });
    if (probe.status === 0) return candidate;
  }

  const system = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' });
  const python3 = String(system.stdout || '').trim();
  if (python3 && spawnSync(python3, ['-c', 'import faster_whisper'], { stdio: 'ignore' }).status === 0) {
    return python3;
  }
  return null;
}

/** Stop it. Called on shutdown; it is our process to clean up. */
function stopServer() {
  if (!serverProcess) return;
  const doomed = serverProcess;
  serverProcess = null;
  serverOrigin = '';
  try {
    doomed.kill('SIGTERM');
  } catch {
    /* gone */
  }
}

/**
 * POST, tolerating the server still coming up.
 *
 * Core starts listening before whisper-server has finished loading its model, so the first
 * utterance of a session can arrive at a socket nobody is listening on yet. That is a wait,
 * not a failure.
 */
async function postWithRetry(url, body, attempts = 6) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      last = err;
      // Only a refused connection is worth waiting out; a timeout means it is up and stuck.
      if (!/ECONNREFUSED|fetch failed/i.test(String(err.message))) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`whisper-server unreachable at ${url}: ${last && last.message}`);
}

/** Whichever whisper.cpp binary this machine has, decided once. */
let whisperCppResolved;
function whisperCppBinary() {
  if (whisperCppResolved === undefined) {
    whisperCppResolved = have('whisper-cli') ? 'whisper-cli' : have('whisper-cpp') ? 'whisper-cpp' : null;
  }
  return whisperCppResolved;
}

/* ------------------------------------------------------------------------------------
 * How loud counts as speech
 * --------------------------------------------------------------------------------- */

/** Never trust a room to be quieter than this, or louder than this. */
const MIN_THRESHOLD = 3;
const MAX_THRESHOLD = 25;

let measuredFloorPercent = MIN_THRESHOLD;
let calibrated = false;

/**
 * The level above which sox decides someone is talking.
 *
 * A fixed percentage cannot work. It has to sit above the room's noise floor — or the gate
 * never closes, every utterance runs to the full length cap, and the presenter waits out
 * the cap and then waits again while all that silence is transcribed. Measured in the demo
 * room: a floor at 6.7% RMS against a 3% threshold, which is why a two-second command took
 * more than ten seconds to come back.
 *
 * So it is measured rather than assumed, once, when listening starts. The multiplier is not
 * a guess either — it comes from running a real recording of speech through the gate at a range of
 * thresholds, in that room, on that microphone:
 *
 *    5-10%   keeps 4.6s of a 5s clip   the floor holds the gate open; barely trims
 *    12-15%  keeps 2.1-2.9s            the speech, without the silence around it
 *    20%     keeps 1.6s                starts eating the beginning of sentences
 *    25%     keeps 0.6s                cuts most of it
 *
 * A floor of 6.7% doubled lands at 13%, in the middle of the band that works.
 */
function measuredFloor() {
  const configured = Number(config.threshold || process.env.JARVIS_MIC_THRESHOLD);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return measuredFloorPercent;
}

/** Low: a sentence starts quietly, and missing its first word loses the whole command. */
function startThreshold() {
  const at = measuredFloor() * 1.3;
  return `${Math.round(Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, at)))}%`;
}

/** Higher: by the time they stop, the level is back near the room. */
function stopThreshold() {
  const at = measuredFloor() * 2;
  return `${Math.round(Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, at)))}%`;
}

/** What the two are built from, so both move together when the room does. */
function threshold() {
  return `${startThreshold()} / ${stopThreshold()}`;
}

/**
 * Listen to the empty room for a moment and work out what counts as quiet.
 *
 * Skipped entirely when a threshold is configured by hand, because someone who has tuned it
 * for their room should not have it overridden by a second of measurement.
 */
async function calibrate() {
  if (Number(config.threshold || process.env.JARVIS_MIC_THRESHOLD) > 0) return;
  if (!have('arecord') || !have('sox')) return;

  const sample = path.join(workDir, `calibrate-${Date.now()}.wav`);

  const captured = await runCommand(
    'arecord', ['-q', '-f', 'S16_LE', '-c', '1', '-r', '16000', '-d', '3', sample], 10_000
  );
  if (captured.status !== 0) return;

  // The quietest half-second wins, not the average.
  //
  // A single reading is not safe to trust: the capture device wakes up with a burst that
  // reads far louder than the room, and one cough during the sample would set the gate for
  // the evening. Measured here, that transient produced a floor of 12.5% in a room whose
  // real floor was 5.4%, and a gate at twice that would have ignored everything said to it.
  //
  // The first second is skipped for the same reason, and the lowest window after it is the
  // one closest to the truth.
  const windows = [1.0, 1.5, 2.0, 2.5];
  const levels = [];

  for (const from of windows) {
    const measured = await runCommand(
      'sox', [sample, '-n', 'trim', String(from), '0.5', 'stat'], 8000
    );
    const found = /RMS\s+amplitude:\s+([0-9.]+)/.exec(String(measured.stderr || ''));
    if (found) levels.push(Number(found[1]) * 100);
  }

  fs.unlink(sample, () => {});
  if (!levels.length) return;

  const floor = Math.min(...levels);

  // 2.5x. From running real speech through the gate at every threshold, in the room this
  // was written for: below 10% the floor holds the gate open and nothing is trimmed, above
  // 20% it starts cutting the front off sentences, and 12-15% keeps the speech and drops
  // the silence. A 5.4% floor times 2.5 lands at 13%.
  measuredFloorPercent = floor;
  calibrated = true;

  log.good('room measured', {
    noise_floor: `${floor.toFixed(1)}%`,
    starts_above: startThreshold(),
    stops_below: stopThreshold(),
    samples: levels.map((l) => l.toFixed(1)).join(' '),
  });
}

/**
 * How many threads whisper.cpp may use.
 *
 * It was passing none, so it took the binary's own default rather than this machine's
 * shape. Capped at four: transcription scales with physical cores, and hyperthreads past
 * that buy little while competing with Core and the browser for the same laptop.
 */
function threads() {
  const asked = Number(config.threads || process.env.JARVIS_WHISPER_THREADS);
  if (Number.isInteger(asked) && asked > 0) return asked;
  return Math.max(1, Math.min(4, os.cpus().length));
}

/**
 * Which whisper model.
 *
 * tiny.en, measured on the demo laptop against the same spoken line:
 *
 *   tiny.en    530ms    "Jarvis, show me their architecture."
 *   base.en    860ms    identical
 *   small.en  2158ms    identical
 *
 * Identical text from all three, so the larger models buy nothing here and cost up to four
 * times the wait. That is what short fixed commands do to a recogniser — there is not much
 * for a bigger model to be cleverer about. Set JARVIS_WHISPER_SIZE if a room proves harder
 * than this one.
 */
function whisperSize() {
  return config.whisperModel || process.env.JARVIS_WHISPER_SIZE || 'tiny.en';
}

/**
 * Which Gemini model transcribes.
 *
 * gemini-3.7-flash is the model the audio documentation's own transcription example uses
 * against this endpoint, so it is the one default that is known to work. Only models that
 * accept audio input are valid here — a text-only or unknown model is a 404, not a helpful
 * error, which is how this broke the first time.
 */
function sttModel() {
  return config.sttModel || process.env.JARVIS_STT_MODEL || 'gemini-3.7-flash';
}

/** Dig the text out without assuming one envelope shape; these APIs move. */
function findText(payload) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && value.trim() && /text|content|output|transcript/i.test(key)) {
        return value;
      }
      if (typeof value === 'object') {
        const found = walk(value);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(payload);
}

/* ------------------------------------------------------------------------------------
 * Setup
 * --------------------------------------------------------------------------------- */

function init(options = {}) {
  config = options || {};
  if (typeof options.isSpeaking === 'function') isSelf = options.isSpeaking;

  workDir = path.join(os.tmpdir(), 'jarvis-ears');
  try {
    fs.mkdirSync(workDir, { recursive: true });
  } catch {
    workDir = os.tmpdir();
  }

  // Before choosing, so the resident transcriber is available to be chosen.
  startServer();

  capture = CAPTURE.find((c) => c.available()) || null;
  transcriber = TRANSCRIBE.find((t) => t.available()) || null;

  if (!capture || !transcriber) {
    // Two unrelated halves, two different fixes. Saying "the mic does not work" would send
    // someone to check a microphone that is fine.
    log.warn('JARVIS cannot listen on this machine');
    if (!capture) log.warn('  nothing can record audio:  sudo apt install -y sox');
    if (!transcriber) {
      log.warn('  nothing can transcribe it: set GEMINI_API_KEY in .env,');
      log.warn('                             or sudo apt install -y whisper.cpp');
    }
    return describe();
  }

  log.good('ears ready', {
    record: capture.name,
    transcribe: transcriber.name,
    ...(capture.fixedWindow ? { note: `no silence detection; ${MAX_UTTERANCE_S}s windows` } : {}),
  });

  // Measure the room now, in the background, so opening the microphone later is instant.
  // Core is still starting up; nobody is waiting on this.
  calibrate().catch(() => {});

  return describe();
}

function describe() {
  return {
    available: Boolean(capture && transcriber),
    listening,
    capture: capture ? capture.name : null,
    transcribe: transcriber ? transcriber.name : null,
    // True when capture cannot detect a pause, so the operator knows why it feels clumsy.
    fixedWindow: Boolean(capture && capture.fixedWindow),
    // What the room measured, so a gate set too high or too low can be seen rather than
    // inferred from the fact that nothing is happening.
    threshold: threshold(),
    calibrated,
  };
}

/* ------------------------------------------------------------------------------------
 * Listening
 * --------------------------------------------------------------------------------- */

function recordOnce() {
  const file = path.join(workDir, `utterance-${Date.now()}.wav`);

  return new Promise((resolve) => {
    const child = spawn(capture.command, capture.args(file), { stdio: ['ignore', 'ignore', 'pipe'] });
    current = child;

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk;
    });

    const guard = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, (MAX_UTTERANCE_S + 5) * 1000);
    guard.unref();

    child.on('error', () => {
      clearTimeout(guard);
      current = null;
      resolve({ ok: false, error: 'capture_failed' });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(guard);
      current = null;

      // A recording cut short by the mic being closed is still a recording.
      //
      // This used to be thrown away, on the reasoning that a command firing after the
      // button was pressed is what the button exists to prevent. That is backwards for the
      // way the button is actually used: it is pressed to say a sentence and pressed again
      // when the sentence is done, and discarding what was just said makes it useless.
      // sox flushes what it has on the way out — verified, a killed capture reads back
      // cleanly — so it is worth transcribing like any other.
      if (code !== 0 && !fs.existsSync(file)) {
        return resolve({ ok: false, error: 'capture_failed', detail: stderr.trim().slice(0, 160) });
      }

      // A recording with no audio in it is not worth a round trip. sox writes a bare
      // 44-byte header when it captures nothing — when the microphone is switched off
      // mid-utterance, or the device hiccups — and sending that to a recogniser produces a
      // decode error that reads like a broken transcriber rather than an empty recording.
      //
      // 16 kHz mono 16-bit is 32000 bytes a second, so this is a fifth of a second of sound.
      // Nobody says anything in less.
      const bytes = (() => {
        try {
          return fs.statSync(file).size;
        } catch {
          return 0;
        }
      })();

      if (bytes < 44 + 6400) {
        fs.unlink(file, () => {});
        return resolve({ ok: false, error: 'nothing_heard' });
      }

      resolve({ ok: true, file });
    });
  });
}

/** Whisper writes bracketed noises and blank lines; none of it is a command. */
function tidy(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loop() {
  while (listening || draining) {
    const recorded = await recordOnce();

    // Whatever this pass captured is finished properly even if the microphone has since
    // been closed; the loop simply does not open another.
    const lastPass = !listening;

    if (!recorded.ok) {
      if (lastPass) break;
      // sox only returns once it has heard something, so an empty recording means it was
      // interrupted or the device misbehaved — not ordinary silence. Said out loud, because
      // a microphone that is on and producing nothing is the single most confusing state
      // this system has, and saying nothing about it is how an evening gets lost.
      if (recorded.error === 'nothing_heard') {
        log.warn('heard something too short to transcribe', {
          note: 'if this repeats, the microphone level is probably below the trigger',
        });
        continue;
      }
      if (lastPass) break;
      log.warn('could not record', { detail: recorded.detail || recorded.error });
      // A capture that fails instantly would spin. Pause before trying again.
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    // Noted before transcription, which takes long enough that JARVIS may have started
    // and finished speaking in the meantime.
    const spokeWhileRecording = isSelf();

    let text = '';
    try {
      text = tidy(await transcriber.run(recorded.file));
    } catch (err) {
      log.warn('could not transcribe', { via: transcriber.name, error: String(err.message).slice(0, 120) });
    }

    fs.unlink(recorded.file, () => {});

    // Do not act on JARVIS's own voice.
    //
    // The microphone is in the same room as the speakers, so it hears every line JARVIS
    // says and transcribes it back: "One moment, sir." returned as "One moment to serve.",
    // "Releasing the room." came back word for word. Each one costs a transcription, and a
    // line that happened to look like a command would have the room acting on itself.
    //
    // Checked here rather than before recording, because the answer that matters is whether
    // JARVIS was talking while this was being captured.
    if (spokeWhileRecording) {
      log.info('ignored its own voice', { text: text.slice(0, 60) });
      continue;
    }

    if (text && text.length > 2 && onTranscript) {
      log.info('HEARD', { text: text.slice(0, 120) });

      // Deliberately not awaited. Acting on a sentence can mean a model call taking twelve
      // to seventeen seconds, and waiting for it here would mean the microphone hears
      // nothing for that whole time — so "jarvis take the room", said while JARVIS was
      // still thinking about the last thing, was never heard at all.
      //
      // Whoever handles the transcript is responsible for not starting two of those at
      // once; see the guard in server.js.
      Promise.resolve()
        .then(() => onTranscript(text))
        .catch((err) => log.error('handling what was heard threw', { error: err.message }));
    }

    if (lastPass) break;
  }

  draining = false;
}

function start(handler) {
  if (!capture || !transcriber) return { ok: false, error: 'unavailable', ...describe() };
  if (listening) return { ok: true, ...describe() };

  onTranscript = handler || onTranscript;
  listening = true;
  log.good('microphone open', { record: capture.name, transcribe: transcriber.name });

  // Not calibrated here. Measuring takes about three seconds, and doing it on every unmute
  // put that between pressing the button and being heard — which is the one moment in this
  // whole system where a wait is least acceptable. It happens once at startup instead,
  // while nobody is waiting.
  loop().catch((err) => {
    log.error('listening stopped unexpectedly', { error: err.message });
    listening = false;
  });

  return { ok: true, ...describe() };
}

/**
 * Close the microphone, and finish the sentence.
 *
 * Stopping means "hear nothing further", not "forget what I just said". The button is used
 * as push-to-talk — pressed to speak, pressed again once the sentence is done — so the
 * recording in progress is ended and then transcribed and acted on like any other. Only
 * after that does the loop stop.
 */
function stop() {
  if (!listening) return { ok: true, ...describe() };

  listening = false;
  draining = true;

  if (current) {
    try {
      // Ends the capture; sox writes out what it has rather than losing it.
      current.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }

  log.info('microphone closed', { note: 'finishing what was already said' });
  return { ok: true, ...describe() };
}

const isListening = () => listening;

// CAPTURE and TRANSCRIBE are exported the way intents.js exports INTENTS: so the provider
// chains can be exercised directly, without needing a microphone or a network.
module.exports = { init, start, stop, stopServer, describe, isListening, MAX_UTTERANCE_S, CAPTURE, TRANSCRIBE };
