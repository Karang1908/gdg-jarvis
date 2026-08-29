'use strict';

/**
 * JARVIS's voice.
 *
 * One presence, one voice, coming from the machine that runs Core — see DEVIATIONS.md D11.
 * This file is about making that voice good enough to carry a room, without making the
 * demo depend on a network call landing in time.
 *
 * The shape that solves it is a cache in front of a provider chain:
 *
 *     speak(text)
 *       ├── cached?  ── play the file                    instant, no network
 *       └── not cached
 *             ├── gemini   natural, needs internet ──┐
 *             ├── piper    natural, local, fast    ──┤── write to cache ── play
 *             └── say / spd-say / espeak            ──┘   (spoken directly)
 *
 * Almost every line the demo needs is known in advance, so `scripts/warm-voice.sh`
 * generates them all once with the best provider available and leaves the audio on disk.
 * At showtime those play from a file: no latency, no tether, no failure mode. Only lines
 * the model invents on the spot reach a provider live, and if that call fails the chain
 * falls through to something local rather than going silent.
 *
 * Nothing here builds a shell command from text. Every provider is spawned with an
 * argument array, because the text may have come from a language model.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const log = require('./log');

const SPEECH_TIMEOUT_MS = 10_000;
const SYNTH_TIMEOUT_MS = 15_000;

let config = {};
let cacheDir = null;
let player = null;
let chain = [];

const queue = [];
let speaking = false;
let current = null;
let enabled = true;

/* ------------------------------------------------------------------------------------
 * Small helpers
 * --------------------------------------------------------------------------------- */

function have(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

/**
 * Wrap raw PCM in a WAV header.
 *
 * Gemini returns bare 24 kHz mono 16-bit PCM with no container, which no ordinary audio
 * player will touch. Forty-four bytes of RIFF header is the whole difference between an
 * unusable blob and a file `afplay` or `paplay` will play.
 */
function wavFromPcm(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/* ------------------------------------------------------------------------------------
 * Providers
 *
 * Two kinds. A `synth` provider returns audio, which can be cached and replayed for free
 * forever after. A `direct` provider just makes a noise and cannot be cached — those are
 * the last resort, and the reason the chain prefers anything else.
 * --------------------------------------------------------------------------------- */

const PROVIDERS = {
  /**
   * Gemini TTS. The natural one.
   *
   * The style prompt is the reason this is worth the network call: the model is told how to
   * deliver the line, not merely what to say, so "Yes, sir" comes out measured and dry
   * rather than chirpy. That is not something a concatenative engine can do at all.
   */
  gemini: {
    kind: 'synth',
    available() {
      return Boolean(apiKey());
    },
    async synth(text) {
      const settings = config.gemini || {};
      const model = settings.model || 'gemini-3.1-flash-tts-preview';
      const voice = settings.voice || 'Charon';
      const style = config.style || '';

      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/interactions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey(),
          },
          body: JSON.stringify({
            model,
            input: style ? `${style}: ${text}` : text,
            response_format: { type: 'audio' },
            generation_config: { speech_config: [{ voice }] },
          }),
          signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
        }
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`gemini ${response.status}: ${detail.slice(0, 160)}`);
      }

      const payload = await response.json();
      const base64 = findAudio(payload);
      if (!base64) throw new Error('gemini returned no audio');

      // 24 kHz mono 16-bit PCM, per the API docs.
      return wavFromPcm(Buffer.from(base64, 'base64'));
    },
  },

  /**
   * Piper. Neural, local, and fast enough to be conversational.
   *
   * Roughly five times faster than real time on a laptop CPU, so a short line is ready in
   * well under a second with no network at all. This is what makes the demo sound good on
   * a Kali box with no tether.
   */
  piper: {
    kind: 'synth',
    available() {
      return have('piper') && Boolean((config.piper || {}).model);
    },
    synth(text) {
      const settings = config.piper || {};
      const output = path.join(cacheDir, `.piper-${process.pid}-${Date.now()}.wav`);

      return new Promise((resolve, reject) => {
        const child = spawn(
          'piper',
          ['--model', settings.model, '--output_file', output],
          { stdio: ['pipe', 'ignore', 'pipe'] }
        );

        let stderr = '';
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);

        child.on('exit', (code) => {
          if (code !== 0) return reject(new Error(`piper exited ${code}: ${stderr.slice(0, 160)}`));
          try {
            const audio = fs.readFileSync(output);
            fs.unlinkSync(output);
            resolve(audio);
          } catch (err) {
            reject(err);
          }
        });

        // Text goes in on stdin, never as an argument, so nothing about it can be read as
        // an option however it was generated.
        child.stdin.end(text + '\n');
      });
    },
  },

  /**
   * macOS `say`, writing a file.
   *
   * Treated as a synthesiser rather than a direct speaker because it can emit WAV, which
   * means macOS gets the same cache as everything else — and, more usefully, means the
   * cache path is exercised on the machine this is developed on rather than only in
   * production.
   */
  say: {
    kind: 'synth',
    available: () => have('say'),
    synth(text) {
      const output = path.join(cacheDir, `.say-${process.pid}-${Date.now()}.wav`);
      return new Promise((resolve, reject) => {
        const child = spawn('say', [...sayArgs(text), '--data-format=LEI16@24000', '-o', output], {
          stdio: 'ignore',
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code !== 0) return reject(new Error(`say exited ${code}`));
          try {
            const audio = fs.readFileSync(output);
            fs.unlinkSync(output);
            resolve(audio);
          } catch (err) {
            reject(err);
          }
        });
      });
    },
  },

  /** The same voice, spoken straight out, for when nothing on the machine can play a file. */
  'say-direct': {
    kind: 'direct',
    available: () => have('say'),
    command: 'say',
    args: (text) => sayArgs(text),
  },

  'spd-say': {
    kind: 'direct',
    available: () => have('spd-say'),
    command: 'spd-say',
    args(text) {
      const settings = config.spd || {};
      return [
        '-w',
        '-y', settings.voice || 'en-GB',
        '-r', String(settings.rate === undefined ? -10 : settings.rate),
        '-p', String(settings.pitch === undefined ? -20 : settings.pitch),
        '--',
        text,
      ];
    },
  },

  'espeak-ng': {
    kind: 'direct',
    available: () => have('espeak-ng'),
    command: 'espeak-ng',
    args: (text) => espeakArgs(text, 'en-gb-x-rp'),
  },

  espeak: {
    kind: 'direct',
    available: () => have('espeak'),
    command: 'espeak',
    args: (text) => espeakArgs(text, 'en-gb'),
  },
};

