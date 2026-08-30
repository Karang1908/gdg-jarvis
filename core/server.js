#!/usr/bin/env node
'use strict';

/**
 * JARVIS Core.
 *
 * The device registry, command API, event bus, and static server described in SPEC.md
 * §1. Runs on the Kali laptop that also carries the access point, and requires nothing
 * but a Node runtime — no install step, which matters because that machine has no
 * internet while its Wi-Fi is busy being the AP.
 *
 *   node core/server.js --host 10.42.0.1 --port 3000
 *
 * Ctrl+C releases the room before exiting. Losing Core should never leave a teammate
 * looking at a black screen.
 */

const fsp = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ask = require('./lib/ask');
const ears = require('./lib/ears');
const env = require('./lib/env');
const intents = require('./lib/intents');
const personality = require('./lib/personality');

const auth = require('./lib/auth');
const bus = require('./lib/bus');
const choreography = require('./lib/choreography');
const commands = require('./lib/commands');
const httpLib = require('./lib/http');
const log = require('./lib/log');
const registry = require('./lib/registry');
const validate = require('./lib/validate');
const voice = require('./lib/voice');

const { json, text, readBody, serveStatic } = httpLib;

const PUBLIC_DIR = path.join(__dirname, 'public');
const AGENT_DIR = path.join(__dirname, '..', 'agent');

// ---------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    port: 3000,
    host: '0.0.0.0',
    config: path.join(__dirname, 'config', 'core.json'),
    apps: path.join(__dirname, 'config', 'apps.json'),
    layout: path.join(__dirname, 'config', 'layout.json'),
    personality: path.join(__dirname, 'config', 'personality.md'),
    memory: path.join(__dirname, 'config', 'memory.md'),
    phrases: path.join(__dirname, 'config', 'phrases.json'),
    env: path.join(__dirname, '..', '.env'),
  };

  for (let i = 2; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--port':
        options.port = Number(value);
        break;
      case '--host':
        options.host = value;
        break;
      case '--config':
        options.config = path.resolve(value);
        break;
      case '--apps':
        options.apps = path.resolve(value);
        break;
      case '--layout':
        options.layout = path.resolve(value);
        break;
      case '--personality':
        options.personality = path.resolve(value);
        break;
      case '--memory':
        options.memory = path.resolve(value);
        break;
      case '--phrases':
        options.phrases = path.resolve(value);
        break;
      case '--env':
        options.env = path.resolve(value);
        break;
      case '--help':
      case '-h':
        console.log(
          'Usage: node core/server.js [--host ADDR] [--port N] [--config PATH]\n' +
            '  --host    interface to bind (default 0.0.0.0; use the AP address to harden)\n' +
            '  --port    default 3000\n' +
            '  --config  secrets file (default core/config/core.json)\n'
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${flag}`);
        process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv);

// lib/settings loads .env during auth.load() below; this is only so the banner can say
// whether it found one.
const envFile = env.load(options.env);

// ---------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------

try {
  const config = auth.load({ config: options.config, env: options.env });
  validate.loadApps(options.apps);
  const voiceState = voice.init(config.voice || {});
  if (envFile.loaded) {
    log.info('.env loaded', { keys: envFile.keys.length, from: path.basename(envFile.path) });
  }
  if (!voiceState.natural && voiceState.available) {
    log.warn('using the fallback voice', {
      fix: 'set GEMINI_API_KEY in .env, or install piper',
    });
  }
  personality.load(options.personality, options.memory);

  // Runs from the repository root so agy picks up .agents/AGENTS.md as its persona.
  // The personality goes to agy explicitly: it does not read .agents/AGENTS.md, so without
  // this it answers as a generic assistant — in markdown, at length, out loud.
  ask.init({
    cwd: path.join(__dirname, '..'),
    instructions: personality.get().body,
  });

  // Start agy now rather than on the first question. It takes about five seconds to be
  // ready, and the difference between paying that while someone is plugging in the
  // projector and paying it in front of an audience is the whole point. Not awaited —
  // Core serves everything else meanwhile, and a spoken command never needs agy at all.
  ask.warm().catch(() => {});
  // The microphone is in the same room as the speakers, so ears has to be able to tell
  // JARVIS's own voice from somebody talking to it.
  ears.init({ ...(config.ears || {}), isSpeaking: voice.isSpeaking });

  choreography.init(require(options.layout));
  registry.reset();
} catch (err) {
  console.error(`\nJARVIS Core cannot start.\n\n${err.message}\n`);
  process.exit(1);
}

/** Address a node should use to reach Core, used when building overlay URLs. */
function advertisedOrigin() {
  if (options.host !== '0.0.0.0' && options.host !== '::') {
    return `http://${options.host}:${options.port}`;
  }
  // Bound to everything, so pick the first non-loopback IPv4 — on Kali that is the AP.
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return `http://${entry.address}:${options.port}`;
      }
    }
  }
  return `http://127.0.0.1:${options.port}`;
}

