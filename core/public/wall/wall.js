/**
 * Command Wall page.
 *
 * Thin: it authenticates, opens the observer stream, and hands every payload to the
 * shared renderer. All of the actual wall lives in shared/wall-view.js so this page and
 * MAIN's overlay show the room identically.
 */

(function () {
  'use strict';

  var gate = document.getElementById('gate');
  var gateForm = document.getElementById('gate-form');
  var gateToken = document.getElementById('gate-token');
  var gateError = document.getElementById('gate-error');
  var wallRoot = document.getElementById('wall');
  var linkDot = document.getElementById('link-dot');
  var linkText = document.getElementById('link-text');

  function linkState(state) {
    linkDot.className = 'dot' + (state === 'open' ? ' online' : state === 'lost' ? ' alert' : ' warn');
    linkText.textContent = state === 'open' ? 'LINKED' : state === 'lost' ? 'LINK LOST' : 'CONNECTING';
  }

  function begin() {
    gate.hidden = true;
    wallRoot.hidden = false;

    JarvisStream.connect({
      // A fresh ticket per attempt. The admin token stays in sessionStorage and never
      // reaches the URL.
      resolveUrl: JarvisSession.eventStreamUrl,
      onStatus: linkState,
      on: {
        state: function (snapshot) {
          JarvisWall.render(wallRoot, snapshot, {});
        },
        activity: function (entry) {
          JarvisWall.activity(wallRoot, entry);
        },
      },
    });
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
        // Distinguishing these matters during setup: a rejected token is a typo, an
        // unreachable Core is a network problem, and they need different fixes.
        gateError.textContent = 'CORE UNREACHABLE';
        gateError.hidden = false;
      });
  });

  // Survive a refresh without asking again — the wall gets reloaded a lot in rehearsal.
  if (JarvisSession.token()) begin();
})();
