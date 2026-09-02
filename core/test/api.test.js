'use strict';

/**
 * End-to-end API test.
 *
 * Boots a real Core on a spare port, enrols real devices over HTTP, attaches real agent and
 * overlay streams, and then calls every endpoint the server defines.
 *
 * The important part is that the route list is **read out of server.js**, not written here.
 * A new endpoint that nobody adds a case for fails the run. Every bug this suite exists
 * because of — `registry.onlineNodes is not a function`, a move that resolved to a name
 * that no longer existed — was a route that worked when it was written and quietly stopped
 * working when something was renamed underneath it. A hand-maintained list would have
 * rotted the same way.
 *
 *   node core/test/api.test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 3877;
const BASE = `http://127.0.0.1:${PORT}`;

const ADMIN = 'test-admin-password';
const JOIN = 'test-join-secret';

let core = null;
const streams = [];
let failures = 0;
let checks = 0;

function check(name, ok, detail) {
  checks++;
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------------------------
 * Route discovery
 * ------------------------------------------------------------------------------------ */

/**
 * Every route server.js registers.
 *
 * Parsed from the source rather than imported, because importing would start a server.
 */
function declaredRoutes() {
  const source = fs.readFileSync(path.join(ROOT, 'core', 'server.js'), 'utf8');
  const routes = [];
  for (const match of source.matchAll(/router\.(get|post)\(\s*'([^']+)'/g)) {
    routes.push(`${match[1].toUpperCase()} ${match[2]}`);
  }
  return [...new Set(routes)];
}

/* ---------------------------------------------------------------------------------------
 * Core lifecycle
 * ------------------------------------------------------------------------------------ */