const origin = advertisedOrigin();
commands.setCoreOrigin(origin);

// ---------------------------------------------------------------------------------
// Observer channel — the wall and the controller
// ---------------------------------------------------------------------------------

const observers = new bus.Channel('observers');

/** Overlays on a node whose role is 'wall'; they receive state as well as scenes. */
const wallOverlays = new Set();

function pushState() {
  if (observers.size === 0 && wallOverlays.size === 0) return;

  const snapshot = registry.snapshot();
  observers.broadcast('state', snapshot);
  for (const connection of wallOverlays) connection.sendJson('state', snapshot);
}

registry.onChange(pushState);

// Activity reaches the wall overlay as well as the observer channel. Without this MAIN's
// overlay shows a permanently empty SYSTEM ACTIVITY panel, which is worse than having no
// panel at all — it reads as a system that has stopped rather than one that is idle.
log.subscribe((entry) => {
  observers.broadcast('activity', entry);
  for (const connection of wallOverlays) connection.sendJson('activity', entry);
});

// Heartbeat fields (latency, awake, uptime) change without a registry event, so the wall
// gets a tick as well. One second is below the point where a stale number is noticeable.
const stateTicker = setInterval(pushState, 1000);
stateTicker.unref();

// ---------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------

const router = new httpLib.Router();

/** Guard for every control endpoint (§27). */
function requireAdmin(req, res, context) {
  if (auth.authenticateAdmin(req.headers.authorization)) return true;
  log.deny('admin auth refused', { path: context.pathname, from: context.address });
  json(res, 401, { ok: false, error: 'unauthorized' });
  return false;
}

// --- Agent channel ----------------------------------------------------------------

