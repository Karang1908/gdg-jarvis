/**
 * The mic button, without a browser.
 *
 *   node core/test/control.test.js
 *
 * control.js is an IIFE against the DOM, so this stubs just enough of one to run it and
 * then drives the button the way a thumb would. What is being proved is the part that is
 * easy to get wrong and invisible until a demo: that reading the state uses GET (a POST of
 * {} would read as "off" and mute Core every time a phone reconnects), and that the label
 * tells the truth when Core cannot listen at all.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CONTROL_JS = path.join(__dirname, '..', 'public', 'control', 'control.js');

const calls = [];
const reports = [];
const nodes = {};

function fakeEl(id) {
  return {
    id, className: '', textContent: '', hidden: false, disabled: false, value: '',
    _classes: new Set(), _click: null,
    classList: {
      add(c) { nodes[id]._classes.add(c); },
      remove() { [].slice.call(arguments).forEach((c) => nodes[id]._classes.delete(c)); },
      toggle() {},
    },
    setAttribute() {}, appendChild() {}, removeChild() {},
    addEventListener(ev, fn) { if (ev === 'click' || ev === 'submit') nodes[id]._click = fn; },
    querySelectorAll: () => [], querySelector: () => null,
    get firstChild() { return null; },
  };
}

const document = {
  getElementById: (id) => (nodes[id] = nodes[id] || fakeEl(id)),
  createElement: () => fakeEl('created'),
  addEventListener() {},
  querySelectorAll: () => [],
  querySelector: () => null,
  body: { classList: { add() {}, remove() {} } },
};

let available = true;
let listening = false;

const JarvisSession = {
  token: () => 'test-admin-password',
  api(path, body) {
    calls.push({ path, verb: body === undefined ? 'GET' : 'POST', body: body });
    if (path === '/api/mic') {
      if (body !== undefined) listening = available && Boolean(body.on);
      return Promise.resolve({ ok: true, data: {
        ok: true, available, listening,
        capture: available ? 'sox' : null,
        transcribe: available ? 'whisper' : null,
        fixedWindow: false,
      } });
    }
    return Promise.resolve({ ok: true, data: { ok: true, devices: [], summary: { online: 0 } } });
  },
  clear() {}, eventStreamUrl: () => '', signIn: () => Promise.resolve(false),
};

const sandbox = {
  document, JarvisSession, JarvisStream: { connect() {} }, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  location: { host: 'x', origin: 'http://x' },
};
sandbox.window = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(CONTROL_JS, 'utf8'), sandbox, { filename: 'control.js' });

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : '\n      ' + detail}`);
  if (!ok) failures++;
}

const mic = nodes['mic'];
const label = nodes['mic-label'];

async function main() {
  // begin() runs on load because token() is non-null; give its promises a turn.
  await new Promise((r) => setTimeout(r, 30));

  const stateReads = calls.filter((c) => c.path === '/api/mic');
  check('reading mic state on load uses GET, not a POST that would mute Core',
    stateReads.length === 1 && stateReads[0].verb === 'GET',
    JSON.stringify(stateReads));

  check('a mic that is off on load does not read as listening', listening === false);

  mic._click();
  await new Promise((r) => setTimeout(r, 30));
  check('tapping opens Core’s microphone',
    listening === true && label.textContent === 'LISTENING', label.textContent);

  mic._click();
  await new Promise((r) => setTimeout(r, 30));
  check('tapping again closes it',
    listening === false && label.textContent === 'MIC OFF', label.textContent);

  // Core with no recorder and no transcriber. The button must say so rather than pretend.
  available = false;
  mic._click();
  await new Promise((r) => setTimeout(r, 30));
  check('a Core that cannot listen is reported, not faked',
    listening === false && label.textContent === 'NO MIC', label.textContent);

  console.log(failures === 0
    ? '\nPASS  the mic button is a remote, and an honest one\n'
    : `\nFAIL  ${failures} check(s)\n`);
  process.exit(failures ? 1 : 0);
}
main();