function sayArgs(text) {
  const settings = config.say || {};
  const argv = [];
  if (settings.voice !== null) argv.push('-v', settings.voice || 'Daniel');
  argv.push('-r', String(settings.rate || 165));
  // [[pbas n]] is a Speech Synthesis command inside the text, not a shell construct.
  argv.push(`[[pbas ${settings.pitch === undefined ? 38 : settings.pitch}]]${text}`);
  return argv;
}

function espeakArgs(text, defaultVoice) {
  const settings = config.espeak || {};
  return [
    '-v', settings.voice || defaultVoice,
    '-s', String(settings.rate || 150),
    '-p', String(settings.pitch === undefined ? 35 : settings.pitch),
    '--',
    text,
  ];
}

/** Order matters: natural first, local-natural second, robotic last. */
const PREFERENCE = ['gemini', 'piper', 'say', 'spd-say', 'espeak-ng', 'espeak', 'say-direct'];

function apiKey() {
  return (
    (config.gemini && config.gemini.apiKey) ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ''
  );
}

/**
 * Dig the audio out of a response without assuming one exact shape.
 *
 * These endpoints are in preview and the envelope has already changed once. Walking the
 * object for the first plausible base64 blob means a field being renamed costs a warning
 * rather than a silent demo.
 */
function findAudio(payload) {
  const seen = new Set();

  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);

    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && value.length > 512) {
        if (/audio|data|pcm|content/i.test(key)) return value;
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
 * Cache
 * --------------------------------------------------------------------------------- */

/**
 * Key on everything that changes how a line sounds.
 *
 * Including the provider, voice and style means changing any of them produces a fresh file
 * rather than replaying yesterday's delivery — the failure would be editing the style
 * prompt, hearing no difference, and concluding the setting does nothing.
 */
function cacheKey(text) {
  const settings = config.gemini || {};
  const material = [
    config.provider || 'auto',
    settings.voice || '',
    settings.model || '',
    config.style || '',
    (config.piper || {}).model || '',
    text,
  ].join(' ');

  return crypto.createHash('sha1').update(material).digest('hex');
}

function cachePath(text) {
  return cacheDir ? path.join(cacheDir, `${cacheKey(text)}.wav`) : null;
}

function isCached(text) {
  const file = cachePath(text);
  return Boolean(file && fs.existsSync(file));
}

/* ------------------------------------------------------------------------------------
 * Playback
 * --------------------------------------------------------------------------------- */

const PLAYERS = [
  { command: 'afplay', args: (file) => [file] },
  { command: 'paplay', args: (file) => [file] },
  { command: 'aplay', args: (file) => ['-q', file] },
  { command: 'mpv', args: (file) => ['--no-video', '--really-quiet', file] },
  { command: 'ffplay', args: (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] },
];

function findPlayer() {
  return PLAYERS.find((candidate) => have(candidate.command)) || null;
}

/* ------------------------------------------------------------------------------------
 * Setup
 * --------------------------------------------------------------------------------- */

function init(options = {}) {
  config = options || {};
  enabled = config.enabled !== false;

  cacheDir = path.resolve(config.cacheDir || path.join(__dirname, '..', 'cache', 'voice'));
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    log.warn('could not create the voice cache; every line will be synthesised live', {
      dir: cacheDir,
      error: err.message,
    });
    cacheDir = null;
  }

  player = findPlayer();

  // An explicitly named provider wins even if something "better" is installed: an operator
  // who names one has a reason, usually that the default sounds wrong in their room.
  const wanted = config.provider && config.provider !== 'auto' ? [config.provider] : PREFERENCE;
  chain = wanted.filter((name) => PROVIDERS[name] && PROVIDERS[name].available());

  const usable = chain.filter((name) => PROVIDERS[name].kind === 'direct' || player);

  if (!usable.length) {
    if (enabled) {
      log.warn('JARVIS has no usable voice on this machine');
      if (chain.length && !player) {
        log.warn('a synthesiser is available but nothing can play audio', {
          install: 'sudo apt install pulseaudio-utils   # or alsa-utils, mpv',
        });
      } else {
        log.warn('install one of:  gemini api key  ·  piper  ·  speech-dispatcher  ·  espeak-ng');
      }
    }
    chain = [];
    return describe();
  }

  chain = usable;
  const primary = chain[0];

  log.good('voice ready', {
    using: primary,
    fallbacks: chain.slice(1).join(' ') || 'none',
    player: player ? player.command : 'not needed',
    cached: cacheDir ? countCached() : 0,
  });

  if (primary === 'espeak' || primary === 'espeak-ng') {
    log.warn('espeak is the fallback of last resort and sounds like it');
    log.warn('for a natural voice: set a GEMINI_API_KEY, or install piper');
  }

  return describe();
}