router.post('/api/agent/register', async (req, res, context) => {
  const body = await readBody(req);
  if (!body) return text(res, 400, 'REJECT malformed_body');

  const admitted = auth.authenticateJoin(body.secret, context.address);
  if (!admitted.ok) return text(res, 401, `REJECT ${admitted.reason}`);

  const hostname = validate.checkHostname(body.host);
  if (!hostname.ok) return text(res, 400, `REJECT ${hostname.reason}`);

  // The device tells Core what it is; Core decides what to call it. The number comes back
  // in the reply, which is the first thing the agent prints, so a teammate can read their
  // own device number off their screen and the presenter can ask for it by number.
  const device = registry.enroll({
    hostname: hostname.value,
    os: validate.checkOs(body.os),
    agentVersion: body.agent || null,
    wantsWall: body.wall === '1' || body.wall === 1 || body.wall === true,
    capabilities: String(body.caps || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  });

  return text(
    res,
    200,
    `OK ${device.number} ${device.sessionId} ${registry.HEARTBEAT_MS} ${registry.HEARTBEAT_TIMEOUT_MS}`
  );
});

router.get('/api/agent/stream', (req, res, context) => {
  const streamDevice = registry.bySession(context.query.get('session'));
  const nodeId = streamDevice ? streamDevice.number : Number(context.query.get('device'));

  if (!streamDevice) {
    log.deny('stream refused', { node: nodeId, reason: 'bad_session', from: context.address });
    return text(res, 401, 'REJECT bad_session');
  }

  // Read the scene before attaching: attaching is what makes the node online, and the
  // scene we want is the one Core last asked for, from before the connection dropped.
  const previousScene = (registry.get(nodeId) || {}).scene;

  registry.attachAgent(nodeId, new bus.Connection(res, { nodeId }));

  // A node that reconnects mid-demo should come back to whatever it was showing, not to
  // a bare desktop — otherwise a Wi-Fi blip looks like an unplanned release. Routed
  // through takeover() rather than written straight to the socket so the resume is
  // tracked, logged, and acknowledged like any other command.
  if (previousScene && previousScene !== 'normal') {
    log.info('restoring scene after reconnect', { node: nodeId, scene: previousScene });
    commands.takeover(nodeId, auth, { source: 'reconnect' }, previousScene);
  }
});

router.post('/api/agent/heartbeat', async (req, res) => {
  const body = await readBody(req);
  if (!body) return text(res, 400, 'REJECT malformed_body');

  // Resolve by session, never by the number the agent sent: after a renumber the agent's
  // copy is stale through no fault of its own, and trusting it would credit the heartbeat
  // to whichever device now holds that number.
  const device = registry.bySession(body.session);
  if (!device) return text(res, 401, 'REJECT bad_session');
  const nodeId = device.number;

  registry.heartbeat(nodeId, {
    state: body.state,
    overlay: body.overlay === '1' || body.overlay === 1 || body.overlay === true,
    awake: body.awake === '1' || body.awake === 1 || body.awake === true,
    net: body.net === undefined ? undefined : body.net === '1' || body.net === 1 || body.net === true,
    seq: body.seq !== undefined ? Number(body.seq) : undefined,
    rtt: body.rtt !== undefined ? Number(body.rtt) : undefined,
  });

  return text(res, 200, `OK ${Date.now()}`);
});

router.post('/api/agent/ack', async (req, res) => {
  const body = await readBody(req);
  if (!body) return text(res, 400, 'REJECT malformed_body');

  const device = registry.bySession(body.session);
  if (!device) return text(res, 401, 'REJECT bad_session');
  const nodeId = device.number;

  commands.acknowledge(nodeId, body.cid, body.status || 'success', body.msg || null);
  return text(res, 200, 'OK');
});

// --- Overlay channel ---------------------------------------------------------------

router.get('/api/overlay/stream', (req, res, context) => {
  const nodeId = Number(context.query.get('device'));
  const ticket = context.query.get('ticket');

  const redeemed = auth.redeemTicket(ticket, 'overlay', nodeId);
  if (!redeemed.ok) {
    log.deny('overlay stream refused', { node: nodeId, reason: redeemed.reason, from: context.address });
    return text(res, 401, 'REJECT ' + redeemed.reason);
  }

  const connection = new bus.Connection(res, { nodeId, kind: 'overlay' });
  registry.attachOverlay(nodeId, connection);

  const node = registry.get(nodeId);
  connection.sendJson('hello', {
    device: nodeId,
    label: node ? node.hostname : String(nodeId),
    os: node ? node.os : 'unknown',
    isWall: registry.isWall(nodeId),
    scene: node ? node.scene : 'normal',
    order: registry.ids(),

    // Tickets are single use, so the one that authorised this connection is now spent. An
    // overlay holds no admin token and could not mint another, which would make any
    // dropped stream permanent. Hand it the next one now: each reconnect spends one
    // ticket and receives its replacement.
    renew: auth.issueTicket('overlay', nodeId).ticket,
  });

  // The wall is a node whose overlay shows the room rather than a scene (DEVIATIONS.md
  // D5), so it needs the state feed the observers get. Subscribing here rather than
  // giving MAIN an observer ticket keeps the overlay's authority scoped to one screen.
  if (registry.isWall(nodeId)) {
    wallOverlays.add(connection);
    connection.sendJson('state', registry.snapshot());

    // Replay recent activity, exactly as the observer channel does. Without it the wall
    // appears with an empty SYSTEM ACTIVITY panel and fills in only from whatever happens
    // next — so everything the operator did during setup is invisible on the one surface
    // built to show it.
    for (const entry of log.recent(20)) connection.sendJson('activity', entry);
    const previousOnClose = connection.onClose;
    connection.onClose = (closed) => {
      wallOverlays.delete(connection);
      if (previousOnClose) previousOnClose(closed);
    };
  }
});

// --- Observer channel --------------------------------------------------------------

router.get('/api/events', (req, res, context) => {
  const redeemed = auth.redeemTicket(context.query.get('ticket'), 'observer');
  if (!redeemed.ok) {
    log.deny('event stream refused', { reason: redeemed.reason, from: context.address });
    return text(res, 401, 'REJECT ' + redeemed.reason);
  }

  const connection = observers.attach(res, { kind: 'observer' });
  connection.sendJson('state', registry.snapshot());
  for (const entry of log.recent(40)) connection.sendJson('activity', entry);
});

// --- Authentication ----------------------------------------------------------------

router.post('/api/auth/ticket', (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  json(res, 200, auth.issueTicket('observer'));
});

// --- Control API (§26) --------------------------------------------------------------

router.get('/api/devices', (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  json(res, 200, { ok: true, ...registry.snapshot(), apps: validate.appNames() });
});

/** Kept so an old controller or MCP build keeps working after an upgrade mid-rehearsal. */
router.get('/api/nodes', (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  json(res, 200, { ok: true, ...registry.snapshot(), apps: validate.appNames() });
});

/** Mute or unmute speech, per device or across the room. */
router.post('/api/mute', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });
  const muted = Boolean(body.muted);
  const target = body.target ? String(body.target) : 'ALL';

  // ALL means everything that can make a noise, including JARVIS's own voice. Muting the
  // devices but leaving Core talking would be the opposite of what the button says.
  if (target.toUpperCase() === 'ALL' || target.toLowerCase() === 'core') {
    voice.setEnabled(!muted);
    if (muted) voice.silence();
  }

  const result = target.toLowerCase() === 'core'
    ? { ok: true, target: 'core', muted, changed: ['core'] }
    : commands.setMuted(target, muted);

  json(res, 200, result);
});

