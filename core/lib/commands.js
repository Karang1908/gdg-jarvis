'use strict';

/**
 * Command construction, routing, and acknowledgement.
 *
 * Everything an operator, the controller, or the MCP server asks for passes through
 * dispatch(). That single funnel is what makes SPEC.md §28's logging requirement true by
 * construction rather than by remembering: there is no second path to a node.
 *
 * Two rules shape this file.
 *
 * Nothing is dispatched unvalidated. Arguments are checked here, before they reach the
 * wire, and again in the agent — see lib/validate.js for why the duplication is wanted.
 *
 * Nothing fails silently. A node that is offline, that never advertised the capability,
 * or whose argument was refused comes back in `skipped` with a reason. During a live demo
 * the operator has seconds to notice that three of four screens moved, and a partial
 * success that looks like a whole one is the worst possible outcome.
 */

const crypto = require('crypto');

const log = require('./log');
const registry = require('./registry');
const validate = require('./validate');
const choreography = require('./choreography');

/**
 * Where each action executes.
 *
 * The split is the reason the shell agent never has to talk to the browser it launched.
 * Scenes are pure presentation and go straight to the overlay's own connection; anything
 * touching the operating system goes to the agent. `identify` is the one action that can
 * go either way, because §21 requires it to work on a node that has not been taken over.
 */
const ROUTES = {
  takeover: 'agent',
  release: 'agent',
  open_app: 'agent',
  open_url: 'agent',
  speak: 'agent',
  set_volume: 'agent',
  ping: 'agent',

  show_scene: 'overlay',
  cascade: 'overlay',
  move: 'overlay',

  identify: 'either',
};

/** Capability each action requires a node to have advertised (§9, §12). */
const REQUIRED_CAPABILITY = {
  takeover: 'takeover',
  release: 'release',
  open_app: 'open_app',
  open_url: 'open_url',
  speak: 'speak',
  set_volume: 'set_volume',
  identify: 'identify',
  show_scene: 'takeover',
  cascade: 'takeover',
  move: 'takeover',
  ping: null,
};

/** In-flight and recently completed commands, for correlating acknowledgements. */
const MAX_TRACKED = 300;
const pending = new Map();

let coreOrigin = 'http://127.0.0.1:3000';

function setCoreOrigin(origin) {
  coreOrigin = origin;
}

function newCommandId() {
  return crypto.randomBytes(6).toString('hex');
}

function track(record) {
  pending.set(record.commandId, record);
  if (pending.size > MAX_TRACKED) {
    // Maps iterate in insertion order, so the first key is the oldest.
    pending.delete(pending.keys().next().value);
  }
}

/**
 * Validate an action's arguments against the node it is destined for.
 *
 * Platform matters: `open_app('spotify')` is legitimate for a Mac that has it listed and
 * a refusal for a node whose OS has no mapping. Doing this per node rather than once per
 * request is what lets a broadcast succeed on three machines and report a clean reason
 * for the fourth.
 */
function prepareArgs(action, rawArgs, node) {
  const args = rawArgs || {};

  switch (action) {
    case 'open_url': {
      const url = validate.checkUrl(args.url);
      if (!url.ok) return { ok: false, reason: url.reason };
      return { ok: true, args: { url: url.value } };
    }

    case 'open_app': {
      const app = validate.checkApp(args.app, node.os);
      if (!app.ok) return { ok: false, reason: app.reason };
      // Only the logical name crosses the wire. The agent resolves it against its own
      // copy of the allowlist, so Core cannot hand a node an executable path (§13).
      return { ok: true, args: { app: app.value }, label: app.label };
    }

    case 'speak': {
      const speech = validate.checkSpeech(args.text);
      if (!speech.ok) return { ok: false, reason: speech.reason };
      const out = { text: speech.value };
      if (args.voice && /^[A-Za-z ]{1,32}$/.test(args.voice)) out.voice = args.voice;
      return { ok: true, args: out, truncated: speech.truncated };
    }

    case 'set_volume': {
      const volume = validate.checkVolume(args.level);
      if (!volume.ok) return { ok: false, reason: volume.reason };
      return { ok: true, args: { level: volume.value } };
    }

    case 'show_scene': {
      const scene = validate.checkScene(args.scene);
      if (!scene.ok) return { ok: false, reason: scene.reason };
      const out = { scene: scene.value };
      if (args.delay !== undefined) out.delay = Math.max(0, Math.round(Number(args.delay) || 0));
      if (args.transition) out.transition = args.transition;
      if (args.direction) out.direction = args.direction;
      return { ok: true, args: out };
    }

    case 'takeover': {
      // Core builds the overlay URL itself, including a single-use ticket scoped to this
      // node. The agent opens exactly what it is given and validates the scheme; it never
      // constructs a URL, so a node cannot be talked into opening someone else's overlay.
      return { ok: true, args: { ...args } };
    }

    default:
      return { ok: true, args: { ...args } };
  }
}

