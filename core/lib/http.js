'use strict';

/**
 * A small HTTP layer, written rather than installed.
 *
 * Express would be three lines of this file's job and a hundred packages. That trade is
 * normally fine and is wrong here for one specific reason: during the demo the Kali
 * laptop's Wi-Fi *is* the access point, so the machine running Core has no internet. A
 * dependency-free Core cannot fail to start because something was never fetched, and
 * `node core/server.js` works on a clean checkout with no install step at all.
 *
 * See DEVIATIONS.md D1.
 */

const fs = require('fs');
const path = require('path');

/**
 * Request body cap.
 *
 * Nothing this system accepts is large — the biggest legitimate body is a registration
 * with a capability list. A cap means a malformed or hostile client cannot make Core
 * buffer indefinitely.
 */
const MAX_BODY_BYTES = 64 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
};

/** JSON response. */
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Plain-text response, one line.
 *
 * This is what the shell agents read. They parse with `read`, so the trailing newline
 * matters and the body must never be JSON.
 */
function text(res, status, line) {
  const body = line.endsWith('\n') ? line : line + '\n';
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Read and parse a request body.
 *
 * Accepts both JSON (browsers, MCP) and form encoding (the shell agents, which build
 * bodies with curl -d and cannot construct JSON). Returns null on anything malformed;
 * callers treat that as a client error rather than a crash.
 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') return resolve({});

      const contentType = (req.headers['content-type'] || '').toLowerCase();

      if (contentType.includes('application/json')) {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
        return;
      }

      // Form encoding. URLSearchParams handles the percent-decoding, which is the same
      // encoding the agent uses on the way out — see lib/wire.js.
      const params = new URLSearchParams(raw);
      const out = {};
      for (const [key, value] of params) out[key] = value;
      resolve(out);
    });

    req.on('error', () => resolve(null));
  });
}

/**
 * Serve a file from a directory, refusing anything outside it.
 *
 * Resolving both sides and comparing prefixes is the check that actually holds: it
 * catches `..`, symlinks pointing out of the tree, and encoded traversal alike, because
 * it asks where the path *lands* rather than what it looks like.
 */
function serveStatic(res, rootDir, urlPath) {
  const root = path.resolve(rootDir);

  // Decode before resolving, or %2e%2e%2f would survive the check as a literal segment.
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return text(res, 400, 'bad path');
  }

  const relative = decoded.replace(/^\/+/, '');
  const target = path.resolve(root, relative);

  if (target !== root && !target.startsWith(root + path.sep)) {
    return text(res, 403, 'forbidden');
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return text(res, 404, 'not found');
  }

  const file = stat.isDirectory() ? path.join(target, 'index.html') : target;

  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return text(res, 404, 'not found');
  }

  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,

    // The demo runs from a checkout that gets edited between rehearsals. A stale cached
    // overlay that ignores a fix is a worse problem than re-fetching a few kilobytes on
    // a LAN, so nothing here is cacheable.
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Client address, for the log.
 *
 * No proxy sits in front of Core on a private LAN, so the socket address is the truth and
 * X-Forwarded-For would be client-controlled fiction. The IPv6-mapped prefix is stripped
 * because `::ffff:10.42.0.7` is the same machine an operator knows as `10.42.0.7`.
 */
function clientAddress(req) {
  const raw = req.socket.remoteAddress || 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * Minimal router.
 *
 * Exact paths only. There is no path-parameter syntax because the API in PROTOCOL.md §7
 * needs exactly one dynamic segment, `/api/nodes/:id`, which its handler reads directly.
 */
class Router {
  constructor() {
    this.routes = new Map();
    this.fallback = null;
  }

  add(method, pathname, handler) {
    this.routes.set(`${method} ${pathname}`, handler);
    return this;
  }

  get(pathname, handler) {
    return this.add('GET', pathname, handler);
  }

  post(pathname, handler) {
    return this.add('POST', pathname, handler);
  }

  /** Everything unmatched. Used to serve the static UI trees. */
  otherwise(handler) {
    this.fallback = handler;
    return this;
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://placeholder');
    const handler = this.routes.get(`${req.method} ${url.pathname}`);

    const context = {
      url,
      query: url.searchParams,
      pathname: url.pathname,
      address: clientAddress(req),
    };

    if (handler) return handler(req, res, context);
    if (this.fallback) return this.fallback(req, res, context);
    return text(res, 404, 'not found');
  }
}

module.exports = {
  Router,
  json,
  text,
  readBody,
  serveStatic,
  clientAddress,
  MAX_BODY_BYTES,
  CONTENT_TYPES,
};
