'use strict';

/**
 * The latency budget: off by default, and correct when someone turns it on.
 *
 * Capping synthesis is the wrong default and has been tried twice. A cap does not shorten a
 * line, it decides whether the line is spoken well or badly — and since synthesis time
 * scales with length, any ceiling lands hardest on the longest sentences. So the default is
 * no cap, and these assert that a budget still behaves when a venue explicitly asks for one.
 *
 * Two behaviours make an opt-in budget survivable, and they are what this pins:
 *
 *   A line that blows the budget is still synthesised in the background and still cached.
 *   So the room hears the fallback once, and the good voice every time after.
 *
 *   A line already in the cache never consults the budget at all. Since every line the demo
 *   plans to say is warmed ahead of time, the budget is a guard for novel sentences rather
 *   than the normal path.
 *
 * Driven with stub providers — one deliberately slower than its budget, one instant — so it
 * measures this logic and never the network.
 *
 *   node core/test/voice.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const voice = require('../lib/voice');

const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-voice-test-'));

// Exercise the speaking path without actually making a sound. The host's player has
// unpredictable timing and rejects a synthetic buffer outright — "AudioFileOpen failed" —
// which made the timing assertion below flap while the code under test was fine. `true`
// accepts any argument and exits immediately.
process.env.JARVIS_AUDIO_PLAYER = 'true';

/**
 * Slower than the budget it is given, the way a bad uplink is.
 *
 * Generous on purpose. The assertion below is that the budget fired rather than that it
 * fired to the millisecond, and a machine busy with other work can be late delivering a
 * timer by hundreds of milliseconds. With too little room between the budget and this, the
 * suite fails on a loaded laptop and accuses code that is behaving correctly — which is
 * exactly what it did on the demo machine.
 */
const SLOW_MS = 3000;
const BUDGET_MS = 400;

voice.PROVIDERS.testcloud = {
  kind: 'synth',
  network: true,
  available: () => true,
  async synth() {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    const file = path.join(CACHE, `.slow-${Date.now()}.wav`);
    fs.writeFileSync(file, voice.wavFromPcm(Buffer.alloc(3200)));
    return file;
  },
};

voice.PROVIDERS.testlocal = {
  kind: 'synth',
  network: false,
  available: () => true,
  async synth() {
    const file = path.join(CACHE, `.fast-${Date.now()}.wav`);
    fs.writeFileSync(file, voice.wavFromPcm(Buffer.alloc(3200)));
    return file;
  },
};

voice.PREFERENCE.length = 0;
voice.PREFERENCE.push('testcloud', 'testlocal');

let failures = 0;

function check(name, condition, detail) {
  console.log(`  ${condition ? '✓' : '✗'} ${name}${condition || !detail ? '' : '\n      ' + detail}`);
  if (!condition) failures++;
}

async function main() {
  console.log('\nWhen the good voice is too slow');

  const unwarmed = 'A line nobody thought to warm.';
  voice.init({ cacheDir: CACHE, budgetMs: BUDGET_MS });

  let started = Date.now();
  await voice.speak(unwarmed);
  let waited = Date.now() - started;

  // Half the synthesis time: unmistakably "gave up early" rather than "waited for it",
  // with room for a loaded machine to deliver the timer late.
  check('the room is not held past the budget',
    waited < SLOW_MS / 2, `waited ${waited}ms against a ${BUDGET_MS}ms budget`);

  // The point of the whole arrangement. Giving up on the slow call would mean paying the
  // fallback every single time the line is spoken.
  await new Promise((r) => setTimeout(r, SLOW_MS + 800));
  check('the good voice finishes in the background and is cached',
    voice.isCached(unwarmed), 'nothing cached — every repeat would sound bad too');

  started = Date.now();
  const repeat = await voice.speak(unwarmed);
  waited = Date.now() - started;
  check('so the second time is instant, and is the good one',
    repeat.source === 'cache' && waited < 400, `${repeat.source} after ${waited}ms`);

  console.log('\nWhen there is time for it');

  const other = 'A different unwarmed line.';
  voice.init({ cacheDir: CACHE, budgetMs: SLOW_MS + 2000 });

  started = Date.now();
  const good = await voice.speak(other);
  waited = Date.now() - started;
  check('a budget it can meet gets the good voice',
    good.source === 'testcloud', `used ${good.source} after ${waited}ms`);

  console.log('\nWhat the budget resolves to');

  // Zero has to survive as a real value: it means "wait for the good voice", and must not
  // be mistaken for "unset" and replaced by the default.
  voice.init({ cacheDir: CACHE, budgetMs: 0 });
  check('zero means no budget, not "unconfigured"', voice.describe().budgetMs === 0,
    String(voice.describe().budgetMs));

  voice.init({ cacheDir: CACHE });
  check('unset means no cap — a long line is not punished for being long',
    voice.describe().budgetMs === 0, String(voice.describe().budgetMs));

  // The budget still has to work when a venue actually asks for one.
  voice.init({ cacheDir: CACHE, budgetMs: 1500 });
  check('an explicit budget is still honoured', voice.describe().budgetMs === 1500,
    String(voice.describe().budgetMs));

  fs.rmSync(CACHE, { recursive: true, force: true });

  if (failures === 0) {
    console.log('\nPASS  voice: no cap by default, and an opt-in budget never costs the quality twice\n');
  } else {
    console.error(`\nFAIL  ${failures} check(s)\n`);
    process.exit(1);
  }
}

main();