/**
 * Give a device a different number.
 *
 * Swaps with whatever holds the destination number, so the room always has a clean 1..n
 * with no gaps and no machine renumbered that the operator did not touch.
 */
router.post('/api/renumber', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  const from = registry.resolve(body.device);
  if (!from.ok || from.all) return json(res, 400, { ok: false, error: 'device_unknown' });

  const result = registry.renumber(from.number, Number(body.to));
  json(res, result.ok ? 200 : 400, result.ok ? { ok: true, ...result } : { ok: false, error: result.reason });
});

/** Designate which device shows the Command Wall — the one the operator calls "main". */
router.post('/api/wall', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  const resolved = registry.resolve(body.device);
  if (!resolved.ok || resolved.all) return json(res, 400, { ok: false, error: 'device_unknown' });

  registry.claimWall(resolved.number);
  json(res, 200, { ok: true, wall: resolved.number });
});

/** Forget a device entirely — the operator's way to remove one that should not be here. */
router.post('/api/forget', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  const resolved = registry.resolve(body.device);
  if (!resolved.ok || resolved.all) return json(res, 400, { ok: false, error: 'device_unknown' });

  json(res, 200, { ok: registry.forget(resolved.number), device: resolved.number });
});

router.post('/api/command', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  json(
    res,
    200,
    commands.dispatch(body.target, body.action, body.args || {}, { source: 'api' })
  );
});

router.post('/api/takeover', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  json(res, 200, commands.takeover((body && body.target) || 'ALL', auth, { source: 'api' }));
});

router.post('/api/release', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  json(res, 200, commands.release((body && body.target) || 'ALL', { source: 'api' }));
});

router.post('/api/scene', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });
  json(res, 200, commands.scene(body.target || 'ALL', body.scene, { source: 'api' }));
});

router.post('/api/broadcast', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });
  json(res, 200, commands.broadcast(body.scene || 'jarvis', { source: 'api' }));
});

router.post('/api/move', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  const destination = registry.resolve(body.to);
  if (!destination.ok || destination.all) {
    return json(res, 400, { ok: false, error: destination.reason || 'device_unknown' });
  }

  // Default source is wherever JARVIS actually is, so "move to three" means "from where you
  // are" rather than from a fixed machine that may not be the one showing it.
  let from = null;
  if (body.from) {
    const source = registry.resolve(body.from);
    if (!source.ok || source.all) return json(res, 400, { ok: false, error: 'device_unknown' });
    from = source.number;
  } else {
    const here = registry.jarvisDevice();
    from = here ? here.number : null;
  }

  if (from === null) return json(res, 400, { ok: false, error: 'jarvis_is_nowhere' });
  if (from === destination.number) {
    return json(res, 200, { ok: true, from, to: from, dispatched: [], skipped: [], note: 'already there' });
  }

  json(res, 200, commands.move(from, destination.number, { source: 'api' }));
});

