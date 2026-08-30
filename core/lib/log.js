'use strict';

/**
 * Activity log.
 *
 * Serves two readers with different needs. The operator's terminal wants the aligned,
 * scannable format from SPEC.md §34; the Command Wall wants structured records it can
 * render as a scrolling activity panel (§18). Both come from the same call so they can
 * never disagree about what happened.
 *
 * Kept in memory as a ring buffer. Nothing here is a durability mechanism — it is a
 * record of one demo, and one demo fits comfortably in RAM.
 */

const MAX_ENTRIES = 500;

/**
 * Suppress the terminal half of the log.
 *
 * The scripts that borrow Core's modules — voice auditions, the cache warmer — want their
 * own output, not Core's startup chatter interleaved with it. Listeners still fire, so
 * nothing that reads the log loses anything.
 */
const QUIET = process.env.JARVIS_QUIET === '1';

const entries = [];
const listeners = new Set();

let sequence = 0;

/** ANSI colour, suppressed when stdout is not a terminal so piped logs stay clean. */
const useColour = process.stdout.isTTY;
const paint = (code, text) => (useColour ? `\x1b[${code}m${text}\x1b[0m` : text);

const LEVEL_STYLE = {
  info: (t) => t,
  good: (t) => paint('32', t),
  warn: (t) => paint('33', t),
  error: (t) => paint('31', t),
  deny: (t) => paint('35', t),
};

/** HH:MM:SS in local time, matching the sample log in §34. */
function clock(at) {
  return new Date(at).toTimeString().slice(0, 8);
}

/**
 * Record one event.
 *
 * `fields` is free-form and ends up on the wall verbatim, so keep keys stable:
 * commandId, source, target, action, status, ms, error.
 */
function record(level, message, fields = {}) {
  // Caller fields first, so a field named `at` or `level` cannot overwrite the entry's own.
  // It has happened: a log call passing `at: <a url>` produced entries stamped "Invalid",
  // because the timestamp had been replaced by a string Date could not parse.
  const entry = {
    ...fields,
    seq: ++sequence,
    at: Date.now(),
    level,
    message,
  };

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  const style = LEVEL_STYLE[level] || LEVEL_STYLE.info;
  const detail = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

  if (!QUIET) {
    process.stdout.write(
      `${paint('90', clock(entry.at))} ${style(message)}${detail ? ' ' + paint('90', detail) : ''}\n`
    );
  }

  // Listeners are the wall's SSE connections. One slow or broken client must not be able
  // to take down the log, so each is isolated.
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      listeners.delete(listener);
    }
  }

  return entry;
}

const info = (message, fields) => record('info', message, fields);
const good = (message, fields) => record('good', message, fields);
const warn = (message, fields) => record('warn', message, fields);
const error = (message, fields) => record('error', message, fields);

/**
 * A refused action. Separate from warn() because SPEC.md §28 requires every remote
 * action to be logged, and a denial is the one an operator most needs to spot in a
 * scrolling panel — it means someone asked for something the allowlist rejected.
 */
const deny = (message, fields) => record('deny', message, fields);

/** Most recent entries, oldest first. The wall replays these when it connects. */
function recent(limit = 60) {
  return entries.slice(-limit);
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = { record, info, good, warn, error, deny, recent, subscribe };
