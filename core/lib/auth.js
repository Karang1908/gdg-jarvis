'use strict';

/**
 * Trust boundary.
 *
 * SPEC.md §1 is the whole point of this file: joining the Wi-Fi grants nothing. Control
 * requires a per-node token issued out of band. Three trust levels exist (§27) — device
 * agents, the controller, and the MCP server — and the last two share the admin token.
 *
 * Browsers complicate this, because EventSource cannot set an Authorization header. The
 * naive fix is a token in the query string, which then lives in browser history and in
 * every access log on the path. Instead Core mints short-lived, single-use, scoped
 * tickets; see DEVIATIONS.md D7.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const log = require('./log');

const TICKET_TTL_MS = 60_000;
const TICKET_SWEEP_MS = 30_000;

let config = null;

/** Live tickets, keyed by ticket string. */
const tickets = new Map();

/**
 * Constant-time token comparison.
 *
 * timingSafeEqual throws on a length mismatch, which would itself leak length. Hashing
 * both sides first gives fixed-width inputs, so the comparison is uniform regardless of
 * what was submitted.
 */
function tokensMatch(submitted, expected) {
  if (typeof submitted !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(submitted).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Load nodes.json, refusing to start on anything that would silently weaken the demo.
 *
 * Failing loudly here is deliberate. A Core that boots with placeholder tokens is worse
 * than one that refuses to boot, because the failure would surface in front of an
 * audience instead of at setup time.
 */
function load(configPath) {
  const resolved = path.resolve(configPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `No node registry at ${resolved}\n` +
        `  Copy core/config/nodes.example.json to core/config/nodes.json and set real tokens.\n` +
        `  scripts/setup-kali.sh can generate them for you.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`Node registry at ${resolved} is not valid JSON: ${err.message}`);
  }

  if (!parsed.admin || typeof parsed.admin.token !== 'string') {
    throw new Error(`Node registry at ${resolved} has no admin.token`);
  }
  if (!parsed.nodes || Object.keys(parsed.nodes).length === 0) {
    throw new Error(`Node registry at ${resolved} defines no nodes`);
  }

  const placeholders = [];
  if (parsed.admin.token.startsWith('CHANGE-ME')) placeholders.push('admin');
  for (const [id, node] of Object.entries(parsed.nodes)) {
    if (typeof node.token !== 'string' || node.token.length === 0) {
      throw new Error(`Node ${id} has no token`);
    }
    if (node.token.startsWith('CHANGE-ME')) placeholders.push(id);
  }
  if (placeholders.length) {
    throw new Error(
      `Placeholder tokens still present for: ${placeholders.join(', ')}\n` +
        `  Run scripts/setup-kali.sh to generate a registry with real tokens.`
    );
  }

  // Two nodes sharing a token would make the activity log a work of fiction: commands
  // would be attributable to either machine. Catch it at load rather than at 2am.
  const seen = new Map();
  for (const [id, node] of Object.entries(parsed.nodes)) {
    if (seen.has(node.token)) {
      throw new Error(`Nodes ${seen.get(node.token)} and ${id} share a token`);
    }
    seen.set(node.token, id);
  }

  config = parsed;
  return {
    nodeIds: Object.keys(parsed.nodes),
    nodes: parsed.nodes,
  };
}

function nodeConfig(nodeId) {
  if (!config) return null;
  return config.nodes[nodeId] || null;
}

function nodeIds() {
  return config ? Object.keys(config.nodes) : [];
}

/**
 * Authenticate an agent. Returns a reason string on failure, per PROTOCOL.md §3.
 *
 * An unknown node and a bad token are reported distinctly because the operator needs to
 * tell a typo'd node name from a stale token while setting up four laptops. Both are
 * logged with the source address, and neither reveals anything an attacker on the
 * network could not already learn by trying.
 */
function authenticateNode(nodeId, token, remoteAddress) {
  const node = nodeConfig(nodeId);

  if (!node) {
    log.deny('register refused', { node: nodeId, reason: 'unknown_node', from: remoteAddress });
    return { ok: false, reason: 'unknown_node' };
  }
  if (node.disabled) {
    log.deny('register refused', { node: nodeId, reason: 'node_disabled', from: remoteAddress });
    return { ok: false, reason: 'node_disabled' };
  }
  if (!tokensMatch(token, node.token)) {
    log.deny('register refused', { node: nodeId, reason: 'bad_token', from: remoteAddress });
    return { ok: false, reason: 'bad_token' };
  }

  return { ok: true, node };
}

/** Authenticate a controller or the MCP server from an Authorization header. */
function authenticateAdmin(headerValue) {
  if (!config) return false;
  if (typeof headerValue !== 'string') return false;

  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) return false;

  return tokensMatch(match[1], config.admin.token);
}

/**
 * Mint a scoped, single-use ticket.
 *
 * `scope` is 'observer' (read-only state and activity) or 'overlay' (one node's scene
 * stream). An overlay ticket names its node, so a teammate who copies the URL out of
 * their own browser gains access to nothing but their own screen.
 */
function issueTicket(scope, nodeId = null) {
  const ticket = crypto.randomBytes(16).toString('hex');
  tickets.set(ticket, {
    scope,
    nodeId,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return { ticket, expiresIn: TICKET_TTL_MS / 1000 };
}

/**
 * Redeem a ticket.
 *
 * Single-use: redeeming removes it. A dropped SSE connection therefore needs a fresh
 * ticket, which the browser clients handle by re-authenticating. That is the right
 * trade — a ticket replayable for its full minute is a ticket worth stealing.
 */
function redeemTicket(ticket, requiredScope, requiredNode = null) {
  const record = tickets.get(ticket);
  if (!record) return { ok: false, reason: 'unknown_ticket' };

  tickets.delete(ticket);

  if (record.expiresAt < Date.now()) return { ok: false, reason: 'expired_ticket' };
  if (record.scope !== requiredScope) return { ok: false, reason: 'wrong_scope' };
  if (requiredNode && record.nodeId !== requiredNode) return { ok: false, reason: 'wrong_node' };

  return { ok: true, scope: record.scope, nodeId: record.nodeId };
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
  nodeConfig,
  nodeIds,
  authenticateNode,
  authenticateAdmin,
  issueTicket,
  redeemTicket,
  TICKET_TTL_MS,
};
