'use strict';

/**
 * The bridge from a spoken sentence to the model.
 *
 *   mic  →  transcript  →  intents miss  →  agy  →  MCP tools  →  the room
 *
 * This is what makes "Jarvis, which one is Ravi's, and put Chrome on it" work. Core matches
 * the fixed demo commands itself and answers them instantly; anything it does not recognise
 * comes here, where a model can actually reason about it.
 *
 * **agy is kept running.** This used to spawn `agy -p "..."` per question, and almost all of
 * that was waste. Measured on 1.1.22:
 *
 *   agy -p "reply: ready"                  8.30s wall clock
 *   the model turn inside it               1.30s
 *
 * Seven seconds of every question was process startup, config load, and MCP connection —
 * paid again for the next sentence. Feeding NDJSON to one long-lived process instead:
 *
 *   process ready                          4998ms   ← once, at boot
 *   turn 1                                 +1419ms
 *   turn 2                                 +1214ms
 *   turn 3                                 +1415ms
 *
 * So the startup happens while somebody is still plugging in the projector, and each
 * question afterwards costs about what the model actually takes.
 *
 * The cost of that choice is state: it is one conversation, so turns accumulate context.
 * Useful — "and put Chrome on it" can refer to the last answer — but it grows, so there is
 * a turn limit after which the process is recycled.
 *
 * **Its output is not really the point.** The model's effect on the room is the MCP tool
 * calls it makes, and JARVIS speaking is one of them — the audio comes out of Core, not out
 * of agy's stdout. So an empty answer on a clean turn is "worked, said nothing", not
 * failure.
 */

const { spawn, spawnSync } = require('child_process');

const log = require('./log');

/**
 * How long one turn gets.
 *
 * Generous, because a real question may involve several tool calls. Core shows that it is
 * thinking, and the fixed commands never come this way.
 */
const DEFAULT_TIMEOUT_MS = 45_000;

/** How long to wait for the process to announce itself before giving up on it. */
const READY_TIMEOUT_MS = 30_000;

/**
 * Turns before the conversation is recycled.
 *
 * Every turn stays in context, so a long session gets slower and more expensive with no
 * benefit to a demo that lasts twenty minutes. Recycling costs one startup, and it happens
 * between questions rather than during one.
 */
const MAX_TURNS = 40;

let config = {};
let available = null;

let child = null;
let ready = false;
let starting = null;
let pending = null;
let stdoutBuffer = '';
let turns = 0;
let restarts = 0;

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
    // low | medium | high. Lower is quicker; the room commands do not need deliberation.
    effort: options.effort || process.env.JARVIS_AGY_EFFORT || '',
  };

  available = have(config.bin);

  if (!available) {
    // Not a failure. Everything else works; only free-form questions do not.
    log.info('no agy on this machine — spoken commands still work, free-form questions will not', {
      looked_for: config.bin,
    });
    return describe();
  }

  log.good('ask ready', { via: config.bin, model: config.model || 'default' });
  return describe();
}

function describe() {
  return {
    available: Boolean(available),
    bin: config.bin,
    model: config.model || null,
    timeoutMs: config.timeoutMs,
    // Whether the expensive startup has already been paid.
    warm: ready,
    turns,
  };
}

/**
 * The arguments that keep one process serving many turns.
 *
 * `-p=` rather than `-p`: the flag insists on a value, and its value here is nothing,
 * because the prompts arrive on stdin instead. Written any other way, agy takes the next
 * flag as the prompt and refuses to start.
 */
function buildArgs() {
  const args = [
    '-p=',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
  ];
  if (config.model) args.push('--model', config.model);
  if (config.effort) args.push('--effort', config.effort);
  if (config.skipPermissions) args.push('--dangerously-skip-permissions');
  return args;
}

/* ------------------------------------------------------------------------------------
 * The process
 * --------------------------------------------------------------------------------- */

/**
 * Start it, and resolve once it says it is ready.
 *
 * Called at boot so the startup cost lands during setup rather than in front of an
 * audience. Safe to call again; a start already in progress is shared rather than doubled.
 */
function warm() {
  if (!available) return Promise.resolve({ ok: false, error: 'agy_not_installed' });
  if (ready) return Promise.resolve({ ok: true, alreadyWarm: true });
  if (starting) return starting;

  starting = new Promise((resolve) => {
    const startedAt = Date.now();

    let mine;
    try {
      mine = spawn(config.bin, buildArgs(), {
        cwd: config.cwd, // so .agents/AGENTS.md is picked up as the persona
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
      });
    } catch (err) {
      starting = null;
      return resolve({ ok: false, error: 'spawn_failed', detail: err.message });
    }
    child = mine;

    /**
     * Is this handler still speaking for the live process?
     *
     * A killed process reports its exit asynchronously, by which time a replacement may
     * already be running. Without this, the dead one's exit handler tears down its
     * successor — which looks like agy working once and then never again.
     */
    const current = () => child === mine;

    stdoutBuffer = '';
    turns = 0;

    const guard = setTimeout(() => {
      log.warn('agy did not become ready; questions will be slow', { after_ms: READY_TIMEOUT_MS });
      stop();
      starting = null;
      resolve({ ok: false, error: 'never_ready' });
    }, READY_TIMEOUT_MS);
    guard.unref();

    const settleReady = () => {
      clearTimeout(guard);
      ready = true;
      starting = null;
      log.good('agy warm', {
        ms: Date.now() - startedAt,
        note: 'this cost is now paid; questions no longer wait for it',
      });
      resolve({ ok: true, ms: Date.now() - startedAt });
    };

    mine.stdout.on('data', (chunk) => {
      if (current()) onStdout(chunk, settleReady);
    });

    mine.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text && current()) log.warn('agy said', { text: text.slice(0, 200) });
    });

    mine.on('error', (err) => {
      if (!current()) return;
      clearTimeout(guard);
      failPending({ ok: false, error: 'spawn_failed', detail: err.message });
      teardown();
      starting = null;
      resolve({ ok: false, error: 'spawn_failed', detail: err.message });
    });

    mine.on('exit', (code) => {
      if (!current()) return; // superseded; its replacement is the live one
      clearTimeout(guard);
      const wasReady = ready;
      failPending({ ok: false, error: 'agy_exited', detail: `agy exited (${code})` });
      teardown();
      // Only worth saying if it had been working; a failure to start is already reported.
      if (wasReady) log.warn('agy exited; it will be restarted on the next question', { code });
      starting = null;
      resolve({ ok: false, error: 'agy_exited' });
    });
  });

  return starting;
}

