#!/usr/bin/env bash
#
# Hear the voices, pick one.
#
#   scripts/voices.sh                 # list what is available
#   scripts/voices.sh --audition      # speak a line in each voice worth considering
#   scripts/voices.sh --try Iapetus   # hear one
#   scripts/voices.sh --all           # audition every voice, not just the shortlist
#
# Whichever you like, put it in .env:
#
#   JARVIS_VOICE=Iapetus
#
# The delivery matters as much as the voice. JARVIS_STYLE in .env tells the model *how* to
# say the line, and changing it changes the result more than swapping voices does.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

MODE="list"
WANTED=""
LINE="Yes, sir. All systems are online."

while [ $# -gt 0 ]; do
  case "$1" in
    --audition) MODE="audition"; shift ;;
    --all) MODE="all"; shift ;;
    --try) MODE="try"; WANTED="${2:-}"; shift 2 ;;
    --say) LINE="${2:-$LINE}"; shift 2 ;;
    --help|-h) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

bold ""
bold "JARVIS — voices"
bold ""

MODE="$MODE" WANTED="$WANTED" LINE="$LINE" JARVIS_QUIET=1 node -e '
const voice = require("./core/lib/voice.js");
const settings = require("./core/lib/settings.js");

const mode = process.env.MODE;
const wanted = process.env.WANTED;
const line = process.env.LINE;

const state = voice.init(settings.load().voice);

/**
 * The 30 Gemini voices, with the characteristic Google gives each.
 *
 * `jarvis: true` marks the ones actually worth auditioning for this. JARVIS is composed,
 * dry and unhurried, so anything described as upbeat, excitable, youthful or lively is
 * listed for completeness and skipped by default — hearing "Yes, sir" delivered brightly
 * is funny once and wastes the other twenty auditions.
 */
const GEMINI = [
  { name: "Charon",        note: "informative",   jarvis: true },
  { name: "Iapetus",       note: "clear",         jarvis: true },
  { name: "Rasalgethi",    note: "informative",   jarvis: true },
  { name: "Alnilam",       note: "firm",          jarvis: true },
  { name: "Orus",          note: "firm",          jarvis: true },
  { name: "Kore",          note: "firm",          jarvis: true },
  { name: "Schedar",       note: "even",          jarvis: true },
  { name: "Gacrux",        note: "mature",        jarvis: true },
  { name: "Algenib",       note: "gravelly",      jarvis: true },
  { name: "Sadaltager",    note: "knowledgeable", jarvis: true },
  { name: "Enceladus",     note: "breathy",       jarvis: true },
  { name: "Algieba",       note: "smooth",        jarvis: true },
  { name: "Erinome",       note: "clear",         jarvis: true },
  { name: "Umbriel",       note: "easy-going" },
  { name: "Despina",       note: "smooth" },
  { name: "Vindemiatrix",  note: "gentle" },
  { name: "Achernar",      note: "soft" },
  { name: "Sulafat",       note: "warm" },
  { name: "Achird",        note: "friendly" },
  { name: "Zubenelgenubi", note: "casual" },
  { name: "Callirrhoe",    note: "easy-going" },
  { name: "Aoede",         note: "breezy" },
  { name: "Autonoe",       note: "bright" },
  { name: "Zephyr",        note: "bright" },
  { name: "Pulcherrima",   note: "forward" },
  { name: "Puck",          note: "upbeat" },
  { name: "Laomedeia",     note: "upbeat" },
  { name: "Sadachbia",     note: "lively" },
  { name: "Fenrir",        note: "excitable" },
  { name: "Leda",          note: "youthful" },
];

