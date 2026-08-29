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

/** Silence that ends an utterance. Shorter and it cuts people off mid-sentence. */
const SILENCE_S = 1.2;

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
    name: 'whisper.cpp',
    available: () => Boolean(whisperCppBinary()) && Boolean(modelPath()),
    async run(file) {
      // Resolved once at startup rather than probed per utterance — `command -v` is a
      // synchronous spawn, and this path runs on every single thing anyone says.
      const result = await runCommand(whisperCppBinary(), ['-m', modelPath(), '-f', file, '-nt', '-l', 'en'], 30_000);
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

/** Whichever whisper.cpp binary this machine has, decided once. */
let whisperCppResolved;
function whisperCppBinary() {
  if (whisperCppResolved === undefined) {
    whisperCppResolved = have('whisper-cli') ? 'whisper-cli' : have('whisper-cpp') ? 'whisper-cpp' : null;
  }
  return whisperCppResolved;
}

/** Which Python whisper model. tiny.en is the one that keeps up with a live demo. */
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
module.exports = { init, start, stop, describe, isListening, MAX_UTTERANCE_S, CAPTURE, TRANSCRIBE };
