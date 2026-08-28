/**
 * Controller.
 *
 * The path that must never fail. SPEC.md §39 requires the first takeover to be triggered
 * by hand rather than by voice, and if the LLM layer stops working mid-demo this page is
 * what the presenter falls back to — so it depends on nothing but Core.
 *
 * Every dispatch reports what actually happened, including which nodes were skipped and
 * why. Silence after a tap is the one response this interface must never give: the
 * presenter needs to know that three of four screens moved before the audience does.
 */

(function () {
  'use strict';

  var gate = document.getElementById('gate');
  var gateForm = document.getElementById('gate-form');
  var gateToken = document.getElementById('gate-token');
  var gateError = document.getElementById('gate-error');

  var consoleEl = document.getElementById('console');
  var nodesEl = document.getElementById('nodes');
  var targetValue = document.getElementById('target-value');
  var feedback = document.getElementById('feedback');
  var linkDot = document.getElementById('link-dot');
  var linkText = document.getElementById('link-text');
  var releaseAll = document.getElementById('release-all');

  var target = 'ALL';
  var snapshot = null;
  var apps = [];

  /* ----------------------------------------------------------------------------------
   * Scenes and phrases
   * ------------------------------------------------------------------------------- */

  var SCENES = [
    { id: 'jarvis', label: 'JARVIS' },
    { id: 'reactor', label: 'REACTOR' },
    { id: 'network', label: 'ARCHITECTURE' },
    { id: 'terminal', label: 'TERMINAL' },
    { id: 'gdg', label: 'GDG' },
    { id: 'wall', label: 'COMMAND WALL' },
    { id: 'red_alert', label: 'RED ALERT', hot: true },
    { id: 'blackout', label: 'BLACKOUT', hot: true },
  ];

  /**
   * The demo's spoken lines, as buttons.
   *
   * Every response SPEC.md §32 and §43 need is here. If the voice layer fails, or
   * mishears, or the venue is too loud for it, the presenter taps and the room never
   * learns the difference. Under ten words each, per §31.
   */
  var PHRASES = [
    'Yes, sir.',
    'Four authorized systems are online.',
    'Beta is the Windows machine.',
    'Identifying Beta.',
    'Taking Beta now.',
    'Chrome is open, sir.',
    'Moving to Alpha.',
    'Splitting across all nodes.',
    'Reactor sequence engaged.',
    'Releasing the room.',
  ];

  /* ----------------------------------------------------------------------------------
   * Reporting
   * ------------------------------------------------------------------------------- */

  function report(result, verb) {
    if (!result) {
      feedback.className = 'feedback bad';
      feedback.textContent = verb + ': CORE UNREACHABLE';
      return;
    }

    if (!result.ok && result.status === 401) {
      feedback.className = 'feedback bad';
      feedback.textContent = 'NOT AUTHORISED — sign in again';
      return;
    }

    var data = result.data || {};
    var dispatched = data.dispatched || [];
    var skipped = data.skipped || [];

    if (data.error && !dispatched.length) {
      feedback.className = 'feedback bad';
      feedback.textContent = verb + ' REFUSED: ' + data.error;
      return;
    }

    var line = verb + ' → ' + dispatched.length + ' node' + (dispatched.length === 1 ? '' : 's');

    // Naming the skipped nodes and the reason, rather than a count, is the difference
    // between the operator knowing to look at Gamma and finding out from the audience.
    if (skipped.length) {
      line +=
        '  ·  skipped ' +
        skipped
          .map(function (entry) {
            return entry.node + ' (' + entry.reason + ')';
          })
          .join(', ');
    }

    feedback.className = 'feedback ' + (skipped.length ? 'warn' : dispatched.length ? 'ok' : 'bad');
    feedback.textContent = line;
  }

  function send(path, body, verb) {
    feedback.className = 'feedback';
    feedback.textContent = verb + '…';

    return JarvisSession.api(path, body || {})
      .then(function (result) {
        report(result, verb);
        return result;
      })
      .catch(function () {
        report(null, verb);
      });
  }

  /* ----------------------------------------------------------------------------------
   * Room state
   * ------------------------------------------------------------------------------- */

  function setTarget(next) {
    target = next;
    targetValue.textContent = next;
    paintNodes();
  }

  function paintNodes() {
    if (!snapshot) return;

    var wanted = ['ALL'].concat(snapshot.order || []);

    // Rebuild only when the set of nodes changed; otherwise patch, so a tap does not fight
    // a re-render arriving on the next state push.
    if (nodesEl.childNodes.length !== wanted.length) {
      while (nodesEl.firstChild) nodesEl.removeChild(nodesEl.firstChild);

      wanted.forEach(function (id) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'node-chip';
        chip.dataset.node = id;

        var name = document.createElement('span');
        name.className = 'node-id';
        name.textContent = id;

        var sub = document.createElement('span');
        sub.className = 'node-sub';

        chip.appendChild(name);
        chip.appendChild(sub);
        chip.addEventListener('click', function () {
          setTarget(id);
        });
        nodesEl.appendChild(chip);
      });
    }

    var byId = {};
    (snapshot.nodes || []).forEach(function (node) {
      byId[node.id] = node;
    });

    Array.prototype.forEach.call(nodesEl.children, function (chip) {
      var id = chip.dataset.node;
      chip.setAttribute('aria-pressed', String(id === target));

      if (id === 'ALL') {
        var summary = snapshot.summary || {};
        chip.querySelector('.node-sub').textContent =
          (summary.online || 0) + '/' + (summary.configured || 0) + ' online';
        chip.classList.remove('offline');
        return;
      }

      var node = byId[id];
      if (!node) return;

      chip.classList.toggle('offline', !node.online);
      chip.querySelector('.node-sub').textContent = !node.online
        ? 'offline'
        : !node.displayAwake
          ? 'screen locked'
          : node.hasOverlay
            ? node.scene
            : 'ready';
    });
  }

  /* ----------------------------------------------------------------------------------
   * Controls
   * ------------------------------------------------------------------------------- */

  function chip(label, onTap, hot) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip' + (hot ? ' hot' : '');
    button.textContent = label;
    button.addEventListener('click', onTap);
    return button;
  }

  function buildChips() {
    var scenes = document.getElementById('scene-chips');
    SCENES.forEach(function (scene) {
      scenes.appendChild(
        chip(
          scene.label,
          function () {
            send('/api/scene', { target: target, scene: scene.id }, scene.label);
          },
          scene.hot
        )
      );
    });

    var moves = document.getElementById('move-chips');
    (snapshot ? snapshot.order : []).forEach(function (id) {
      moves.appendChild(
        chip(id, function () {
          send('/api/move', { to: id }, 'MOVE TO ' + id);
        })
      );
    });

    var appChips = document.getElementById('app-chips');
    apps.forEach(function (app) {
      appChips.appendChild(
        chip(app.toUpperCase(), function () {
          send(
            '/api/command',
            { target: target, action: 'open_app', args: { app: app } },
            'OPEN ' + app.toUpperCase()
          );
        })
      );
    });

    var phrases = document.getElementById('phrase-chips');
    PHRASES.forEach(function (text) {
      phrases.appendChild(
        chip(text, function () {
          send('/api/speak', { target: target, text: text }, 'SPEAK');
        })
      );
    });
  }

  function wireActions() {
    document.querySelectorAll('[data-act]').forEach(function (button) {
      button.addEventListener('click', function () {
        var action = button.dataset.act;

        if (action === 'takeover') return send('/api/takeover', { target: target }, 'TAKEOVER');
        if (action === 'identify') return send('/api/identify', { target: target }, 'IDENTIFY');
        if (action === 'split') return send('/api/broadcast', { scene: 'jarvis' }, 'SPLIT');
        if (action === 'cascade') return send('/api/cascade', { effect: 'arc_reactor' }, 'CASCADE');
      });
    });

    document.getElementById('url-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var input = document.getElementById('url-input');
      if (!input.value.trim()) return;
      send(
        '/api/command',
        { target: target, action: 'open_url', args: { url: input.value.trim() } },
        'OPEN URL'
      );
    });

    document.getElementById('speak-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var input = document.getElementById('speak-input');
      if (!input.value.trim()) return;
      send('/api/speak', { target: target, text: input.value.trim() }, 'SPEAK');
      input.value = '';
    });

    // Never confirms, never disables, never depends on the current target. SPEC.md §33
    // wants one control that always gives the room back, and a confirmation dialog in
    // front of it would be one more thing to get through while a demo is going wrong.
    releaseAll.addEventListener('click', function () {
      send('/api/release', { target: 'ALL' }, 'RELEASE ALL');
    });
  }

  /* ----------------------------------------------------------------------------------
   * Start
   * ------------------------------------------------------------------------------- */

  function linkState(state) {
    linkDot.className = 'dot' + (state === 'open' ? ' online' : state === 'lost' ? ' alert' : ' warn');
    linkText.textContent = state === 'open' ? 'LINKED' : state === 'lost' ? 'LINK LOST' : 'CONNECTING';
  }

  function begin() {
    gate.hidden = true;
    consoleEl.hidden = false;
    releaseAll.hidden = false;

    JarvisSession.api('/api/nodes').then(function (result) {
      if (!result.ok) return;
      snapshot = result.data;
      apps = result.data.apps || [];
      paintNodes();
      buildChips();
    });

    JarvisStream.connect({
      resolveUrl: JarvisSession.eventStreamUrl,
      onStatus: linkState,
      on: {
        state: function (payload) {
          snapshot = payload;
          paintNodes();
        },
      },
    });

    wireActions();
  }

  gateForm.addEventListener('submit', function (event) {
    event.preventDefault();
    gateError.hidden = true;

    JarvisSession.signIn(gateToken.value.trim())
      .then(function (accepted) {
        if (accepted) return begin();
        gateError.textContent = 'REJECTED';
        gateError.hidden = false;
      })
      .catch(function () {
        gateError.textContent = 'CORE UNREACHABLE';
        gateError.hidden = false;
      });
  });

  if (JarvisSession.token()) begin();
})();
