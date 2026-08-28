/**
 * Voice control.
 *
 * Speech recognition in the presenter's own browser, matched against a fixed set of
 * phrases locally. No model, no server round trip, no LLM anywhere in the path — which is
 * the whole point: this keeps working when the AI layer does not, and it cannot invent a
 * command that was never spoken.
 *
 * The microphone is closed by default and closes again the moment it is tapped. A
 * presenter spends most of a demo talking to an audience, and nothing said to the room
 * should be interpreted as an instruction. That is why this is a toggle the operator holds
 * rather than something that listens continuously on its own.
 *
 * One honest limitation: the Web Speech API in Chrome performs recognition in the cloud,
 * so the mic needs the presenter's tethered internet. Everything else on the controller
 * works with no internet at all, and if the mic is unavailable the button says so rather
 * than failing silently.
 */

(function (global) {
  'use strict';

  var Recognition = global.SpeechRecognition || global.webkitSpeechRecognition;

  /**
   * Intents, in match order.
   *
   * Deliberately a list of regular expressions rather than anything cleverer. Every phrase
   * the demo script uses is here, along with the ways someone actually says them under
   * stage lights — "take the room", "take it", "jarvis take the room". The alternative,
   * sending the transcript to an LLM to interpret, adds a network round trip and a chance
   * of a wrong guess to a moment that has to be instant and certain.
   *
   * `\b(?:jarvis[,\s]*)?` at the front lets every command be addressed or not.
   */
  var WAKE = '^(?:hey\\s+|ok\\s+)?(?:jarvis[,\\s]*)?';

  var INTENTS = [
    {
      name: 'takeover_all',
      test: new RegExp(WAKE + '(?:take|seize|grab)\\s+(?:the\\s+)?(?:room|everything|all)'),
      say: 'Taking the room.',
      run: function (api) {
        return api.post('/api/takeover', { target: 'ALL' }, 'TAKE THE ROOM');
      },
    },
    {
      name: 'release_all',
      test: new RegExp(WAKE + '(?:release|let go of|give back|free)\\s+(?:the\\s+)?(?:room|everything|all|them)'),
      say: 'Releasing the room.',
      run: function (api) {
        return api.post('/api/release', { target: 'ALL' }, 'RELEASE ALL');
      },
    },
    {
      name: 'takeover_device',
      test: new RegExp(WAKE + '(?:take|grab)\\s+(?:over\\s+)?(?:device\\s+|number\\s+)?(\\S+)'),
      run: function (api, match) {
        var device = api.toDevice(match[1]);
        if (!device) return api.unknownDevice(match[1]);
        return api.post('/api/takeover', { target: device }, 'TAKEOVER ' + device);
      },
    },
    {
      name: 'release_device',
      test: new RegExp(WAKE + 'release\\s+(?:device\\s+|number\\s+)?(\\S+)'),
      run: function (api, match) {
        var device = api.toDevice(match[1]);
        if (!device) return api.unknownDevice(match[1]);
        return api.post('/api/release', { target: device }, 'RELEASE ' + device);
      },
    },
    {
      name: 'scene',
      test: new RegExp(WAKE + '(?:show|display|switch to|go to)\\s+(?:me\\s+)?(?:the\\s+)?(jarvis|reactor|architecture|network|terminal|gdg|red alert|blackout|wall)'),
      run: function (api, match) {
        var scene = match[1].replace(/\s+/g, '_');
        if (scene === 'architecture') scene = 'network';
        return api.post('/api/scene', { target: api.target(), scene: scene }, scene.toUpperCase());
      },
    },

    // Scenes are tested before identify because they share the "show me ..." opening.
    // Ordered the other way, "show me the architecture" is read as a request to identify a
    // device called "the".
    {
      name: 'identify',
      test: new RegExp(WAKE + '(?:identify|which is|show me|find)\\s+(?:device\\s+|number\\s+)?(\\S+)'),
      run: function (api, match) {
        var device = api.toDevice(match[1]);
        if (!device) return api.unknownDevice(match[1]);
        return api.post('/api/identify', { target: device }, 'IDENTIFY ' + device);
      },
    },
    {
      name: 'move',
      test: new RegExp(WAKE + '(?:move|go|jump|come)\\s+(?:to|back to|over to)?\\s*(?:device\\s+|number\\s+)?(\\S+)'),
      run: function (api, match) {
        var device = api.toDevice(match[1]);
        if (!device) return api.unknownDevice(match[1]);
        return api.post('/api/move', { to: device }, 'MOVE TO ' + device);
      },
    },
    {
      name: 'split',
      test: new RegExp(WAKE + '(?:split|divide|clone)\\s*(?:yourself|up)?'),
      say: 'Splitting across all devices.',
      run: function (api) {
        return api.post('/api/broadcast', { scene: 'jarvis' }, 'SPLIT');
      },
    },
    {
      name: 'cascade',
      test: new RegExp(WAKE + '(?:reactor|cascade|arc)\\s*(?:sequence|reactor)?'),
      say: 'Reactor sequence engaged.',
      run: function (api) {
        return api.post('/api/cascade', { effect: 'arc_reactor' }, 'CASCADE');
      },
    },
    {
      name: 'count',
      test: new RegExp(WAKE + '(?:how many|count|status|are you there|you there)'),
      run: function (api) {
        var online = api.onlineCount();
        return api.speak(
          online === 1 ? 'One authorized system is online.' : online + ' authorized systems are online.'
        );
      },
    },
  ];

  /** Spoken numbers, because recognisers return "two" as often as "2". */
  var WORD_NUMBERS = {
    one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, tree: 3, four: 4, for: 4, fore: 4,
    five: 5, six: 6, sex: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12,
  };

  /**
   * Turn a spoken word into a device number.
   *
   * Homophones are included on purpose — a recogniser hearing "take two" will often return
   * "take too", and refusing that would make the voice layer feel broken for a reason the
   * presenter cannot see.
   */
  function spokenToNumber(word) {
    if (!word) return null;
    var cleaned = String(word).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/^\d+$/.test(cleaned)) return Number(cleaned);
    if (Object.prototype.hasOwnProperty.call(WORD_NUMBERS, cleaned)) return WORD_NUMBERS[cleaned];
    return null;
  }

  /**
   * Create the voice controller.
   *
   * `handlers` supplies everything that touches the outside world, so this module never
   * has to know how commands are sent or how the page reports things.
   */
  function create(handlers) {
    var recognition = null;
    var listening = false;
    var wantListening = false;

    var api = {
      post: handlers.post,
      speak: handlers.speak,
      target: handlers.target,
      onlineCount: handlers.onlineCount,
      toDevice: function (word) {
        var number = spokenToNumber(word);
        if (number !== null && handlers.deviceExists(number)) return String(number);
        // Not a number, so try it as a hostname — Core resolves those too, and refuses an
        // ambiguous one rather than guessing.
        return handlers.hostnameExists(word) ? String(word) : null;
      },
      unknownDevice: function (word) {
        handlers.report('no device matching "' + word + '"', 'bad');
        return null;
      },
    };

    function interpret(transcript) {
      var text = String(transcript).toLowerCase().trim().replace(/[.?!]+$/, '');
      if (!text) return;

      for (var i = 0; i < INTENTS.length; i++) {
        var match = INTENTS[i].test.exec(text);
        if (!match) continue;

        handlers.heard(text, INTENTS[i].name);
        if (INTENTS[i].say) handlers.speak(INTENTS[i].say);
        INTENTS[i].run(api, match);
        return;
      }

      // Not a command. Reported rather than swallowed, so the presenter can see that the
      // mic is live and simply did not recognise that phrasing — which is very different
      // from the mic being dead.
      handlers.heard(text, null);
    }

    function build() {
      var engine = new Recognition();
      engine.continuous = true;
      engine.interimResults = true;
      engine.lang = 'en-GB';

      engine.onresult = function (event) {
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var result = event.results[i];
          var transcript = result[0].transcript;

          if (result.isFinal) interpret(transcript);
          else handlers.interim(transcript);
        }
      };

      engine.onerror = function (event) {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          wantListening = false;
          handlers.state('denied');
          return;
        }
        // 'no-speech' and 'network' are routine; onend restarts below.
        handlers.state(wantListening ? 'listening' : 'off');
      };

      engine.onend = function () {
        listening = false;
        // Chrome ends the session on its own after a pause. Restart while the operator
        // still wants the mic open, so a toggle they set once stays set.
        if (wantListening) {
          try {
            engine.start();
            listening = true;
          } catch (err) {
            handlers.state('off');
          }
        } else {
          handlers.state('off');
        }
      };

      engine.onstart = function () {
        listening = true;
        handlers.state('listening');
      };

      return engine;
    }

    return {
      available: Boolean(Recognition),

      isOn: function () {
        return wantListening;
      },

      start: function () {
        if (!Recognition) return handlers.state('unavailable');
        if (!recognition) recognition = build();

        wantListening = true;
        try {
          if (!listening) recognition.start();
        } catch (err) {
          // start() throws if it is already running, which is harmless.
        }
        handlers.state('listening');
      },

      stop: function () {
        wantListening = false;
        if (recognition && listening) {
          try {
            recognition.stop();
          } catch (err) {
            /* already stopped */
          }
        }
        handlers.state('off');
      },
    };
  }

  global.JarvisVoice = { create: create, spokenToNumber: spokenToNumber, INTENTS: INTENTS };
})(window);
