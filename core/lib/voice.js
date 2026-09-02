'use strict';

/**
 * JARVIS's voice.
 *
 * One presence, one voice, from the machine that runs Core — see DEVIATIONS.md D11.
 *
 * Ordinary path: a line comes in, it is synthesised, it is played. Gemini if there is a
 * key, Piper if it is installed, the platform's own voice otherwise.
 *
 * Two things sit on top of that, and neither is something to think about.
 *
 * **An optional latency budget**, off by default. When set, a call that has not produced
 * audio in time is abandoned and the local voice speaks instead. It began as a one-second
 * default and that was wrong: Gemini routinely takes longer, so the guard fired constantly
 * and the room heard the robotic fallback rather than the voice it was configured for.
 *
 * **A cache**, which is simply "do not pay for the same line twice". It fills itself as
 * JARVIS talks. Nothing has to be run for it to work, and a repeated line — "Yes, sir"
 * five times in one demo — costs one synthesis rather than five.
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

/**
 * How long a live synthesis may take before the local voice takes over.
 *
 * Off. Not "off for now" — off because capping it is the wrong trade, and it has been tried
 * twice.
 *
 * A cap does not shorten a line; it decides whether the line is spoken in the good voice or
 * the robotic one. And synthesis time scales with sentence length, so any ceiling lands
 * hardest on the longest sentences — exactly the ones where the voice matters most. A demo
 * where short lines sound right and long ones sound like 1998 is worse than one that waits.
 *
 * Set JARVIS_VOICE_BUDGET_MS if a venue's uplink turns out to be bad enough that waiting is
 * worse than sounding flat. The hard timeout still stops a wedged call hanging forever.
 */
const DEFAULT_BUDGET_MS = 0;

/** The hard ceiling on a background call, once the budget has already been given up on. */
const SYNTH_TIMEOUT_MS = 15_000;

let config = {};
let cacheDir = null;

/**
 * What the API key has actually been spent on.
 *
 * The free tier is rate limited, and the only thing in this system that touches it is
 * speech — the MCP server never calls Google, and the AI client authenticates as itself.
 * Counting here makes that claim checkable rather than something to take on trust, and
 * makes the cache's value visible: `saved` is calls that were never made.
 */
const usage = { calls: 0, saved: 0, failed: 0, rateLimited: 0, lastError: null };
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

/**
 * Where piper is.
 *
 * Usually not on PATH. `pip install piper-tts` puts it inside whichever virtual environment
 * it was installed into, and on a Debian-family machine that is the only way to install it
 * without fighting the system package manager — so an installed, working piper that Core
 * could not find was the normal case rather than the exception.
 */
