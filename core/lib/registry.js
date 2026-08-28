'use strict';

/**
 * The device registry — what SPEC.md §10 and §18 call the room's live state.
 *
 * Presence here is derived from the command stream itself, not from heartbeats. When an
 * agent's SSE connection drops, the node is offline that instant; there is no 15-second
 * window in which the wall shows a machine that is already gone. Heartbeats remain, but
 * as a backstop for the one case the socket cannot detect: a wedged client holding the
 * connection open while no longer executing anything.
 *
 * That inversion matters on stage. An operator who unplugs a laptop should see it leave
 * the wall before they finish looking up.
 */

const crypto = require('crypto');

const log = require('./log');

/** Heartbeat cadence asked of agents, and the silence after which we stop believing them. */
const HEARTBEAT_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const SWEEP_MS = 2_000;

/** Node IDs in the order the wall should draw them. Set from layout.json at boot. */
let displayOrder = [];

const nodes = new Map();
const changeListeners = new Set();

function emitChange(reason, nodeId) {
  for (const listener of changeListeners) {
    try {
      listener(reason, nodeId);
    } catch (err) {
      log.error('registry listener threw', { reason, node: nodeId, error: err.message });
    }
  }
}

function onChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/**
 * Seed the registry from configuration.
 *
 * Every configured node exists from boot, offline. The wall therefore shows GAMMA as a
 * dark slot rather than omitting it, which is the difference between an operator seeing
 * "three of four" and seeing nothing wrong at all.
 */
function init(nodeConfigs, layout) {
  nodes.clear();

  for (const [id, config] of Object.entries(nodeConfigs)) {
    nodes.set(id, {
      id,
      label: config.label || id,
      role: config.role || 'node',

      online: false,
      sessionId: null,
      connectedAt: null,
      disconnectedAt: null,

      os: null,
      hostname: null,
      agentVersion: null,
      capabilities: [],

      // Self-reported by the agent each heartbeat.
      state: 'offline',
      hasOverlay: false,
      displayAwake: false,
      rttMs: null,
      lastHeartbeatAt: null,
      heartbeatSeq: 0,

      // What Core last told this node to display. Distinct from hasOverlay: the scene is
      // Core's intent, hasOverlay is the agent's observed reality. When they disagree,
      // something failed and the wall should show it.
      scene: 'normal',

      agentConnection: null,
      overlayConnection: null,

      lastCommandAt: null,
      lastError: null,
    });
  }

  const configured = [...nodes.keys()];
  const ordered = (layout && Array.isArray(layout.order) ? layout.order : []).filter((id) =>
    nodes.has(id)
  );
  // Anything configured but missing from layout.json still has to appear somewhere.
  displayOrder = [...ordered, ...configured.filter((id) => !ordered.includes(id))];

  const unknown = (layout && layout.order ? layout.order : []).filter((id) => !nodes.has(id));
  if (unknown.length) {
    log.warn('layout names nodes that are not configured', { nodes: unknown.join(',') });
  }

  return displayOrder;
}

function get(nodeId) {
  return nodes.get(nodeId) || null;
}

function has(nodeId) {
  return nodes.has(nodeId);
}

function ids() {
  return [...displayOrder];
}

/** Online nodes, in display order. The set a broadcast actually reaches. */
function onlineNodes() {
  return displayOrder.map((id) => nodes.get(id)).filter((node) => node && node.online);
}

/**
 * Open a session for a freshly authenticated agent.
 *
 * A node reconnecting while an old connection is still attached is normal — a Wi-Fi blip
 * leaves Core holding a socket the client has already given up on. The previous
 * connection is destroyed rather than refused, so the live agent always wins. Refusing
 * the new one would strand the node until a timeout it cannot influence.
 */
function openSession(nodeId, meta) {
  const node = nodes.get(nodeId);
  if (!node) return null;

  if (node.agentConnection) {
    log.warn('replacing an existing agent connection', { node: nodeId });
    node.agentConnection.destroy();
    node.agentConnection = null;
  }

  node.sessionId = crypto.randomBytes(12).toString('hex');
  node.os = meta.os || 'unknown';
  node.hostname = meta.hostname || null;
  node.agentVersion = meta.agentVersion || null;
  node.capabilities = Array.isArray(meta.capabilities) ? meta.capabilities : [];
  node.lastError = null;

  return node.sessionId;
}

/** True only if this session is the one Core currently believes in. */
function sessionValid(nodeId, sessionId) {
  const node = nodes.get(nodeId);
  return Boolean(node && node.sessionId && sessionId && node.sessionId === sessionId);
}

/**
 * Attach the agent's command stream. This is the moment a node becomes online.
 */
function attachAgent(nodeId, connection) {
  const node = nodes.get(nodeId);
  if (!node) return false;

  node.agentConnection = connection;
  node.online = true;
  node.state = 'ready';
  node.connectedAt = Date.now();
  node.lastHeartbeatAt = Date.now();

  connection.onClose = () => {
    // Only tear down if this is still the current connection. A reconnect that replaced
    // it will have already fired this handler for the old socket.
    if (node.agentConnection !== connection) return;

    node.agentConnection = null;
    node.online = false;
    node.state = 'offline';
    node.sessionId = null;
    node.disconnectedAt = Date.now();
    node.hasOverlay = false;
    node.rttMs = null;

    log.warn('node disconnected', { node: nodeId });
    emitChange('disconnect', nodeId);
  };

  log.good('node registered', {
    node: nodeId,
    os: node.os,
    host: node.hostname,
    caps: node.capabilities.length,
  });
  emitChange('connect', nodeId);
  return true;
}

