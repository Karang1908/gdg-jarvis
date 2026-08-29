#!/usr/bin/env bash
#
# Pre-generate every line JARVIS is expected to say.
#
#   scripts/warm-voice.sh                  # against a running Core
#   scripts/warm-voice.sh --list           # show what would be generated
#   scripts/warm-voice.sh --say "one off"  # add a line and cache it
#   scripts/warm-voice.sh --clear          # throw the cache away and start again
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

CONFIG="core/config/core.json"
PHRASES="core/config/phrases.json"
MODE="warm"
EXTRA=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list"; shift ;;
    --clear) MODE="clear"; shift ;;
    --say) MODE="one"; EXTRA="${2:-}"; shift 2 ;;
    --help|-h) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

[ -f "$CONFIG" ] || { bad "no $CONFIG — run scripts/setup-kali.sh --secrets-only"; exit 1; }

bold ""
bold "JARVIS — voice cache"
bold ""

# Everything below runs inside Core's own modules rather than over HTTP, because warming is
# a local operation on a local directory and going through the API would only add a way for
# it to be pointed at the wrong machine's cache.
node -e '
const fs = require("fs");
const path = require("path");
const voice = require("./core/lib/voice.js");

const mode = process.argv[1];
const extra = process.argv[2] || "";

const config = JSON.parse(fs.readFileSync("./core/config/core.json", "utf8"));
const state = voice.init(config.voice || {});

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
  console.log("  Then set voice.provider in core/config/core.json, or leave it on auto.");
  process.exit(1);
}

(async () => {
  let made = 0;
  let hit = 0;
  let failed = 0;
  const started = Date.now();

  for (const line of lines) {
    if (voice.isCached(line)) {
      hit++;
      console.log(`  \x1b[90m·\x1b[0m ${line}`);
      continue;
    }

    const at = Date.now();
    const result = await voice.synthesise(line);

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
    console.log("  \x1b[33m!\x1b[0m some lines failed — check the API key and that this machine has internet");
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
  node -e '
    const voice = require("./core/lib/voice.js");
    const fs = require("fs");
    const config = JSON.parse(fs.readFileSync("./core/config/core.json", "utf8"));
    const state = voice.init(config.voice || {});
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
