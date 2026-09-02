'use strict';

/**
 * Intent matching tests.
 *
 * These decide what happens when the presenter opens their mouth, and they run before any
 * model does — so a regression here is not a wrong answer, it is the room doing something
 * nobody asked for in front of an audience.
 *
 * Two properties matter more than the individual phrasings:
 *
 *   1. Every command in the run of show matches. Missing one means a dead mic on stage.
 *   2. Ordinary speech does NOT match. This is the harder half. The presenter talks for
 *      minutes with the microphone open, and "take a look at this slide" must not be heard
 *      as "take a look" and seize a laptop. A false positive is far worse than a miss: a
 *      miss reaches the model, which is where an unrecognised sentence was always going.
 *
 *   node core/test/intents.test.js
 */

const intents = require('../lib/intents');

/** Devices 1-3 exist, as they will in the demo. Anything else is not a device. */
const resolve = (target) => ['1', '2', '3'].includes(String(target));

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failures++;
  console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`);
}

/** A phrase that must produce a given intent, with the fields that carry the meaning. */
function matches(phrase, expected, fields) {
  const found = intents.match(phrase, resolve);
  const named = found && found.name === expected;
  const carried = !fields || (found && Object.entries(fields).every(([key, value]) => {
    const actual = key in found ? found[key] : (found.body || {})[key];
    return JSON.stringify(actual) === JSON.stringify(value);
  }));

  check(
    `"${phrase}" → ${expected}`,
    named && carried,
    found ? `got ${found.name} ${JSON.stringify(found.body || {})}` : 'matched nothing'
  );
}

/** A phrase that must fall through to the model rather than fire a command. */
function fallsThrough(phrase) {
  const found = intents.match(phrase, resolve);
  check(
    `"${phrase}" → model`,
    found === null,
    found ? `WRONGLY matched ${found.name} ${JSON.stringify(found.body || {})}` : ''
  );
}

console.log('\nCommands the demo depends on');
matches('jarvis take the room', 'takeover_all', { target: 'ALL' });
matches('take the room', 'takeover_all', { target: 'ALL' });
matches('hey jarvis, take everything', 'takeover_all', { target: 'ALL' });
matches('jarvis release the room', 'release_all', { target: 'ALL' });
matches('jarvis, give back everything', 'release_all', { target: 'ALL' });
matches('show me the architecture', 'scene', { scene: 'network', target: 'ALL' });
matches('jarvis show the reactor', 'scene', { scene: 'reactor' });
matches('switch to terminal', 'scene', { scene: 'terminal' });
matches('jarvis take device two', 'takeover_device', { target: '2' });
matches('jarvis identify three', 'identify', { target: '3' });
matches('jarvis release device one', 'release_device', { target: '1' });
matches('jarvis move to two', 'move', { to: '2' });
matches('jarvis split yourself', 'split');
matches('jarvis reactor sequence', 'cascade');
matches('jarvis how many devices are online', 'count');

console.log('\nHomophones a recogniser actually returns');
// Not hypothetical. Chrome and whisper both return these for spoken digits, and refusing
// them would make the demo feel broken for a reason the presenter cannot see or fix.
matches('jarvis take too', 'takeover_device', { target: '2' });
matches('jarvis identify won', 'identify', { target: '1' });
matches('jarvis take tree', 'takeover_device', { target: '3' });

// Measured, not imagined: these are what came back when a line was played through the
// room's own speakers into its own microphone.
matches('show me their architecture', 'scene', { scene: 'network' });
matches('show me there architecture', 'scene', { scene: 'network' });
matches('jarvis identified device 2', 'identify', { target: '2' });

// "always" is what tiny.en returns for "Jarvis", spoken by a human into that room's
// microphone — consistently, not occasionally. A small model has no reason to expect a
// proper noun it has never seen, so it reaches for the nearest common word. The recogniser
// is primed with the room's vocabulary now, but the matcher stays tolerant of it: losing
// the wake word loses the whole command.
matches('always take the room', 'takeover_all', { target: 'ALL' });
matches('always show me the architecture', 'scene', { scene: 'network' });
matches('always identify two', 'identify', { target: '2' });

// Exactly as they came off the microphone, once the recogniser was primed. Note the full
// stop after the name: a pattern that allowed only a comma there sent a perfectly good
// command to the model instead of firing it.
matches('JARVIS. Take the room.', 'takeover_all', { target: 'ALL' });
matches('JARVIS. Take over the room.', 'takeover_all', { target: 'ALL' });
matches('JARVIS release all.', 'release_all', { target: 'ALL' });
matches('JARVIS. Show me the architecture.', 'scene', { scene: 'network' });

console.log('\nOrdinary speech, which must never fire a command');
// The scene list is checked before identify precisely so this one does not become
// "identify the device called 'the'".
fallsThrough('take a look at this slide');
fallsThrough('so anyway MQTT is a lightweight protocol');
fallsThrough('let me show you what happens next');
fallsThrough('and this is where it gets interesting');
fallsThrough('we should move on to the next section');
fallsThrough('thanks everyone for coming today');
// The loosened article must not turn ordinary sentences into scene changes. The scene name
// still has to be there and exact, which is what holds these back.
fallsThrough('show me there in a minute');
fallsThrough('let me show you their setup');
fallsThrough('we identified a problem earlier');
fallsThrough('display that slide again');
// Tolerating "always" must not turn every sentence containing it into a command. What
// holds these back is that a command verb has to follow it immediately.
fallsThrough('we should always check the network');
fallsThrough('always keep an eye on the slides');
fallsThrough('');
fallsThrough('   ');

console.log('\nOrdinary words are not device names');
// Found live, and the worst kind of bug this system can have: "take a look at this slide",
// said to an audience, seized a screen. Hostname matching is a substring test, so "a" found
// "Karan's Laptop". Two rules stop it — a device name must be at least three characters,
// and a short list of words is never a device however much a hostname contains them.
fallsThrough('take a look at this slide');
fallsThrough('identify a moment');
fallsThrough('show me a second');
fallsThrough('identify the problem');
fallsThrough('show me that slide');
fallsThrough('take my word for it');
// The discourse markers must not become a way in for ordinary speech.
fallsThrough('now let me show you the next slide');
fallsThrough('and this is where it gets interesting');
fallsThrough('so anyway the network is the interesting part');
fallsThrough('right, moving on to the next section');

console.log('\nDevices that do not exist');
// Four is a perfectly good number; there is simply no device four. Handing this to the
// model is right — it can say so, where a takeover of nothing cannot.
fallsThrough('jarvis take device four');
fallsThrough('jarvis identify seven');

console.log('\nThe way people actually speak');
// Nobody starts a sentence at the sentence. Anchoring at the literal first word meant seven
// of eight natural phrasings did nothing — which is what "sometimes it just ignores me" was.
matches('okay jarvis take the room', 'takeover_all');
matches('so jarvis, show me the architecture', 'scene', { scene: 'network' });
matches('right, take the room', 'takeover_all');
matches('um jarvis are you there', 'presence');
matches('alright jarvis identify two', 'identify', { target: '2' });
matches('and jarvis how many are online', 'count');
matches('well take the room', 'takeover_all');
matches('now show me the architecture', 'scene', { scene: 'network' });

console.log('\nWhy are we here');
matches('why are we here', 'why');
matches('jarvis why are we here', 'why');
matches('JARVIS. Why are we all here?', 'why');
matches('what are we doing here', 'why');

console.log('\nAre you there');
// The one question that must never be slow. Answered from a warmed line before the sentence
// has finished echoing — it used to say "One moment, sir." and then, seconds later, "Yes,
// sir.", which is a comic answer to "are you listening".
matches('jarvis are you there', 'presence');
matches('JARVIS. Are you there?', 'presence');
matches('hey jarvis are you there or not', 'presence');
matches('jarvis you there', 'presence');
matches('can you hear me', 'presence');
matches('jarvis are you with me', 'presence');
// Still a count, not a presence check.
matches('jarvis how many are online', 'count');

console.log('\nAddressing JARVIS');
// The gate on the model path. The microphone is open while the presenter talks to a room,
// so anything not addressed to JARVIS must never reach agy — each one is a twelve-second
// call that can reach for the room's tools and speaks its answer out loud.
function addresses(phrase, expected) {
  check(
    `${expected ? 'addressed' : 'ignored  '}  "${phrase}"`,
    intents.addressed(phrase) === expected
  );
}
addresses('jarvis what is on device two', true);
addresses('hey jarvis, what is on device two', true);
addresses('ok jarvis how many are online', true);
addresses('okay jarvis take a look', true);
// Recognisers mangle proper nouns; being deaf to these looks identical to being deaf.
addresses('jervis what is happening', true);
addresses('javis are you there', true);
// Ordinary presenting. None of this is for JARVIS.
addresses('so anyway MQTT is a lightweight protocol', false);
addresses('let me show you what happens next', false);
addresses('and this is where it gets interesting', false);
addresses('we should move on to the next section', false);
addresses('thanks everyone for coming today', false);
addresses('', false);
// The name has to be the address, not merely present — this demo is *about* JARVIS, and
// the presenter will say the word constantly while explaining how it works.
addresses('the jarvis core runs on kali', false);
addresses('what makes jarvis interesting is the wire protocol', false);

console.log('\nNumber words');
check('spokenToNumber reads digits', intents.spokenToNumber('7') === 7);
check('spokenToNumber reads words', intents.spokenToNumber('three') === 3);
check('spokenToNumber reads homophones', intents.spokenToNumber('ate') === 8);
check('spokenToNumber rejects a non-number', intents.spokenToNumber('slide') === null);
check('spokenToNumber survives nothing', intents.spokenToNumber('') === null);

if (failures === 0) {
  console.log(`\nPASS  intents: every demo command matches, and ordinary speech does not\n`);
} else {
  console.error(`\nFAIL  ${failures} check(s)\n`);
  process.exit(1);
}
