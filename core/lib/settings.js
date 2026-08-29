'use strict';

/**
 * Where every secret and setting comes from.
 *
 * One file: `.env`. That is the whole story, and this module exists so that it stays the
 * whole story — Core, the setup script, the health check, the MCP installer and the
 * simulator all resolve settings through here rather than each reaching for a file and
 * quietly disagreeing about which one won.
 *
 * `core/config/core.json` is still read if it happens to exist, because an earlier setup
 * put secrets there and silently ignoring it would lock someone out of their own room.
 * The environment wins over it. Nothing needs it and nothing creates it any more.
 */

const fs = require('fs');
const path = require('path');

const env = require('./env');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** Read the legacy JSON file, if there is one. Absent is the normal case. */
function legacy(configPath) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve everything.
 *
 * `envFile` is loaded into process.env first, so an already-exported variable still wins
 * over the file — deliberate beats forgotten.
 */
function load(options = {}) {
  const envPath = options.env || path.join(REPO_ROOT, '.env');
  const jsonPath = options.config || path.join(REPO_ROOT, 'core', 'config', 'core.json');

  const envResult = env.load(envPath);
  const file = legacy(jsonPath);

  const pick = (envKeys, fromFile) => {
    for (const key of envKeys) {
      const value = process.env[key];
      if (value !== undefined && value !== '') return value;
    }
    return fromFile;
  };

  const admin = pick(
    ['JARVIS_ADMIN_PASSWORD', 'JARVIS_ADMIN_TOKEN'],
    file && file.admin ? file.admin.token : undefined
  );

  const join = pick(
    ['JARVIS_JOIN_SECRET', 'JARVIS_JOIN_PASSWORD'],
    file && file.join ? file.join.secret : undefined
  );

  const wifi = {
    ssid: pick(['JARVIS_SSID'], file && file.wifi ? file.wifi.ssid : undefined) || 'JARVIS-NET',
    passphrase: pick(
      ['JARVIS_WIFI_PASSWORD', 'JARVIS_WIFI_PASSPHRASE'],
      file && file.wifi ? file.wifi.passphrase : undefined
    ),
  };

  return {
    admin,
    join,
    wifi,
    // Voice settings resolve their own environment inside lib/voice.js, so anything here is
    // only what a legacy file supplied.
    voice: (file && file.voice) || {},
    sources: {
      env: envResult.loaded ? envResult.path : null,
      legacy: file ? jsonPath : null,
    },
  };
}

/**
 * Check what is loaded, without deciding what to do about it.
 *
 * Returns a list of problems as plain sentences. Callers decide whether a problem is fatal
 * — Core refuses to start, the setup script offers to fix it — but the wording is written
 * once so both say the same thing.
 */
function problems(settings) {
  const found = [];

  if (!settings.admin) {
    found.push('JARVIS_ADMIN_PASSWORD is not set — this is the password you type to control the room');
  } else if (settings.admin.startsWith('CHANGE-ME')) {
    found.push('JARVIS_ADMIN_PASSWORD is still the placeholder');
  } else if (settings.admin !== settings.admin.trim()) {
    // The Authorization header is trimmed before comparison, so a password with edge
    // whitespace can never be entered. Better to refuse than to lock someone out.
    found.push('JARVIS_ADMIN_PASSWORD has leading or trailing spaces and could never be typed');
  }

  if (!settings.join) {
    found.push('JARVIS_JOIN_SECRET is not set — this is what lets a device join');
  } else if (settings.join.startsWith('CHANGE-ME')) {
    found.push('JARVIS_JOIN_SECRET is still the placeholder');
  }

  // The join secret is handed out inside every teammate's script. If it were also the admin
  // password, every teammate would hold the key to every laptop.
  if (settings.admin && settings.join && settings.admin === settings.join) {
    found.push('JARVIS_ADMIN_PASSWORD and JARVIS_JOIN_SECRET must be different');
  }

  if (settings.wifi.passphrase && settings.wifi.passphrase.length < 8) {
    found.push('JARVIS_WIFI_PASSWORD must be at least 8 characters (WPA2 minimum)');
  }

  return found;
}

module.exports = { load, problems, REPO_ROOT };

/**
 * Also a tiny CLI, so the shell scripts do not each reimplement resolution:
 *
 *   node core/lib/settings.js admin
 *   node core/lib/settings.js join
 *   node core/lib/settings.js wifi.passphrase
 *   node core/lib/settings.js --check      # exit 1 and print problems
 *
 * Prints nothing and exits 1 when a field is missing, so `[ -z "$x" ]` in a caller means
 * exactly what it looks like.
 */
if (require.main === module) {
  const what = process.argv[2];
  const resolved = load();

  if (what === '--check') {
    const found = problems(resolved);
    for (const line of found) process.stderr.write(`${line}\n`);
    process.exit(found.length ? 1 : 0);
  }

  if (what === '--json') {
    process.stdout.write(JSON.stringify(resolved, null, 2) + '\n');
    process.exit(0);
  }

  const value = String(what || '')
    .split('.')
    .reduce((node, key) => (node && node[key] !== undefined ? node[key] : undefined), resolved);

  if (value === undefined || value === null || value === '') process.exit(1);
  process.stdout.write(String(value));
}