function countCached() {
  try {
    return fs.readdirSync(cacheDir).filter((f) => f.endsWith('.wav')).length;
  } catch {
    return 0;
  }
}

function describe() {
  return {
    enabled,
    available: chain.length > 0,
    provider: chain[0] || null,
    fallbacks: chain.slice(1),
    natural: chain[0] === 'gemini' || chain[0] === 'piper',
    player: player ? player.command : null,
    cacheDir,
    cached: cacheDir ? countCached() : 0,
    cacheable: chain[0] ? PROVIDERS[chain[0]].kind === 'synth' : false,
    voice:
      chain[0] === 'gemini'
        ? (config.gemini || {}).voice || 'Charon'
        : chain[0] === 'piper'
          ? path.basename((config.piper || {}).model || '')
          : (config.say || {}).voice || null,
  };
}

/* ------------------------------------------------------------------------------------
 * Speaking
 * --------------------------------------------------------------------------------- */

function play(file) {
  return new Promise((resolve) => {
    const child = spawn(player.command, player.args(file), { stdio: 'ignore' });
    current = child;

    const done = (result) => {
      if (current === child) current = null;
      clearTimeout(guard);
      resolve(result);
    };

    const guard = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      done({ ok: false, error: 'playback_timeout' });
    }, SPEECH_TIMEOUT_MS);
    guard.unref();

    child.on('error', (err) => done({ ok: false, error: err.message }));
    child.on('exit', () => done({ ok: true }));
  });
}

