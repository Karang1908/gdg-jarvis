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

/** Longest single utterance. Anything past this is a presenter talking to the room. */
const MAX_UTTERANCE_S = 12;

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
let transcriber = null;
let listening = false;
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
    args: (file) => [
      '-q', '-c', '1', '-r', '16000', '-b', '16', file,
      'silence', '1', '0.1', '3%', '1', String(SILENCE_S), '3%',
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
  return process.env.JARVIS_WHISPER_SERVER || serverOrigin || '';
}

/**
 * Start whisper-server, if this machine can.
 *
 * Needs the binary and a model. With an explicit JARVIS_WHISPER_SERVER the operator is
 * pointing at one they run themselves, so nothing is started here.
 */
function startServer() {
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

      // Killed on purpose when the mic is switched off mid-utterance.
      if (signal && !listening) return resolve({ ok: false, error: 'stopped' });

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
  while (listening) {
    const recorded = await recordOnce();
    if (!listening) break;

    if (!recorded.ok) {
      if (recorded.error === 'stopped') break;
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
      log.warn('could not record', { detail: recorded.detail || recorded.error });
      // A capture that fails instantly would spin. Pause before trying again.
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    let text = '';
    try {
      text = tidy(await transcriber.run(recorded.file));
    } catch (err) {
      log.warn('could not transcribe', { via: transcriber.name, error: String(err.message).slice(0, 120) });
    }

    fs.unlink(recorded.file, () => {});

    // Silence transcribes to nothing, or to a stray "you" / "thanks" that whisper emits for
    // near-silence. Neither is worth waking the room for.
    // Re-checked after transcribing, not just after recording: transcription takes seconds,
    // and a command that fires after the presenter has already closed the microphone is
    // exactly the kind of thing the button exists to prevent.
    if (!listening) break;

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
  }
}

function start(handler) {
  if (!capture || !transcriber) return { ok: false, error: 'unavailable', ...describe() };
  if (listening) return { ok: true, ...describe() };

  onTranscript = handler || onTranscript;
  listening = true;
  log.good('microphone open', { record: capture.name, transcribe: transcriber.name });

  loop().catch((err) => {
    log.error('listening stopped unexpectedly', { error: err.message });
    listening = false;
  });

  return { ok: true, ...describe() };
}

function stop() {
  if (!listening) return { ok: true, ...describe() };

  listening = false;
  if (current) {
    try {
      current.kill('SIGTERM');
    } catch {
      /* gone */
    }
  }
  log.info('microphone closed');
  return { ok: true, ...describe() };
}

const isListening = () => listening;

// CAPTURE and TRANSCRIBE are exported the way intents.js exports INTENTS: so the provider
// chains can be exercised directly, without needing a microphone or a network.
module.exports = { init, start, stop, stopServer, describe, isListening, MAX_UTTERANCE_S, CAPTURE, TRANSCRIBE };
