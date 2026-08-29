'use strict';

/**
 * The bridge from a spoken sentence to the model.
 *
 *   mic  →  transcript  →  POST /api/ask  →  agy -p "..."  →  MCP tools  →  the room
 *
 * This is what makes "Jarvis, which one is Ravi's, and put Chrome on it" work. The
 * controller's own pattern matcher handles the fixed demo commands instantly; anything it
 * does not recognise comes here, where a model can actually reason about it.
 *
 * Two things about `agy -p` shape this file.
 *
 * **It takes seconds, not milliseconds** — about six for a trivial prompt, more once tools
 * are involved. That is why the controller matches the fixed demo commands itself and only
 * sends here what it does not recognise: "take the room" has to be instant, while "which
 * one is Ravi's, and put Chrome on it" can afford to think.
 *
 * **Its output is not really the point.** The model's effect on the room is the MCP tool
 * calls it makes, and JARVIS speaking is one of them — the audio comes out of Core, not out
 * of agy's stdout. So an empty answer on a clean exit is treated as "worked, said nothing"
 * rather than as failure. Antigravity CLI issue #76 describes exactly that happening on
 * some builds; 1.1.22 returns output fine, and this survives either way.
 */

const { spawn, spawnSync } = require('child_process');

const log = require('./log');

/**
 * How long the model gets.
 *
 * Generous compared to everything else here, because a real question may involve several
 * tool calls. The controller shows that it is thinking, and the fixed commands never come
 * this way — they are matched locally and answered instantly.
 */
const DEFAULT_TIMEOUT_MS = 45_000;

let config = {};
let available = null;

function have(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function init(options = {}) {
  config = {
    bin: options.bin || process.env.JARVIS_AGY_BIN || 'agy',
    model: options.model || process.env.JARVIS_AGY_MODEL || '',
    cwd: options.cwd || process.cwd(),
    timeoutMs: Number(options.timeoutMs || process.env.JARVIS_ASK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    // Unattended by necessity: nobody can approve a tool call from a stage.
    skipPermissions: options.skipPermissions !== false,
  };

  available = have(config.bin);

  if (available) {
    log.good('ask ready', { via: config.bin, model: config.model || 'default' });
  } else {
    // Not a failure. Everything else works; only free-form questions do not.
    log.info('no agy on this machine — spoken commands still work, free-form questions will not', {
      looked_for: config.bin,
    });
  }

  return describe();
}

function describe() {
  return {
    available: Boolean(available),
    bin: config.bin,
    model: config.model || null,
    timeoutMs: config.timeoutMs,
  };
}

/**
 * Build the command.
 *
 * A plain spawn with an argument array. An earlier version wrapped this in `script` to
 * allocate a pseudo-terminal, on the theory that agy swallows stdout when it is not a
 * terminal. Measured against 1.1.22 it does not: a plain spawn returns clean output in
 * about six seconds, while the pty wrapper injected control characters and hung. The
 * workaround was worse than the problem it guarded against, so it is gone.
 *
 * No shell is involved, which matters more than usual here: the prompt came from a
 * microphone and is entirely arbitrary text.
 */
function buildCommand(prompt) {
  const args = ['-p', prompt];
  if (config.model) args.push('--model', config.model);
  if (config.skipPermissions) args.push('--dangerously-skip-permissions');
  return { command: config.bin, args };
}

/**
 * Put a question to the model.
 *
 * Never throws. A question that fails should leave the operator with a sentence explaining
 * why, not an exception mid-demo.
 */
function ask(text) {
  const prompt = String(text || '').trim();

  if (!prompt) return Promise.resolve({ ok: false, error: 'empty' });
  if (!available) {
    return Promise.resolve({
      ok: false,
      error: 'agy_not_installed',
      detail: `No "${config.bin}" on this machine. Spoken commands still work; free-form questions need Antigravity.`,
    });
  }

  const { command, args } = buildCommand(prompt);
  const startedAt = Date.now();

  log.info('ASK', { prompt: prompt.slice(0, 120) });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: config.cwd, // so .agents/AGENTS.md is picked up as the persona
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
      });
    } catch (err) {
      return resolve({ ok: false, error: 'spawn_failed', detail: err.message });
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 64_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += chunk;
    });

    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve({ ...result, ms: Date.now() - startedAt });
    };

    const guard = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      log.warn('ask timed out', { after_ms: config.timeoutMs });
      done({ ok: false, error: 'timeout', detail: `No answer within ${config.timeoutMs}ms.` });
    }, config.timeoutMs);
    guard.unref();

    child.on('error', (err) => done({ ok: false, error: 'spawn_failed', detail: err.message }));

    child.on('exit', (code) => {
      const answer = clean(stdout);

      if (code !== 0) {
        const detail = clean(stderr).split('\n').filter(Boolean).pop() || `exit ${code}`;
        log.error('ask failed', { exit: code, said: detail.slice(0, 160) });
        return done({ ok: false, error: 'agy_failed', detail: detail.slice(0, 300) });
      }

      // Empty output on a clean exit is not a failure — see the note at the top. Whatever tools
      // the model called have already run, so the room has already responded.
      if (!answer) {
        log.info('ask completed with no text', { note: 'any tool calls still ran' });
        return done({ ok: true, answer: '', silent: true });
      }

      log.good('ask answered', { chars: answer.length });
      done({ ok: true, answer });
    });
  });
}

/** Strip terminal control sequences, in case a build of agy emits them. */
function clean(text) {
  return String(text)
    .replace(new RegExp('\\x1b\\[[0-9;?]*[a-zA-Z]', 'g'), '')
    .replace(new RegExp('\\x1b\\][^\\x07]*\\x07', 'g'), '')
    .replace(/\r/g, '')
    .trim();
}

module.exports = { init, ask, describe, DEFAULT_TIMEOUT_MS };
