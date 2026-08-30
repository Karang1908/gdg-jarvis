#!/usr/bin/env bash
#
# Pre-generate every line JARVIS is expected to say.
#
#   scripts/warm-voice.sh                  # against a running Core
#   scripts/warm-voice.sh --list           # show what would be generated
#   scripts/warm-voice.sh --say "one off"  # add a line and cache it
#   scripts/warm-voice.sh --clear          # throw the cache away and start again
#   scripts/warm-voice.sh --test           # say something, and report exactly what is wrong
#
# Run this once, on the Core machine, while it still has internet. Every phrase in
# core/config/phrases.json is synthesised with the best provider available and left on
# disk as audio.
#
# The point is showtime. A cached line needs no network and no synthesiser — it is a file,
# and playing it is the only thing that happens. That turns a Gemini call that might take a
# second or two, over a tethered phone, into a file read. It is also what makes the demo
# survive the tether dropping: the scripted beats keep their good voice regardless.
#
# Only lines the model invents on the spot reach a provider live.

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT" || exit 1

CONFIG=".env"
PHRASES="core/config/phrases.json"
MODE="warm"
EXTRA=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list"; shift ;;
    --clear) MODE="clear"; shift ;;
    --test) MODE="test"; shift ;;
    --say) MODE="one"; EXTRA="${2:-}"; shift 2 ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

[ -f "$CONFIG" ] || { bad "no .env — cp .env.example .env and edit it"; exit 1; }

# ---------------------------------------------------------------------------------------
# Self test
#
# The two halves of a voice fail for unrelated reasons — no text-to-speech program, or
# nothing that can play audio — and a machine with working speakers can be missing either.
# This reports both, then makes a sound, because the only convincing evidence that audio
# works is hearing it.
# ---------------------------------------------------------------------------------------

if [ "$MODE" = "test" ]; then
  bold ""
  bold "JARVIS — voice test"
  bold ""

  JARVIS_QUIET=1 node -e '
    const voice = require("./core/lib/voice.js");
    const state = voice.init(require("./core/lib/settings.js").load().voice);

    const tick = (yes, text) =>
      console.log(`  ${yes ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${text}`);

    tick(state.hasSynth, state.hasSynth
      ? `text-to-speech: ${state.provider}${state.voice ? " / " + state.voice : ""}`
      : "text-to-speech: nothing installed and no API key");

    tick(state.hasPlayer, state.hasPlayer
      ? `audio player: ${state.player}`
      : "audio player: none (this is separate from whether your speakers work)");

    if (state.root) {
      console.log("");
      console.log("  \x1b[33m!\x1b[0m you are running this as root.");
      console.log("     PulseAudio and PipeWire are per-user daemons, so root usually cannot");
      console.log("     reach the sound server no matter how loud the speakers are.");
      console.log("     Run it as yourself:   scripts/warm-voice.sh --test");
      console.log("     Core does not need root either — only the network setup does.");
    }

    if (!state.available) {
      console.log("");
      console.log("  JARVIS will be silent. Fix whichever is marked above:");
      if (!state.hasSynth) {
        console.log("    GEMINI_API_KEY=... in .env       free, and the good voice");
        console.log("    sudo apt install -y espeak-ng speech-dispatcher");
      }
      if (!state.hasPlayer) {
        console.log("    sudo apt install -y pulseaudio-utils");
      }
      process.exit(1);
    }

    if (!state.natural) {
      console.log("  \x1b[33m!\x1b[0m this is the fallback voice — set GEMINI_API_KEY for a natural one");
    }

    console.log("");
    console.log("  speaking now — you should hear it...");

    (async () => {
      const at = Date.now();
      const result = await voice.speak("JARVIS voice test. If you can hear this, the voice is working.");
      const ms = Date.now() - at;

      if (result.ok) {
        console.log(`  \x1b[32m✓\x1b[0m played via ${result.source} in ${ms}ms`);
        console.log("");
        console.log("  Heard nothing? The player exited cleanly, so it believes it played.");
        console.log("  In order of likelihood:");
        console.log("    1. you are root — run it as your normal user instead");
        console.log("    2. it went to the wrong output:   pactl list short sinks");
        console.log("       set one:                       pactl set-default-sink <name>");
        console.log("    3. no sound card at all (a VM):   aplay -l");
        console.log("    4. over SSH there is no audio session; use the machine directly");
      } else {
        // The player told us why. Repeating it verbatim beats any guess we could make.
        console.log(`  \x1b[31m✗\x1b[0m could not speak: ${result.error}`);
        if (result.detail) console.log(`     ${result.player || "it"} said: ${result.detail}`);

        if (/refused|connect|server|pulse/i.test(result.detail || "")) {
          console.log("");
          console.log("  That is the sound server refusing the connection, not a broken speaker.");
          console.log("    - if you used sudo, do not: run it as your normal user");
          console.log("    - otherwise check it is running:  systemctl --user status pulseaudio pipewire");
        }
        process.exit(1);
      }
    })();
  '
  STATUS=$?

  # Whatever happened above, report what the system thinks it has. A VM with no emulated
  # sound card produces exactly the same symptom as a routing problem, and only this tells
  # them apart.
  bold ""
  bold "What this machine has"
  if command -v aplay >/dev/null 2>&1; then
    if aplay -l 2>/dev/null | grep -q '^card'; then
      aplay -l 2>/dev/null | grep '^card' | sed 's/^/    /'
    else
      bad "ALSA reports no sound card — if this is a VM, enable audio in its settings"
    fi
  fi
  if command -v pactl >/dev/null 2>&1; then
    SINKS=$(pactl list short sinks 2>/dev/null)
    if [ -n "$SINKS" ]; then
      printf '%s\n' "$SINKS" | awk '{print "    sink: " $2 "  (" $NF ")"}'
    else
      bad "no PulseAudio sinks — the sound server is not reachable from this session"
      warn "  as root this is expected; run as your normal user"
    fi
  fi

  printf '\n'
  exit $STATUS