router.post('/api/cascade', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  json(
    res,
    200,
    commands.cascade((body && body.effect) || 'arc_reactor', { source: 'api' }, Boolean(body && body.reverse))
  );
});

/**
 * Mint an overlay URL for a node without commanding anything.
 *
 * The operator's escape valve. If a node's overlay is closed by accident, or the presenter
 * wants the Command Wall on a second screen, or a scene needs checking during setup, this
 * hands back a ticketed URL to paste into any browser. It issues no command and moves no
 * screen, so it is safe to call while the demo is running.
 */
router.post('/api/overlay/url', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  const nodeId = String(body.node || '').trim().toUpperCase();
  if (!registry.has(nodeId)) return json(res, 400, { ok: false, error: 'node_unknown' });

  const scene = body.scene ? validate.checkScene(body.scene) : null;
  if (scene && !scene.ok) return json(res, 400, { ok: false, error: scene.reason });

  json(res, 200, {
    ok: true,
    node: nodeId,
    url: commands.overlayUrl(nodeId, auth, scene ? scene.value : null),
    expiresIn: auth.TICKET_TTL_MS / 1000,
  });
});

router.post('/api/identify', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });
  json(res, 200, commands.identify(body.target, auth, { source: 'api' }));
});

/**
 * Act on something JARVIS heard.
 *
 * The fixed demo commands are matched here and dispatched immediately; anything else goes
 * to the model. Shared by the microphone and by any client that wants to send a sentence,
 * so both take exactly the same path.
 */
/**
 * Said the moment a question goes to the model, before it has answered.
 *
 * Warmed in phrases.json, so it is a disk read rather than a synthesis. If it ever drifts
 * out of that list, core/test/phrases.test.js fails — the whole point of it is to be
 * instant, and an unwarmed version would arrive after the answer it was meant to precede.
 */
const ACKNOWLEDGEMENT = 'One moment, sir.';

/**
 * How long JARVIS keeps listening after it has answered a question.
 *
 * The wake word exists so the presenter can talk to a room for half an hour without every
 * sentence becoming a model call. It is not meant to make conversation absurd — having to
 * say the name again to ask "and what about the other one?" is not how anyone talks.
 *
 * So answering a question leaves the door open for a while. A fixed command does not: that
 * is fire and forget, said on the way back to addressing the audience.
 *
 * Twenty seconds is long enough to think of the follow-up and short enough that going back
 * to presenting costs at most one stray model call.
 */
const FOLLOW_UP_MS = 20_000;

let conversationUntil = 0;
let thinking = false;