/** Resolve a target into the concrete list of nodes it names. */
function resolveTargets(target) {
  const check = validate.checkNodeId(target, registry.ids());
  if (!check.ok) return { ok: false, reason: check.reason };

  if (check.isBroadcast) {
    return { ok: true, target: 'ALL', nodeIds: registry.ids() };
  }
  return { ok: true, target: check.value, nodeIds: [check.value] };
}

/**
 * Send one command to one node.
 *
 * Returns a dispatch record on success or a skip record with a reason. Never throws for
 * an ordinary refusal — an offline node is a normal state during a demo, not an error.
 */
function sendTo(nodeId, action, rawArgs, context) {
  const node = registry.get(nodeId);
  if (!node) return { skipped: { node: nodeId, reason: 'node_unknown' } };
  if (!node.online) return { skipped: { node: nodeId, reason: 'offline' } };

  const capability = REQUIRED_CAPABILITY[action];
  if (capability && !registry.supports(nodeId, capability)) {
    log.deny('capability not advertised', { node: nodeId, action, needs: capability });
    return { skipped: { node: nodeId, reason: `capability_missing:${capability}` } };
  }

  const prepared = prepareArgs(action, rawArgs, node);
  if (!prepared.ok) {
    log.deny('argument refused', { node: nodeId, action, reason: prepared.reason });
    return { skipped: { node: nodeId, reason: prepared.reason } };
  }

  // Pick the channel. `identify` prefers an overlay that already exists so the node
  // flashes instantly; with none, the agent opens one for the duration (§21).
  let channel = ROUTES[action] || 'agent';
  if (channel === 'either') channel = node.overlayConnection ? 'overlay' : 'agent';

  const connection = channel === 'overlay' ? node.overlayConnection : node.agentConnection;
  if (!connection) {
    return { skipped: { node: nodeId, reason: channel === 'overlay' ? 'no_overlay' : 'no_agent' } };
  }

  const commandId = newCommandId();
  const record = {
    commandId,
    node: nodeId,
    action,
    args: prepared.args,
    channel,
    source: (context && context.source) || 'unknown',
    issuedAt: Date.now(),
    status: 'sent',
  };

  const delivered =
    channel === 'overlay'
      ? connection.sendJson('command', { commandId, action, args: prepared.args })
      : connection.sendCommand(commandId, action, prepared.args);

  if (!delivered) {
    return { skipped: { node: nodeId, reason: 'channel_closed' } };
  }

  track(record);
  node.lastCommandAt = record.issuedAt;

  log.info(action.toUpperCase(), {
    commandId,
    target: nodeId,
    source: record.source,
    ...(prepared.label ? { app: prepared.label } : {}),
    ...(prepared.args.scene ? { scene: prepared.args.scene } : {}),
    ...(prepared.args.delay ? { delay: prepared.args.delay + 'ms' } : {}),
  });

  return { dispatched: { commandId, node: nodeId, channel, action } };
}

/**
 * The single entry point every caller uses.
 *
 * `perNodeArgs` lets choreography give each node its own delay without turning one
 * logical command into N separate dispatch calls that would each log their own line.
 */
function dispatch(target, action, args, context = {}, perNodeArgs = null) {
  const resolved = resolveTargets(target);
  if (!resolved.ok) {
    log.deny('target refused', { target, action, reason: resolved.reason });
    return { ok: false, error: resolved.reason, dispatched: [], skipped: [] };
  }

  if (!ROUTES[action]) {
    // Reaching here means an action name that no route knows. Refusing rather than
    // guessing is what keeps §12's denylist meaningful: an unknown action is never
    // forwarded to a node on the chance that it might understand it.
    log.deny('unknown action refused', { target, action });
    return { ok: false, error: 'action_unknown', dispatched: [], skipped: [] };
  }

  const dispatched = [];
  const skipped = [];

  for (const nodeId of resolved.nodeIds) {
    const nodeArgs = perNodeArgs ? { ...args, ...(perNodeArgs.get(nodeId) || {}) } : args;
    const result = sendTo(nodeId, action, nodeArgs, context);
    if (result.dispatched) dispatched.push(result.dispatched);
    if (result.skipped) skipped.push(result.skipped);
  }

  return { ok: dispatched.length > 0, target: resolved.target, dispatched, skipped };
}

