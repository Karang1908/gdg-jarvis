'use strict';

/**
 * Input validation for every argument that reaches a node.
 *
 * This module is the reason SPEC.md §12's denylist holds. There is no action carrying a
 * command line, so the only way to reach a shell would be through an argument that gets
 * interpolated somewhere downstream. Two things prevent that: values are inert on the
 * wire (see lib/wire.js), and the values themselves are checked here before dispatch.
 *
 * The agents repeat these checks locally. Duplicating them is deliberate — the agent is
 * the process actually holding a shell, and it should not be safe only because Core
 * happened to be well behaved.
 */

const fs = require('fs');
const path = require('path');

/**
 * URL schemes. An allowlist, never a denylist.
 *
 * SPEC.md §28 names file: and javascript: as the ones to reject. Enumerating dangerous
 * schemes is a losing game — data:, blob:, vbscript:, intent:, and every app-registered
 * custom scheme on the machine would all need to be on that list, forever. Enumerating
 * the two safe ones is a game that stays won.
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

const MAX_URL_LENGTH = 2048;
const MAX_SPEECH_LENGTH = 240;
const MAX_HOSTNAME_LENGTH = 48;

/** Operating systems with an application-allowlist column in apps.json. */
const KNOWN_OS = new Set(['macos', 'windows', 'linux']);

/** C0 controls plus DEL. Stripped from anything headed for a speech synthesiser. */
const CONTROL_CHARS = new RegExp('[\\x00-\\x1F\\x7F]', 'g');

let apps = null;

function loadApps(configPath) {
  const resolved = path.resolve(configPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));

  // Strip the documentation keys so they cannot be requested as applications.
  apps = {};
  for (const [name, entry] of Object.entries(parsed)) {
    if (name.startsWith('_')) continue;
    apps[name] = entry;
  }
  return apps;
}

function appNames() {
  return apps ? Object.keys(apps) : [];
}

function appEntry(name) {
  return apps ? apps[name] || null : null;
}

/**
 * Validate a URL for open_url.
 *
 * Parsing with the URL constructor rather than a regex matters: it normalises the input
 * the same way the browser will, so what we approve is what actually gets opened. A
 * regex that approves the string while a parser resolves it differently is exactly how
 * scheme-confusion bugs happen.
 */
function checkUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'url_missing' };
  }
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'url_too_long' };
  }

  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'url_unparseable' };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: `scheme_not_allowed:${parsed.protocol.replace(':', '')}` };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: 'url_has_no_host' };
  }

  return { ok: true, value: parsed.href };
}

/**
 * Validate an application request against the allowlist (§13).
 *
 * Only the logical name travels to the agent. Core resolves the platform target purely
 * to report a useful label in the log; the agent holds its own mapping and looks the
 * name up again there.
 */
function checkApp(name, platform) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, reason: 'app_missing' };
  }

  const key = name.trim().toLowerCase();
  const entry = appEntry(key);

  if (!entry) {
    return { ok: false, reason: 'app_not_allowlisted' };
  }
  if (platform && !entry[platform]) {
    return { ok: false, reason: `app_unavailable_on:${platform}` };
  }

  return {
    ok: true,
    value: key,
    label: entry.label || key,
    target: platform ? entry[platform] : null,
  };
}

/**
 * Validate speech text (§31).
 *
 * Control characters are stripped rather than rejected: they would be invisible in the
 * controller's text box, so refusing the command would look like a bug to the operator.
 * Length is capped because the LLM occasionally wants to give a speech and the demo
 * wants a sentence.
 */
function checkSpeech(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'text_missing' };

  const cleaned = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();

  if (cleaned === '') return { ok: false, reason: 'text_empty' };
  if (cleaned.length > MAX_SPEECH_LENGTH) {
    return { ok: true, value: cleaned.slice(0, MAX_SPEECH_LENGTH), truncated: true };
  }
  return { ok: true, value: cleaned };
}

/** Validate a volume level. Clamped rather than rejected — the intent is unambiguous. */
function checkVolume(raw) {
  const level = Number(raw);
  if (!Number.isFinite(level)) return { ok: false, reason: 'volume_not_a_number' };
  return { ok: true, value: Math.max(0, Math.min(100, Math.round(level))) };
}

/**
 * Validate a hostname reported at enrollment.
 *
 * This string is displayed on the wall, on the controller, and read aloud, so it is
 * sanitised rather than rejected — a machine called "Ravi's MacBook (work)" is perfectly
 * ordinary and refusing it would strand a real laptop. Control characters go, length is
 * capped so one absurd hostname cannot break the wall's layout, and the result is only
 * ever inserted with textContent, never as markup.
 */
function checkHostname(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'hostname_missing' };

  const cleaned = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === '') return { ok: false, reason: 'hostname_empty' };

  return { ok: true, value: cleaned.slice(0, MAX_HOSTNAME_LENGTH) };
}

/**
 * Validate an operating system name against the ones we have backends for.
 *
 * Unknown values become 'unknown' rather than being refused: an OS we do not recognise
 * only means the device gets no application mappings, which its own capability list
 * already reflects.
 */
function checkOs(raw) {
  const os = String(raw || '').trim().toLowerCase();
  return KNOWN_OS.has(os) ? os : 'unknown';
}

/** Scene names the overlay actually implements (§20), plus the three it adds. */
const SCENES = new Set([
  'normal',
  'jarvis',
  'identify',
  'reactor',
  'red_alert',
  'blackout',
  'network',
  'gdg',
  'terminal',
  'takeover',
  'wall',
  'cascade',
]);

function checkScene(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'scene_missing' };
  const scene = raw.trim().toLowerCase();
  if (!SCENES.has(scene)) return { ok: false, reason: 'scene_unknown' };
  return { ok: true, value: scene };
}

module.exports = {
  loadApps,
  appNames,
  appEntry,
  checkUrl,
  checkApp,
  checkSpeech,
  checkVolume,
  checkHostname,
  checkOs,
  checkScene,
  SCENES,
  ALLOWED_SCHEMES,
  MAX_SPEECH_LENGTH,
  MAX_HOSTNAME_LENGTH,
  KNOWN_OS,
};
