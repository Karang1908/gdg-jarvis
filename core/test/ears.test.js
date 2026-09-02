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

/** The real one, so the sections that need a live socket can put it back. */
const realFetch = global.fetch;

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

  await residentServer();
  await responsiveness();
  await finishesTheSentence();

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

  // 32000 bytes is one second at 16 kHz mono 16-bit. Core drops anything shorter as
  // silence, so a stub that writes a token few bytes would be testing the wrong path.
  fs.writeFileSync(path.join(bin, 'rec'),
    '#!/bin/sh\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\n' +
    'head -c 32000 /dev/zero > "$out"\nexit 0\n', { mode: 0o755 });

  // Slow enough to be obvious if it ever blocks the loop again.
  fs.writeFileSync(path.join(bin, 'whisper'),
    '#!/bin/sh\nsleep 0.6\nfor a in "$@"; do case "$a" in *.wav) s="$a";; esac; done\n' +
    'echo "take the room" > "${s%.wav}.txt"\nexit 0\n', { mode: 0o755 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  // These stubs are the command-line whisper. On a machine that also has the resident one
  // installed, init would pick that instead and the stubs would never run.
  process.env.JARVIS_WHISPER_SERVER = 'off';

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

/**
 * The resident transcriber.
 *
 * The command-line whisper re-reads its model for every utterance, which is a fixed cost on
 * everything anyone says and the reason a larger, more accurate model is unaffordable. A
 * server keeps it loaded. What matters here is that the request matches what whisper.cpp
 * documents — the field is `file`, not `audio` — and that the reply is read whichever shape
 * it arrives in, since its README documents the request but not the response.
 */
async function residentServer() {
  console.log('\nThe resident transcriber');

  // The Gemini section above replaces fetch with a stub; this one talks to a real socket.
  global.fetch = realFetch;

  const http = require('http');
  const provider = ears.TRANSCRIBE.find((t) => t.name === 'whisper.cpp-server');

  let seen = {};
  let reply = { type: 'json', body: JSON.stringify({ text: '  take the room  ' }) };

  const server = http.createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on('data', (c) => { body = Buffer.concat([body, c]); });
    req.on('end', () => {
      const raw = body.toString('latin1');
      seen = {
        path: req.url,
        method: req.method,
        fileField: /name="file"/.test(raw),
        format: (raw.match(/name="response_format"[\s\S]*?\r\n\r\n(\w+)/) || [])[1] || '',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(reply.body);
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.JARVIS_WHISPER_SERVER = `http://127.0.0.1:${server.address().port}`;

  const clip = path.join(os.tmpdir(), `jarvis-server-test-${process.pid}.wav`);
  fs.writeFileSync(clip, Buffer.alloc(512));

  const heard = await provider.run(clip);

  check('posts to the documented endpoint',
    seen.path === '/inference' && seen.method === 'POST', JSON.stringify(seen));
  check('sends the audio as the "file" field whisper.cpp expects',
    seen.fileField === true, JSON.stringify(seen));
  check('asks for json', seen.format === 'json', seen.format);
  check('reads the transcript out of the reply', heard.trim() === 'take the room',
    JSON.stringify(heard));

  // Its README does not document the response, so a plain-text reply must work too rather
  // than throwing on JSON.parse.
  reply = { type: 'text', body: 'take the room' };
  const plain = await provider.run(clip);
  check('a plain-text reply is accepted just as well', plain.trim() === 'take the room',
    JSON.stringify(plain));

  // Chosen ahead of the command line, or none of the above is worth anything.
  const chosen = ears.init({});
  check('it is preferred over the command line', chosen.transcribe === 'whisper.cpp-server',
    String(chosen.transcribe));

  delete process.env.JARVIS_WHISPER_SERVER;
  fs.unlinkSync(clip);
  await new Promise((r) => server.close(r));
}

/**
 * Closing the microphone must not discard what was already said.
 *
 * The button is push-to-talk: pressed to speak, pressed again when the sentence is done. A
 * stop that threw away the recording in progress made it useless — the presenter would say
 * the whole command, release, and nothing would happen.
 */
async function finishesTheSentence() {
  console.log('\nClosing the microphone');

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-drain-'));

  // Records for a long time, so stop() always lands mid-capture — the case that matters.
  // Writes as it goes, the way sox flushes what it has when it is ended.
  fs.writeFileSync(path.join(bin, 'rec'),
    '#!/bin/sh\nfor a in "$@"; do case "$a" in *.wav) out="$a";; esac; done\n' +
    'head -c 64000 /dev/zero > "$out"\nsleep 20\nexit 0\n', { mode: 0o755 });

  fs.writeFileSync(path.join(bin, 'whisper'),
    '#!/bin/sh\nfor a in "$@"; do case "$a" in *.wav) s="$a";; esac; done\n' +
    'echo "take the room" > "${s%.wav}.txt"\nexit 0\n', { mode: 0o755 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.JARVIS_WHISPER_SERVER = 'off';

  const ready = ears.init({});
  if (!ready.available) {
    console.log('  · skipped — could not stage stub binaries');
    process.env.PATH = originalPath;
    return;
  }

  const heard = [];
  ears.start(async (text) => { heard.push(text); });

  // Let it get well into a recording, then close the microphone mid-sentence.
  await new Promise((r) => setTimeout(r, 1500));
  ears.stop();

  check('stop() reports the microphone closed', ears.isListening() === false);

  // The sentence that was in progress still has to arrive.
  await new Promise((r) => setTimeout(r, 3000));

  check('what was already said is still transcribed and acted on',
    heard.length >= 1, `handler saw ${heard.length} utterances; the one in progress was dropped`);

  // And it must genuinely stop — not keep recording after being closed.
  const seen = heard.length;
  await new Promise((r) => setTimeout(r, 2500));
  check('and nothing further is picked up once it has drained',
    heard.length === seen, `grew from ${seen} to ${heard.length} after stopping`);

  process.env.PATH = originalPath;
  fs.rmSync(bin, { recursive: true, force: true });
}

main();
