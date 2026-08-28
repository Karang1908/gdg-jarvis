'use strict';

/**
 * JARVIS's own voice.
 *
 * Speech used to belong to whichever device was told to talk. That was wrong: JARVIS is
 * one presence, and one presence has one voice. It now comes out of the machine running
 * Core — the Kali laptop — which is also where the LLM and the MCP server live, so the
 * thinking and the speaking happen in the same place. See DEVIATIONS.md D11.
 *
 * Per-device speech still exists, and is still the right tool for the moment every laptop
 * in the room says the same thing at once. It is simply no longer the default.
 *
 * Nothing here touches a shell. Every backend is spawned with an argument array, so the
 * text being spoken — which may have come from an LLM — cannot become a command.
 */

const { spawn, spawnSync } = require('child_process');

const log = require('./log');

/**
 * Backends, in preference order.
 *
 * `say` is macOS and by far the best of them. On Kali, speech-dispatcher (`spd-say`) is
 * usually already installed and sounds markedly better than raw espeak; espeak-ng is the
 * fallback that is essentially always available.
 *
 * `args` builds the argument array. It is a function rather than a template because each
 * backend spells rate and voice differently, and because getting this wrong would mean
 * concatenating user text into a string somewhere.
 */
const BACKENDS = [
  {
    name: 'say',
    command: 'say',
    /** macOS. Rate is words per minute; pitch is an inline synthesiser command. */
    args: (text, config) => {
      const argv = [];
      if (config.voice) argv.push('-v', config.voice);
      if (config.rate) argv.push('-r', String(config.rate));
      argv.push(config.pitch ? `[[pbas ${config.pitch}]]${text}` : text);
      return argv;
    },
    defaults: { voice: 'Daniel', rate: 165, pitch: 38 },
  },
  {
    name: 'spd-say',
    command: 'spd-say',
    /**
     * speech-dispatcher. `-w` waits for the utterance to finish, which is what lets the
     * queue below serialise properly instead of overlapping every line.
     */
    args: (text, config) => {
      const argv = ['-w'];
      if (config.voice) argv.push('-y', config.voice);
      if (config.rate) argv.push('-r', String(config.spdRate !== undefined ? config.spdRate : -10));
      if (config.pitch !== undefined) argv.push('-p', String(config.spdPitch !== undefined ? config.spdPitch : -20));
      argv.push('--', text);
      return argv;
    },
    defaults: { voice: 'en-GB', spdRate: -10, spdPitch: -20 },
  },
  {
    name: 'espeak-ng',
    command: 'espeak-ng',
    args: (text, config) => buildEspeak(text, config),
    defaults: { voice: 'en-gb-x-rp', rate: 150, pitch: 35 },
  },
  {
    name: 'espeak',
    command: 'espeak',
    args: (text, config) => buildEspeak(text, config),
    defaults: { voice: 'en-gb', rate: 150, pitch: 35 },
  },
];

/**
 * espeak and espeak-ng share a command line.
 *
 * `-v` voice, `-s` words per minute, `-p` pitch 0-99. The defaults above pick a received
 * pronunciation English voice at a deliberately low pitch and unhurried rate, because the
 * out-of-the-box espeak voice sounds like a 1980s train announcement and JARVIS does not.
 */
function buildEspeak(text, config) {
  const argv = [];
  if (config.voice) argv.push('-v', config.voice);
  if (config.rate) argv.push('-s', String(config.rate));
  if (config.pitch !== undefined) argv.push('-p', String(config.pitch));
  argv.push('--', text);
  return argv;
}