fi

bold ""
bold "JARVIS — voice cache"
bold ""

# Everything below runs inside Core's own modules rather than over HTTP, because warming is
# a local operation on a local directory and going through the API would only add a way for
# it to be pointed at the wrong machine's cache.
JARVIS_QUIET=1 node -e '
const fs = require("fs");
const path = require("path");
const voice = require("./core/lib/voice.js");

const mode = process.argv[1];
const extra = process.argv[2] || "";

const state = voice.init(require("./core/lib/settings.js").load().voice);

if (mode === "clear") {
  const dir = state.cacheDir;
  let removed = 0;
  if (dir && fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".wav")) { fs.unlinkSync(path.join(dir, file)); removed++; }
    }
  }
  console.log(`  \x1b[32m✓\x1b[0m removed ${removed} cached line(s)`);
  process.exit(0);
}

let lines = [];
if (mode === "one") {
  lines = [extra];
} else {
  const raw = JSON.parse(fs.readFileSync("./core/config/phrases.json", "utf8"));
  lines = [...(raw.phrases || []), ...(raw.counts || [])];
}

if (mode === "list") {
  for (const line of lines) {
    console.log(`  ${voice.isCached(line) ? "\x1b[32m✓\x1b[0m" : "\x1b[90m·\x1b[0m"} ${line}`);
  }
  console.log("");
  console.log(`  ${lines.filter((l) => voice.isCached(l)).length} of ${lines.length} already cached`);
  process.exit(0);
}

// A provider that only speaks — say, espeak — cannot produce a file, so there is nothing
// to warm. Saying so plainly beats a run that reports success and caches nothing.
const canSynthesise = state.cacheable;
if (!canSynthesise) {
  console.log(`  \x1b[33m!\x1b[0m the active provider (${state.provider || "none"}) speaks directly and cannot be cached`);
  console.log("");
  console.log("  For a natural, cacheable voice, do one of:");
  console.log("    export GEMINI_API_KEY=...        free tier, most natural");
  console.log("    pip install piper-tts            local, no internet needed");
  console.log("");
  console.log("  Then set JARVIS_VOICE_PROVIDER in .env, or leave it unset for auto.");
  process.exit(1);
}

