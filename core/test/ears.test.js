'use strict';

/**
 * What JARVIS sends to transcribe, and what it says when that fails.
 *
 * This exists because of a real failure: the Gemini transcriber named a model that does
 * not exist, so every utterance died with `gemini 404` and the room went deaf. Two lessons
 * are pinned here.
 *
 * **The model must be one that accepts audio.** This endpoint answers 404 for an unknown
 * or text-only model, which looks identical to a broken URL. Asserting the default is the
 * cheapest way to stop that recurring.
 *
 * **A failure has to name its cause.** The original threw the bare status, so the message
 * said `gemini 404` and nothing else — not the model, not Google's own explanation, which
 * said outright that the model was not found. The fix was one line and it would have saved
 * the whole investigation.
 *
 * No network: fetch is replaced, so this asserts the request that would be sent rather
 * than any live service.
 *
 *   node core/test/ears.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GEMINI_API_KEY = 'not-a-real-key';
delete process.env.JARVIS_STT_MODEL;

const ears = require('../lib/ears');

const gemini = ears.TRANSCRIBE.find((t) => t.name === 'gemini');
const sample = path.join(os.tmpdir(), `jarvis-ears-test-${process.pid}.wav`);

let failures = 0;
let sent = null;

function check(name, condition, detail) {
  console.log(`  ${condition ? '✓' : '✗'} ${name}${condition || !detail ? '' : '\n      ' + detail}`);
  if (!condition) failures++;
}

function reply(response) {
  global.fetch = async (url, options) => {
    sent = { url, body: JSON.parse(options.body), headers: options.headers };
    return response;
  };
}

async function main() {
  fs.writeFileSync(sample, Buffer.alloc(64));

  console.log('\nThe request');

  reply({ ok: true, json: async () => ({ output_text: 'take the room' }) });
  const heard = await gemini.run(sample);

  // The bug. gemini-3.1-flash does not exist; naming it cost a demo.
  check('the default model is one that accepts audio input',
    sent.body.model === 'gemini-3.7-flash', `sent ${sent.body.model}`);

  check('posts to the interactions endpoint',
    sent.url === 'https://generativelanguage.googleapis.com/v1beta/interactions', sent.url);

  check('sends the prompt, then the audio with its mime type',
    sent.body.input[0].type === 'text' &&
    sent.body.input[1].type === 'audio' &&
    sent.body.input[1].mime_type === 'audio/wav' &&
    typeof sent.body.input[1].data === 'string',
    JSON.stringify(sent.body.input).slice(0, 180));

  check('authenticates by header, never in the URL',
    sent.headers['x-goog-api-key'] === 'not-a-real-key' && !sent.url.includes('key'),
    sent.url);

  check('reads the transcript from output_text', heard === 'take the room', JSON.stringify(heard));

  console.log('\nThe failure');

  reply({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({
      error: { code: 404, message: 'models/gemini-3.1-flash is not found for API version v1beta' },
    }),
  });

  let message = '';
  try {
    await gemini.run(sample);
  } catch (err) {
    message = err.message;
  }

  check('a 404 names the model it tried',
    message.includes('gemini-3.7-flash'), message);
  check('a 404 carries Google’s own explanation',
    message.includes('not found'), message);

  // A non-JSON body (a proxy error page, a gateway timeout) must not throw inside the
  // error handler — that would replace a clear failure with a confusing one.
  reply({ ok: false, status: 502, text: async () => '<html>gateway</html>' });
  let second = '';
  try {
    await gemini.run(sample);
  } catch (err) {
    second = err.message;
  }
  check('a non-JSON error body still produces a usable message',
    second.includes('502'), second);

  console.log('\nConfiguration');

  process.env.JARVIS_STT_MODEL = 'gemini-3.5-transcribe';
  reply({ ok: true, json: async () => ({ output_text: 'ok' }) });
  await gemini.run(sample);
  check('JARVIS_STT_MODEL overrides the default',
    sent.body.model === 'gemini-3.5-transcribe', sent.body.model);

  fs.unlinkSync(sample);

  await responsiveness();

  if (failures === 0) {
    console.log('\nPASS  ears: the transcription request is well formed, failures explain themselves, and listening never blocks\n');
  } else {
    console.error(`\nFAIL  ${failures} check(s)\n`);
    process.exit(1);
  }
}

/**
 * Listening must not stop the rest of Core.
 *
 * Two regressions this guards, both of which were real:
 *
 *   Transcription used spawnSync, which halts Node entirely. A 2.5 second freeze per
 *   utterance meant Core served nothing at all while it thought — no event stream, no
 *   commands, no health check.
 *
 *   The capture loop awaited the transcript handler. Acting on a sentence can mean a
 *   twelve-second model call, and for those twelve seconds the microphone heard nothing,
 *   so anything said meanwhile was lost.
 *
 * Driven with stub binaries so it measures this code and not a real recogniser.
 */
async function responsiveness() {
  console.log('\nStaying responsive');

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ears-bin-'));

  fs.writeFileSync(path.join(bin, 'rec'),
    '#!/bin/sh\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\n' +
    'head -c 2048 /dev/zero > "$out"\nexit 0\n', { mode: 0o755 });

  // Slow enough to be obvious if it ever blocks the loop again.
  fs.writeFileSync(path.join(bin, 'whisper'),
    '#!/bin/sh\nsleep 0.6\nfor a in "$@"; do case "$a" in *.wav) s="$a";; esac; done\n' +
    'echo "take the room" > "${s%.wav}.txt"\nexit 0\n', { mode: 0o755 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;

  const ready = ears.init({});
  if (!ready.available) {
    console.log('  · skipped — could not stage stub capture/transcribe binaries');
    process.env.PATH = originalPath;
    return;
  }

  let worstStall = 0;
  let last = Date.now();
  const beat = setInterval(() => {
    const now = Date.now();
    worstStall = Math.max(worstStall, now - last);
    last = now;
  }, 50);

  const heard = [];
  ears.start(async () => {
    heard.push(Date.now());
    // Stands in for agy, which really does take this long and longer.
    await new Promise((r) => setTimeout(r, 1200));
  });

  await new Promise((r) => setTimeout(r, 4000));

  clearInterval(beat);
  ears.stop();
  process.env.PATH = originalPath;
  fs.rmSync(bin, { recursive: true, force: true });

  // Generous: a blocking spawnSync showed up as a 2.5 second stall, so anything near the
  // timer interval is fine and the failure mode is unmistakable.
  check('the event loop keeps running while transcribing',
    worstStall < 500, `worst stall ${worstStall}ms — Core would be unresponsive that long`);

  check('the microphone keeps listening while a transcript is acted on',
    heard.length >= 3, `heard ${heard.length} utterances in 4s; a blocking handler yields 2 or fewer`);
}

main();
