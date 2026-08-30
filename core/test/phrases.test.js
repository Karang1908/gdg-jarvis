'use strict';

/**
 * Everything JARVIS says on purpose must be in the warmed cache.
 *
 * This is a latency test wearing a correctness costume. A warmed line is served from disk:
 * full Gemini quality, no network, no wait. A line that drifted by one character is a live
 * synthesis every single time it is spoken — seconds of delay, and the robotic fallback if
 * the venue's uplink is having a bad evening.
 *
 * It is written because that had already happened three ways at once:
 *
 *   "Taking the room." — the headline command of the demo — was never in the list.
 *   The count answers were built with a digit ("3 authorized systems...") while the list
 *   warmed the word ("Three authorized systems..."), so every count missed.
 *   "No systems are online, sir." was added to the code and not to the list.
 *
 * None of it was visible in review, and none of it fails anywhere except out loud.
 *
 *   node core/test/phrases.test.js
 */

const fs = require('fs');
const path = require('path');

const intents = require('../lib/intents');

const phrases = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'phrases.json'), 'utf8')
);
const warmed = new Set([...(phrases.phrases || []), ...(phrases.counts || [])]);

let failures = 0;

function check(name, condition, detail) {
  console.log(`  ${condition ? '✓' : '✗'} ${name}${condition || !detail ? '' : '\n      ' + detail}`);
  if (!condition) failures++;
}

function warmedLine(line, why) {
  check(`${why}: ${JSON.stringify(line)}`, warmed.has(line),
    'not in phrases.json — this is synthesised live every time it is spoken');
}

console.log('\nLines the intents acknowledge with');

// Read from the source rather than importing INTENTS, so a line added as a bare string is
// caught too. The point is that nothing can be spoken without being warmed.
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'intents.js'), 'utf8');
const spoken = [...source.matchAll(/say: '([^']+)'/g)].map((m) => m[1]);

check('the intents do acknowledge out loud at all', spoken.length > 0, 'found no say: lines');
for (const line of spoken) warmedLine(line, 'intent');

console.log('\nLines Core speaks directly');

// Core speaks a few things itself, outside the intent list — the acknowledgement before a
// model call most importantly, whose entire job is to be instant. Read from source so a
// line added here without being warmed fails rather than quietly costing a synthesis.
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const literals = [...serverSource.matchAll(/^const [A-Z_]+ = '([^']+)';$/gm)]
  .map((m) => m[1])
  .filter((line) => /\s/.test(line) && /[.?!]$/.test(line));

check('Core does speak something of its own', literals.length > 0,
  'found no spoken literals in server.js');
for (const line of literals) warmedLine(line, 'core');

console.log('\nThe spoken count, for every room this demo can have');

// Built exactly as server.js builds it. If that construction changes, this drifts and the
// check fails — which is the entire point.
const countLine = (online) =>
  online === 0 ? 'No systems are online, sir.'
    : online === 1 ? 'One authorized system is online.'
    : `${intents.numberWord(online)} authorized systems are online.`;

for (let online = 0; online <= 8; online++) {
  warmedLine(countLine(online), `${online} online`);
}

// The digit is the tell. If numberWord ever stops spelling numbers out, every count in the
// room becomes a live synthesis and nothing else in the suite would notice.
check('counts are spoken as words, not digits',
  !/\d/.test(countLine(3)), countLine(3));

console.log('\nThe list itself');

check('no duplicates', warmed.size === (phrases.phrases.length + phrases.counts.length),
  'a duplicate wastes a synthesis when warming');

check('nothing blank', [...warmed].every((line) => line.trim().length > 1));

// SPEC.md §31. Long lines are slower to synthesise, slower to play, and JARVIS is not
// supposed to give speeches.
const wordy = [...warmed].filter((line) => line.split(/\s+/).length > 10);
check('every line is short enough to say', wordy.length === 0, wordy.join(' | '));

if (failures === 0) {
  console.log(`\nPASS  phrases: all ${warmed.size} warmed, and everything spoken on purpose is among them\n`);
} else {
  console.error(`\nFAIL  ${failures} check(s)\n`);
  process.exit(1);
}