function piperBinary() {
  const configured = (config.piper || {}).bin || process.env.JARVIS_PIPER_BIN;
  if (configured) return fs.existsSync(configured) ? configured : null;
  return have('piper') ? 'piper' : null;
}

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
    // Whether this provider can be slow for reasons outside this machine. Used to choose
    // a fallback when the budget is blown — naming one provider instead would mean any
    // future cloud backend silently falls back to itself.
    network: true,
    available() {
      return Boolean(apiKey());
    },
    async synth(text) {
      usage.calls++;
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
        usage.failed++;
        usage.lastError = `${response.status}`;

        // 429 is the one worth naming. The chain already falls through to the local voice,
        // so the demo keeps talking — but silently sounding worse for the rest of the
        // evening, with no indication why, would be the wrong way to find out.
        if (response.status === 429) {
          usage.rateLimited++;
          log.warn('Gemini rate limit reached; falling back to the local voice', {
            calls_so_far: usage.calls,
            note: 'cached lines are unaffected',
          });
        }
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
      return Boolean(piperBinary()) && Boolean((config.piper || {}).model);
    },
    synth(text) {
      const settings = config.piper || {};
      const output = path.join(cacheDir, `.piper-${process.pid}-${Date.now()}.wav`);

      return new Promise((resolve, reject) => {
        const child = spawn(
          piperBinary(),
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
  { command: 'paplay', args: (file) => [file], needsUserSession: true },
  { command: 'aplay', args: (file) => ['-q', file] },
  { command: 'mpv', args: (file) => ['--no-video', '--really-quiet', file], needsUserSession: true },
  { command: 'ffplay', args: (file) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] },
];

/** Running as root, where a per-user audio daemon is usually out of reach. */
function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Pick something that can actually make a noise here.
 *
 * PulseAudio and PipeWire are per-user daemons. Running as root — which is easy to end up
 * doing, since the setup script needs sudo for the network — means paplay has no session to
 * connect to and fails with "Connection refused" no matter how loud the speakers are.
 * ALSA does not care, so as root it is tried first.
 *
 * The right answer is still to run Core as a normal user; this only stops the common
 * mistake from being silent.
 */
function findPlayer() {
  const candidates = isRoot()
    ? [...PLAYERS].sort((a, b) => Number(Boolean(a.needsUserSession)) - Number(Boolean(b.needsUserSession)))
    : PLAYERS;

  return candidates.find((candidate) => have(candidate.command)) || null;
}

/* ------------------------------------------------------------------------------------
 * Setup
 * --------------------------------------------------------------------------------- */

/**
 * Merge the environment over the config file.
 *
 * Env wins, so a `.env` or an exported variable is the quick way to change how JARVIS
 * sounds without editing JSON — and so an API key never has to be written into a file that
 * lives next to the code.
 */
function resolve(options) {
  const merged = JSON.parse(JSON.stringify(options || {}));
  const env = process.env;

  merged.gemini = merged.gemini || {};
  merged.piper = merged.piper || {};

  if (env.JARVIS_VOICE_PROVIDER) merged.provider = env.JARVIS_VOICE_PROVIDER;
  if (env.JARVIS_STYLE) merged.style = env.JARVIS_STYLE;
  if (env.JARVIS_VOICE) merged.gemini.voice = env.JARVIS_VOICE;
  if (env.JARVIS_GEMINI_MODEL) merged.gemini.model = env.JARVIS_GEMINI_MODEL;
  if (env.JARVIS_PIPER_MODEL) merged.piper.model = env.JARVIS_PIPER_MODEL;
  if (env.JARVIS_PIPER_BIN) merged.piper.bin = env.JARVIS_PIPER_BIN;

  // The default has to be applied here rather than at the point of use, because zero is a
  // meaningful value there — it means "no budget, wait for the good voice" — and cannot
  // also stand for "nothing was configured".
  const budget = Number(env.JARVIS_VOICE_BUDGET_MS);
  if (Number.isFinite(budget) && budget >= 0) {
    merged.budgetMs = budget;
  } else if (merged.budgetMs === undefined) {
    merged.budgetMs = DEFAULT_BUDGET_MS;
  }

  return merged;
}

function init(options = {}) {
  config = resolve(options);
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

  // JARVIS_AUDIO_PLAYER names one outright. Two uses: an operator whose machine picks the
  // wrong one, and the test suite, which needs the speaking path exercised without putting
  // sound through the host's audio stack — whose timing is unpredictable and which fails
  // outright on a synthetic buffer, making a timing assertion flap for no real reason.
  const named = config.player || process.env.JARVIS_AUDIO_PLAYER;
  player = named
    ? { command: named, args: (file) => [file] }
    : findPlayer();

  // An explicitly named provider wins even if something "better" is installed: an operator
  // who names one has a reason, usually that the default sounds wrong in their room.
  const wanted = config.provider && config.provider !== 'auto' ? [config.provider] : PREFERENCE;
  chain = wanted.filter((name) => PROVIDERS[name] && PROVIDERS[name].available());

  const usable = chain.filter((name) => PROVIDERS[name].kind === 'direct' || player);

  if (!usable.length) {
    if (enabled) {
      // Two entirely different problems produce silence, and conflating them sends people
      // to check their speakers when the real answer is that no text-to-speech program is
      // installed. Say which one it is.
      const haveSynth = chain.length > 0;

      if (haveSynth && !player) {
        log.warn('JARVIS cannot speak: a voice is configured, but nothing here can play audio');
        log.warn('  your speakers are fine — this machine has no audio player command');
        log.warn('  sudo apt install -y pulseaudio-utils      # gives you paplay');
      } else if (!haveSynth && player) {
        log.warn('JARVIS cannot speak: audio works, but there is no text-to-speech program');
        log.warn('  set GEMINI_API_KEY in .env for a natural voice (free), or:');
        log.warn('  sudo apt install -y espeak-ng speech-dispatcher');
      } else {
        log.warn('JARVIS cannot speak: no text-to-speech program and no audio player');
        log.warn('  sudo apt install -y espeak-ng speech-dispatcher pulseaudio-utils');
        log.warn('  and set GEMINI_API_KEY in .env for a voice worth listening to');
      }
    }
    chain = [];
    return describe();
  }

  chain = usable;
  const primary = chain[0];

  if (isRoot()) {
    // Worth saying every time. Audio failing under sudo looks like broken hardware, and
    // the fix — do not use sudo — is not one anybody guesses.
    log.warn('running as root; audio often fails because PulseAudio belongs to your user', {
      using: player ? player.command : 'none',
      fix: 'run Core as your normal user, not with sudo',
    });
  }

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
    // Reported separately because they fail for unrelated reasons and have different fixes.
    hasSynth: PREFERENCE.some((name) => PROVIDERS[name] && PROVIDERS[name].available()),
    hasPlayer: Boolean(player),
    root: isRoot(),
    provider: chain[0] || null,
    fallbacks: chain.slice(1),
    natural: chain[0] === 'gemini' || chain[0] === 'piper',
    player: player ? player.command : null,
    cacheDir,
    cached: cacheDir ? countCached() : 0,
    cacheable: chain[0] ? PROVIDERS[chain[0]].kind === 'synth' : false,
    usage: { ...usage },
    budgetMs: Number(config.budgetMs) > 0 ? Number(config.budgetMs) : 0,
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

/**
 * Play a file, and actually notice whether it worked.
 *
 * The exit code is the whole point. An earlier version reported success on any exit, so a
 * player that died with "Connection refused" — the normal outcome of running as root while
 * PulseAudio belongs to the desktop user — was indistinguishable from one that made a
 * noise. That turns a five-second fix into an unfalsifiable mystery.
 *
 * stderr is captured for the same reason: the player already knows exactly what is wrong
 * and says so, and discarding that was throwing away the answer.
 */
/**
 * When JARVIS last stopped talking.
 *
 * The microphone is in the same room as the speakers, so it hears everything JARVIS says
 * and dutifully transcribes it: "One moment, sir." came back as "One moment to serve." and
 * "Releasing the room." came back verbatim. Each one costs a transcription, and a line that
 * happened to look like a command would make the room act on its own voice.
 */
let speakingUntil = 0;

/** True while JARVIS is talking, and for a moment after the last sound leaves the speaker. */
function isSpeaking() {
  return Date.now() < speakingUntil;
}

/**
 * How long a clip may take to play before something is wrong.
 *
 * Its own duration plus room for a slow start. A flat allowance killed anything longer than
 * it, mid-word, and reported a timeout for audio that was playing perfectly well. The guard
 * still stops a wedged player hanging forever — it just asks the file how long it is first.
 *
 * Read from the WAV header, where the byte rate lives at offset 28, falling back to the flat
 * allowance for anything that cannot be read: a wrong guess here cuts speech off.
 */
function playbackAllowance(file) {
  try {
    const header = Buffer.alloc(44);
    const handle = fs.openSync(file, 'r');
    fs.readSync(handle, header, 0, 44, 0);
    fs.closeSync(handle);

    if (header.toString('ascii', 0, 4) !== 'RIFF') return SPEECH_TIMEOUT_MS;

    const byteRate = header.readUInt32LE(28);
    if (!byteRate) return SPEECH_TIMEOUT_MS;

    const seconds = (fs.statSync(file).size - 44) / byteRate;
    return Math.max(SPEECH_TIMEOUT_MS, Math.ceil(seconds * 1000) + 5_000);
  } catch {
    return SPEECH_TIMEOUT_MS;
  }
}

function play(file, startedAt) {
  return new Promise((resolve) => {
    const spawnedAt = Date.now();
    const child = spawn(player.command, player.args(file), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    current = child;
    // Generous while it plays; narrowed to a short tail once it finishes.
    speakingUntil = Date.now() + 60_000;

    // The player has the file open and is about to make a noise. Close enough to
    // "first sound" to be the number worth reporting, and far more useful than the
    // moment the audio *finishes*, which is dominated by how long the line is.
    const firstSoundMs = startedAt ? spawnedAt - startedAt : null;

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk;
    });

    const done = (result) => {
      if (current === child) current = null;
      // A moment past the end: the tail of a word is still in the air, and the recorder is
      // quicker to notice sound than the room is to go quiet.
      speakingUntil = Date.now() + 600;
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
    }, playbackAllowance(file));
    guard.unref();

    child.on('error', (err) => done({ ok: false, error: err.message }));

    child.on('exit', (code, signal) => {
      if (code === 0) return done({ ok: true, firstSoundMs });

      const detail = stderr.trim().split('\n').filter(Boolean).pop() || '';
      log.error('audio player failed', {
        player: player.command,
        exit: code === null ? signal : code,
        ...(detail ? { said: detail.slice(0, 160) } : {}),
      });
      done({
        ok: false,
        error: 'playback_failed',
        player: player.command,
        exit: code,
        detail: detail.slice(0, 200),
      });
    });
  });
}

function speakDirect(name, text) {
  const provider = PROVIDERS[name];
  return new Promise((resolve) => {
    const child = spawn(provider.command, provider.args(text), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    current = child;

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk;
    });

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

    child.on('exit', (code, signal) => {
      if (code === 0) return done({ ok: true });

      const detail = stderr.trim().split('\n').filter(Boolean).pop() || '';
      log.error('speech command failed', {
        command: provider.command,
        exit: code === null ? signal : code,
        ...(detail ? { said: detail.slice(0, 160) } : {}),
      });
      done({ ok: false, error: 'speech_failed', detail: detail.slice(0, 200) });
    });
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

/**
 * The best thing available that does not depend on a network.
 *
 * Chosen by the provider's own `network` flag rather than by name. Excluding only
 * "gemini" would mean any other network-backed provider fell back to itself, which is not
 * a fallback at all — it just pays the same latency twice.
 */
function localFallback() {
  return chain.find((name) => !PROVIDERS[name].network) || null;
}

/**
 * Synthesise, but give up after the budget.
 *
 * The abandoned promise is deliberately not cancelled — it is left to finish and write to
 * the cache. The first time a novel line is slow you hear the local voice; every time
 * after that, the good one is already on disk. Being late is a reason to stop *waiting*,
 * not a reason to throw away work that is nearly done.
 */
function synthesiseWithin(text, budgetMs) {
  const work = synthesise(text);

  // Keep the background write alive without letting a rejection become unhandled.
  work.catch(() => {});

  return Promise.race([
    work.then((made) => ({ made })),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
      timer.unref();
    }),
  ]);
}

async function deliver(text) {
  if (!chain.length) return { ok: false, error: 'no_provider' };

  const requestedAt = Date.now();

  // Already have the audio. Nothing to decide, and nothing spent — counted, because the
  // free tier is rate limited and "calls the cache avoided" is the number that shows
  // whether that is a problem worth worrying about.
  if (player && isCached(text)) {
    if (chain[0] === 'gemini') usage.saved++;
    const result = await play(cachePath(text), requestedAt);
    return { ...result, source: 'cache' };
  }

  // A budget of zero means no budget: wait for the real voice.
  const budgetMs = Number(config.budgetMs) > 0 ? Number(config.budgetMs) : 0;

  if (player) {
    const started = Date.now();
    const outcome = budgetMs
      ? await synthesiseWithin(text, budgetMs)
      : { made: await synthesise(text) };

    if (outcome.made) {
      const synthMs = Date.now() - started;
      const result = await play(outcome.made.file, requestedAt);
      return { ...result, source: outcome.made.provider || 'cache', synthMs };
    }

    if (outcome.timedOut) {
      const local = localFallback();
      log.warn('voice took longer than the budget; using the local voice', {
        budget_ms: budgetMs,
        falling_back_to: local || 'nothing',
        note: 'the slow one is still being cached for next time',
      });

      if (local && PROVIDERS[local].kind === 'direct') {
        const result = await speakDirect(local, text);
        return { ...result, source: local, overBudget: true };
      }
      if (local && PROVIDERS[local].kind === 'synth') {
        const made = await PROVIDERS[local]
          .synth(text)
          .then((audio) => {
            const file = path.join(cacheDir, `.fallback-${Date.now()}.wav`);
            fs.writeFileSync(file, audio);
            return file;
          })
          .catch(() => null);

        if (made) {
          const result = await play(made, requestedAt);
          fs.unlink(made, () => {});
          return { ...result, source: local, overBudget: true };
        }
      }
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
  isSpeaking,
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
