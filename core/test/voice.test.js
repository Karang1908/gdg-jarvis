'use strict';

/**
 * The latency budget, which is the whole of "best quality, and not one second past four".
 *
 * The budget on its own would be a bad trade — cut the good voice off at four seconds and
 * you get the robotic one instead, which is worse than waiting. What makes it work is the
 * two behaviours either side of it, and those are what this pins:
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

/** Slower than the budget it is given, the way a bad uplink is. */
const SLOW_MS = 1200;

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
  voice.init({ cacheDir: CACHE, budgetMs: 400 });

  let started = Date.now();
  await voice.speak(unwarmed);
  let waited = Date.now() - started;

  check('the room is not held past the budget',
    waited < SLOW_MS, `waited ${waited}ms against a 400ms budget`);

  // The point of the whole arrangement. Giving up on the slow call would mean paying the
  // fallback every single time the line is spoken.
  await new Promise((r) => setTimeout(r, SLOW_MS + 600));
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
  const fallbackDefault = voice.describe().budgetMs;
  check('unset falls back to the four-second requirement', fallbackDefault === 4000,
    String(fallbackDefault));

  fs.rmSync(CACHE, { recursive: true, force: true });

  if (failures === 0) {
    console.log('\nPASS  voice: the budget caps the wait without costing the quality twice\n');
  } else {
    console.error(`\nFAIL  ${failures} check(s)\n`);
    process.exit(1);
  }
}

main();
