'use strict';

/**
 * Read a `.env` file into the environment.
 *
 * Twenty lines rather than a dependency, because Core has none by design — during the demo
 * the machine running it has no internet, and a Core that cannot start because a package
 * was never fetched is the failure this whole project keeps designing around.
 *
 * Existing environment variables always win. Something exported in the shell is more
 * deliberate than something left in a file weeks ago, and silently overriding it would be
 * a genuinely confusing thing to debug at a venue.
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse `.env` text.
 *
 * Deliberately small: `KEY=value`, `#` comments, `export KEY=value` because people paste
 * that out of habit, and quoted values because an API key is fine bare but a style prompt
 * has spaces in it. No variable interpolation and no multi-line values — the moment a
 * config format needs a parser with a state machine, it should have been JSON.
 */
function parse(text) {
  const out = {};

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    let value = match[2].trim();

    // Strip one matching pair of quotes, and only then drop a trailing comment — otherwise
    // a `#` inside a quoted style prompt would truncate it.
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2];
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    out[match[1]] = value;
  }

  return out;
}

/**
 * Load a `.env` file if there is one.
 *
 * Missing is normal and silent — plenty of setups export their variables in the shell
 * instead, and warning about it every boot would be noise.
 */
function load(filePath) {
  const resolved = path.resolve(filePath);

  let text;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch {
    return { loaded: false, path: resolved, keys: [] };
  }

  const values = parse(text);
  const applied = [];

  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied.push(key);
  }

  return {
    loaded: true,
    path: resolved,
    keys: applied,
    skipped: Object.keys(values).filter((key) => !applied.includes(key)),
  };
}

module.exports = { load, parse };