async function handleUtterance(text, source) {
  const heard = String(text || '').trim();
  if (!heard) return { ok: false, error: 'empty' };

  // resolve rather than has, so "identify ravi" works as well as "identify two" — has only
  // understands numbers, and a spoken hostname is the natural way to refer to a teammate.
  const intent = intents.match(heard, (device) => registry.resolve(device).ok);

  // Addressed by name, or still inside the window opened by the last time it was.
  const addressed = intents.addressed(heard) || Date.now() < conversationUntil;

  // Say what is about to happen with it, so the phone can show the difference between a
  // command, a question being thought about, and speech that was simply not for JARVIS.
  // A live microphone that ignores you must never look like a dead one.
  const status = intent ? 'command' : addressed ? 'thinking' : 'ignored';
  observers.broadcast('heard', { text: heard, at: Date.now(), source, status });

  // A fixed command does not open the window.
  //
  // "Take the room" is fire and forget — the presenter says it and goes straight back to
  // talking to the audience, and treating the next half minute of that as conversation
  // would put every sentence of it through the model. That is the exact thing the wake word
  // exists to prevent. Only a question opens a conversation, because only a question is one.
  if (intent) conversationUntil = 0;

  if (intent) {
    if (intent.answer === 'count') {
      const online = registry.onlineDevices().length;
      // Spelled out, not a digit: this is the exact string phrases.json warms, so the
      // answer comes from the cache at full quality rather than costing a live synthesis.
      const line = online === 0 ? 'No systems are online, sir.'
        : online === 1 ? 'One authorized system is online.'
        : `${intents.numberWord(online)} authorized systems are online.`;
      commands.speakAsJarvis(line, { source });
      return { ok: true, matched: intent.name, spoken: line };
    }

    if (intent.say) commands.speakAsJarvis(intent.say, { source });

    // Dispatched through the same functions the controller's buttons use, so a spoken
    // command and a tapped one cannot behave differently.
    const result = dispatchIntent(intent, source);
    return { ok: true, matched: intent.name, label: intent.label, ...result };
  }

  // Not a fixed command. The model only gets it if it was addressed to JARVIS — the
  // microphone is open while the presenter talks to an audience, and without this every
  // sentence of the talk became a model call that could reach for the room's tools.
  if (status === 'ignored') {
    return { ok: true, ignored: true, reason: 'not_addressed', heard };
  }

  // One at a time. ears.js no longer waits for this to finish before listening again, so
  // without a guard a run of questions would start a pile of concurrent agy processes on
  // the machine that is also driving the room.
  if (thinking) {
    log.info('still thinking; ignoring', { heard: heard.slice(0, 80) });
    return { ok: false, error: 'busy', heard };
  }
  thinking = true;

  // Say something immediately.
  //
  // The model takes a couple of seconds even warm, and silence is the worst possible
  // response on a stage — the presenter cannot tell whether they were heard, so they repeat
  // themselves into a room that is already working on it. This line is warmed, so it costs
  // a disk read and starts almost at once.
  commands.speakAsJarvis(ACKNOWLEDGEMENT, { source });

  // Counted after the acknowledgement, so only speech the model asks for lands between here
  // and the comparison below.
  const spokenBefore = commands.speechCount();

  const answered = await ask.ask(heard).finally(() => {
    thinking = false;
    // Measured from the end of the answer, not the start of the question — the follow-up
    // comes after JARVIS has finished speaking, not while it is still thinking.
    conversationUntil = Date.now() + FOLLOW_UP_MS;
  });

  // The model can speak for itself through the MCP speak tool. If it did, repeating the
  // answer would say everything twice.
  if (answered.ok && answered.answer && commands.speechCount() === spokenBefore) {
    commands.speakAsJarvis(answered.answer, { source });
  }

  // A failure is still worth hearing; otherwise a dead agy is indistinguishable from being
  // ignored, and the presenter just repeats themselves into a room that will never answer.
  if (!answered.ok && answered.detail) {
    commands.speakAsJarvis(answered.detail, { source });
  }

  return { ok: answered.ok, viaModel: true, ...answered };
}

/** Turn a matched intent into the command it stands for. */
function dispatchIntent(intent, source) {
  const context = { source };
  const body = intent.body || {};

  switch (intent.route) {
    case '/api/takeover': return commands.takeover(body.target, auth, context);
    case '/api/release': return commands.release(body.target, context);
    case '/api/identify': return commands.identify(body.target, auth, context);
    case '/api/scene': return commands.scene(body.target, body.scene, context);
    case '/api/broadcast': return commands.broadcast(body.scene, context);
    case '/api/cascade': return commands.cascade(body.effect, context);
    case '/api/move': {
      const to = registry.resolve(body.to);
      const here = registry.jarvisDevice();
      if (!to.ok || to.all || !here) return { ok: false, error: 'device_unknown' };
      if (here.number === to.number) return { ok: true, note: 'already there' };
      return commands.move(here.number, to.number, context);
    }
    default: return { ok: false, error: 'no_route' };
  }
}

/**
 * The microphone on this machine.
 *
 * The phone's mic button calls this. It does not capture anything itself — Core hears,
 * Core transcribes, Core decides. The phone is a remote for that.
 */
router.post('/api/mic', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  const wanted = body.on === true || body.on === 'true' || body.on === 1;
  const result = wanted ? ears.start((text) => handleUtterance(text, 'mic')) : ears.stop();

  observers.broadcast('state', registry.snapshot());
  json(res, 200, { ...result, ...ears.describe() });
});

router.get('/api/mic', (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  json(res, 200, { ok: true, ...ears.describe() });
});

