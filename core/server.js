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

const auth = require('./lib/auth');
const bus = require('./lib/bus');
const choreography = require('./lib/choreography');
const commands = require('./lib/commands');
const httpLib = require('./lib/http');
const log = require('./lib/log');
const registry = require('./lib/registry');
const validate = require('./lib/validate');

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
    config: path.join(__dirname, 'config', 'nodes.json'),
    apps: path.join(__dirname, 'config', 'apps.json'),
    layout: path.join(__dirname, 'config', 'layout.json'),
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
      case '--help':
      case '-h':
        console.log(
          'Usage: node core/server.js [--host ADDR] [--port N] [--config PATH]\n' +
            '  --host    interface to bind (default 0.0.0.0; use the AP address to harden)\n' +
            '  --port    default 3000\n' +
            '  --config  node registry (default core/config/nodes.json)\n'
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

let registryConfig;
try {
  registryConfig = auth.load(options.config);
  validate.loadApps(options.apps);
  const layout = require(options.layout);
  choreography.init(layout);
  registry.init(registryConfig.nodes, layout);
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
log.subscribe((entry) => observers.broadcast('activity', entry));

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

  const nodeId = String(body.node || '').trim().toUpperCase();
  const result = auth.authenticateNode(nodeId, body.token, context.address);
  if (!result.ok) return text(res, 401, `REJECT ${result.reason}`);

  const sessionId = registry.openSession(nodeId, {
    os: String(body.os || 'unknown').toLowerCase(),
    hostname: body.host || null,
    agentVersion: body.agent || null,
    capabilities: String(body.caps || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean),
  });

  if (!sessionId) return text(res, 500, 'REJECT registry_error');

  // The agent needs both intervals so its timing follows Core rather than a local
  // constant that could drift out of agreement across a release.
  return text(
    res,
    200,
    `OK ${sessionId} ${registry.HEARTBEAT_MS} ${registry.HEARTBEAT_TIMEOUT_MS}`
  );
});

router.get('/api/agent/stream', (req, res, context) => {
  const nodeId = String(context.query.get('node') || '').trim().toUpperCase();
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

  const nodeId = String(body.node || '').trim().toUpperCase();
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

  const nodeId = String(body.node || '').trim().toUpperCase();
  if (!registry.sessionValid(nodeId, body.session)) return text(res, 401, 'REJECT bad_session');

  commands.acknowledge(nodeId, body.cid, body.status || 'success', body.msg || null);
  return text(res, 200, 'OK');
});

// --- Overlay channel ---------------------------------------------------------------

router.get('/api/overlay/stream', (req, res, context) => {
  const nodeId = String(context.query.get('node') || '').trim().toUpperCase();
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
    node: nodeId,
    label: node ? node.label : nodeId,
    role: node ? node.role : 'node',
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
  if (node && node.role === 'wall') {
    wallOverlays.add(connection);
    connection.sendJson('state', registry.snapshot());
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

router.get('/api/nodes', (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  json(res, 200, { ok: true, ...registry.snapshot(), apps: validate.appNames() });
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

router.post('/api/identify', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });
  json(res, 200, commands.identify(body.target, auth, { source: 'api' }));
});

router.post('/api/speak', async (req, res, context) => {
  if (!requireAdmin(req, res, context)) return;
  const body = await readBody(req);
  if (!body) return json(res, 400, { ok: false, error: 'malformed_body' });

  json(
    res,
    200,
    commands.dispatch(
      body.target || choreography.homeNode(),
      'speak',
      { text: body.text, voice: body.voice },
      { source: 'api' }
    )
  );
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
  res.end(source.split('@@CORE_URL@@').join(origin));
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
  text(res, 200, `ok nodes=${snapshot.summary.online}/${snapshot.summary.configured}`);
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
  const nodeIds = registry.ids();

  console.log('');
  console.log('    J.A.R.V.I.S.  CORE');
  console.log('');
  console.log(`    listening   ${options.host}:${options.port}`);
  console.log(`    origin      ${origin}`);
  console.log(`    nodes       ${nodeIds.join('  ')}`);
  console.log(`    apps        ${validate.appNames().join('  ')}`);
  console.log('');
  console.log(`    wall        ${origin}/wall/`);
  console.log(`    control     ${origin}/control/`);
  console.log('');
  console.log('    teammates run:');
  console.log(`      macOS    curl -s ${origin}/join | bash -s <NODE> <TOKEN>`);
  console.log(`      Windows  iwr ${origin}/join.ps1 -UseBasicParsing | iex`);
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
