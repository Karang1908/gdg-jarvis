/**
 * SSE client with reconnection.
 *
 * EventSource reconnects on its own, which is almost what we want and not quite. Every
 * stream here is authorised by a single-use ticket (PROTOCOL.md §8), so EventSource's
 * automatic retry would replay a spent ticket and be refused forever. This wrapper takes
 * the retry back: on any drop it asks the caller for a fresh URL and starts again.
 *
 * The cost of getting this wrong is a screen that goes dark mid-demo and stays dark, so
 * it also reports connection state to the page rather than failing quietly.
 */

(function (global) {
  'use strict';

  var RETRY_MIN_MS = 500;
  var RETRY_MAX_MS = 5000;

  /**
   * @param {object} options
   * @param {function(): Promise<string>} options.resolveUrl  fresh, authorised stream URL
   * @param {object} options.on                               event name -> handler
   * @param {function(string, object=)} [options.onStatus]    'connecting'|'open'|'lost'
   */
  function connect(options) {
    var source = null;
    var retryMs = RETRY_MIN_MS;
    var stopped = false;
    var lastEventAt = Date.now();

    function status(state, detail) {
      if (options.onStatus) options.onStatus(state, detail || {});
    }

    function attach(url) {
      source = new EventSource(url);

      source.onopen = function () {
        retryMs = RETRY_MIN_MS;
        lastEventAt = Date.now();
        status('open');
      };

      // A named-event stream never fires onmessage in normal operation; when it does, the
      // server sent an unnamed frame, which is worth seeing rather than dropping.
      source.onmessage = function (event) {
        lastEventAt = Date.now();
        if (options.on && options.on.message) options.on.message(event);
      };

      Object.keys(options.on || {}).forEach(function (eventName) {
        if (eventName === 'message') return;
        source.addEventListener(eventName, function (event) {
          lastEventAt = Date.now();
          var payload = null;
          try {
            payload = JSON.parse(event.data);
          } catch (err) {
            return;
          }
          options.on[eventName](payload, event);
        });
      });

      source.onerror = function () {
        // EventSource fires error for both a transient blip and a hard close. Either way
        // the ticket is spent, so tear down and take a fresh one rather than letting the
        // built-in retry hammer a URL that can no longer authenticate.
        if (source) {
          source.close();
          source = null;
        }
        if (stopped) return;

        status('lost', { retryMs: retryMs });
        setTimeout(start, retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      };
    }

    function start() {
      if (stopped) return;
      status('connecting');

      Promise.resolve()
        .then(options.resolveUrl)
        .then(function (url) {
          if (stopped || !url) throw new Error('no stream url');
          attach(url);
        })
        .catch(function () {
          if (stopped) return;
          status('lost', { retryMs: retryMs });
          setTimeout(start, retryMs);
          retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        });
    }

    start();

    return {
      /** Milliseconds since anything arrived. Feeds the overlay's dead-man switch. */
      silentFor: function () {
        return Date.now() - lastEventAt;
      },
      close: function () {
        stopped = true;
        if (source) {
          source.close();
          source = null;
        }
      },
    };
  }

  /** Read a query parameter from the page URL. */
  function param(name) {
    return new URLSearchParams(global.location.search).get(name);
  }

  global.JarvisStream = { connect: connect, param: param };
})(window);