/**
 * Warming is rate limited, so it has to be patient rather than fast.
 *
 * Measured against a free-tier key: three requests per minute for the TTS model. Firing the
 * whole list at once means the first few succeed and every one after is refused, which is
 * exactly what happened — 23 of 28 lines failed in 15 seconds and the cache stayed empty.
 *
 * So: wait between lines, and when the API says to come back later, come back later. This
 * takes minutes rather than seconds. That is the correct trade — it runs once, before the
 * demo, and what it buys is every scripted line playing instantly and in the good voice for
 * the rest of the evening.
 */
const GAP_MS = Number(process.env.JARVIS_WARM_GAP_MS) || 21_000;
const RETRIES = 4;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let made = 0;
  let hit = 0;
  let failed = 0;
  const started = Date.now();

  const todo = lines.filter((line) => !voice.isCached(line));
  if (todo.length > 1) {
    const estimate = Math.ceil((todo.length * GAP_MS) / 60000);
    console.log(`  \x1b[90m${todo.length} to generate, pacing for the rate limit — about ${estimate} min\x1b[0m`);
    console.log("");
  }

  let first = true;

  for (const line of lines) {
    if (voice.isCached(line)) {
      hit++;
      console.log(`  \x1b[90m·\x1b[0m ${line}`);
      continue;
    }

    // Not before the first, so a single line stays quick.
    if (!first) await wait(GAP_MS);
    first = false;

    const at = Date.now();
    let result = null;

    for (let attempt = 0; attempt <= RETRIES && !result; attempt++) {
      if (attempt > 0) {
        // Backs off well past the one-minute window the limit is measured over.
        const backoff = 30_000 * attempt;
        console.log(`  \x1b[33m⟳\x1b[0m rate limited, waiting ${backoff / 1000}s — ${line}`);
        await wait(backoff);
      }
      result = await voice.synthesise(line);
    }

    if (result) {
      made++;
      console.log(`  \x1b[32m✓\x1b[0m ${line}  \x1b[90m${Date.now() - at}ms\x1b[0m`);
    } else {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${line}`);
    }
  }

  console.log("");
  console.log(`  ${made} generated, ${hit} already cached, ${failed} failed  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`  cache: ${state.cacheDir}`);

  if (failed) {
    console.log("");
    console.log("  \x1b[33m!\x1b[0m some lines failed — usually the rate limit. Run it again;");
    console.log("      whatever succeeded is cached, so each run has less left to do.");
  }
  process.exit(failed ? 1 : 0);
})();
' "$MODE" "$EXTRA"

STATUS=$?

if [ "$MODE" = "warm" ] && [ $STATUS -eq 0 ]; then
  bold ""
  bold "Playback"
  # The number that matters at showtime is how long a cached line takes to start, and it is
  # a property of this machine's audio player rather than of the synthesiser. Measure it
  # here so it is a known quantity rather than a surprise on stage.
  JARVIS_QUIET=1 node -e '
    const voice = require("./core/lib/voice.js");
    const fs = require("fs");
    const state = voice.init(require("./core/lib/settings.js").load().voice);
    if (!state.player) { console.log("  \x1b[33m!\x1b[0m nothing on this machine can play audio"); process.exit(0); }

    (async () => {
      const line = "Yes, sir.";
      if (!voice.isCached(line)) { console.log("  \x1b[90m·\x1b[0m nothing cached to measure"); return; }
      const at = Date.now();
      await voice.speak(line);
      console.log(`  \x1b[32m✓\x1b[0m "${line}" played in ${Date.now() - at}ms via ${state.player}`);
      console.log("     that is playback, not synthesis — synthesis already happened");
    })();
  ' 2>/dev/null
fi

printf '\n'
exit $STATUS