/** Is a command actually runnable? `which` rather than trying it, so nothing is spoken. */
function available(command) {
  const probe = spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

let backend = null;
let settings = {};
let enabled = true;

/** Utterances waiting their turn. Capped — see enqueue(). */
const queue = [];
let speaking = false;

/**
 * Choose a backend and merge in whatever the operator configured.
 *
 * An explicit `backend` in config wins even if something better is installed, because an
 * operator who names one has a reason — usually that the default sounds wrong on their
 * hardware.
 */
function init(config = {}) {
  enabled = config.enabled !== false;
  const wanted = config.backend;

  const candidates = wanted ? BACKENDS.filter((b) => b.name === wanted) : BACKENDS;
  backend = candidates.find((b) => available(b.command)) || null;

  if (!backend) {
    if (enabled) {
      log.warn('no speech backend found; JARVIS will be silent on this machine', {
        looked_for: BACKENDS.map((b) => b.command).join(' '),
      });
      if (wanted) log.warn(`configured backend "${wanted}" is not installed`);
      else log.warn('on Debian/Kali:  sudo apt install speech-dispatcher espeak-ng');
    }
    return { ok: false };
  }

  settings = { ...backend.defaults };
  for (const key of ['voice', 'rate', 'pitch', 'spdRate', 'spdPitch']) {
    if (config[key] !== undefined) settings[key] = config[key];
  }

  log.good('voice ready', { backend: backend.name, voice: settings.voice || 'default' });
  return { ok: true, backend: backend.name, settings };
}

function describe() {
  return {
    enabled,
    available: Boolean(backend),
    backend: backend ? backend.name : null,
    voice: settings.voice || null,
  };
}

function setEnabled(value) {
  enabled = Boolean(value);
  if (!enabled) {
    // Drop anything queued. Muting should stop the next sentence, not merely prevent new
    // ones from being added behind it.
    queue.length = 0;
  }
  return enabled;
}

function isEnabled() {
  return enabled;
}

/** Speak the next queued line, then the one after it. */
function drain() {
  if (speaking || queue.length === 0) return;
  if (!backend || !enabled) {
    queue.length = 0;
    return;
  }

  const { text, resolve } = queue.shift();
  speaking = true;

  let child;
  try {
    // No shell. The text is one element of an argument array and cannot be re-parsed.
    child = spawn(backend.command, backend.args(text, settings), { stdio: 'ignore' });
  } catch (err) {
    speaking = false;
    log.error('speech failed to start', { error: err.message });
    resolve({ ok: false, error: err.message });
    return drain();
  }

  const finish = (result) => {
    if (!speaking) return;
    speaking = false;
    resolve(result);
    drain();
  };

  child.on('error', (err) => finish({ ok: false, error: err.message }));
  child.on('exit', () => finish({ ok: true }));

  // A wedged synthesiser must not take the voice down for the rest of the demo. Ten
  // seconds is far longer than any line SPEC.md §31 permits.
  const guard = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    log.warn('speech timed out and was cut short');
    finish({ ok: false, error: 'timeout' });
  }, 10_000);
  guard.unref();
  child.on('exit', () => clearTimeout(guard));
}

/**
 * Say something.
 *
 * Queued rather than concurrent: two synthesisers talking over each other is unintelligible
 * and sounds broken, where a half-second wait sounds deliberate.
 */
function speak(text) {
  if (!enabled) return Promise.resolve({ ok: false, error: 'muted' });
  if (!backend) return Promise.resolve({ ok: false, error: 'no_backend' });
  if (typeof text !== 'string' || text.trim() === '') {
    return Promise.resolve({ ok: false, error: 'empty' });
  }

  // A backlog means something is generating speech faster than it can be spoken, and the
  // useful thing to say is the most recent one, not a queue of stale lines.
  if (queue.length >= 4) {
    const dropped = queue.splice(0, queue.length - 3);
    for (const item of dropped) item.resolve({ ok: false, error: 'superseded' });
    log.warn('speech queue trimmed', { dropped: dropped.length });
  }

  return new Promise((resolve) => {
    queue.push({ text: text.trim(), resolve });
    drain();
  });
}

/** Stop mid-sentence and clear the queue. Used by release and by shutdown. */
function silence() {
  queue.length = 0;
  if (speaking && backend) {
    // There is no portable "stop talking" across these backends, so the process is ended.
    spawnSync('sh', ['-c', `pkill -x ${backend.command} 2>/dev/null || true`], { stdio: 'ignore' });
    speaking = false;
  }
}

module.exports = { init, speak, silence, describe, setEnabled, isEnabled, BACKENDS };