/**
 * Build the overlay URL for a node, minting the ticket that authorises it.
 *
 * The ticket is scoped to this node and single-use, so it authorises exactly one browser
 * to read exactly one screen's scene stream (PROTOCOL.md §8).
 */
function overlayUrl(nodeId, auth, initialScene = null) {
  const { ticket } = auth.issueTicket('overlay', nodeId);
  const node = registry.get(nodeId);
  const url = new URL('/overlay/', coreOrigin);
  url.searchParams.set('node', nodeId);
  url.searchParams.set('ticket', ticket);
  if (node && node.role === 'wall') url.searchParams.set('wall', '1');

  // Set when an overlay is being reopened after a reconnect. The page boots straight into
  // this scene rather than replaying the takeover animation, so a Wi-Fi blip does not
  // announce itself to the audience.
  if (initialScene) url.searchParams.set('scene', initialScene);

  return url.href;
}

/**
 * Take the room (§17).
 *
 * Each node gets its own delay so the overlays appear in sequence across the room, and
 * its own ticketed URL. MAIN's URL carries wall=1, which is what makes its overlay settle
 * into the Command Wall instead of an idle JARVIS scene — see DEVIATIONS.md D5.
 */
function takeover(target, auth, context, resumeScene = null) {
  const resolved = resolveTargets(target);
  if (!resolved.ok) return { ok: false, error: resolved.reason, dispatched: [], skipped: [] };

  const reachable = resolved.nodeIds.filter((id) => {
    const node = registry.get(id);
    return node && node.online;
  });

  // A resume is one node coming back, not a room-wide cue, so it skips the stagger and
  // reopens immediately into the scene it was already showing.
  const stagger = resumeScene ? new Map() : choreography.takeoverStagger(reachable);

  const perNode = new Map();
  for (const nodeId of reachable) {
    perNode.set(nodeId, {
      url: overlayUrl(nodeId, auth, resumeScene),
      delay: stagger.get(nodeId) || 0,
    });
  }

  const result = dispatch(target, 'takeover', {}, context, perNode);
  for (const entry of result.dispatched) {
    registry.setScene(entry.node, resumeScene || 'takeover');
  }
  return result;
}

/**
 * Release (§16, §33).
 *
 * Sent to every configured node, online or not, and deliberately not gated on the
 * `release` capability. This is the failure-safe path: if a node is in a state where Core
 * is unsure what it advertised, the answer is still to tell it to let go. Nodes that
 * cannot be reached are reported, so the operator knows which screen to walk over to.
 */
function release(target, context) {
  const result = dispatch(target, 'release', {}, context);
  for (const entry of result.dispatched) registry.setScene(entry.node, 'normal');
  return result;
}

/** Show a scene on one target (§20). */
function scene(target, sceneName, context, extraArgs = {}) {
  const result = dispatch(target, 'show_scene', { scene: sceneName, ...extraArgs }, context);
  for (const entry of result.dispatched) registry.setScene(entry.node, sceneName);
  return result;
}

/** Split JARVIS across every screen at once (§23). */
function broadcast(sceneName, context) {
  const online = registry.onlineNodes().map((node) => node.id);
  const stagger = choreography.broadcastStagger(online);

  const perNode = new Map();
  for (const nodeId of online) perNode.set(nodeId, { delay: stagger.get(nodeId) || 0 });

  const result = dispatch('ALL', 'show_scene', { scene: sceneName }, context, perNode);
  for (const entry of result.dispatched) registry.setScene(entry.node, sceneName);
  return result;
}

/**
 * Move JARVIS from one node to another (§22).
 *
 * Two commands, one on each end, timed so the arrival slightly overlaps the departure.
 * No process migrates; the spec is explicit that this is visual choreography.
 */
