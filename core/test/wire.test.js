'use strict';

/**
 * Wire encoding tests.
 *
 * The important half of this file is the bash round-trip. Encoding correctly in Node
 * proves nothing on its own — what has to hold is that the exact decoder embedded in
 * the shell agent reproduces the original bytes. So the test shells out to /bin/bash,
 * decodes there, and compares SHA-256 digests. Digests rather than string equality
 * because the fixtures deliberately contain tabs and newlines, which no delimiter-based
 * comparison could carry safely.
 *
 *   node core/test/wire.test.js
 */

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const wire = require('../lib/wire');

/** Strings chosen to break a naive encoder: shell metacharacters, escapes, non-BMP. */
const FIXTURES = [
  'Yes, sir.',
  'http://10.42.0.1:3000/overlay/?node=ALPHA&ticket=c9f2',
  'tab\there',
  'newline\nhere',
  'back\\slash',
  'pct%25',
  'a%20b',
  'A%41A',
  'emoji 🚀 ok',
  'ünïcødé',
  '$(id)',
  '`id`',
  '; rm -rf /',
  '&& shutdown -h now',
  '| tee /etc/passwd',
  'quote"and\'',
  '  leading and trailing  ',
  '',
];

/** The decoder as it appears in agent/jarvis-agent.sh. Kept identical on purpose. */
const BASH_DECODER = `
decode() { printf '%b' "\${1//%/\\\\x}"; }
while IFS=$'\\t' read -r want encoded; do
  got=$(decode "$encoded" | shasum -a 256 | cut -d' ' -f1)
  [ "$got" = "$want" ] && echo "ok" || echo "fail $encoded want=$want got=$got"
done
`;

let failures = 0;

function check(name, condition, detail) {
  if (condition) return;
  failures++;
  console.error(`FAIL  ${name}${detail ? '\n      ' + detail : ''}`);
}

// --- 1. Node-side round trip ------------------------------------------------------
for (const fixture of FIXTURES) {
  const encoded = wire.encode(fixture);
  check(
    `round-trip ${JSON.stringify(fixture)}`,
    wire.decode(encoded) === fixture,
    `encoded=${encoded} decoded=${JSON.stringify(wire.decode(encoded))}`
  );
}

// --- 2. No shell-active byte survives encoding -------------------------------------
// This is the property the agent depends on. If it ever regresses, a crafted app name
// or URL could inject extra fields into a command line.
for (const fixture of FIXTURES) {
  const encoded = wire.encode(fixture);
  check(
    `encoding is inert for ${JSON.stringify(fixture)}`,
    !/[^A-Za-z0-9\-_.~%]/.test(encoded),
    `leaked: ${encoded}`
  );
}

// --- 3. Command framing -------------------------------------------------------------
const line = wire.encodeCommand('4f1c9e2a', 'speak', { text: 'Yes, sir.', voice: 'Daniel' });
check('command line has no embedded newline', !line.includes('\n'), line);
check(
  'command line splits into exactly 4 fields',
  line.split('\t').length === 4,
  JSON.stringify(line)
);

const parsed = wire.decodeCommand(line);
check('command id survives framing', parsed.commandId === '4f1c9e2a');
check('action survives framing', parsed.action === 'speak');
check('args survive framing', parsed.args.text === 'Yes, sir.' && parsed.args.voice === 'Daniel');

// A value that itself contains a TAB and an '=' must not create phantom fields.
const hostile = wire.encodeCommand('c1', 'open_url', { url: 'http://x/\tinjected=yes' });
check(
  'hostile arg cannot inject a field',
  hostile.split('\t').length === 3,
  JSON.stringify(hostile)
);
check(
  'hostile arg decodes intact',
  wire.decodeCommand(hostile).args.url === 'http://x/\tinjected=yes'
);

// --- 4. SSE framing -----------------------------------------------------------------
check('sse frame terminates with a blank line', wire.sse('hello').endsWith('\n\n'));
check(
  'sse splits multi-line payloads into multiple data fields',
  wire.sse('a\nb') === 'data: a\ndata: b\n\n',
  JSON.stringify(wire.sse('a\nb'))
);

// --- 5. The bash round trip ----------------------------------------------------------
const input = FIXTURES.map(
  (f) => crypto.createHash('sha256').update(Buffer.from(f, 'utf8')).digest('hex') + '\t' + wire.encode(f)
).join('\n') + '\n';

const bash = spawnSync('/bin/bash', ['-c', BASH_DECODER], { input, encoding: 'utf8' });

if (bash.error) {
  check('bash is available', false, String(bash.error));
} else {
  const results = bash.stdout.trim().split('\n').filter(Boolean);
  // Every fixture yields a line, the empty one included: its line is `<digest>\t` with an
  // empty second field, which `read` still delivers. So the shell must report exactly as
  // many results as we sent — a short count means a fixture was silently dropped.
  const expected = FIXTURES.length;
  check(
    `bash decoded all ${expected} fixtures`,
    results.length === expected && results.every((r) => r === 'ok'),
    results.filter((r) => r !== 'ok').join('\n      ') || `got ${results.length} results`
  );
}

if (failures === 0) {
  console.log(`PASS  wire: ${FIXTURES.length} fixtures round-trip in Node and under bash ${
    spawnSync('/bin/bash', ['-c', 'echo -n $BASH_VERSION'], { encoding: 'utf8' }).stdout
  }`);
} else {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