/** Send a sentence as if it had been heard. The text box beside the mic uses this. */
router.post('/api/utterance', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });
  json(res, 200, await handleUtterance(body.text, 'typed'));
});

/**
 * Put a sentence to the model.
 *
 * The far end of the microphone. The controller recognises the fixed demo commands itself
 * and dispatches them instantly; anything else arrives here, goes to agy, and comes back
 * having called whatever MCP tools it decided on.
 *
 * The answer is spoken as well as returned — the presenter is holding a phone, not reading
 * it — but only if the model did not already speak for itself through the speak tool, which
 * is the usual case and would otherwise say everything twice.
 */
router.post('/api/ask', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  const spokenBefore = commands.speechCount();

  const result = await ask.ask(body.text);

  // Exact rather than inferred from cache counters — see commands.speechCount().
  if (result.ok && result.answer && commands.speechCount() === spokenBefore) {
    commands.speakAsJarvis(result.answer, { source: 'ask' });
  }

  json(res, 200, result);
});

/**
 * Speak.
 *
 * Defaults to JARVIS's own voice on this machine rather than to any device. Passing an
 * explicit target still sends it to devices, which is what "every laptop says it at once"
 * needs — but the ordinary case is one voice, here.
 */
router.post('/api/speak', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  const target = body.target ? String(body.target).toLowerCase() : 'core';

  if (target === 'core' || target === 'jarvis') {
    return json(res, 200, commands.speakAsJarvis(body.text, { source: 'api' }));
  }

  json(
    res,
    200,
    commands.dispatch(body.target, 'speak', { text: body.text, voice: body.voice }, { source: 'api' })
  );
});

/**
 * The lines JARVIS is expected to say.
 *
 * Served so the controller's buttons and scripts/warm-voice.sh read one list. Warming the
 * cache from a different list than the buttons use would leave exactly the lines the demo
 * needs uncached, which is the failure this prevents.
 */
router.get('/api/phrases', (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;

  let list = { phrases: [], counts: [] };
  try {
    const raw = JSON.parse(fsp.readFileSync(options.phrases, 'utf8'));
    list = { phrases: raw.phrases || [], counts: raw.counts || [] };
  } catch (err) {
    log.warn('could not read phrases.json', { error: err.message });
  }

  // Tell the caller which are already cached, so the controller can show what will be
  // instant and the warmer knows what is left to do.
  const cached = [...list.phrases, ...list.counts].filter((line) => voice.isCached(line));
  json(res, 200, { ok: true, ...list, cached: cached.length });
});

/** What JARVIS's voice is doing, and the personality it is running. */
router.get('/api/voice', (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  json(res, 200, {
    ok: true,
    ...voice.describe(),
    personality: personality.summary(),
    ask: ask.describe(),
    ears: ears.describe(),
  });
});

/**
 * The personality.
 *
 * Served so the MCP server — and anything else driving the room — reads the same file the
 * operator edits, without needing to share a filesystem with Core.
 */
router.get('/api/personality', (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  json(res, 200, { ok: true, ...personality.get() });
});

/**
 * Add something to JARVIS's memory.
 *
 * Appended to memory.md under a marked heading, so it survives a restart and it is obvious
 * later which lines a human wrote and which the model added.
 */
router.post('/api/remember', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  const noted = personality.remember(body.text);
  if (noted.ok) personality.load(options.personality, options.memory);
  json(res, noted.ok ? 200 : 400, noted);
});

/** Re-read personality.md without restarting Core, so it can be tuned during rehearsal. */
/**
 * Pick up an edited personality without a restart.
 *
 * Re-priming matters as much as re-reading. agy is told who it is once, as the first turn
 * of the conversation Core keeps open — so a personality reloaded into Core but not into
 * agy changes nothing the model does, which looks exactly like the edit having no effect.
 */
router.post('/api/personality/reload', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;

  const loaded = personality.load(options.personality, options.memory);
  ask.init({ cwd: path.join(__dirname, '..'), instructions: personality.get().body });

  // A fresh conversation, because the old one still has the old personality in its context.
  ask.stop();
  const warmed = await ask.warm();

  json(res, 200, { ok: true, ...loaded, model: warmed.ok ? 'reprimed' : (warmed.error || 'not_repriming') });
});

