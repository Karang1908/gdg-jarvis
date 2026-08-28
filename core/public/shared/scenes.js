/**
 * Scene renderers.
 *
 * Each scene is a function that fills a root element and optionally returns a teardown.
 * They are pure presentation — a scene never talks to Core, never decides when it runs,
 * and never knows what came before it. The overlay owns sequencing; this file owns looks.
 *
 * Everything is drawn with CSS and inline SVG. No images, no video, no fonts: the demo
 * runs on a network with no internet, and a scene that waits on a fetch is a black screen
 * with an audience watching it.
 */

(function (global) {
  'use strict';

  /** Build an element without innerHTML, so node labels can never inject markup. */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  /* ----------------------------------------------------------------------------------
   * The arc reactor
   *
   * The signature object, so it is drawn rather than approximated: three concentric rings
   * counter-rotating at different rates, a segmented stator, and a core that breathes.
   * Counter-rotation is what stops it reading as a loading spinner — a single spinning
   * ring is a progress indicator, three at different speeds is a machine.
   *
   * SVG rather than nested divs so it scales to a projector without resampling, and so
   * the whole thing animates on the compositor via transforms alone.
   * ------------------------------------------------------------------------------- */

  function arcReactor(size, hue) {
    var accent = hue || 'var(--cyan)';
    var svgNS = 'http://www.w3.org/2000/svg';

    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('class', 'reactor');

    function circle(r, opacity, width, dash) {
      var c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('cx', '100');
      c.setAttribute('cy', '100');
      c.setAttribute('r', String(r));
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke', accent);
      c.setAttribute('stroke-width', String(width));
      c.setAttribute('opacity', String(opacity));
      if (dash) c.setAttribute('stroke-dasharray', dash);
      return c;
    }

    var outer = document.createElementNS(svgNS, 'g');
    outer.setAttribute('class', 'ring ring-outer');
    outer.appendChild(circle(88, 0.35, 1, '2 10'));
    outer.appendChild(circle(80, 0.8, 2, '48 14'));

    var middle = document.createElementNS(svgNS, 'g');
    middle.setAttribute('class', 'ring ring-middle');
    middle.appendChild(circle(64, 0.55, 6, '6 9'));

    // The stator: eighteen spokes, which is enough to read as engineered and few enough
    // that each one stays visible when the whole thing is 40px tall on a phone.
    var stator = document.createElementNS(svgNS, 'g');
    stator.setAttribute('class', 'ring ring-inner');
    for (var i = 0; i < 18; i++) {
      var spoke = document.createElementNS(svgNS, 'line');
      var angle = (i / 18) * Math.PI * 2;
      spoke.setAttribute('x1', String(100 + Math.cos(angle) * 38));
      spoke.setAttribute('y1', String(100 + Math.sin(angle) * 38));
      spoke.setAttribute('x2', String(100 + Math.cos(angle) * 52));
      spoke.setAttribute('y2', String(100 + Math.sin(angle) * 52));
      spoke.setAttribute('stroke', accent);
      spoke.setAttribute('stroke-width', '3');
      spoke.setAttribute('opacity', i % 3 === 0 ? '0.95' : '0.4');
      stator.appendChild(spoke);
    }

    var core = document.createElementNS(svgNS, 'circle');
    core.setAttribute('cx', '100');
    core.setAttribute('cy', '100');
    core.setAttribute('r', '30');
    core.setAttribute('fill', accent);
    core.setAttribute('class', 'reactor-core');

    var halo = document.createElementNS(svgNS, 'circle');
    halo.setAttribute('cx', '100');
    halo.setAttribute('cy', '100');
    halo.setAttribute('r', '34');
    halo.setAttribute('fill', 'none');
    halo.setAttribute('stroke', accent);
    halo.setAttribute('stroke-width', '1.5');
    halo.setAttribute('opacity', '0.7');

    svg.appendChild(outer);
    svg.appendChild(middle);
    svg.appendChild(stator);
    svg.appendChild(halo);
    svg.appendChild(core);
    return svg;
  }

  /* ----------------------------------------------------------------------------------
   * Takeover — SPEC.md §17
   *
   * The timeline is the spec's, beat for beat, because the beats are good: interruption,
   * then explanation, then progress, then identity, then arrival. What matters is that
   * every line is *legible* — each holds long enough to be read from the back of a room
   * before the next replaces it.
   * ------------------------------------------------------------------------------- */

  var TAKEOVER_BEATS = [
    { at: 0, kind: 'blank' },
    { at: 250, kind: 'line', text: 'SIGNAL INTERRUPTED', tone: 'alert' },
    { at: 700, kind: 'line', text: 'REMOTE CONTROL CHANNEL DETECTED' },
    { at: 1200, kind: 'line', text: 'LINKING NODE' },
    { at: 1800, kind: 'progress' },
    { at: 2300, kind: 'identity' },
    { at: 3000, kind: 'arrival' },
  ];

  function sceneTakeover(root, args, context) {
    clear(root);
    var stage = el('div', 'takeover-stage');
    root.appendChild(stage);

    var timers = [];
    var nodeName = context.nodeId || 'NODE';

    TAKEOVER_BEATS.forEach(function (beat) {
      timers.push(
        setTimeout(function () {
          clear(stage);

          if (beat.kind === 'blank') return;

          if (beat.kind === 'line') {
            var line = el('div', 'takeover-line' + (beat.tone === 'alert' ? ' alert' : ''), beat.text);
            stage.appendChild(line);
            return;
          }

          if (beat.kind === 'progress') {
            stage.appendChild(el('div', 'takeover-line', 'LINKING NODE'));
            var track = el('div', 'takeover-bar');
            var fill = el('div', 'takeover-bar-fill');
            track.appendChild(fill);
            stage.appendChild(track);
            var readout = el('div', 'takeover-percent', '0%');
            stage.appendChild(readout);

            // Driven off the animation clock rather than a counter, so the number and the
            // bar cannot disagree if the machine drops frames.
            var began = performance.now();
            var tick = function () {
              var progress = Math.min(1, (performance.now() - began) / 480);
              readout.textContent = Math.round(progress * 100) + '%';
              if (progress < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            return;
          }

          if (beat.kind === 'identity') {
            stage.appendChild(el('div', 'takeover-node', 'NODE ' + nodeName));
            stage.appendChild(el('div', 'takeover-line', 'CONTROL ESTABLISHED'));
            return;
          }

          if (beat.kind === 'arrival') {
            var mark = el('div', 'takeover-mark wordmark', 'J.A.R.V.I.S.');
            stage.appendChild(mark);
            stage.appendChild(el('div', 'takeover-line', 'ONLINE'));
          }
        }, beat.at)
      );
    });

    return function teardown() {
      timers.forEach(clearTimeout);
    };
  }

  /* ----------------------------------------------------------------------------------
   * Idle presence
   * ------------------------------------------------------------------------------- */

  function sceneJarvis(root, args, context) {
    clear(root);

    var stage = el('div', 'centre-stage');

    // Move choreography (§22): the same scene arrives from one side or leaves toward the
    // other, which is what sells one JARVIS travelling rather than two copies existing.
    if (args.transition === 'arrive') {
      stage.classList.add('arrive-' + (args.direction === 'right' ? 'right' : 'left'));
    } else if (args.transition === 'depart') {
      stage.classList.add('depart-' + (args.direction === 'right' ? 'right' : 'left'));
    }

    stage.appendChild(arcReactor('min(38vh, 38vw)'));
    stage.appendChild(el('h1', 'headline wordmark', 'J.A.R.V.I.S.'));
    stage.appendChild(el('div', 'label spaced', context.label || context.nodeId || ''));

    root.appendChild(stage);
    return null;
  }

  /* ----------------------------------------------------------------------------------
   * Identify — SPEC.md §21
   *
   * Deliberately the loudest thing in the system. Its whole job is to prove, to a sceptical
   * room, that one named laptop and only that laptop responded. Subtlety would defeat it.
   * ------------------------------------------------------------------------------- */

  function sceneIdentify(root, args, context) {
    clear(root);
    var name = context.nodeId || 'NODE';

    var stage = el('div', 'identify-stage');
    for (var i = 0; i < 3; i++) stage.appendChild(el('div', 'identify-name', name));
    stage.appendChild(el('div', 'identify-tag', 'IDENTIFIED'));
    root.appendChild(stage);
    return null;
  }

  /* ----------------------------------------------------------------------------------
   * Reactor, alert, blackout
   * ------------------------------------------------------------------------------- */

  function sceneReactor(root, args, context) {
    clear(root);
    var stage = el('div', 'centre-stage');
    stage.appendChild(arcReactor('min(62vh, 62vw)'));
    stage.appendChild(el('div', 'label spaced', 'ARC REACTOR ONLINE'));
    root.appendChild(stage);
    return null;
  }

  function sceneRedAlert(root, args, context) {
    clear(root);
    root.classList.add('alert-mode');

    var stage = el('div', 'centre-stage');
    stage.appendChild(el('div', 'alert-bar'));
    stage.appendChild(el('h1', 'headline alert-text', 'RED ALERT'));
    stage.appendChild(el('div', 'label spaced alert-sub', (context.nodeId || '') + ' — CONTAINMENT ACTIVE'));
    stage.appendChild(el('div', 'alert-bar'));
    root.appendChild(stage);

    return function teardown() {
      root.classList.remove('alert-mode');
    };
  }

  function sceneBlackout(root) {
    clear(root);
    // Not entirely black. A barely-visible breath is the difference between "the demo is
    // doing something dramatic" and "that laptop has crashed" — and the operator is the
    // one who most needs to tell those apart.
    var pulse = el('div', 'blackout-breath');
    root.appendChild(pulse);
    return null;
  }

  /* ----------------------------------------------------------------------------------
   * Architecture — SPEC.md §32 phase 7
   *
   * The moment the trick is explained. Every layer is named honestly, and the bottom line
   * says out loud that the endpoints enrolled themselves.
   * ------------------------------------------------------------------------------- */

  var ARCHITECTURE = [
    { label: 'VOICE', note: 'presenter' },
    { label: 'LLM', note: 'natural language' },
    { label: 'MCP', note: 'tool calls' },
    { label: 'JARVIS CORE', note: 'registry + command bus' },
    { label: 'DEVICE AGENTS', note: 'enrolled, authenticated' },
    { label: 'OPERATING SYSTEM', note: 'allowlisted actions only' },
  ];

  function sceneNetwork(root) {
    clear(root);
    var stage = el('div', 'stack-stage');

    ARCHITECTURE.forEach(function (layer, index) {
      var row = el('div', 'stack-row');
      row.style.animationDelay = index * 120 + 'ms';
      row.appendChild(el('div', 'stack-label', layer.label));
      row.appendChild(el('div', 'stack-note', layer.note));
      stage.appendChild(row);

      if (index < ARCHITECTURE.length - 1) {
        var arrow = el('div', 'stack-arrow', '↓');
        arrow.style.animationDelay = index * 120 + 60 + 'ms';
        stage.appendChild(arrow);
      }
    });

    stage.appendChild(el('div', 'stack-footer', 'every endpoint voluntarily enrolled'));
    root.appendChild(stage);
    return null;
  }

  /* ----------------------------------------------------------------------------------
   * GDG
   * ------------------------------------------------------------------------------- */

  function sceneGdg(root) {
    clear(root);
    var stage = el('div', 'centre-stage gdg-stage');

    var dots = el('div', 'gdg-dots');
    ['--g-blue', '--g-red', '--g-yellow', '--g-green'].forEach(function (token, index) {
      var dot = el('span', 'gdg-dot');
      dot.style.background = 'var(' + token + ')';
      dot.style.animationDelay = index * 140 + 'ms';
      dots.appendChild(dot);
    });

    stage.appendChild(dots);
    stage.appendChild(el('h1', 'headline gdg-title', 'GOOGLE DEVELOPER GROUPS'));
    stage.appendChild(
      el('div', 'gdg-line', "IoT isn't about connecting devices to the internet.")
    );
    stage.appendChild(el('div', 'gdg-line strong', "It's about making an environment programmable."));

    root.appendChild(stage);
    return null;
  }

  /* ----------------------------------------------------------------------------------
   * Terminal
   *
   * A live readout rather than a fake one: the lines are this node's real state and the
   * commands it has actually run. If the demo is going to show a terminal, it may as well
   * be telling the truth.
   * ------------------------------------------------------------------------------- */

  function sceneTerminal(root, args, context) {
    clear(root);
    var stage = el('div', 'terminal-stage');
    var head = el('div', 'terminal-head', 'jarvis@' + (context.nodeId || 'node').toLowerCase());
    var body = el('div', 'terminal-body');
    stage.appendChild(head);
    stage.appendChild(body);
    root.appendChild(stage);

    var boot = [
      'jarvis-agent  ' + (context.agentVersion || '1.0.0'),
      'transport     server-sent events',
      'core          ' + (global.location.host || 'jarvis-core'),
      'node          ' + (context.nodeId || '?'),
      'auth          per-node token, accepted',
      'capabilities  ' + (context.capabilities || []).join(' '),
      'shell access  denied by design',
      '',
      'awaiting instruction',
    ];

    var index = 0;
    var timer = setInterval(function () {
      if (index >= boot.length) {
        clearInterval(timer);
        var caret = el('span', 'terminal-caret', '█');
        body.appendChild(caret);
        return;
      }
      body.appendChild(el('div', 'terminal-line', boot[index]));
      index++;
    }, 180);

    return function teardown() {
      clearInterval(timer);
    };
  }

  /* ----------------------------------------------------------------------------------
   * Cascade — SPEC.md §24
   *
   * One beam crossing one screen. The illusion of a beam crossing the *room* comes from
   * Core giving each node a different start delay; no node knows about any other, which is
   * why the effect survives a machine dropping out of the room entirely.
   * ------------------------------------------------------------------------------- */

  function sceneCascade(root, args, context) {
    clear(root);
    var stage = el('div', 'cascade-stage');

    var beam = el('div', 'cascade-beam');
    if (args.direction === 'right') beam.classList.add('to-right');
    else beam.classList.add('to-left');

    var flare = el('div', 'cascade-flare');

    stage.appendChild(beam);
    stage.appendChild(flare);
    stage.appendChild(el('div', 'label spaced cascade-tag', (args.effect || 'ARC REACTOR').toUpperCase().replace(/_/g, ' ')));
    root.appendChild(stage);
    return null;
  }

  /* ----------------------------------------------------------------------------------
   * Registry
   * ------------------------------------------------------------------------------- */

  var SCENES = {
    normal: function (root) {
      clear(root);
      return null;
    },
    takeover: sceneTakeover,
    jarvis: sceneJarvis,
    identify: sceneIdentify,
    reactor: sceneReactor,
    red_alert: sceneRedAlert,
    blackout: sceneBlackout,
    network: sceneNetwork,
    gdg: sceneGdg,
    terminal: sceneTerminal,
    cascade: sceneCascade,
  };

  global.JarvisScenes = {
    render: function (root, name, args, context) {
      var scene = SCENES[name] || SCENES.jarvis;
      return scene(root, args || {}, context || {});
    },
    has: function (name) {
      return Object.prototype.hasOwnProperty.call(SCENES, name);
    },
    arcReactor: arcReactor,
    el: el,
    clear: clear,
  };
})(window);
