/**
 * Controller.
 *
 * The path that must never fail. SPEC.md §39 requires the first takeover to be triggered
 * by hand rather than by voice, and if the LLM layer stops working mid-demo this page is
 * what the presenter falls back to — so it depends on nothing but Core.
 *
 * Every dispatch reports what actually happened, including which devices were skipped and
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

  var voiceSection = document.getElementById('voice');
  var micButton = document.getElementById('mic');
  var micLabel = document.getElementById('mic-label');
  var voiceHeard = document.getElementById('voice-heard');
  var speakerButton = document.getElementById('speaker');
  var speakerLabel = document.getElementById('speaker-label');

  var target = 'ALL';
  var snapshot = null;
  var apps = [];
  var chipsBuilt = false;
  var voice = null;

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
   * If the voice layer fails, or mishears, or the venue is too loud, the presenter taps
   * and the room never learns the difference. Under ten words each, per SPEC.md §31.
   */
  var PHRASES = [
    'Yes, sir.',
    'All systems are online.',
    'Identifying now.',
    'Taking control.',
    'Chrome is open, sir.',
    'Moving across.',
    'Splitting across all devices.',
    'Reactor sequence engaged.',
    'Releasing the room.',
  ];

  /* ----------------------------------------------------------------------------------
   * Reporting
   * ------------------------------------------------------------------------------- */

  function report(message, tone) {
    feedback.className = 'feedback ' + (tone || '');
    feedback.textContent = message;
  }

  function describe(result, verb) {
    if (!result) return report(verb + ': CORE UNREACHABLE', 'bad');

    if (!result.ok && result.status === 401) {
      return report('NOT AUTHORISED — sign in again', 'bad');
    }

    var data = result.data || {};
    var dispatched = data.dispatched || [];
    var skipped = data.skipped || [];

    if (data.error && !dispatched.length) {
      return report(verb + ' REFUSED: ' + data.error, 'bad');
    }

    // JARVIS speaking in its own voice reports what it said, not a dispatch.
    if (data.spoken) return report('JARVIS: “' + data.spoken + '”', data.ok ? 'ok' : 'warn');

    // Some endpoints (mute, wall, forget) report differently. Treat a bare ok as success.
    if (!data.dispatched && data.ok) return report(verb + ' → ok', 'ok');

    var line = verb + ' → ' + dispatched.length + ' device' + (dispatched.length === 1 ? '' : 's');

    // Naming the skipped devices and the reason, rather than a count, is the difference
    // between the operator knowing to look at device 3 and finding out from the audience.
    if (skipped.length) {
      line +=
        '  ·  skipped ' +
        skipped
          .map(function (entry) {
            return entry.node + ' (' + entry.reason + ')';
          })
          .join(', ');
    }

    report(line, skipped.length ? 'warn' : dispatched.length ? 'ok' : 'bad');
  }

  function send(path, body, verb) {
    report(verb + '…', '');
    return JarvisSession.api(path, body || {})
      .then(function (result) {
        describe(result, verb);
        return result;
      })
      .catch(function () {
        describe(null, verb);
      });
  }

  /* ----------------------------------------------------------------------------------
   * Room state
   * ------------------------------------------------------------------------------- */

  function devices() {
    return (snapshot && snapshot.devices) || [];
  }

  function deviceByNumber(number) {
    return devices().filter(function (d) {
      return d.number === Number(number);
    })[0];
  }

  function setTarget(next) {
    target = String(next);
    targetValue.textContent = target === 'ALL' ? 'ALL' : 'DEVICE ' + target;
    paintDevices();
    paintSpeaker();
  }

  /**
   * Is the current target audible?
   *
   * ALL counts as muted only when every device is, so the toggle reflects what the
   * presenter would actually hear rather than the state of one arbitrary machine.
   */
  function targetMuted() {
    var list = target === 'ALL' ? devices() : [deviceByNumber(target)].filter(Boolean);
    if (!list.length) return false;
    return list.every(function (d) {
      return d.muted;
    });
  }

  function paintSpeaker() {
    var muted = targetMuted();
    speakerButton.setAttribute('aria-pressed', String(muted));
    speakerButton.classList.toggle('is-muted', muted);
    speakerLabel.textContent = muted ? 'JARVIS MUTED' : 'JARVIS AUDIBLE';
  }

  function paintDevices() {
    if (!snapshot) return;

    var wanted = ['ALL'].concat(
      devices().map(function (d) {
        return String(d.number);
      })
    );

    // Rebuild only when the set of devices changed; otherwise patch, so a tap does not
    // fight a re-render arriving on the next state push.
    if (nodesEl.childNodes.length !== wanted.length) {
      while (nodesEl.firstChild) nodesEl.removeChild(nodesEl.firstChild);

      wanted.forEach(function (id) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'node-chip';
        chip.dataset.device = id;

        var name = document.createElement('span');
        name.className = 'node-id';
        name.textContent = id;

        var host = document.createElement('span');
        host.className = 'node-host';

        var sub = document.createElement('span');
        sub.className = 'node-sub';

        chip.appendChild(name);
        chip.appendChild(host);
        chip.appendChild(sub);
        chip.addEventListener('click', function () {
          setTarget(id);
        });
        nodesEl.appendChild(chip);
      });
    }

    Array.prototype.forEach.call(nodesEl.children, function (chip) {
      var id = chip.dataset.device;
      chip.setAttribute('aria-pressed', String(id === target));

      if (id === 'ALL') {
        var summary = snapshot.summary || {};
        chip.querySelector('.node-host').textContent = 'everyone';
        chip.querySelector('.node-sub').textContent = (summary.online || 0) + ' online';
        chip.classList.remove('offline');
        return;
      }

      var device = deviceByNumber(id);
      if (!device) return;

      chip.classList.toggle('offline', !device.online);
      chip.classList.toggle('is-wall', Boolean(device.isWall));
      chip.querySelector('.node-host').textContent = device.hostname || '';
      chip.querySelector('.node-sub').textContent = !device.online
        ? 'offline'
        : !device.displayAwake
          ? 'locked'
          : device.muted
            ? 'muted'
            : device.hasOverlay
              ? device.scene
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
    if (chipsBuilt) return;
    chipsBuilt = true;

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
          // JARVIS's own voice, from Core — not whichever device happens to be selected.
          // The target selector governs what is *done to* a device; speech is JARVIS.
          send('/api/speak', { text: text }, 'SPEAK');
        })
      );
    });
  }

  /**
   * Move targets are rebuilt on every state change.
   *
   * Unlike scenes and apps, this list is the room itself — a device that joins mid-demo
   * has to become a destination without the page being reloaded.
   */
  function paintMoveChips() {
    var moves = document.getElementById('move-chips');
    var current = devices()
      .map(function (d) {
        return d.number;
      })
      .join(',');
    if (moves.dataset.built === current) return;
    moves.dataset.built = current;

    while (moves.firstChild) moves.removeChild(moves.firstChild);
    devices().forEach(function (device) {
      moves.appendChild(
        chip(String(device.number), function () {
          send('/api/move', { to: String(device.number) }, 'MOVE TO ' + device.number);
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
      send('/api/speak', { text: input.value.trim() }, 'SPEAK');
      input.value = '';
    });

    // Whether JARVIS is heard at all. Distinct from the microphone: this is JARVIS's
    // voice, that one is yours.
    speakerButton.addEventListener('click', function () {
      var muting = !targetMuted();
      send('/api/mute', { target: target, muted: muting }, muting ? 'MUTE' : 'UNMUTE');
    });

    // Never confirms, never disables, never depends on the current target. SPEC.md §33
    // wants one control that always gives the room back, and a confirmation dialog in
    // front of it would be one more thing to get through while a demo is going wrong.
    releaseAll.addEventListener('click', function () {
      send('/api/release', { target: 'ALL' }, 'RELEASE ALL');
    });
  }

  /* ----------------------------------------------------------------------------------
   * Microphone
   * ------------------------------------------------------------------------------- */

  function micState(state) {
    micButton.classList.remove('is-on', 'is-denied', 'is-unavailable');
    micButton.setAttribute('aria-pressed', String(state === 'listening'));

    if (state === 'listening') {
      micButton.classList.add('is-on');
      micLabel.textContent = 'LISTENING';
    } else if (state === 'denied') {
      micButton.classList.add('is-denied');
      micLabel.textContent = 'MIC BLOCKED';
      report('microphone permission was refused — allow it in the browser and tap again', 'warn');
    } else if (state === 'unavailable') {
      micButton.classList.add('is-unavailable');
      micLabel.textContent = 'NO MIC';
    } else {
      micLabel.textContent = 'MIC OFF';
      voiceHeard.textContent = '';
    }
  }

  function setupVoice() {
    voice = JarvisVoice.create({
      post: function (path, body, verb) {
        return send(path, body, verb);
      },
      speak: function (text) {
        return send('/api/speak', { text: text }, 'SPEAK');
      },
      target: function () {
        return target;
      },
      onlineCount: function () {
        return (snapshot && snapshot.summary && snapshot.summary.online) || 0;
      },
      deviceExists: function (number) {
        return Boolean(deviceByNumber(number));
      },
      hostnameExists: function (word) {
        var needle = String(word).toLowerCase();
        return devices().some(function (d) {
          return (d.hostname || '').toLowerCase().indexOf(needle) !== -1;
        });
      },
      interim: function (text) {
        voiceHeard.className = 'voice-heard is-interim';
        voiceHeard.textContent = text;
      },
      heard: function (text, intent) {
        // Showing what was heard even when nothing matched is what tells the presenter the
        // mic is live but the phrasing was not recognised — very different from a dead mic.
        voiceHeard.className = 'voice-heard' + (intent ? ' is-command' : ' is-ignored');
        voiceHeard.textContent = intent ? '“' + text + '”' : '“' + text + '” — not a command';
      },
      report: report,
      state: micState,
    });

    if (!voice.available) {
      micState('unavailable');
      micButton.disabled = true;
      return;
    }

    micButton.addEventListener('click', function () {
      if (voice.isOn()) voice.stop();
      else voice.start();
    });
  }

  /* ----------------------------------------------------------------------------------
   * Start
   * ------------------------------------------------------------------------------- */

  function linkState(state) {
    linkDot.className = 'dot' + (state === 'open' ? ' online' : state === 'lost' ? ' alert' : ' warn');
    linkText.textContent = state === 'open' ? 'LINKED' : state === 'lost' ? 'LINK LOST' : 'CONNECTING';
  }

  function applySnapshot(payload) {
    snapshot = payload;

    // A device the operator dismissed, or one that never came back, should not stay
    // selected — every subsequent command would silently target nothing.
    if (target !== 'ALL' && !deviceByNumber(target)) setTarget('ALL');

    paintDevices();
    paintMoveChips();
    paintSpeaker();
  }

  function begin() {
    gate.hidden = true;
    consoleEl.hidden = false;
    voiceSection.hidden = false;
    releaseAll.hidden = false;

    JarvisSession.api('/api/devices').then(function (result) {
      if (!result.ok) return;
      apps = result.data.apps || [];
      buildChips();
      applySnapshot(result.data);
    });

    JarvisStream.connect({
      resolveUrl: JarvisSession.eventStreamUrl,
      onStatus: linkState,
      on: { state: applySnapshot },
    });

    wireActions();
    setupVoice();
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
