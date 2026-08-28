/**
 * Operator session for the wall and the controller.
 *
 * Holds the admin token and exchanges it for the short-lived tickets the event stream
 * needs (PROTOCOL.md §8).
 *
 * sessionStorage rather than localStorage: the token should not outlive the tab. A demo
 * laptop gets handed around, opened on a projector, and left unlocked on a table, and a
 * key to the room that survives closing the window is a key someone else can find.
 *
 * The token is never placed in a URL. That is the whole reason tickets exist — a query
 * string survives in history, in the back button, and in Core's own access log, and a
 * screenshot of the address bar during a talk should not hand over the room.
 */

(function (global) {
  'use strict';

  var KEY = 'jarvis.admin';

  function token() {
    try {
      return sessionStorage.getItem(KEY);
    } catch (err) {
      // Private browsing and some kiosk configurations throw on access rather than
      // returning null. Treat that as "not signed in" rather than breaking the page.
      return null;
    }
  }

  function setToken(value) {
    try {
      sessionStorage.setItem(KEY, value);
    } catch (err) {
      /* held in memory for this page only */
    }
  }

  function clear() {
    try {
      sessionStorage.removeItem(KEY);
    } catch (err) {
      /* nothing to clear */
    }
  }

  /**
   * Call a control endpoint.
   *
   * Resolves to { ok, status, data }. A rejected promise is reserved for the network
   * being gone, so callers can tell "Core said no" from "Core is not there" — during a
   * demo those need different reactions from the operator.
   */
  function api(path, body) {
    var options = {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + (token() || '') },
    };

    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body || {});
    }

    return fetch(path, options).then(function (response) {
      return response
        .json()
        .catch(function () {
          return null;
        })
        .then(function (data) {
          return { ok: response.ok, status: response.status, data: data };
        });
    });
  }

  /** Exchange the admin token for a single-use observer ticket. */
  function observerTicket() {
    return api('/api/auth/ticket', {}).then(function (result) {
      if (!result.ok || !result.data || !result.data.ticket) return null;
      return result.data.ticket;
    });
  }

  /** Stream URL for the observer channel, with a freshly minted ticket. */
  function eventStreamUrl() {
    return observerTicket().then(function (ticket) {
      return ticket ? '/api/events?ticket=' + encodeURIComponent(ticket) : null;
    });
  }

  /** Confirm a token before storing it, so a typo fails at the sign-in rather than later. */
  function signIn(candidate) {
    return fetch('/api/devices', { headers: { Authorization: 'Bearer ' + candidate } }).then(
      function (response) {
        if (!response.ok) return false;
        setToken(candidate);
        return true;
      }
    );
  }

  global.JarvisSession = {
    token: token,
    setToken: setToken,
    clear: clear,
    api: api,
    observerTicket: observerTicket,
    eventStreamUrl: eventStreamUrl,
    signIn: signIn,
  };
})(window);