function speakDirect(name, text) {
  const provider = PROVIDERS[name];
  return new Promise((resolve) => {
    const child = spawn(provider.command, provider.args(text), { stdio: 'ignore' });
    current = child;

    const done = (result) => {
      if (current === child) current = null;
      clearTimeout(guard);
      resolve(result);
    };

    const guard = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      done({ ok: false, error: 'speech_timeout' });
    }, SPEECH_TIMEOUT_MS);
    guard.unref();

    child.on('error', (err) => done({ ok: false, error: err.message }));
    child.on('exit', () => done({ ok: true }));
  });
}

/**
 * Produce audio for a line and cache it, without playing it.
 *
 * Exported so `scripts/warm-voice.sh` can fill the cache before a demo. Returns which
 * provider produced it, or null if only direct providers are available.
 */
async function synthesise(text) {
  if (!cacheDir) return null;

  const file = cachePath(text);
  if (fs.existsSync(file)) return { cached: true, file, provider: null };

  for (const name of chain) {
    const provider = PROVIDERS[name];
    if (provider.kind !== 'synth') continue;

    try {
      const audio = await provider.synth(text);
      // Write beside the target and rename, so a killed process cannot leave a truncated
      // file that would then be played as a valid cache hit forever.
      const temporary = `${file}.partial`;
      fs.writeFileSync(temporary, audio);
      fs.renameSync(temporary, file);
      return { cached: false, file, provider: name };
    } catch (err) {
      log.warn(`${name} could not synthesise; trying the next provider`, {
        error: String(err.message).slice(0, 120),
      });
    }
  }

  return null;
}

async function deliver(text) {
  if (!chain.length) return { ok: false, error: 'no_provider' };

  // The fast path, and the one the demo actually runs on.
  if (player && isCached(text)) {
    const result = await play(cachePath(text));
    return { ...result, source: 'cache' };
  }

  if (player) {
    const made = await synthesise(text);
    if (made) {
      const result = await play(made.file);
      return { ...result, source: made.provider || 'cache' };
    }
  }

  for (const name of chain) {
    if (PROVIDERS[name].kind !== 'direct') continue;
    const result = await speakDirect(name, text);
    if (result.ok) return { ...result, source: name };
  }

  return { ok: false, error: 'all_providers_failed' };
}

function drain() {
  if (speaking || queue.length === 0) return;
  if (!chain.length || !enabled) {
    for (const item of queue.splice(0)) item.resolve({ ok: false, error: 'unavailable' });
    return;
  }

  const { text, resolve } = queue.shift();
  speaking = true;

  deliver(text)
    .catch((err) => ({ ok: false, error: err.message }))
    .then((result) => {
      speaking = false;
      resolve(result);
      drain();
    });
}

/**
 * Say something.
 *
 * Queued rather than concurrent: two voices over each other is unintelligible and sounds
 * broken, where a half-second wait sounds deliberate.
 */
function speak(text) {
  if (!enabled) return Promise.resolve({ ok: false, error: 'muted' });
  if (!chain.length) return Promise.resolve({ ok: false, error: 'no_provider' });
  if (typeof text !== 'string' || text.trim() === '') {
    return Promise.resolve({ ok: false, error: 'empty' });
  }

  // A backlog means something is producing speech faster than it can be spoken, and the
  // useful line is the newest one, not a queue of stale ones.
  if (queue.length >= 4) {
    for (const item of queue.splice(0, queue.length - 3)) {
      item.resolve({ ok: false, error: 'superseded' });
    }
  }

  return new Promise((resolve) => {
    queue.push({ text: text.trim(), resolve });
    drain();
  });
}

/** Stop mid-sentence and drop the queue. Used by release and by shutdown. */
function silence() {
  for (const item of queue.splice(0)) item.resolve({ ok: false, error: 'silenced' });
  if (current) {
    try {
      current.kill('SIGKILL');
    } catch {
      /* gone */
    }
    current = null;
  }
  speaking = false;
}

function setEnabled(value) {
  enabled = Boolean(value);
  if (!enabled) silence();
  return enabled;
}

const isEnabled = () => enabled;

module.exports = {
  init,
  speak,
  synthesise,
  silence,
  describe,
  setEnabled,
  isEnabled,
  isCached,
  cachePath,
  wavFromPcm,
  PROVIDERS,
  PREFERENCE,
};