/**
 * Attach an overlay's scene stream.
 *
 * Independent of the agent connection: the overlay is a browser process the agent
 * launched, and it reaches Core on its own. Core needs to know it exists so that
 * identify() can pick between "flash the overlay already on screen" and "the agent must
 * open one first" (PROTOCOL.md §1).
 */
function attachOverlay(nodeId, connection) {
  const node = nodes.get(nodeId);
  if (!node) return false;

  if (node.overlayConnection) node.overlayConnection.destroy();
  node.overlayConnection = connection;

  connection.onClose = () => {
    if (node.overlayConnection !== connection) return;
    node.overlayConnection = null;
    node.scene = 'normal';
    emitChange('overlay-detach', nodeId);
  };

  log.info('overlay attached', { node: nodeId });
  emitChange('overlay-attach', nodeId);
  return true;
}

/** Record a heartbeat (PROTOCOL.md §5). */
function heartbeat(nodeId, fields) {
  const node = nodes.get(nodeId);
  if (!node) return false;

  // A sequence number that went backwards means the agent process restarted while its
  // socket survived. Rare, but it makes rtt and overlay state meaningless until the next
  // register, so say so rather than silently reporting stale values.
  if (fields.seq !== undefined && fields.seq < node.heartbeatSeq) {
    log.warn('agent restarted without re-registering', { node: nodeId });
  }

  node.lastHeartbeatAt = Date.now();
  node.heartbeatSeq = fields.seq !== undefined ? fields.seq : node.heartbeatSeq + 1;
  if (fields.state) node.state = fields.state;
  if (fields.overlay !== undefined) node.hasOverlay = Boolean(fields.overlay);
  if (fields.awake !== undefined) node.displayAwake = Boolean(fields.awake);
  if (fields.rtt !== undefined && Number.isFinite(fields.rtt)) node.rttMs = fields.rtt;

  return true;
}

/** Note what Core last asked this node to display. */
function setScene(nodeId, scene) {
  const node = nodes.get(nodeId);
  if (!node) return;
  node.scene = scene;
  node.lastCommandAt = Date.now();
  emitChange('scene', nodeId);
}

function noteError(nodeId, message) {
  const node = nodes.get(nodeId);
  if (!node) return;
  node.lastError = message;
  emitChange('error', nodeId);
}

/**
 * Does this node advertise the capability an action needs?
 *
 * SPEC.md §9 and §30 both insist on this: a node declares what it can do at registration
 * and nothing may assume more. A Windows machine with no speech backend simply does not
 * list `speak`, and asking for it produces a clean refusal rather than a silent no-op.
 */
function supports(nodeId, capability) {
  const node = nodes.get(nodeId);
  if (!node) return false;
  return node.capabilities.includes(capability);
}

/**
 * The wall's view of the room. Connections are deliberately absent — this gets
 * JSON.stringify'd straight onto the observer channel.
 */
function snapshot() {
  const now = Date.now();

  return {
    at: now,
    order: displayOrder,
    nodes: displayOrder.map((id) => {
      const node = nodes.get(id);
      const silentFor = node.lastHeartbeatAt ? now - node.lastHeartbeatAt : null;

      return {
        id: node.id,
        label: node.label,
        role: node.role,
        online: node.online,
        state: node.state,
        os: node.os,
        hostname: node.hostname,
        capabilities: node.capabilities,
        scene: node.scene,
        hasOverlay: node.hasOverlay,
        displayAwake: node.displayAwake,
        rttMs: node.rttMs,
        silentForMs: silentFor,

        // True when the socket is up but heartbeats stopped: the wedged-client case the
        // connection alone cannot reveal.
        stale: Boolean(node.online && silentFor !== null && silentFor > HEARTBEAT_TIMEOUT_MS),

        uptimeMs: node.connectedAt && node.online ? now - node.connectedAt : null,
        lastError: node.lastError,
      };
    }),
    summary: {
      configured: displayOrder.length,
      online: displayOrder.filter((id) => nodes.get(id).online).length,
      withOverlay: displayOrder.filter((id) => nodes.get(id).hasOverlay).length,
      asleep: displayOrder.filter((id) => {
        const node = nodes.get(id);
        return node.online && !node.displayAwake;
      }).length,
    },
  };
}

/**
 * Drop nodes whose heartbeats stopped even though the socket is still open.
 *
 * The socket-close path handles every ordinary disconnect. This exists purely for the
 * client that is hung rather than gone, which on a Wi-Fi network with roaming clients
 * happens often enough to matter.
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const node of nodes.values()) {
    if (!node.online || !node.lastHeartbeatAt) continue;
    if (now - node.lastHeartbeatAt <= HEARTBEAT_TIMEOUT_MS * 2) continue;

    log.warn('node stopped heartbeating, dropping', {
      node: node.id,
      silentMs: now - node.lastHeartbeatAt,
    });
    if (node.agentConnection) node.agentConnection.destroy();
  }
}, SWEEP_MS);
sweeper.unref();

module.exports = {
  init,
  get,
  has,
  ids,
  onlineNodes,
  openSession,
  sessionValid,
  attachAgent,
  attachOverlay,
  heartbeat,
  setScene,
  noteError,
  supports,
  snapshot,
  onChange,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
};
