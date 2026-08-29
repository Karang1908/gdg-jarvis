'use strict';

/**
 * The device registry.
 *
 * Devices are not configured in advance. One arrives, presents the join secret, says what
 * it is called and what it runs, and is given the next free number. That number is how
 * everything else addresses it — the wall, the controller, the voice layer, and MCP all
 * say "device 3", never a codename someone has to memorise.
 *
 * Two properties matter more than they look.
 *
 * **Numbers are stable.** A laptop that drops off the Wi-Fi and comes back is still
 * device 3. Renumbering mid-demo would be the single most confusing thing this system
 * could do — the presenter says "identify three" and the wrong screen answers.
 *
 * **Presence follows the connection, not the heartbeat.** When a device's stream drops it
 * leaves the wall that instant; there is no window in which the wall shows a machine that
 * is already gone. Heartbeats remain as a backstop for the one case a live socket cannot
 * reveal: a client that is wedged rather than gone.
 */

const crypto = require('crypto');

const log = require('./log');

const HEARTBEAT_MS = 5_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const SWEEP_MS = 2_000;

/** Devices by number. Insertion order is join order, which is also display order. */
const devices = new Map();

/**
 * Number → fingerprint, so a returning device reclaims its own slot.
 *
 * Kept separately from `devices` because it must outlive a disconnect: the whole point is
 * that a laptop which drops off and rejoins is recognised.
 */
const fingerprints = new Map();

const changeListeners = new Set();

let nextNumber = 1;

/**
 * Identify a physical machine across reconnects.
 *
 * Hostname plus OS is not a security boundary — it is trivially forgeable — and it does
 * not need to be. Enrollment is already authenticated by the join secret; this only has to
 * be stable enough that the same laptop gets the same number twice, which it is.
 */
