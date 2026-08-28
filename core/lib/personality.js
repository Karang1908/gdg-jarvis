'use strict';

/**
 * Who JARVIS is.
 *
 * `config/personality.md` is a plain markdown file the operator edits — it is the system
 * prompt for whatever model is driving the room. Keeping it as a file rather than a string
 * in code means it can be rewritten between rehearsals without touching anything else, and
 * reloaded without restarting Core.
 *
 * Core does not interpret it. It loads it, and serves it to the MCP server and to
 * Antigravity's installer, so there is exactly one copy and no chance of the personality on
 * disk disagreeing with the one the model is actually running.
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

function load(filePath) {
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

  state = {
    loaded: true,
    path: resolved,
    name: meta.name || 'JARVIS',
    description: meta.description || 'Control intelligence for an authorized device demonstration.',
    body,
    digest: crypto.createHash('sha256').update(body).digest('hex').slice(0, 12),
    loadedAt: Date.now(),
  };

  log.good('personality loaded', {
    name: state.name,
    words: body.split(/\s+/).filter(Boolean).length,
    digest: state.digest,
  });

  return summary();
}

/** Metadata only. Safe for the wall and the health check. */
function summary() {
  return {
    loaded: state.loaded,
    name: state.name,
    description: state.description,
    digest: state.digest,
    words: state.body ? state.body.split(/\s+/).filter(Boolean).length : 0,
    loadedAt: state.loadedAt,
  };
}

/** The whole thing, for the MCP server and the Antigravity installer. */
function get() {
  return { ...summary(), body: state.body };
}

module.exports = { load, get, summary, splitFrontmatter };