async function startCore() {
  // A throwaway .env, so the test never depends on — or disturbs — the operator's own.
  const envFile = path.join(os.tmpdir(), `jarvis-test-${process.pid}.env`);
  fs.writeFileSync(
    envFile,
    [
      `JARVIS_ADMIN_PASSWORD=${ADMIN}`,
      `JARVIS_JOIN_SECRET=${JOIN}`,
      'JARVIS_WIFI_PASSWORD=test-passphrase',
      // No key, so nothing here reaches the network or spends anyone's quota.
      'GEMINI_API_KEY=',
      // Deliberately not pinning a provider. This used to force espeak, which meant the
      // suite only passed on machines that happened to have espeak — the demo laptop has
      // spd-say and not espeak, so a working room reported that it could not speak.
      // Whatever local synthesiser exists is the right one to exercise.
    ].join('\n') + '\n'
  );

  // A scratch memory file, so exercising `remember` does not append test noise to the
  // operator's own notes every time the suite runs.
  const memoryFile = path.join(os.tmpdir(), `jarvis-test-${process.pid}-memory.md`);
  fs.writeFileSync(memoryFile, '# Test memory\n');

  core = spawn(
    process.execPath,
    [
      path.join(ROOT, 'core', 'server.js'),
      '--host', '127.0.0.1',
      '--port', String(PORT),
      '--env', envFile,
      '--memory', memoryFile,
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  core.memoryFile = memoryFile;

  core.envFile = envFile;
  core.log = '';
  core.stdout.on('data', (c) => (core.log += c));
  core.stderr.on('data', (c) => (core.log += c));

  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${BASE}/healthz`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`Core did not start:\n${core.log}`);
}

function stopCore() {
  for (const beat of beats) clearInterval(beat);
  for (const controller of streams) {
    try {
      controller.abort();
    } catch {
      /* already gone */
    }
  }
  if (core) {
    try {
      core.kill('SIGKILL');
    } catch {
      /* gone */
    }
    for (const file of [core.envFile, core.memoryFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* gone */
      }
    }
  }
}

/* ---------------------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------------------ */

const called = new Set();

/** Heartbeat timers, so they can be stopped when the suite finishes. */
const beats = [];

/**
 * Hold an event stream open the way a real client does — by reading it.
 *
 * `fetch()` alone is not enough. Its Response carries an unread body, and an unread body is
 * a connection the runtime is entitled to tear down; when it does, Core sees the socket
 * close and marks the device offline. That is correct behaviour on Core's part and a bug in
 * the harness, and it surfaced as unrelated checks failing with "offline" on a slow machine
 * while passing on a fast one.
 */
function hold(url) {
  const controller = new AbortController();
  streams.push(controller);

  fetch(url, { signal: controller.signal })
    .then(async (response) => {
      const reader = response.body.getReader();
      // Drain until aborted. The bytes are not interesting; consuming them is.
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    })
    .catch(() => {
      /* aborted at teardown, or Core went away */
    });

  return controller;
}

async function api(method, route, body, token = ADMIN) {
  called.add(`${method} ${route.split('?')[0]}`);
  const options = { method, headers: {} };
  if (token) options.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${route}`, options);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

/** Enrol a device the way an agent does, and hold its command stream open. */
async function enrol(hostname, deviceOs, wall = false) {
  const body = new URLSearchParams({
    secret: JOIN,
    os: deviceOs,
    host: hostname,
    wall: wall ? '1' : '0',
    caps: 'takeover,release,identify,open_url,open_app,speak,set_volume',
    agent: 'test',
  });
  called.add('POST /api/agent/register');

  const response = await fetch(`${BASE}/api/agent/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const [status, number, session] = (await response.text()).trim().split(/\s+/);
  if (status !== 'OK') throw new Error(`enrol ${hostname}: ${status} ${number}`);

  // Hold the stream. Presence follows this connection, so dropping it drops the device.
  called.add('GET /api/agent/stream');
  hold(`${BASE}/api/agent/stream?device=${number}&session=${session}`);

  // Beat like a real agent does.
  //
  // Holding the socket open is not enough: Core drops a device that stops heartbeating,
  // because a live socket with a wedged client behind it is exactly the case presence has
  // to catch. Without this the suite passed only on a machine fast enough to finish inside
  // that window — on a slower one the devices were swept mid-run and three unrelated checks
  // failed with "offline", which is a confusing way to learn the harness was unfaithful.
  let seq = 0;
  const beat = setInterval(() => {
    seq += 1;
    fetch(`${BASE}/api/agent/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, state: 'idle', overlay: '0', awake: '1', seq }),
    }).catch(() => {});
  }, 4_000);
  beat.unref();
  beats.push(beat);

  return { number: Number(number), session, hostname };
}

/** Attach an overlay stream, so scene commands have somewhere to land. */
async function attachOverlay(device) {
  const minted = await api('POST', '/api/overlay/url', { node: String(device.number) });
  const url = new URL(minted.data.url);
  called.add('GET /api/overlay/stream');
  hold(`${BASE}/api/overlay/stream?device=${device.number}&ticket=${url.searchParams.get('ticket')}`);
  await sleep(250);
}