function fingerprintOf(hostname, os) {
  return crypto
    .createHash('sha256')
    .update(`${String(hostname).toLowerCase()}|${String(os).toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
}

function emitChange(reason, number) {
  for (const listener of changeListeners) {
    try {
      listener(reason, number);
    } catch (err) {
      log.error('registry listener threw', { reason, device: number, error: err.message });
    }
  }
}

function onChange(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function reset() {
  devices.clear();
  fingerprints.clear();
  nextNumber = 1;
}

/**
 * Enroll a device, or welcome back one that has been here before.
 *
 * Returns the device record. Never fails for an unknown machine — that is the point.
 */
function enroll(meta) {
  const fingerprint = fingerprintOf(meta.hostname, meta.os);

  let number = fingerprints.get(fingerprint);
  let device = number ? devices.get(number) : null;

  if (!device) {
    number = nextNumber++;
    fingerprints.set(fingerprint, number);

    device = {
      number,
      fingerprint,

      hostname: meta.hostname || `device-${number}`,
      os: meta.os || 'unknown',
      agentVersion: meta.agentVersion || null,
      capabilities: [],

      // Set by an agent started with --wall. The device showing the Command Wall.
      isWall: false,

      online: false,
      sessionId: null,
      connectedAt: null,
      disconnectedAt: null,

      state: 'offline',
      hasOverlay: false,
      displayAwake: false,
      hasInternet: null,
      rttMs: null,
      lastHeartbeatAt: null,
      heartbeatSeq: 0,

      scene: 'normal',
      muted: false,

      agentConnection: null,
      overlayConnection: null,

      lastCommandAt: null,
      lastError: null,
    };
    devices.set(number, device);
    log.good('device enrolled', { device: number, host: device.hostname, os: device.os });
  } else {
    // A returning machine may have been renamed, or reinstalled, since it was last here.
    device.hostname = meta.hostname || device.hostname;
    device.agentVersion = meta.agentVersion || device.agentVersion;
    log.info('device returned', { device: number, host: device.hostname });
  }

  if (device.agentConnection) {
    // A device reconnecting while Core still holds its old socket is normal — a Wi-Fi blip
    // leaves a connection the client has already given up on. The live agent wins;
    // refusing it would strand the device until a timeout it cannot influence.
    log.warn('replacing an existing agent connection', { device: number });
    device.agentConnection.destroy();
    device.agentConnection = null;
  }

  device.os = meta.os || device.os;
  device.capabilities = Array.isArray(meta.capabilities) ? meta.capabilities : [];
  device.sessionId = crypto.randomBytes(12).toString('hex');
  device.lastError = null;

  if (meta.wantsWall) claimWall(number);

  return device;
}

/**
 * Designate the device that shows the Command Wall.
 *
 * Exclusive: only one device can be the wall, because two Command Walls disagreeing about
 * the room is worse than none.
 */
function claimWall(number) {
  if (!devices.has(number)) return false;
  for (const device of devices.values()) device.isWall = device.number === number;
  log.info('wall assigned', { device: number });
  emitChange('wall', number);
  return true;
}

/**
 * The device that should render the wall.
 *
 * Falls back to the lowest-numbered online device, so there is always somewhere for the
 * room's state to appear even if nobody passed --wall.
 */
function wallDevice() {
  for (const device of devices.values()) {
    if (device.isWall) return device;
  }
  for (const device of devices.values()) {
    if (device.online) return device;
  }
  return null;
}

/**
 * Where JARVIS currently appears.
 *
 * The device showing a JARVIS scene, if one is; otherwise the wall. Used as the default
 * source for a move, so "move to three" means "from wherever you are" rather than from a
 * fixed machine that may not even be the one showing it.
 */
function jarvisDevice() {
  for (const device of devices.values()) {
    if (device.online && (device.scene === 'jarvis' || device.scene === 'wall')) return device;
  }
  return wallDevice();
}

function isWall(number) {
  const wall = wallDevice();
  return Boolean(wall && wall.number === Number(number));
}

function get(number) {
  return devices.get(Number(number)) || null;
}

function has(number) {
  return devices.has(Number(number));
}

/** Every known device number, in join order. */
function ids() {
  return [...devices.keys()];
}

/** Online devices, in join order. The set a broadcast actually reaches. */
function onlineDevices() {
  return [...devices.values()].filter((device) => device.online);
}

/**
 * Resolve what a human or a model said into a device number.
 *
 * Accepts the number itself, and also a hostname — because someone looking at the wall
 * will read out "Ravi's MacBook" as readily as "3", and refusing that would be pedantry.
 * Hostname matching is deliberately strict about ambiguity: two machines that both match
 * produce a refusal rather than a guess at which screen to take over.
 */
function resolve(input) {
  if (input === null || input === undefined) return { ok: false, reason: 'device_missing' };

  const text = String(input).trim();
  if (text === '') return { ok: false, reason: 'device_missing' };
  if (text.toUpperCase() === 'ALL') return { ok: true, all: true };

  if (/^\d+$/.test(text)) {
    const number = Number(text);
    if (devices.has(number)) return { ok: true, all: false, number };
    return { ok: false, reason: 'device_unknown' };
  }

  const needle = text.toLowerCase();
  const matches = [...devices.values()].filter(
    (device) => device.hostname && device.hostname.toLowerCase().includes(needle)
  );

  if (matches.length === 1) return { ok: true, all: false, number: matches[0].number };
  if (matches.length > 1) return { ok: false, reason: 'device_ambiguous' };
  return { ok: false, reason: 'device_unknown' };
}

function sessionValid(number, sessionId) {
  const device = get(number);
  return Boolean(device && device.sessionId && sessionId && device.sessionId === sessionId);
}

/** Attach a device's command stream. This is the moment it becomes online. */
function attachAgent(number, connection) {
  const device = get(number);
  if (!device) return false;

  device.agentConnection = connection;
  device.online = true;
  device.state = 'ready';
  device.connectedAt = Date.now();
  device.lastHeartbeatAt = Date.now();

  connection.onClose = () => {
    if (device.agentConnection !== connection) return;

    device.agentConnection = null;
    device.online = false;
    device.state = 'offline';
    device.sessionId = null;
    device.disconnectedAt = Date.now();
    device.hasOverlay = false;
    device.rttMs = null;

    log.warn('device disconnected', { device: number, host: device.hostname });
    emitChange('disconnect', number);
  };

  emitChange('connect', number);
  return true;
}

/**
 * Attach an overlay's scene stream.
 *
 * Independent of the agent connection: the overlay is a browser the agent launched, and it
 * reaches Core on its own. Core needs to know it exists so identify() can choose between
 * flashing an overlay already on screen and asking the agent to open one.
 */
function attachOverlay(number, connection) {
  const device = get(number);
  if (!device) return false;

  if (device.overlayConnection) device.overlayConnection.destroy();
  device.overlayConnection = connection;

  connection.onClose = () => {
    if (device.overlayConnection !== connection) return;
    device.overlayConnection = null;
    device.scene = 'normal';
    emitChange('overlay-detach', number);
  };

  emitChange('overlay-attach', number);
  return true;
}

function heartbeat(number, fields) {
  const device = get(number);
  if (!device) return false;

  if (fields.seq !== undefined && fields.seq < device.heartbeatSeq) {
    log.warn('agent restarted without re-enrolling', { device: number });
  }

  device.lastHeartbeatAt = Date.now();
  device.heartbeatSeq = fields.seq !== undefined ? fields.seq : device.heartbeatSeq + 1;
  if (fields.state) device.state = fields.state;
  if (fields.overlay !== undefined) device.hasOverlay = Boolean(fields.overlay);
  if (fields.awake !== undefined) device.displayAwake = Boolean(fields.awake);
  if (fields.net !== undefined) device.hasInternet = Boolean(fields.net);
  if (fields.rtt !== undefined && Number.isFinite(fields.rtt)) device.rttMs = fields.rtt;

  return true;
}

function setScene(number, scene) {
  const device = get(number);
  if (!device) return;
  device.scene = scene;
  device.lastCommandAt = Date.now();
  emitChange('scene', number);
}

function noteError(number, message) {
  const device = get(number);
  if (!device) return;
  device.lastError = message;
  emitChange('error', number);
}

/**
 * Does this device advertise the capability an action needs?
 *
 * A Windows machine with no speech backend simply does not list `speak`, and asking for it
 * produces a clean refusal rather than a silent no-op.
 */
function supports(number, capability) {
  const device = get(number);
  if (!device) return false;
  return device.capabilities.includes(capability);
}

/**
 * Give a device a different number.
 *
 * Swap rather than insert-and-shift. Shifting would renumber machines nobody touched,
 * which is the one thing this registry promises not to do — the presenter has already said
 * "identify three" out loud and cannot have that mean a different laptop a minute later.
 * A swap moves exactly two devices and is its own undo.
 *
 * If the destination number is free the device simply moves into it.
 *
 * The fingerprint map is updated on both sides, so the assignment survives a reconnect. A
 * laptop the operator deliberately made device 1 must still be device 1 after it drops off
 * the Wi-Fi and comes back, or the manual assignment was pointless.
 */
function renumber(fromNumber, toNumber) {
  const from = Number(fromNumber);
  const to = Number(toNumber);

  if (!Number.isInteger(to) || to < 1 || to > 999) {
    return { ok: false, reason: 'number_out_of_range' };
  }
  if (from === to) return { ok: true, from, to, swappedWith: null };

  const moving = devices.get(from);
  if (!moving) return { ok: false, reason: 'device_unknown' };

  const displaced = devices.get(to) || null;

  devices.delete(from);
  if (displaced) devices.delete(to);

  moving.number = to;
  devices.set(to, moving);
  fingerprints.set(moving.fingerprint, to);

  if (displaced) {
    displaced.number = from;
    devices.set(from, displaced);
    fingerprints.set(displaced.fingerprint, from);
  }

  // Keep numeric order, so the wall and the controller list 1, 2, 3 rather than the order
  // the swaps happened in.
  const ordered = [...devices.entries()].sort((a, b) => a[0] - b[0]);
  devices.clear();
  for (const [number, device] of ordered) devices.set(number, device);

  // A number handed out manually must not be handed out again to the next machine to join.
  nextNumber = Math.max(nextNumber, to + 1);

  log.good('device renumbered', {
    from,
    to,
    host: moving.hostname,
    ...(displaced ? { swapped_with: displaced.hostname } : {}),
  });
  emitChange('renumber', to);

  return {
    ok: true,
    from,
    to,
    swappedWith: displaced ? { number: from, hostname: displaced.hostname } : null,
  };
}

/** Remove a device entirely. Used when the operator dismisses one from the controller. */
function forget(number) {
  const device = get(number);
  if (!device) return false;

  if (device.agentConnection) device.agentConnection.destroy();
  if (device.overlayConnection) device.overlayConnection.destroy();

  fingerprints.delete(device.fingerprint);
  devices.delete(device.number);

  log.warn('device removed', { device: number, host: device.hostname });
  emitChange('forget', number);
  return true;
}

/** The room, as JSON. Connections are deliberately absent. */
function snapshot() {
  const now = Date.now();
  const wall = wallDevice();

  return {
    at: now,
    order: ids(),
    wall: wall ? wall.number : null,
    devices: [...devices.values()].map((device) => {
      const silentFor = device.lastHeartbeatAt ? now - device.lastHeartbeatAt : null;

      return {
        number: device.number,
        hostname: device.hostname,
        os: device.os,
        isWall: Boolean(wall && wall.number === device.number),
        online: device.online,
        state: device.state,
        capabilities: device.capabilities,
        scene: device.scene,
        hasOverlay: device.hasOverlay,
        displayAwake: device.displayAwake,
        hasInternet: device.hasInternet,
        muted: device.muted,
        rttMs: device.rttMs,
        silentForMs: silentFor,

        // Socket up but heartbeats stopped: the wedged-client case a connection alone
        // cannot reveal.
        stale: Boolean(device.online && silentFor !== null && silentFor > HEARTBEAT_TIMEOUT_MS),

        uptimeMs: device.connectedAt && device.online ? now - device.connectedAt : null,
        lastError: device.lastError,
      };
    }),
    summary: {
      known: devices.size,
      online: onlineDevices().length,
      withOverlay: [...devices.values()].filter((d) => d.hasOverlay).length,
      asleep: [...devices.values()].filter((d) => d.online && !d.displayAwake).length,
    },
  };
}

/**
 * Drop devices whose heartbeats stopped even though the socket is still open.
 *
 * The socket-close path handles every ordinary disconnect. This exists purely for the
 * client that is hung rather than gone, which on a Wi-Fi network with roaming clients
 * happens often enough to matter.
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const device of devices.values()) {
    if (!device.online || !device.lastHeartbeatAt) continue;
    if (now - device.lastHeartbeatAt <= HEARTBEAT_TIMEOUT_MS * 2) continue;

    log.warn('device stopped heartbeating, dropping', {
      device: device.number,
      silentMs: now - device.lastHeartbeatAt,
    });
    if (device.agentConnection) device.agentConnection.destroy();
  }
}, SWEEP_MS);
sweeper.unref();

module.exports = {
  reset,
  enroll,
  get,
  has,
  ids,
  resolve,
  onlineDevices,
  renumber,
  claimWall,
  wallDevice,
  jarvisDevice,
  isWall,
  sessionValid,
  attachAgent,
  attachOverlay,
  heartbeat,
  setScene,
  noteError,
  supports,
  forget,
  snapshot,
  onChange,
  fingerprintOf,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
};