function localVoices() {
  const { execSync } = require("child_process");
  try {
    if (state.provider === "say" || state.provider === "say-direct") {
      // `say -v ?` prints "Name    locale    # sample". Names contain spaces and nested
      // parentheses — "Eddy (English (UK))" — so the locale code is the only reliable
      // boundary to split on.
      return execSync("say -v \x27?\x27", { encoding: "utf8" })
        .split("\n")
        .map((l) => /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/.exec(l))
        .filter(Boolean)
        .filter((m) => /^en_/.test(m[2]))
        .map((m) => ({ name: m[1].trim(), note: m[2], jarvis: m[2] === "en_GB" }));
    }
    if (state.provider === "espeak" || state.provider === "espeak-ng") {
      return execSync(`${state.provider} --voices=en`, { encoding: "utf8" })
        .split("\n").slice(1).filter(Boolean)
        .map((l) => { const p = l.trim().split(/\s+/); return { name: p[1], note: p[3] || "", jarvis: /gb/.test(p[1]) }; });
    }
  } catch { /* fall through */ }
  return [];
}

const usingGemini = state.provider === "gemini";
const catalogue = usingGemini ? GEMINI : localVoices();

if (!state.available) {
  console.log("  \x1b[31m✗\x1b[0m JARVIS has no voice configured — run scripts/warm-voice.sh --test");
  process.exit(1);
}

console.log(`  provider: \x1b[1m${state.provider}\x1b[0m${state.voice ? "   current: \x1b[1m" + state.voice + "\x1b[0m" : ""}`);
if (!usingGemini) {
  console.log("  \x1b[33m!\x1b[0m these are the local voices. Set GEMINI_API_KEY in .env for the natural ones.");
}
console.log("");

if (mode === "list") {
  const shortlist = catalogue.filter((v) => v.jarvis);
  const rest = catalogue.filter((v) => !v.jarvis);

  console.log("  \x1b[1mWorth trying for JARVIS\x1b[0m");
  for (const v of shortlist) {
    const here = v.name === state.voice ? "  \x1b[36m← current\x1b[0m" : "";
    console.log(`    ${v.name.padEnd(16)} \x1b[90m${v.note}\x1b[0m${here}`);
  }
  if (rest.length) {
    console.log("");
    console.log("  \x1b[90mThe rest (too bright or too casual for this)\x1b[0m");
    console.log("    \x1b[90m" + rest.map((v) => v.name).join(", ") + "\x1b[0m");
  }
  console.log("");
  console.log("  Hear them:   scripts/voices.sh --audition");
  console.log("  Hear one:    scripts/voices.sh --try " + (shortlist[1] || shortlist[0] || { name: "Kore" }).name);
  console.log("  Then set it in .env:   JARVIS_VOICE=<name>");
  process.exit(0);
}

const queue =
  mode === "try"
    ? catalogue.filter((v) => v.name.toLowerCase() === String(wanted).toLowerCase())
    : mode === "all"
      ? catalogue
      : catalogue.filter((v) => v.jarvis);

if (!queue.length) {
  console.log(`  \x1b[31m✗\x1b[0m no voice called "${wanted}"`);
  console.log("     scripts/voices.sh   to see the list");
  process.exit(1);
}

(async () => {
  console.log(`  "${line}"`);
  console.log("");

  for (const v of queue) {
    process.stdout.write(`    ${v.name.padEnd(16)} \x1b[90m${v.note.padEnd(14)}\x1b[0m `);

    // Re-init per voice so the cache key changes with it — otherwise every voice would
    // replay whichever one was synthesised first.
    voice.init({ ...settings.load().voice, gemini: { ...(settings.load().voice.gemini || {}), voice: v.name },
                 say: { voice: v.name }, espeak: { voice: v.name } });

    const at = Date.now();
    const result = await voice.speak(line);
    if (result.ok) {
      console.log(`\x1b[32m✓\x1b[0m ${Date.now() - at}ms`);
    } else {
      console.log(`\x1b[31m✗\x1b[0m ${result.error}${result.detail ? " — " + result.detail : ""}`);
    }
  }

  console.log("");
  console.log("  Put the one you liked in .env:   JARVIS_VOICE=<name>");
  console.log("  Then restart Core.");
})();
' 2>&1 | grep -v "^[0-9][0-9]:[0-9][0-9]:[0-9][0-9] "

printf '\n'
