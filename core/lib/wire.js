'use strict';

/**
 * Wire encoding for the agent channel.
 *
 * The shell agents parse commands with nothing but bash builtins. Everything in this
 * module exists to make that safe: after encoding, a value cannot contain a TAB, a
 * newline, a backslash, a quote, or a percent sign, so splitting a command line on TAB
 * and decoding each field can never be tricked into producing extra fields or escapes.
 *
 * The agent's decoder is exactly this, and nothing more:
 *
 *     decode() { printf '%b' "${1//%/\\x}"; }
 *
 * That maps every %XX to \xXX and lets printf turn it back into a byte. Two consequences
 * drive the encoder below:
 *
 *   1. Backslash MUST be encoded, or printf %b would interpret whatever follows it.
 *   2. Exactly two hex digits per byte, always. bash's \xHH consumes at most two, so a
 *      fixed width keeps decoding unambiguous when the next literal character happens to
 *      be a hex digit itself.
 */

const FIELD_SEP = '\t';

/** Bytes that survive unencoded: RFC 3986 unreserved. Everything else becomes %XX. */
const UNRESERVED = /^[A-Za-z0-9\-_.~]$/;

/**
 * Percent-encode a value for the agent channel.
 *
 * Stricter than encodeURIComponent, which leaves !'()* intact. We do not want to reason
 * about which punctuation is safe in a shell, so only the unreserved set passes through.
 *
 * The `u` flag matters: without it the regex iterates UTF-16 code units and would split
 * a surrogate pair into two lone surrogates, which encode as U+FFFD and corrupt any
 * emoji or non-BMP character in, say, a speak() string.
 */
function encode(value) {
  return String(value).replace(/[\s\S]/gu, (ch) => {
    if (UNRESERVED.test(ch)) return ch;
    let out = '';
    for (const byte of Buffer.from(ch, 'utf8')) {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  });
}

/** Inverse of encode(). Used by tests and by the JSON-speaking clients. */
function decode(value) {
  return Buffer.from(
    String(value).replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    ),
    'binary'
  ).toString('utf8');
}

/**
 * Build one command line: <commandId>\t<action>\t<key>=<value>...
 *
 * Argument order is sorted so that identical commands produce identical lines, which
 * makes the activity log and any diffing of captured streams deterministic.
 */
function encodeCommand(commandId, action, args) {
  const fields = [encode(commandId), encode(action)];
  for (const key of Object.keys(args || {}).sort()) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    fields.push(`${key}=${encode(value)}`);
  }
  return fields.join(FIELD_SEP);
}

/** Parse a command line back into an object. Used by the protocol tests. */
function decodeCommand(line) {
  const [commandId, action, ...rest] = line.split(FIELD_SEP);
  const args = {};
  for (const field of rest) {
    const eq = field.indexOf('=');
    if (eq === -1) continue;
    args[field.slice(0, eq)] = decode(field.slice(eq + 1));
  }
  return { commandId: decode(commandId), action: decode(action), args };
}

/**
 * Frame a payload as a Server-Sent Event.
 *
 * SSE splits on newlines, so a payload containing one would silently become two events.
 * Agent lines are encoded and cannot contain newlines; JSON payloads for the browser
 * clients cannot either, since JSON.stringify escapes them. The split below is belt and
 * braces for anything that reaches here by another path.
 */
function sse(payload, eventName) {
  const lines = String(payload).split('\n');
  let frame = '';
  if (eventName) frame += `event: ${eventName}\n`;
  for (const line of lines) frame += `data: ${line}\n`;
  return frame + '\n';
}

/** SSE comment. Keeps idle connections alive through NAT and proxy timeouts. */
function ssePing() {
  return ': ping\n\n';
}

module.exports = { FIELD_SEP, encode, decode, encodeCommand, decodeCommand, sse, ssePing };
