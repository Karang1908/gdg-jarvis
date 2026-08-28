/**
 * The overlay.
 *
 * One browser window, launched by the agent, sitting fullscreen over a teammate's
 * desktop. It receives scenes from Core on its own SSE stream and renders them; it never
 * issues a command and never touches the operating system.
 *
 * Three obligations shape everything below, in order of importance:
 *
 *   1. It must be dismissable by the person in front of it, always, without help.
 *   2. It must not outlive Core. A dead control plane leaves nobody to release it.
 *   3. It must look like the room was taken.
 *
 * The first two are why this file is longer than the scene renderers it drives.
 */

(function () {
  'use strict';

  var sceneRoot = document.getElementById('scene');
  var hudNode = document.getElementById('hud-node');
  var hudDot = document.getElementById('hud-dot');
  var hudLink = document.getElementById('hud-link');
  var escapePanel = document.getElementById('escape');
  var escapeFill = document.getElementById('escape-fill');

  var nodeId = JarvisStream.param('device') || '?';
  var ticket = JarvisStream.param('ticket');
  var isWall = JarvisStream.param('wall') === '1';
  var resumeScene = JarvisStream.param('scene');

  // The overlay shows the device number as its identity, with the hostname underneath —
  // the same pairing the wall and the controller use, so a teammate seeing their own screen
  // taken over can read off the number the presenter is about to say.
  var context = { nodeId: nodeId, label: nodeId, capabilities: [] };
  var teardown = null;
  var pendingScene = null;
  var lastState = null;
  var currentScene = null;
  var pendingActivity = [];

  hudNode.textContent = 'DEVICE ' + nodeId;

  /**
   * If Core stops talking for this long, close.
   *
   * Long enough to ride out a Wi-Fi roam or a Core restart between rehearsal runs, short
   * enough that a teammate is not left staring at a dead overlay while someone debugs.
   * The agent's own trap handles the ordinary cases; this covers the one where the agent
   * died too. See DEVIATIONS.md D4.
   */
  var DEAD_MAN_MS = 45000;

  /* ----------------------------------------------------------------------------------
   * Scene rendering
   * ------------------------------------------------------------------------------- */

  function show(name, args) {
    if (teardown) {
      try {
        teardown();
      } catch (err) {
        /* a scene that fails to clean up must not block the next one */
      }
      teardown = null;
    }

    currentScene = name;
    sceneRoot.className = 'scene-root';

    // The wall is a scene like any other from the overlay's point of view; it just happens
    // to render the room instead of an effect (DEVIATIONS.md D5).
    if (name === 'wall') {
      sceneRoot.classList.add('wall-mode');
      JarvisWall.render(sceneRoot, lastState, { self: nodeId });

      // Drain whatever arrived while the takeover animation was still playing, so the
      // wall appears with history rather than filling in from empty.
      var backlog = pendingActivity.splice(-14);
      for (var i = 0; i < backlog.length; i++) JarvisWall.activity(sceneRoot, backlog[i]);
      return;
    }

    teardown = JarvisScenes.render(sceneRoot, name, args || {}, context);
  }

  /** What this node settles into once nothing else is happening. */
  function restingScene() {
    return isWall ? 'wall' : 'jarvis';
  }

  /**
   * Apply a scene, honouring the stagger Core attached to it.
   *
   * `delay` is relative to this moment, never an absolute timestamp — the laptops in the
   * room do not agree about the time and there is no NTP to make them. See
   * DEVIATIONS.md D2.
   */
  function applyScene(name, args) {
    var delay = Number(args && args.delay) || 0;

    if (pendingScene) {
      clearTimeout(pendingScene);
      pendingScene = null;
    }

    if (delay <= 0) return show(name, args);

    pendingScene = setTimeout(function () {
      pendingScene = null;
      show(name, args);
    }, delay);
  }

  /* ----------------------------------------------------------------------------------
   * Commands
   * ------------------------------------------------------------------------------- */

  function handleCommand(payload) {
    var action = payload.action;
    var args = payload.args || {};

    if (action === 'show_scene') {
      applyScene(args.scene, args);

      // Cascade and identify are momentary by nature; leaving them on screen would freeze
      // a beam mid-flight. Everything else persists until Core says otherwise.
      if (args.scene === 'cascade') {
        setTimeout(function () {
          if (currentScene === 'cascade') show(restingScene(), {});
        }, 1200 + (Number(args.delay) || 0));
      }
      return;
    }

    if (action === 'identify') {
      var duration = Number(args.duration) || 4000;
      show('identify', args);
      setTimeout(function () {
        if (currentScene === 'identify') show(restingScene(), {});
      }, duration);
      return;
    }

    // An action this surface does not implement is ignored rather than guessed at. The
    // agent handles everything that touches the operating system; if one arrives here it
    // is a routing mistake in Core, and rendering something arbitrary would hide it.
  }

  /* ----------------------------------------------------------------------------------
   * Connection
   * ------------------------------------------------------------------------------- */

  function linkState(state) {
    hudDot.className = 'dot' + (state === 'open' ? ' online' : state === 'lost' ? ' alert' : ' warn');
    hudLink.textContent = state === 'open' ? 'LINKED' : state === 'lost' ? 'LINK LOST' : 'LINKING';
  }

  var stream = JarvisStream.connect({
    resolveUrl: function () {
      if (!ticket) return null;
      return (
        '/api/overlay/stream?device=' + encodeURIComponent(nodeId) + '&ticket=' + encodeURIComponent(ticket)
      );
    },

    onStatus: linkState,

    on: {
      hello: function (payload) {
        context.label = payload.label || nodeId;
        context.os = payload.os;
        hudNode.textContent = 'DEVICE ' + nodeId + (payload.label ? ' · ' + payload.label : '');

        // Tickets are single use. This is the replacement for the one just spent, and
        // without storing it here a dropped stream could never come back.
        ticket = payload.renew || null;
      },

      command: handleCommand,

      state: function (payload) {
        lastState = payload;
        if (currentScene === 'wall') JarvisWall.render(sceneRoot, lastState, { self: nodeId });
      },

      activity: function (entry) {
        // Buffered until the wall is on screen: Core replays recent activity on connect,
        // which arrives while the takeover animation is still running.
        if (currentScene === 'wall') JarvisWall.activity(sceneRoot, entry);
        else pendingActivity.push(entry);
      },
    },
  });

  /**
   * Dead-man switch.
   *
   * Core sends a keep-alive comment every 15 seconds, so silence for three times that
   * means the control plane is genuinely gone rather than merely quiet.
   */
  setInterval(function () {
    if (stream.silentFor() > DEAD_MAN_MS) {
      release('core unreachable');
    }
  }, 5000);

  /* ----------------------------------------------------------------------------------
   * Escape hatch — DEVIATIONS.md D4
   *
   * Hold Escape. A hold rather than a tap because a stray keypress must not drop a screen
   * mid-demo, and a visible progress bar because someone doing this is already worried and
   * deserves to see that it is working.
   * ------------------------------------------------------------------------------- */

  var ESCAPE_HOLD_MS = 1200;
  var escapeStarted = 0;
  var escapeTimer = null;

  function beginEscape() {
    if (escapeStarted) return;
    escapeStarted = Date.now();
    escapePanel.hidden = false;

    escapeTimer = setInterval(function () {
      var held = Date.now() - escapeStarted;
      escapeFill.style.transform = 'scaleX(' + Math.min(1, held / ESCAPE_HOLD_MS) + ')';
      if (held >= ESCAPE_HOLD_MS) release('escape held');
    }, 40);
  }

  function cancelEscape() {
    if (!escapeStarted) return;
    escapeStarted = 0;
    clearInterval(escapeTimer);
    escapeTimer = null;
    escapePanel.hidden = true;
    escapeFill.style.transform = 'scaleX(0)';
  }

  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') beginEscape();
  });
  window.addEventListener('keyup', function (event) {
    if (event.key === 'Escape') cancelEscape();
  });

  // Losing focus should abandon a half-finished hold rather than leave it running.
  window.addEventListener('blur', cancelEscape);

  /**
   * Give the screen back.
   *
   * window.close() succeeds in a Chrome --app window, which is how the agent launches
   * this. When it does not, the page says what to press rather than leaving someone
   * stuck with a black rectangle and no explanation.
   */
  function release(reason) {
    if (stream) stream.close();
    if (escapeTimer) clearInterval(escapeTimer);

    window.close();

    setTimeout(function () {
      JarvisScenes.clear(sceneRoot);
      sceneRoot.className = 'scene-root';

      var stage = JarvisScenes.el('div', 'centre-stage');
      stage.appendChild(JarvisScenes.el('div', 'headline', 'RELEASED'));
      stage.appendChild(JarvisScenes.el('div', 'label spaced', reason));
      stage.appendChild(
        JarvisScenes.el('div', 'label spaced', 'press ' + (isMac() ? 'Cmd+Q' : 'Alt+F4') + ' to close this window')
      );
      sceneRoot.appendChild(stage);
    }, 350);
  }

  function isMac() {
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  }

  /* ----------------------------------------------------------------------------------
   * Start
   * ------------------------------------------------------------------------------- */

  if (resumeScene) {
    // Reopened after a reconnect. Going straight to the scene it was already showing means
    // a Wi-Fi blip does not announce itself to the audience as a fresh takeover.
    show(resumeScene === 'takeover' ? restingScene() : resumeScene, {});
  } else {
    show('takeover', {});
    setTimeout(function () {
      if (currentScene === 'takeover') show(restingScene(), {});
    }, 4200);
  }
})();
