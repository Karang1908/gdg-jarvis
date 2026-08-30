'use strict';

/**
 * The persistent agy runner.
 *
 * The reason it is persistent is measured, not assumed: `agy -p` costs about 8.3 seconds
 * wall clock for a trivial prompt, of which the model turn is 1.3. The rest is startup and
 * MCP connection, and it used to be paid again for every sentence anyone said.
 *
 * Keeping one process alive moves that cost to boot, but it buys a set of failure modes a
 * one-shot spawn never had — a process that dies mid-demo, a turn that never answers, a
 * conversation that grows forever. Those are what this covers.
 *
 * Driven against a stub that speaks agy's stream-json protocol, so it runs anywhere and
 * costs nothing. The protocol itself was read off the real binary:
 *
 *   in   {"event":"user","message":{"role":"user","content":"..."}}
 *   out  {"event":"init",...} then {"event":"result","result":{status,response,...}}
 *
 *   node core/test/ask.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ask = require('../lib/ask');

const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ask-test-'));
const FAKE = path.join(BIN_DIR, 'fake-agy');
const STARTS = path.join(BIN_DIR, 'starts.log');

/**
 * A stand-in for agy.
 *
 * Records each start, so the test can prove one process served several turns rather than
 * trusting that it did. Behaviour is steered by env: it can hang, or die after a turn.
 */
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.STARTS_LOG, 'start\\n');

process.stdout.write(JSON.stringify({ event: 'init', init: { cwd: process.cwd() } }) + '\\n');

let buf = '';
let turn = 0;

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;

    const msg = JSON.parse(line);
    turn += 1;

    if (process.env.FAKE_MODE === 'hang') return;                  // never answers
    if (process.env.FAKE_MODE === 'die') { process.exit(3); }      // dies mid-turn

    if (process.env.FAKE_MODE === 'error') {
      process.stdout.write(JSON.stringify({ event: 'result', result: {
        status: 'ERROR', error: 'model refused', response: '',
      } }) + '\\n');
      continue;
    }

    process.stdout.write(JSON.stringify({ event: 'result', result: {
      status: 'SUCCESS',
      response: 'answer to: ' + msg.message.content,
      duration_seconds: 0.01,
    } }) + '\\n');
  }
});

// Like the real one, it does not exit when stdin closes.
process.stdin.on('end', () => {});
setTimeout(() => process.exit(0), 30000);
`, { mode: 0o755 });

let failures = 0;

function check(name, condition, detail) {
  console.log(`  ${condition ? '✓' : '✗'} ${name}${condition || !detail ? '' : '\n      ' + detail}`);
  if (!condition) failures++;
}

function startCount() {
  try {
    return fs.readFileSync(STARTS, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function useFake(mode) {
  fs.writeFileSync(STARTS, '');
  process.env.STARTS_LOG = STARTS;
  process.env.FAKE_MODE = mode || 'ok';
  ask.stop();
  ask.init({ bin: FAKE, cwd: process.cwd(), timeoutMs: 1500 });
}

async function main() {
  console.log('\nOne process, many turns');

  useFake('ok');
  const warmed = await ask.warm();
  check('warm() starts it and waits for init', warmed.ok, JSON.stringify(warmed));
  check('describe reports it warm', ask.describe().warm === true);

  const first = await ask.ask('what is on device two');
  check('a question is answered', first.ok && first.answer.includes('device two'),
    JSON.stringify(first).slice(0, 160));

  await ask.ask('second question');
  await ask.ask('third question');

  // The whole point. Three turns must not be three startups.
  check('three turns used one process', startCount() === 1, `${startCount()} starts`);
  check('turns are counted', ask.describe().turns === 3, String(ask.describe().turns));

  console.log('\nWhen it dies');

  useFake('die');
  await ask.warm();
  const died = await ask.ask('this one kills it');
  check('a death mid-turn is reported, not hung',
    !died.ok && died.error === 'agy_exited', JSON.stringify(died).slice(0, 140));
  check('it is no longer considered warm', ask.describe().warm === false);

  // Recovery: the next question must start a fresh process rather than stay broken.
  process.env.FAKE_MODE = 'ok';
  const after = await ask.ask('does it recover');
  check('the next question restarts it and succeeds',
    after.ok && after.answer.includes('recover'), JSON.stringify(after).slice(0, 140));

  console.log('\nWhen it stops answering');

  useFake('hang');
  await ask.warm();
  const started = Date.now();
  const stuck = await ask.ask('this never comes back');
  const waited = Date.now() - started;
  check('a turn that never answers times out', !stuck.ok && stuck.error === 'timeout',
    JSON.stringify(stuck).slice(0, 140));
  check('it gives up near the timeout, not later', waited < 4000, `${waited}ms`);

  // A turn cannot be cancelled, so the process is no longer in a known state and must go.
  check('a timed-out process is dropped rather than reused', ask.describe().warm === false);

  console.log('\nWhen the model itself fails');

  useFake('error');
  await ask.warm();
  const refused = await ask.ask('something it will not do');
  check('an error result is surfaced with its reason',
    !refused.ok && String(refused.detail).includes('refused'), JSON.stringify(refused).slice(0, 140));

  console.log('\nHousekeeping');

  useFake('ok');
  const empty = await ask.ask('   ');
  check('an empty question is refused without starting anything',
    !empty.ok && empty.error === 'empty' && startCount() === 0, JSON.stringify(empty));

  ask.init({ bin: path.join(BIN_DIR, 'no-such-binary'), cwd: process.cwd() });
  const missing = await ask.ask('anything');
  check('a missing agy is reported as such, not as a crash',
    !missing.ok && missing.error === 'agy_not_installed', JSON.stringify(missing).slice(0, 140));

  ask.stop();
  fs.rmSync(BIN_DIR, { recursive: true, force: true });

  if (failures === 0) {
    console.log('\nPASS  ask: one process serves many turns, and survives losing it\n');
  } else {
    console.error(`\nFAIL  ${failures} check(s)\n`);
    process.exit(1);
  }
}

main();
