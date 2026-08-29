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
 *   node core/server.js --config core/config/nodes.json --host 10.42.0.1 --port 3000
 *
 * Ctrl+C releases the room before exiting. Losing Core should never leave a teammate
 * looking at a black screen.
 */

const fsp = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

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
    phrases: path.join(__dirname, 'config', 'phrases.json'),
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
      case '--phrases':
        options.phrases = path.resolve(value);
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

// ---------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------

try {
  const config = auth.load(options.config);
  validate.loadApps(options.apps);
  voice.init(config.voice || {});
  personality.load(options.personality);
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
  const nodeId = Number(context.query.get('device'));
  const sessionId = context.query.get('session');

  if (!registry.sessionValid(nodeId, sessionId)) {
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

  const nodeId = Number(body.device);
  if (!registry.sessionValid(nodeId, body.session)) return text(res, 401, 'REJECT bad_session');

  registry.heartbeat(nodeId, {
    state: body.state,
    overlay: body.overlay === '1' || body.overlay === 1 || body.overlay === true,
    awake: body.awake === '1' || body.awake === 1 || body.awake === true,
    seq: body.seq !== undefined ? Number(body.seq) : undefined,
    rtt: body.rtt !== undefined ? Number(body.rtt) : undefined,
  });

  return text(res, 200, `OK ${Date.now()}`);
});

router.post('/api/agent/ack', async (req, res) => {
  const body = await readBody(req);
  if (!body) return text(res, 400, 'REJECT malformed_body');

  const nodeId = Number(body.device);
  if (!registry.sessionValid(nodeId, body.session)) return text(res, 401, 'REJECT bad_session');

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

  const from = String(body.from || choreography.homeNode()).toUpperCase();
  const to = String(body.to || '').toUpperCase();
  if (!registry.has(to)) return json(res, 400, { ok: false, error: 'node_unknown' });

  json(res, 200, commands.move(from, to, { source: 'api' }));
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
  json(res, 200, { ok: true, ...voice.describe(), personality: personality.summary() });
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

/** Re-read personality.md without restarting Core, so it can be tuned during rehearsal. */
router.post('/api/personality/reload', (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  json(res, 200, { ok: true, ...personality.load(options.personality) });
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
