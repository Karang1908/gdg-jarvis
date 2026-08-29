'use strict';

/**
 * Trust boundary.
 *
 * Three secrets, three jobs:
 *
 *   join secret   any device that presents it may enroll. Handed out inside the join
 *                 script, so a teammate types nothing at all.
 *   admin token   controls the room. The controller and the MCP server hold it.
 *   session token issued per device at enrollment, valid until it disconnects.
 *
 * Both come from `.env`, resolved by lib/settings.js. There is one file to edit and no
 * generated JSON to keep in step with it.
 *
 * SPEC.md §8 assumed a fixed roster with a pre-shared token per node. That is abandoned
 * deliberately — the room has to accept any number of devices, arriving in any order, with
 * nobody editing a config file (see DEVIATIONS.md D8). What survives is the part that
 * matters: joining the Wi-Fi still grants nothing on its own, and controlling *other*
 * people's machines still needs the admin password, which is never handed out.
 *
 * The worst a leaked join secret buys is the ability to put JARVIS on your own screen.
 */

const crypto = require('crypto');

const log = require('./log');
const settings = require('./settings');

const TICKET_TTL_MS = 60_000;
const TICKET_SWEEP_MS = 30_000;

let config = null;

const tickets = new Map();

/**
 * Constant-time comparison.
 *
 * timingSafeEqual throws on a length mismatch, which would itself leak length. Hashing
 * both sides first gives fixed-width inputs, so the comparison is uniform regardless of
 * what was submitted.
 */
function secretsMatch(submitted, expected) {
  if (typeof submitted !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(submitted).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Load configuration, refusing to start on anything that would silently weaken the demo.
 *
 * Failing loudly here is deliberate. A Core that boots with placeholder secrets fails in
 * front of an audience instead of at setup time.
 */
function load(options = {}) {
  const resolved = settings.load(options);
  const found = settings.problems(resolved);

  if (found.length) {
    throw new Error(
      `Configuration:\n  - ${found.join('\n  - ')}\n\n` +
        `  Everything lives in .env at the top of the repository.\n` +
        `  Copy .env.example to .env if you have not already, then edit it.`
    );
  }

  config = resolved;
  return config;
}

function adminToken() {
  return config ? config.admin : null;
}

function joinSecret() {
  return config ? config.join : null;
}

function wifi() {
  return (config && config.wifi) || { ssid: 'JARVIS-NET', passphrase: null };
}

/**
 * Authenticate a device that wants to enroll.
 *
 * Every rejection is logged with the source address. There is no per-device token to get
 * wrong any more, so a refusal here means either the wrong secret or a stale copy of the
 * join script from a previous run.
 */
function authenticateJoin(secret, remoteAddress) {
  if (!config) return { ok: false, reason: 'not_configured' };

  if (!secretsMatch(secret, config.join)) {
    log.deny('join refused', { reason: 'bad_secret', from: remoteAddress });
    return { ok: false, reason: 'bad_secret' };
  }
  return { ok: true };
}

/** Authenticate a controller or the MCP server from an Authorization header. */
function authenticateAdmin(headerValue) {
  if (!config) return false;
  if (typeof headerValue !== 'string') return false;

  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) return false;

  return secretsMatch(match[1], config.admin);
}

/**
 * Mint a scoped, single-use ticket.
 *
 * Browsers cannot set an Authorization header on an EventSource, and putting the admin
 * token in a query string would write it into history and into every access log on the
 * path. `scope` is 'observer' (read-only room state) or 'overlay' (one device's scenes).
 */
function issueTicket(scope, deviceId = null) {
  const ticket = crypto.randomBytes(16).toString('hex');
  tickets.set(ticket, { scope, deviceId, expiresAt: Date.now() + TICKET_TTL_MS });
  return { ticket, expiresIn: TICKET_TTL_MS / 1000 };
}

/**
 * Redeem a ticket. Single use: redeeming removes it.
 *
 * A dropped stream therefore needs a fresh ticket, which the browser clients handle by
 * re-authenticating or by using the replacement handed to them on connect. That is the
 * right trade — a ticket replayable for a full minute is a ticket worth stealing.
 */
function redeemTicket(ticket, requiredScope, requiredDevice = null) {
  const record = tickets.get(ticket);
  if (!record) return { ok: false, reason: 'unknown_ticket' };

  tickets.delete(ticket);

  if (record.expiresAt < Date.now()) return { ok: false, reason: 'expired_ticket' };
  if (record.scope !== requiredScope) return { ok: false, reason: 'wrong_scope' };
  if (requiredDevice !== null && String(record.deviceId) !== String(requiredDevice)) {
    return { ok: false, reason: 'wrong_device' };
  }

  return { ok: true, scope: record.scope, deviceId: record.deviceId };
}

/** Expired tickets are already useless; this just stops the map growing all evening. */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [ticket, record] of tickets) {
    if (record.expiresAt < now) tickets.delete(ticket);
  }
}, TICKET_SWEEP_MS);
sweeper.unref();

module.exports = {
  load,
  adminToken,
  joinSecret,
  wifi,
  authenticateJoin,
  authenticateAdmin,
  issueTicket,
  redeemTicket,
  TICKET_TTL_MS,
};