function teardown() {
  child = null;
  ready = false;
  stdoutBuffer = '';
}

function failPending(result) {
  if (!pending) return;
  const settle = pending;
  pending = null;
  clearTimeout(settle.guard);
  settle.resolve({ ...result, ms: Date.now() - settle.startedAt });
}

/** NDJSON, one message per line. Partial lines are normal and are held over. */
function onStdout(chunk, settleReady) {
  stdoutBuffer += chunk;

  let newline;
  while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue; // not every line is ours to understand
    }

    if (message.event === 'init' && settleReady) settleReady();
    if (message.event === 'result') onResult(message.result || {});
  }
}

function onResult(result) {
  if (!pending) return;

  const settle = pending;
  pending = null;
  clearTimeout(settle.guard);

  turns += 1;
  const ms = Date.now() - settle.startedAt;

  if (result.status && result.status !== 'SUCCESS') {
    const detail = String(result.error || result.status).slice(0, 300);
    log.error('ask failed', { said: detail.slice(0, 160) });
    return settle.resolve({ ok: false, error: 'agy_failed', detail, ms });
  }

  const answer = clean(result.response || '');

  if (!answer) {
    // Not a failure — see the note at the top. Whatever tools the model called have already
    // run, so the room has already responded.
    log.info('ask completed with no text', { note: 'any tool calls still ran' });
    return settle.resolve({ ok: true, answer: '', silent: true, ms });
  }

  log.good('ask answered', { chars: answer.length, ms });
  settle.resolve({ ok: true, answer, ms });
}

/* ------------------------------------------------------------------------------------
 * Asking
 * --------------------------------------------------------------------------------- */

/**
 * Put a question to the model.
 *
 * Never throws. A question that fails should leave the operator with a sentence explaining
 * why, not an exception mid-demo.
 */
async function ask(text) {
  const prompt = String(text || '').trim();

  if (!prompt) return { ok: false, error: 'empty' };
  if (!available) {
    return {
      ok: false,
      error: 'agy_not_installed',
      detail: `No "${config.bin}" on this machine. Spoken commands still work; free-form questions need Antigravity.`,
    };
  }

  // One at a time. Core already guards this, but a second question arriving here would
  // otherwise be answered with the first one's result — the replies are not tagged.
  if (pending) return { ok: false, error: 'busy' };

  // Between questions, never during one.
  if (ready && turns >= MAX_TURNS) {
    log.info('recycling the agy conversation', { after_turns: turns });
    stop();
  }

  if (!ready) {
    const started = await warm();
    if (!started.ok) {
      return {
        ok: false,
        error: started.error || 'agy_unavailable',
        detail: started.detail || 'agy could not be started.',
      };
    }
  }

  log.info('ASK', { prompt: prompt.slice(0, 120) });

  return new Promise((resolve) => {
    const startedAt = Date.now();

    const guard = setTimeout(() => {
      log.warn('ask timed out', { after_ms: config.timeoutMs });
      // A turn cannot be cancelled, so the process is no longer in a known state. Dropping
      // it is the only way back to one; the next question pays a restart.
      failPending({ ok: false, error: 'timeout', detail: `No answer within ${config.timeoutMs}ms.` });
      stop();
    }, config.timeoutMs);
    guard.unref();

    pending = { resolve, guard, startedAt };

    const message = JSON.stringify({
      event: 'user',
      message: { role: 'user', content: prompt },
    });

    try {
      child.stdin.write(message + '\n');
    } catch (err) {
      failPending({ ok: false, error: 'write_failed', detail: err.message });
      stop();
    }
  });
}

/** Stop the process. It does not exit when stdin closes, so it is signalled. */
function stop() {
  // Cleared even with no process: a start still in flight must not be handed to the next
  // caller of warm(), which would return "ready" for a process that was just discarded.
  starting = null;
  if (!child) return;
  const doomed = child;
  teardown();
  try {
    doomed.stdin.end();
  } catch {
    /* already gone */
  }
  try {
    doomed.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  restarts += 1;
}

/** Strip terminal control sequences, in case a build of agy emits them. */
function clean(text) {
  return String(text)
    .replace(new RegExp('\\x1b\\[[0-9;?]*[a-zA-Z]', 'g'), '')
    .replace(new RegExp('\\x1b\\][^\\x07]*\\x07', 'g'), '')
    .replace(/\r/g, '')
    .trim();
}

module.exports = { init, warm, ask, stop, describe, DEFAULT_TIMEOUT_MS, MAX_TURNS };