function move(fromNodeId, toNodeId, context) {
  const plan = choreography.movePlan(fromNodeId, toNodeId);

  const departure = dispatch(
    plan.from.nodeId,
    'show_scene',
    {
      scene: plan.from.scene,
      transition: plan.from.transition,
      direction: plan.from.direction,
      delay: plan.from.delayMs,
    },
    context
  );

  const arrival = dispatch(
    plan.to.nodeId,
    'show_scene',
    {
      scene: plan.to.scene,
      transition: plan.to.transition,
      direction: plan.to.direction,
      delay: plan.to.delayMs,
    },
    context
  );

  if (departure.dispatched.length) registry.setScene(fromNodeId, 'normal');
  if (arrival.dispatched.length) registry.setScene(toNodeId, 'jarvis');

  return {
    ok: arrival.dispatched.length > 0,
    from: fromNodeId,
    to: toNodeId,
    dispatched: [...departure.dispatched, ...arrival.dispatched],
    skipped: [...departure.skipped, ...arrival.skipped],
  };
}

/** Run a beam across the room (§24). */
function cascade(effect, context, reverse = false) {
  const online = registry.onlineNodes().map((node) => node.id);
  const plan = choreography.cascadePlan(online, reverse);

  const perNode = new Map();
  for (const step of plan) {
    perNode.set(step.nodeId, {
      delay: step.delayMs,
      direction: step.entering === 'none' ? step.leaving : step.entering,
    });
  }

  const result = dispatch('ALL', 'show_scene', { scene: 'cascade', effect }, context, perNode);
  return { ...result, plan };
}

/**
 * Identify one node (§21).
 *
 * Routed to whichever channel can act: an existing overlay flashes immediately, a node
 * without one has its agent open a temporary overlay for the duration. Either way the
 * command wall highlights the same node, which is the point — it proves the machines are
 * addressed independently.
 */
const IDENTIFY_MS = 4000;

function identify(target, auth, context) {
  const resolved = resolveTargets(target);
  if (!resolved.ok) return { ok: false, error: resolved.reason, dispatched: [], skipped: [] };

  const perNode = new Map();
  for (const nodeId of resolved.nodeIds) {
    const node = registry.get(nodeId);
    if (!node || !node.online) continue;

    if (node.overlayConnection) {
      perNode.set(nodeId, { scene: 'identify', duration: IDENTIFY_MS });
    } else {
      // No overlay to flash, so the agent opens a transient one and closes it again.
      perNode.set(nodeId, { url: overlayUrl(nodeId, auth), duration: IDENTIFY_MS });
    }
  }

  return dispatch(target, 'identify', { duration: IDENTIFY_MS }, context, perNode);
}

/**
 * Record an acknowledgement from an agent (§11).
 *
 * An ack for a command we never issued is logged rather than dropped. It means either a
 * stale agent replaying work after a reconnect, or a command whose record aged out of the
 * ring buffer — both worth seeing while rehearsing.
 */
function acknowledge(nodeId, commandId, status, message) {
  const record = pending.get(commandId);

  if (!record) {
    log.warn('ack for an unknown command', { node: nodeId, commandId, status });
    return false;
  }
  if (record.node !== nodeId) {
    log.warn('ack from the wrong node', { commandId, expected: record.node, got: nodeId });
    return false;
  }

  record.status = status;
  record.message = message || null;
  record.completedAt = Date.now();
  record.durationMs = record.completedAt - record.issuedAt;

  const level = status === 'success' ? 'good' : status === 'received' || status === 'executing' ? 'info' : 'error';
  log.record(level, `${status} ${record.action}`, {
    commandId,
    target: nodeId,
    ms: record.durationMs,
    ...(message ? { message } : {}),
  });

  if (status === 'failed' || status === 'unsupported') {
    registry.noteError(nodeId, `${record.action}: ${message || status}`);
  }

  return true;
}

/** Recent command records, newest first. Feeds the wall's execution panel. */
function recent(limit = 25) {
  return [...pending.values()].slice(-limit).reverse();
}

module.exports = {
  dispatch,
  takeover,
  release,
  scene,
  broadcast,
  move,
  cascade,
  identify,
  acknowledge,
  recent,
  overlayUrl,
  setCoreOrigin,
  resolveTargets,
  ROUTES,
  REQUIRED_CAPABILITY,
};
