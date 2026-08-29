'use strict';

/**
 * Who JARVIS is.
 *
 * `config/personality.md` is a plain markdown file the operator edits — it is the system
 * prompt for whatever model is driving the room. Keeping it as a file rather than a string
 * in code means it can be rewritten between rehearsals without touching anything else, and
 * reloaded without restarting Core.
 *
 * Two files, not one:
 *
 *   personality.md   who JARVIS is — the character, and how it speaks
 *   memory.md        what JARVIS knows — this room, these people, this run of show
 *
 * Kept apart because they change for different reasons and on different timescales. The
 * character is written once and tuned rarely; the facts change every time the demo is set
 * up somewhere new. Merging them would mean rewriting the character to correct a hostname.
 *
 * Core does not interpret either. It loads them and serves the pair, so there is exactly
 * one copy of each and no chance of what is on disk disagreeing with what the model runs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const log = require('./log');

const MAX_BYTES = 64 * 1024;

let state = {
  loaded: false,
  path: null,
  name: 'JARVIS',
  description: 'Control intelligence for an authorized device demonstration.',
  body: '',
  digest: null,
  loadedAt: null,
};

/**
 * Split optional YAML frontmatter off the top.
 *
 * A deliberately small parser: `key: value` pairs only, because the only fields that mean
 * anything here are name and description, and pulling in a YAML library for two strings
 * would add a dependency to a Core that has none by design.
 */
function splitFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { meta: {}, body: source.trim() };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!pair) continue;
    meta[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: match[2].trim() };
}

/** Read a markdown file, returning '' if it is not there. Absent is normal for memory. */
function readIfPresent(filePath) {
  try {
    return fs.readFileSync(path.resolve(filePath), 'utf8');
  } catch {
    return '';
  }
}

function load(filePath, memoryPath) {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    // Not fatal. A room with no personality file still works — the model simply falls back
    // to whatever instructions its client gives it — and refusing to boot over a missing
    // markdown file would be absurd.
    log.warn('no personality file; JARVIS will use its client default', { path: resolved });
    state = { ...state, loaded: false, path: resolved, body: '', digest: null };
    return summary();
  }

  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    log.error('could not read personality file', { path: resolved, error: err.message });
    return summary();
  }

  if (Buffer.byteLength(raw) > MAX_BYTES) {
    log.warn('personality file is very large; truncating', { bytes: Buffer.byteLength(raw) });
    raw = raw.slice(0, MAX_BYTES);
  }

  const { meta, body } = splitFrontmatter(raw);

  // Memory is optional and separate. A missing file is normal — a room that has not been
  // described yet still runs, JARVIS simply knows nothing specific about it.
  const memoryFile = memoryPath ? path.resolve(memoryPath) : null;
  const memoryRaw = memoryFile ? readIfPresent(memoryFile) : '';
  const memory = memoryRaw ? splitFrontmatter(memoryRaw).body : '';

  state = {
    loaded: true,
    path: resolved,
    memoryPath: memoryFile,
    name: meta.name || 'JARVIS',
    description: meta.description || 'Control intelligence for an authorized device demonstration.',
    body,
    memory,
    // Covers both files, so editing either one is visibly a different personality.
    digest: crypto.createHash('sha256').update(body + memory).digest('hex').slice(0, 12),
    loadedAt: Date.now(),
  };

  log.good('personality loaded', {
    name: state.name,
    words: body.split(/\s+/).filter(Boolean).length,
    memory: memory ? `${memory.split(/\s+/).filter(Boolean).length} words` : 'none',
    digest: state.digest,
  });

  return summary();
}

/**
 * Append something JARVIS was told to remember.
 *
 * Written at the end of memory.md under its own heading, so it is obvious later which lines
 * a human wrote and which the model added, and so clearing what it picked up between runs
 * is a matter of deleting one section.
 *
 * Newlines are flattened out of the note. A multi-line entry would break the one-fact-per-
 * bullet shape that makes the file readable, and this is a notebook rather than a
 * transcript.
 */
function remember(text) {
  if (!state.memoryPath) return { ok: false, error: 'no_memory_file' };

  const line = String(text || '').replace(/[\r\n]+/g, ' ').trim();
  if (!line) return { ok: false, error: 'empty' };

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  try {
    fs.appendFileSync(state.memoryPath, `\n- ${line}  <!-- ${stamp} -->\n`);
  } catch (err) {
    log.error('could not write to memory', { error: err.message });
    return { ok: false, error: err.message };
  }

  log.good('remembered', { note: line.slice(0, 80) });
  return { ok: true, remembered: line };
}

/** Metadata only. Safe for the wall and the health check. */
function summary() {
  return {
    loaded: state.loaded,
    name: state.name,
    description: state.description,
    digest: state.digest,
    words: state.body ? state.body.split(/\s+/).filter(Boolean).length : 0,
    memoryWords: state.memory ? state.memory.split(/\s+/).filter(Boolean).length : 0,
    hasMemory: Boolean(state.memory),
    loadedAt: state.loadedAt,
  };
}

/**
 * The whole thing, for the MCP server and the Antigravity installer.
 *
 * `body` is the two files joined, because that is what a model needs to receive — character
 * and facts as one instruction. They are also returned separately for anything that wants
 * to show or edit one of them.
 */
function get() {
  const combined = state.memory
    ? `${state.body}\n\n---\n\n# What you know about this room\n\n${state.memory}`
    : state.body;

  return { ...summary(), body: combined, personality: state.body, memory: state.memory };
}

module.exports = { load, get, remember, summary, splitFrontmatter };
