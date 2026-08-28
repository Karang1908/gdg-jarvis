'use strict';

/**
 * Server-Sent Event plumbing.
 *
 * Every push in this system is SSE: commands to the shell agents, scenes to the
 * overlays, state to the wall and controller. One implementation serves all three
 * because the differences are entirely in the payload, not the transport.
 *
 * SSE rather than websockets is what lets a shell be a first-class client — `curl -N`
 * on one end, `while read` on the other, no library anywhere. See DEVIATIONS.md D1.
 */

const wire = require('./wire');

/**
 * Keep-alive interval.
 *
 * A silent connection through a NAT or a sleeping Wi-Fi power-save cycle can be dropped
 * without either end noticing until the next write fails. Fifteen seconds is comfortably
 * under the shortest idle timeout we are likely to meet on a consumer AP, and the comment
 * frame costs nine bytes.
 */
const PING_INTERVAL_MS = 15_000;

let connectionSequence = 0;

/**
 * One attached client.
 *
 * Wraps a ServerResponse held open. All writes go through send(), which swallows write
 * failures: a client that has gone away must never turn into an exception on the path of
 * whoever is broadcasting.
 */
class Connection {
  constructor(res, meta) {
    this.id = ++connectionSequence;
    this.res = res;
    this.meta = meta || {};
    this.openedAt = Date.now();
    this.closed = false;
    this.onClose = null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',

      // Without this, any proxy between Core and a node may buffer the stream and hold
      // commands until the buffer fills. On a direct LAN there is no proxy, but the demo
      // has been known to run through one on a laptop's own local network stack.
      'X-Accel-Buffering': 'no',
    });

    // Tell the client not to retry faster than this if the connection drops. The shell
    // agent implements its own backoff, but browsers honour it automatically.
    res.write('retry: 2000\n\n');

    this.pinger = setInterval(() => this.send(wire.ssePing()), PING_INTERVAL_MS);
    this.pinger.unref();

    const finish = () => this.destroy();
    res.on('close', finish);
    res.on('error', finish);
  }

  /** Write a pre-framed SSE payload. Returns false once the connection is gone. */
  send(frame) {
    if (this.closed) return false;
    try {
      this.res.write(frame);
      return true;
    } catch {
      this.destroy();
      return false;
    }
  }

  /** Send a JSON payload as a named event. Used by the browser-facing channels. */
  sendJson(eventName, payload) {
    return this.send(wire.sse(JSON.stringify(payload), eventName));
  }

  /** Send an encoded agent command line. Used by the agent channel. */
  sendCommand(commandId, action, args) {
    return this.send(wire.sse(wire.encodeCommand(commandId, action, args)));
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);

    try {
      this.res.end();
    } catch {
      // Already torn down by the socket layer; nothing to do.
    }

    if (this.onClose) {
      const handler = this.onClose;
      this.onClose = null;
      handler(this);
    }
  }
}

/**
 * A named group of connections that all receive the same payloads.
 *
 * Used for the observer channel, where every wall and controller sees identical state.
 * The agent and overlay channels do not use this — each node's connection is addressed
 * individually and is held by the registry.
 */
class Channel {
  constructor(name) {
    this.name = name;
    this.connections = new Set();
  }

  attach(res, meta) {
    const connection = new Connection(res, meta);
    connection.onClose = () => this.connections.delete(connection);
    this.connections.add(connection);
    return connection;
  }

  /**
   * Send to everyone.
   *
   * The payload is framed once and written many times rather than framed per connection,
   * which matters when the wall, two teleprompter views, and a phone are all attached to
   * a state update that fires on every heartbeat.
   */
  broadcast(eventName, payload) {
    const frame = wire.sse(JSON.stringify(payload), eventName);
    let delivered = 0;
    for (const connection of this.connections) {
      if (connection.send(frame)) delivered++;
    }
    return delivered;
  }

  get size() {
    return this.connections.size;
  }

  closeAll() {
    for (const connection of [...this.connections]) connection.destroy();
  }
}

module.exports = { Connection, Channel, PING_INTERVAL_MS };
