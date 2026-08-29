'use strict';

/**
 * What a spoken sentence means.
 *
 * Runs on Core, because Core is what hears. A transcript arrives from the microphone on
 * this machine, gets matched against the fixed demo commands here, and only goes to the
 * model if nothing matches.
 *
 * Deliberately a list of regular expressions rather than anything cleverer. Every phrase
 * the run of show uses is here, and matching one takes microseconds — where handing the
 * same sentence to a model costs twelve to seventeen seconds. "Take the room" has to be
 * instant; "which one is Ravi's, and put Chrome on it" can afford to think.
 */

/** Optional address, so every command works with or without the name. */
const WAKE = '^(?:hey\\s+|ok\\s+)?(?:jarvis[,\\s]*)?';

/**
 * Spoken numbers, including the homophones a recogniser actually returns.
 *
 * "take two" comes back as "take too" often enough that refusing it would make the whole
 * thing feel broken for a reason the presenter cannot see.
 */
const WORD_NUMBERS = {
  one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, tree: 3, four: 4, for: 4, fore: 4,
  five: 5, six: 6, sex: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

function spokenToNumber(word) {
  if (!word) return null;
  const cleaned = String(word).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^\d+$/.test(cleaned)) return Number(cleaned);
  return Object.prototype.hasOwnProperty.call(WORD_NUMBERS, cleaned) ? WORD_NUMBERS[cleaned] : null;
}

/**
 * Ordered. Scenes are tested before identify because they share the "show me" opening —
 * the other way round, "show me the architecture" is read as identifying a device called
 * "the".
 */
const INTENTS = [
  {
    name: 'takeover_all',
    test: new RegExp(WAKE + '(?:take|seize|grab)\\s+(?:the\\s+)?(?:room|everything|all)'),
    say: 'Taking the room.',
    plan: () => ({ route: '/api/takeover', body: { target: 'ALL' }, label: 'TAKE THE ROOM' }),
  },
  {
    name: 'release_all',
    test: new RegExp(WAKE + '(?:release|let go of|give back|free)\\s+(?:the\\s+)?(?:room|everything|all|them)'),
    say: 'Releasing the room.',
    plan: () => ({ route: '/api/release', body: { target: 'ALL' }, label: 'RELEASE ALL' }),
  },
  {
    name: 'scene',
    test: new RegExp(WAKE + '(?:show|display|switch to|go to)\\s+(?:me\\s+)?(?:the\\s+)?(jarvis|reactor|architecture|network|terminal|gdg|red alert|blackout|wall)'),
    plan: (m) => {
      let scene = m[1].replace(/\s+/g, '_');
      if (scene === 'architecture') scene = 'network';
      return { route: '/api/scene', body: { target: 'ALL', scene }, label: scene.toUpperCase() };
    },
  },
  {
    name: 'takeover_device',
    test: new RegExp(WAKE + '(?:take|grab)\\s+(?:over\\s+)?(?:device\\s+|number\\s+)?(\\S+)'),
    plan: (m) => ({ route: '/api/takeover', body: { target: m[1] }, label: 'TAKEOVER', needsDevice: m[1] }),
  },
  {
    name: 'release_device',
    test: new RegExp(WAKE + 'release\\s+(?:device\\s+|number\\s+)?(\\S+)'),
    plan: (m) => ({ route: '/api/release', body: { target: m[1] }, label: 'RELEASE', needsDevice: m[1] }),
  },
  {
    name: 'identify',
    test: new RegExp(WAKE + '(?:identify|which is|show me|find)\\s+(?:device\\s+|number\\s+)?(\\S+)'),
    plan: (m) => ({ route: '/api/identify', body: { target: m[1] }, label: 'IDENTIFY', needsDevice: m[1] }),
  },
  {
    name: 'move',
    test: new RegExp(WAKE + '(?:move|go|jump|come)\\s+(?:to|back to|over to)?\\s*(?:device\\s+|number\\s+)?(\\S+)'),
    plan: (m) => ({ route: '/api/move', body: { to: m[1] }, label: 'MOVE', needsDevice: m[1] }),
  },
  {
    name: 'split',
    test: new RegExp(WAKE + '(?:split|divide|clone)\\s*(?:yourself|up)?'),
    say: 'Splitting across all devices.',
    plan: () => ({ route: '/api/broadcast', body: { scene: 'jarvis' }, label: 'SPLIT' }),
  },
  {
    name: 'cascade',
    test: new RegExp(WAKE + '(?:reactor|cascade|arc)\\s*(?:sequence|reactor)?'),
    say: 'Reactor sequence engaged.',
    plan: () => ({ route: '/api/cascade', body: { effect: 'arc_reactor' }, label: 'CASCADE' }),
  },
  {
    name: 'count',
    test: new RegExp(WAKE + '(?:how many|count|status|are you there|you there)'),
    plan: () => ({ route: null, label: 'COUNT', answer: 'count' }),
  },
];

/**
 * Match a transcript.
 *
 * Returns null when nothing fits, which is the signal to hand it to the model. A spoken
 * device reference is resolved to a number here so "take too" reaches the right screen.
 */
function match(transcript, resolveDevice) {
  const text = String(transcript || '').toLowerCase().trim().replace(/[.?!]+$/, '');
  if (!text) return null;

  for (const intent of INTENTS) {
    const found = intent.test.exec(text);
    if (!found) continue;

    const plan = intent.plan(found);

    if (plan.needsDevice) {
      const number = spokenToNumber(plan.needsDevice);
      const target = number !== null ? String(number) : plan.needsDevice;

      // A word that is neither a number nor a device here is almost certainly not a command
      // at all — "take a look at this" should reach the model, not take over a screen.
      if (resolveDevice && !resolveDevice(target)) return null;

      if (plan.body.target !== undefined) plan.body.target = target;
      if (plan.body.to !== undefined) plan.body.to = target;
      plan.label = `${plan.label} ${target}`;
    }

    return { name: intent.name, say: intent.say || null, ...plan, heard: text };
  }

  return null;
}

module.exports = { match, spokenToNumber, INTENTS, WORD_NUMBERS };