async function heartbeat(device, extra = {}) {
  called.add('POST /api/agent/heartbeat');
  await fetch(`${BASE}/api/agent/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      device: String(device.number),
      session: device.session,
      state: 'ready',
      overlay: '1',
      awake: '1',
      net: '1',
      seq: '1',
      rtt: '5',
      ...extra,
    }),
  });
}

/* ---------------------------------------------------------------------------------------
 * The run
 * ------------------------------------------------------------------------------------ */

(async () => {
  console.log('\nJARVIS — API integration\n');
  await startCore();

  // --- enrolment ----------------------------------------------------------------------
  console.log('Enrolment');
  const one = await enrol("Karan's Laptop", 'macos', true);
  const two = await enrol('Ravi-PC', 'windows');
  const three = await enrol('anita-mbp', 'macos');
  check('three devices enrol and are numbered 1,2,3', [one.number, two.number, three.number].join() === '1,2,3',
    `got ${[one.number, two.number, three.number].join()}`);

  await Promise.all([heartbeat(one), heartbeat(two), heartbeat(three)]);
  await Promise.all([attachOverlay(one), attachOverlay(two), attachOverlay(three)]);

  const bad = await fetch(`${BASE}/api/agent/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: 'wrong', os: 'macos', host: 'Intruder' }),
  });
  check('a wrong join secret is refused', bad.status === 401);

  // --- reading ------------------------------------------------------------------------
  console.log('\nReading');
  const devices = await api('GET', '/api/devices');
  check('GET /api/devices lists three online', devices.data.summary.online === 3,
    JSON.stringify(devices.data.summary));
  check('the wall is device 1', devices.data.wall === 1, `wall=${devices.data.wall}`);

  check('GET /api/nodes still answers (compat)', (await api('GET', '/api/nodes')).status === 200);
  check('GET /api/voice answers', (await api('GET', '/api/voice')).data.ok === true);
  check('GET /api/personality answers', (await api('GET', '/api/personality')).data.ok === true);
  check('GET /api/phrases answers', Array.isArray((await api('GET', '/api/phrases')).data.phrases));
  check('GET /healthz answers', String((await api('GET', '/healthz', undefined, null)).data).startsWith('ok'));
  check('GET / redirects', (await fetch(`${BASE}/`, { redirect: 'manual' })).status === 302);
  called.add('GET /');

  check('unauthenticated control is refused', (await api('GET', '/api/devices', undefined, null)).status === 401);

  // --- commanding ---------------------------------------------------------------------
  console.log('\nCommanding');
  const expectReach = async (name, route, body, wanted) => {
    const result = await api('POST', route, body);
    const reached = (result.data.dispatched || []).length;
    check(`${name} reached ${wanted}`, result.status === 200 && reached === wanted,
      `status ${result.status}, reached ${reached}, ${JSON.stringify(result.data).slice(0, 140)}`);
  };

  await expectReach('takeover ALL', '/api/takeover', { target: 'ALL' }, 3);
  await expectReach('identify 2', '/api/identify', { target: '2' }, 1);
  await expectReach('identify by hostname', '/api/identify', { target: 'ravi' }, 1);
  await expectReach('scene on 1', '/api/scene', { target: '1', scene: 'reactor' }, 1);
  await expectReach('broadcast (split)', '/api/broadcast', { scene: 'jarvis' }, 3);
  await expectReach('cascade', '/api/cascade', { effect: 'arc_reactor' }, 3);
  await expectReach('open_app', '/api/command', { target: '1', action: 'open_app', args: { app: 'chrome' } }, 1);
  await expectReach('open_url', '/api/command', { target: '1', action: 'open_url', args: { url: 'https://example.com' } }, 1);
  await expectReach('set_volume', '/api/command', { target: '1', action: 'set_volume', args: { level: 50 } }, 1);
  await expectReach('ping', '/api/command', { target: 'ALL', action: 'ping' }, 3);

  const move = await api('POST', '/api/move', { to: '3' });
  check('move with no source resolves', move.status === 200 && (move.data.dispatched || []).length > 0,
    JSON.stringify(move.data).slice(0, 140));

  const speak = await api('POST', '/api/speak', { text: 'Test line.' });
  // A machine with no synthesiser at all is a fact about the machine, not a defect in the
  // room — so it is reported as a skip rather than failing the suite.
  if (speak.data && speak.data.error === 'no_speech_backend') {
    console.log('  \x1b[33m·\x1b[0m speak skipped — this machine has no speech synthesiser');
  } else {
    check('speak in JARVIS’s own voice', speak.status === 200 && 'spoken' in speak.data,
      JSON.stringify(speak.data).slice(0, 140));
  }

  await expectReach('release ALL', '/api/release', { target: 'ALL' }, 3);

  // --- managing -----------------------------------------------------------------------
  console.log('\nManaging');
  check('mute', (await api('POST', '/api/mute', { target: 'ALL', muted: true })).data.ok === true);
  check('unmute', (await api('POST', '/api/mute', { target: 'ALL', muted: false })).data.ok === true);
  check('set the wall to device 2', (await api('POST', '/api/wall', { device: '2' })).data.wall === 2);

  // Somebody has to be the wall. It used to be claimed only by an agent started with
  // --wall, so a room where nobody passed the flag had none at all — the scenes that
  // address it went nowhere and nothing said why. Which device holds it is not the point
  // here; this suite enrols one with the flag deliberately, and an explicit claim wins.
  const room = await api('GET', '/api/devices');
  const holder = (room.data.devices || []).filter((d) => d.isWall);
  check('the room always has a wall, and only one',
    holder.length === 1,
    JSON.stringify((room.data.devices || []).map((d) => [d.number, d.isWall])));

  const renumber = await api('POST', '/api/renumber', { device: '3', to: 1 });
  check('renumber swaps 3 and 1', renumber.data.ok === true && renumber.data.swappedWith,
    JSON.stringify(renumber.data));

  check('overlay/url mints a link', String((await api('POST', '/api/overlay/url', { node: '1' })).data.url).includes('ticket='));
  check('auth/ticket mints a ticket', typeof (await api('POST', '/api/auth/ticket', {})).data.ticket === 'string');
  check('personality reload', (await api('POST', '/api/personality/reload', {})).data.ok === true);

  // agy is optional and slow, so this asserts the route behaves, not that a model answered.
  const asked = await api('POST', '/api/ask', { text: '' });
  check('ask refuses an empty question', asked.status === 200 && asked.data.ok === false,
    JSON.stringify(asked.data));

  const noted = await api('POST', '/api/remember', { text: 'integration test note' });
  check('remember writes to memory', noted.data.ok === true, JSON.stringify(noted.data));
  check('remember refuses an empty note', (await api('POST', '/api/remember', { text: '  ' })).data.ok === false);
  check('forget removes a device', (await api('POST', '/api/forget', { device: '2' })).data.ok === true);

  // --- hearing ------------------------------------------------------------------------
  //
  // The microphone is on this machine, so these assert Core's own listening state rather
  // than anything a browser does. Whether audio hardware exists here is not the test's
  // business — the route has to answer honestly either way.
  console.log('\nHearing');

  const micState = await api('GET', '/api/mic');
  check('mic reports its state', micState.status === 200 && typeof micState.data.available === 'boolean',
    JSON.stringify(micState.data).slice(0, 140));

  const micOn = await api('POST', '/api/mic', { on: true });
  // Listening only becomes true where capture and transcription both exist. On a machine
  // with neither, refusing is the correct answer, and saying so is the point of the route.
  check('mic on is honest about whether it opened',
    micOn.status === 200 && micOn.data.listening === micOn.data.available,
    JSON.stringify(micOn.data).slice(0, 160));

  check('mic off', (await api('POST', '/api/mic', { on: false })).data.listening === false);

  // A sentence Core hears takes the same path whether it arrived by microphone or by text,
  // which is what makes this testable at all.
  const spoken = await api('POST', '/api/utterance', { text: 'jarvis show me the architecture' });
  check('a spoken scene command is matched without the model',
    spoken.data.matched === 'scene' && spoken.data.viaModel === undefined,
    JSON.stringify(spoken.data).slice(0, 160));

  const counted = await api('POST', '/api/utterance', { text: 'jarvis how many are online' });
  check('a spoken question about the room is answered from the registry',
    counted.data.matched === 'count' && typeof counted.data.spoken === 'string',
    JSON.stringify(counted.data).slice(0, 160));

  check('an empty utterance is refused',
    (await api('POST', '/api/utterance', { text: '   ' })).data.error === 'empty');

  // The gate. The microphone stays open while the presenter talks to a room, so speech that
  // is not addressed to JARVIS must not become a model call — each one takes twelve seconds
  // or more, can reach for the room's tools, and speaks its answer over the presenter.
  const aside = await api('POST', '/api/utterance', { text: 'so anyway MQTT is a lightweight protocol' });
  check('speech not addressed to JARVIS never reaches the model',
    aside.data.ignored === true && aside.data.reason === 'not_addressed' && !aside.data.viaModel,
    JSON.stringify(aside.data).slice(0, 160));

  // But a fixed command still needs no wake word — "take the room" has to work bare.
  const bare = await api('POST', '/api/utterance', { text: 'take the room' });
  check('a fixed command still works without being addressed',
    bare.data.matched === 'takeover_all', JSON.stringify(bare.data).slice(0, 160));

  // A command is fire-and-forget, said on the way back to addressing the audience. If it
  // opened a conversation window, the next half minute of presenting would go to the model
  // — the exact thing the wake word exists to prevent.
  const after = await api('POST', '/api/utterance', { text: 'and this is where it gets interesting' });
  check('a command does not leave the room listening for conversation',
    after.data.ignored === true, JSON.stringify(after.data).slice(0, 160));

  // Asking about a subset is not the question the registry can answer. Asked how many
  // Windows machines were connected, it used to reply with the plain total — true of the
  // total, wrong about Windows.
  const qualified = await api('POST', '/api/utterance', { text: 'how many windows devices are there' });
  check('a qualified count is not answered from the registry',
    qualified.data.matched !== 'count', JSON.stringify(qualified.data).slice(0, 160));

  check('the microphone needs the admin password',
    (await api('POST', '/api/mic', { on: true }, null)).status === 401);

  // --- refusals -----------------------------------------------------------------------
  console.log('\nRefusals');
  const refused = async (name, route, body, reason) => {
    const result = await api('POST', route, body);
    const text = JSON.stringify(result.data);
    check(`${name} refused (${reason})`, text.includes(reason), text.slice(0, 160));
  };
  await refused('file:// URL', '/api/command', { target: '1', action: 'open_url', args: { url: 'file:///etc/passwd' } }, 'scheme_not_allowed');
  await refused('non-allowlisted app', '/api/command', { target: '1', action: 'open_app', args: { app: 'hacktool' } }, 'app_not_allowlisted');
  await refused('run_shell', '/api/command', { target: '1', action: 'run_shell', args: {} }, 'action_unknown');
  await refused('unknown device', '/api/identify', { target: '99' }, 'device_unknown');
  // A single letter used to find any hostname containing it, so an aside to the audience
  // could seize a screen. Nothing shorter than a name is a name.
  await refused('single letter as a device', '/api/identify', { target: 'a' }, 'device_unknown');

  // --- the agent surface ---------------------------------------------------------------
  console.log('\nAgent surface');
  called.add('POST /api/agent/ack');
  const ack = await fetch(`${BASE}/api/agent/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ device: String(one.number), session: one.session, cid: 'x', status: 'success' }),
  });
  check('ack accepted', ack.status === 200);

  called.add('GET /api/events');
  const ticket = (await api('POST', '/api/auth/ticket', {})).data.ticket;
  const events = await fetch(`${BASE}/api/events?ticket=${ticket}`);
  check('observer stream opens', events.status === 200);
  events.body.cancel();

  called.add('GET /join');
  const join = await (await fetch(`${BASE}/join`)).text();
  check('/join carries the secret', join.includes(JOIN));
  called.add('GET /join.ps1');
  check('/join.ps1 carries the secret', (await (await fetch(`${BASE}/join.ps1`)).text()).includes(JOIN));

  // --- nothing threw --------------------------------------------------------------------
  console.log('\nServer health');
  const threw = (core.log.match(/request handler threw/g) || []).length;
  check('no handler exceptions', threw === 0,
    core.log.split('\n').filter((l) => l.includes('threw')).join('\n      '));

  // --- coverage ---------------------------------------------------------------------------
  console.log('\nCoverage');
  const missed = declaredRoutes().filter((route) => !called.has(route));
  check(`all ${declaredRoutes().length} declared routes exercised`, missed.length === 0,
    missed.length ? `never called: ${missed.join(', ')}` : '');

  console.log('');
  if (failures === 0) {
    console.log(`\x1b[32mPASS\x1b[0m  ${checks} checks\n`);
  } else {
    console.log(`\x1b[31mFAIL\x1b[0m  ${failures} of ${checks} checks\n`);
  }
  stopCore();
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err.message);
  stopCore();
  process.exit(2);
});