// --- Enrollment (§7) -----------------------------------------------------------------

/**
 * The line a teammate pastes.
 *
 * Serving the agent over HTTP is what removes the entire packaging problem: a script
 * piped from curl is never quarantined, so Gatekeeper and SmartScreen never appear. See
 * DEVIATIONS.md D1.
 */
/**
 * Serve an agent with Core's own address baked in.
 *
 * A script arriving down a pipe has no idea where it came from, and a teammate should not
 * have to type an IP address they cannot see. Substituting here means the pasted line
 * carries only the two things that are actually theirs — node and token.
 */
function serveAgent(res, filename) {
  let source;
  try {
    source = fsp.readFileSync(path.join(AGENT_DIR, filename), 'utf8');
  } catch {
    return text(res, 404, 'agent not found');
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  // Both substitutions are what reduce the teammate's job to pasting one line: the script
  // arrives already knowing where Core is and how to authenticate. Anyone who can fetch
  // this can enroll, which is exactly the model — see DEVIATIONS.md D8.
  res.end(
    source
      .split('@@CORE_URL@@').join(origin)
      .split('@@JOIN_SECRET@@').join(auth.joinSecret())
  );
}

router.get('/join', (req, res) => serveAgent(res, 'jarvis-agent.sh'));
router.get('/join.ps1', (req, res) => serveAgent(res, 'jarvis-agent.ps1'));

// --- Static UI -------------------------------------------------------------------------

router.get('/', (req, res) => {
  res.writeHead(302, { Location: '/control/' });
  res.end();
});

router.get('/healthz', (req, res) => {
  const snapshot = registry.snapshot();
  text(res, 200, `ok devices=${snapshot.summary.online}/${snapshot.summary.known}`);
});

router.otherwise((req, res, context) => {
  if (req.method !== 'GET') return text(res, 405, 'method not allowed');
  serveStatic(res, PUBLIC_DIR, context.pathname);
});

// ---------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  router.handle(req, res).catch((err) => {
    log.error('request handler threw', { path: req.url, error: err.message });
    if (!res.headersSent) json(res, 500, { ok: false, error: 'internal_error' });
  });
});

// SSE connections are long-lived by definition; the default 5s header timeout and 2m
// keep-alive would tear down the agent channel on a schedule.
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;

server.listen(options.port, options.host, () => {
  const network = auth.wifi();

  console.log('');
  console.log('    J.A.R.V.I.S.  CORE');
  console.log('');
  console.log(`    listening   ${options.host}:${options.port}`);
  console.log(`    origin      ${origin}`);
  console.log(`    network     ${network.ssid}`);
  console.log(`    apps        ${validate.appNames().join('  ')}`);
  console.log('');
  console.log(`    wall        ${origin}/wall/`);
  console.log(`    control     ${origin}/control/`);
  console.log('');
  console.log('    every teammate runs the same line — no name, no token:');
  console.log('');
  console.log(`      macOS    curl -s ${origin}/join | bash`);
  console.log(`      Windows  iwr ${origin}/join.ps1 -UseBasicParsing | iex`);
  console.log('');
  console.log('    devices are numbered 1, 2, 3 ... in the order they join.');
  console.log('');

  if (options.host === '0.0.0.0') {
    log.warn('bound to all interfaces; pass --host <AP address> to restrict to JARVIS-NET');
  }
});

server.on('error', (err) => {
  console.error(`\nJARVIS Core could not listen on ${options.host}:${options.port}\n  ${err.message}\n`);
  process.exit(1);
});

/**
 * Release the room on the way out.
 *
 * SPEC.md §33 wants release always available; the case it does not name is Core itself
 * going away. Without this, Ctrl+C on the Kali laptop would leave every teammate staring
 * at a fullscreen overlay whose only remaining exit is the local escape gesture. The
 * agents would eventually notice and self-close, but "eventually" is not a thing to rely
 * on with an audience watching.
 */
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('');
  log.warn(`${signal} — releasing the room before exit`);
  ears.stop();
  ears.stopServer();
  ask.stop();
  voice.silence();
  commands.release('ALL', { source: 'shutdown' });

  // Give the writes a moment to reach the sockets, then go regardless.
  setTimeout(() => {
    observers.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }, 400);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
