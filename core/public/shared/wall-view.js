/**
 * The Command Wall — SPEC.md §18.
 *
 * Rendered in two places: MAIN's overlay after a takeover settles (DEVIATIONS.md D5), and
 * the standalone /wall/ page a presenter can open directly. One renderer for both, so the
 * two can never drift into showing the room differently.
 *
 * It is read from the back of a room, which drove every decision here. The node graph is
 * the largest thing on screen because the audience needs to grasp "these are separate
 * machines" in about a second. Latency and activity are small, because they are texture —
 * present so the thing feels like a real control network, not so anyone reads them.
 *
 * Render is called on every state push, roughly once a second, so it patches rather than
 * rebuilds: replacing the DOM each tick would restart every CSS animation on the page and
 * make the wall visibly stutter.
 */

(function (global) {
  'use strict';

  var el = function (tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  /** Per-root render state, so the wall and an overlay can both be live at once. */
  var mounted = new WeakMap();

  function build(root) {
    while (root.firstChild) root.removeChild(root.firstChild);

    var frame = el('div', 'wall-frame');

    var header = el('header', 'wall-header');
    header.appendChild(el('h1', 'wall-title wordmark', 'J.A.R.V.I.S.'));
    header.appendChild(el('div', 'wall-subtitle', 'ROOM CONTROL PLANE'));
    frame.appendChild(header);

    var graph = el('section', 'wall-graph');
    frame.appendChild(graph);

    var summary = el('div', 'wall-summary');
    var count = el('span', 'wall-count', '0 / 0 NODES ONLINE');
    var network = el('span', 'wall-network', 'JARVIS-NET');
    summary.appendChild(count);
    summary.appendChild(network);
    frame.appendChild(summary);

    var activity = el('section', 'wall-activity panel');
    activity.appendChild(el('div', 'label', 'SYSTEM ACTIVITY'));
    var activityList = el('div', 'wall-activity-list');
    activity.appendChild(activityList);
    frame.appendChild(activity);

    root.appendChild(frame);

    var state = { graph: graph, count: count, activityList: activityList, cards: {} };
    mounted.set(root, state);
    return state;
  }

  /**
   * One node.
   *
   * The status line distinguishes four things an operator needs to tell apart at a glance,
   * and which a single online/offline dot would flatten into two: connected and showing an
   * overlay, connected and idle, connected but with a locked screen, and gone. The locked
   * case is the one that matters most — it is the failure no command can fix, so it gets
   * its own colour rather than passing as healthy.
   */
  function cardFor(state, device) {
    if (state.cards[device.number]) return state.cards[device.number];

    var card = el('article', 'node-card');

    var dotWrap = el('div', 'node-dot-wrap');
    dotWrap.appendChild(el('span', 'dot'));
    card.appendChild(dotWrap);

    // The number is the headline, at the size a codename used to be. It is what the
    // presenter says out loud, what the controller shows, and what the voice layer parses,
    // so it has to be the thing you can read from the back of the room.
    card.appendChild(el('div', 'node-name', device.number));

    // Hostname and OS are how a person recognises their own laptop on the wall. Secondary
    // to the number, but the reason nobody has to be told which device they are.
    card.appendChild(el('div', 'node-label', device.hostname || ''));

    var meta = el('div', 'node-meta');
    meta.appendChild(el('span', 'node-os', ''));
    meta.appendChild(el('span', 'node-rtt', ''));
    card.appendChild(meta);

    card.appendChild(el('div', 'node-scene', ''));

    state.graph.appendChild(card);
    state.cards[device.number] = card;
    return card;
  }

  function paintCard(card, device, self) {
    var dot = card.querySelector('.dot');
    var status;

    if (!device.online) {
      status = 'offline';
      dot.className = 'dot';
    } else if (!device.displayAwake) {
      status = 'screen locked';
      dot.className = 'dot dark';
    } else if (device.stale) {
      status = 'not responding';
      dot.className = 'dot warn pulsing';
    } else if (device.hasOverlay) {
      status = device.scene;
      dot.className = 'dot online';
    } else {
      status = 'ready';
      dot.className = 'dot online';
    }

    if (device.muted) status = status + ' · muted';

    card.classList.toggle('is-offline', !device.online);
    card.classList.toggle('is-dark', Boolean(device.online && !device.displayAwake));
    card.classList.toggle('is-self', device.number === self);
    card.classList.toggle('is-wall', Boolean(device.isWall));

    // Identify has to be unmistakable here too: the whole point of §21 is proving that one
    // named machine responded, and the wall is where the audience checks that claim.
    card.classList.toggle('is-identifying', device.scene === 'identify');

    card.querySelector('.node-label').textContent = device.hostname || '';
    card.querySelector('.node-os').textContent = device.online ? device.os || '' : '';
    card.querySelector('.node-rtt').textContent =
      device.online && device.rttMs !== null && device.rttMs !== undefined
        ? device.rttMs + ' ms'
        : '';
    card.querySelector('.node-scene').textContent = status;
  }

  var LEVEL_CLASS = {
    good: 'act-good',
    warn: 'act-warn',
    error: 'act-error',
    deny: 'act-deny',
    info: 'act-info',
  };

  function render(root, snapshot, options) {
    if (!root) return;
    var state = mounted.get(root) || build(root);
    var self = (options && options.self) || null;

    if (!snapshot) {
      state.count.textContent = 'AWAITING CORE';
      return;
    }

    var devices = snapshot.devices || [];

    devices.forEach(function (device) {
      paintCard(cardFor(state, device), device, self);
    });

    // A device the operator dismissed should leave the wall, not linger as a ghost.
    var present = {};
    devices.forEach(function (device) {
      present[device.number] = true;
    });
    Object.keys(state.cards).forEach(function (number) {
      if (!present[number]) {
        state.graph.removeChild(state.cards[number]);
        delete state.cards[number];
      }
    });

    var summary = snapshot.summary || { online: 0, known: 0 };

    // "4 DEVICES ONLINE" rather than "4 / 4": with dynamic enrollment there is no
    // denominator — the room is however many people joined, and a count out of a total
    // nobody declared would be inventing a number.
    state.count.textContent =
      summary.online === summary.known
        ? summary.online + (summary.online === 1 ? ' DEVICE ONLINE' : ' DEVICES ONLINE')
        : summary.online + ' OF ' + summary.known + ' ONLINE';
    state.count.className = 'wall-count' + (summary.online < summary.known ? ' partial' : '');
  }

  /**
   * Append one activity line.
   *
   * Called per event rather than per state push, and capped, because the log is a texture
   * that should scroll rather than a record anyone reads off the wall.
   */
  function activity(root, entry) {
    var state = mounted.get(root);
    if (!state || !entry) return;

    var line = el('div', 'act-line ' + (LEVEL_CLASS[entry.level] || 'act-info'));
    line.appendChild(el('span', 'act-time', new Date(entry.at).toTimeString().slice(0, 8)));
    line.appendChild(el('span', 'act-msg', entry.message));
    if (entry.target) line.appendChild(el('span', 'act-target', entry.target));

    state.activityList.appendChild(line);

    // Eight lines is what actually fits inside the panel's height cap at projector scale.
    // Keeping more pushes the newest ones out of the clipped region, so the panel fills up
    // and then appears to stop updating — measured on a 16:9 capture, not estimated.
    while (state.activityList.childNodes.length > 8) {
      state.activityList.removeChild(state.activityList.firstChild);
    }
  }

  global.JarvisWall = { render: render, activity: activity };
})(window);
