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

  var devicePanel = document.getElementById('device-panel');
  var panelLabel = document.getElementById('panel-label');
  var renumberTo = document.getElementById('renumber-to');

  var target = 'ALL';
  var snapshot = null;
  var apps = [];
  var chipsBuilt = false;

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
  // Replaced at sign-in by core/config/phrases.json, which is also what the cache warmer
  // reads — so every button here corresponds to a line that was pre-generated.
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
    paintPanel();
  }

  /**
   * The setup panel for one device.
   *
   * Only shown for a specific device — there is no sensible "renumber ALL". The number box
   * is pre-filled with the current number so the common move (swap two devices) is: select
   * one, type the other's number, tap.
   */
  function paintPanel() {
    if (target === 'ALL') {
      devicePanel.hidden = true;
      return;
    }

    var device = deviceByNumber(target);
    if (!device) {
      devicePanel.hidden = true;
      return;
    }

    devicePanel.hidden = false;
    panelLabel.textContent =
      device.hostname + '  ·  ' + device.os + (device.isWall ? '  ·  main' : '');
    renumberTo.value = device.number;
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
          : device.hasInternet === false
            ? 'no internet'
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

    document.getElementById('make-main').addEventListener('click', function () {
      if (target === 'ALL') return;
      send('/api/wall', { device: target }, 'MAKE DEVICE ' + target + ' MAIN');
    });

    document.getElementById('renumber').addEventListener('click', function () {
      if (target === 'ALL') return;
      var wanted = Number(renumberTo.value);
      if (!wanted || wanted < 1) return report('enter a number', 'warn');
      if (String(wanted) === target) return report('already device ' + wanted, 'warn');

      send('/api/renumber', { device: target, to: wanted }, 'DEVICE ' + target + ' → ' + wanted).then(
        function (result) {
          // Follow the device to its new number, otherwise the selection silently points at
          // whichever machine was swapped into the old slot.
          if (result && result.ok && result.data && result.data.ok) setTarget(String(wanted));
        }
      );
    });

    document.getElementById('forget').addEventListener('click', function () {
      if (target === 'ALL') return;
      send('/api/forget', { device: target }, 'FORGET DEVICE ' + target).then(function () {
        setTarget('ALL');
      });
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

  var micOn = false;
  var warnedFixedWindow = false;

  function micState(state, reason) {
    micButton.classList.remove('is-on', 'is-denied', 'is-unavailable');
    micButton.setAttribute('aria-pressed', String(state === 'listening'));

    if (state === 'listening') {
      micButton.classList.add('is-on');
      micLabel.textContent = 'LISTENING';
    } else if (state === 'starting') {
      micLabel.textContent = 'OPENING\u2026';
    } else if (state === 'denied') {
      micButton.classList.add('is-denied');
      micLabel.textContent = 'MIC BLOCKED';
      report('microphone permission was refused — allow it in the browser and tap again', 'warn');
    } else if (state === 'unavailable') {
      micButton.classList.add('is-unavailable');
      micLabel.textContent = (reason && reason.short) || 'NO MIC';
      // Say why, in the place the presenter is already looking. A greyed-out button with no
      // explanation is how someone concludes the whole feature is broken.
      if (reason && reason.detail) report(reason.detail, 'warn');
    } else {
      micLabel.textContent = 'MIC OFF';
      voiceHeard.textContent = '';
    }
  }

  /**
   * The mic button.
   *
   * It does not open a microphone. The microphone is on the Kali machine, next to the
   * speakers and the model — this button asks Core to open or close it, and Core reports
   * back what it heard over the event stream.
   *
   * That is the whole point of the phone: it is a remote, not an ear. Recognition here
   * would mean the phone had to be a secure context, had to have Chrome's cloud
   * recogniser, and had to be near enough to the speaker to hear them.
   */
  function setupVoice() {
    micButton.addEventListener('click', function () {
      var turningOn = !micOn;
      micState(turningOn ? 'starting' : 'off');

      JarvisSession.api('/api/mic', { on: turningOn })
        .then(function (result) {
          var data = (result && result.data) || {};
          applyMic(data);

          if (turningOn && !data.available) {
            report(micProblem(data), 'warn');
          }
        })
        .catch(function () {
          micState('off');
          report('CORE UNREACHABLE', 'bad');
        });
    });

    // The mic may already be open — Core keeps listening across a phone reconnecting, and
    // the button has to show that rather than claim the room is deaf.
    // No body at all — api() sends GET only when body is undefined, and a POST of {} here
    // would read as "on: false" and switch the microphone off every time a phone reconnects.
    JarvisSession.api('/api/mic')
      .then(function (result) {
        applyMic((result && result.data) || {});
      })
      .catch(function () {});
  }

  /** Which half is missing, so the fix is the right one. */
  function micProblem(data) {
    if (!data.capture) return 'the Kali machine has no way to record — install sox on it';
    if (!data.transcribe) return 'the Kali machine cannot transcribe — set GEMINI_API_KEY on it';
    return 'the microphone on the Kali machine is unavailable';
  }

  function applyMic(data) {
    micOn = Boolean(data.listening);

    if (!data.available) {
      micState('unavailable', { short: 'NO MIC' });
      return;
    }
    micState(micOn ? 'listening' : 'off');

    // Fixed-window capture has no silence detection, so it records in blocks rather than
    // stopping when the speaker does. Worth saying once — it feels broken otherwise.
    if (micOn && data.fixedWindow && !warnedFixedWindow) {
      warnedFixedWindow = true;
      report('no silence detection on Core — speak in short bursts, or install sox there', 'warn');
    }
  }

  /**
   * What Core heard, and what it is doing about it.
   *
   * Showing the difference matters more than showing the words. A presenter who says
   * something and sees nothing happen needs to know which of three things went wrong:
   * the mic is dead, the phrase was not a command, or it was not addressed to JARVIS at
   * all. Silence looks the same in every case; this does not.
   */
  function showHeard(event) {
    if (!event || !event.text) return;

    var quoted = '\u201c' + event.text + '\u201d';

    if (event.status === 'ignored') {
      voiceHeard.className = 'voice-heard is-ignored';
      voiceHeard.textContent = quoted + ' \u2014 not addressed to JARVIS';
    } else if (event.status === 'thinking') {
      voiceHeard.className = 'voice-heard is-interim';
      voiceHeard.textContent = quoted + ' \u2014 thinking\u2026';
    } else {
      voiceHeard.className = 'voice-heard is-command';
      voiceHeard.textContent = quoted;
    }
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
    paintPanel();
  }

  /** Drop a token Core has rejected and go back to the sign-in. */
  function signOut(message) {
    JarvisSession.clear();
    consoleEl.hidden = true;
    voiceSection.hidden = true;
    releaseAll.hidden = true;
    gate.hidden = false;
    gateError.textContent = message;
    gateError.hidden = false;
  }

  function begin() {
    gate.hidden = true;
    consoleEl.hidden = false;
    voiceSection.hidden = false;
    releaseAll.hidden = false;

    JarvisSession.api('/api/phrases')
      .then(function (result) {
        if (result.ok && result.data && result.data.phrases) PHRASES = result.data.phrases;
      })
      .catch(function () {
        /* keep the built-in list */
      })
      .then(function () {
        return JarvisSession.api('/api/devices');
      })
      .then(function (result) {
        // A stored token that Core no longer accepts — most often because the secrets were
        // regenerated between rehearsals. Without this the console appears, stays empty,
        // and explains nothing, which looks like the room is broken rather than like a
        // sign-in that needs doing again.
        if (result && result.status === 401) return signOut('SESSION EXPIRED — sign in again');
        if (!result.ok) return report('could not read the room from Core', 'bad');

        apps = result.data.apps || [];
        buildChips();
        applySnapshot(result.data);
      })
      .catch(function () {
        report('CORE UNREACHABLE', 'bad');
      });

    JarvisStream.connect({
      resolveUrl: JarvisSession.eventStreamUrl,
      onStatus: linkState,
      on: { state: applySnapshot, heard: showHeard },
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
