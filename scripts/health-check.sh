#!/usr/bin/env bash
#
# Is the room ready?
#
#   scripts/health-check.sh                          # against localhost:3000
#   scripts/health-check.sh http://10.42.0.1:3000    # against Core over JARVIS-NET
#
# Run this from the Presenter Mac twenty minutes before the talk, not from the Kali box.
# Checking Core from the machine Core runs on proves nothing about the Wi-Fi, and the
# Wi-Fi is what actually fails.
#
# Exit status is the number of problems, so it can gate a rehearsal script.

set -uo pipefail

CORE="${1:-http://127.0.0.1:3000}"
CORE="${CORE%/}"
ADMIN="${JARVIS_ADMIN_TOKEN:-}"

problems=0

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; problems=$((problems + 1)); }

printf '\n'
bold "JARVIS health check — $CORE"
printf '\n'

# --- Reachability ----------------------------------------------------------------------

bold "Core"

health=$(curl -s --max-time 4 "$CORE/healthz" 2>/dev/null)
if [ -n "$health" ]; then
  ok "reachable — $health"
else
  bad "unreachable at $CORE"
  printf '\n    Core is not answering. Check, in this order:\n'
  printf '      1. is Core running?            node core/server.js --host <ap-ip>\n'
  printf '      2. is this Mac on JARVIS-NET?  networksetup -getairportnetwork en0\n'
  printf '      3. is the address right?       ip -4 addr show wlan0   (on Kali)\n\n'
  exit $problems
fi

# --- Route separation — SPEC.md §29 ----------------------------------------------------
#
# The Presenter Mac is dual-homed: JARVIS-NET over Wi-Fi with no internet, and the internet
# over an iPhone on USB. If the default route ever goes out over Wi-Fi, Antigravity loses
# the internet; if the route to Core goes out over the phone, the whole demo stops. This is
# the single most confusing failure in the setup, so it is checked explicitly.

if command -v route >/dev/null 2>&1 && [ "$(uname)" = "Darwin" ]; then
  bold ""
  bold "Route separation"

  core_host=$(printf '%s' "$CORE" | sed -E 's#^https?://##; s#[:/].*$##')
  core_if=$(route -n get "$core_host" 2>/dev/null | awk '/interface:/{print $2}')
  default_if=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')

  if [ -n "$core_if" ]; then
    ok "route to Core uses $core_if"
  else
    bad "no route to $core_host"
  fi

  if [ -n "$default_if" ]; then
    if [ "$default_if" = "$core_if" ]; then
      warn "default route also uses $core_if — internet and Core share one interface"
      warn "fine for a local rehearsal; connect the iPhone before the live demo"
    else
      ok "default route uses $default_if — separate from Core"
    fi
  fi
fi

# --- The room ---------------------------------------------------------------------------

if [ -z "$ADMIN" ]; then
  # Read it from the registry when running out of a checkout, so the common case needs no
  # environment variable.
  if [ -f "$(dirname "${BASH_SOURCE[0]}")/../core/config/core.json" ] && command -v node >/dev/null 2>&1; then
    ADMIN=$(node -e "
      process.stdout.write(require('$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/core/config/core.json').admin.token)
    " 2>/dev/null)
  fi
fi

if [ -z "$ADMIN" ]; then
  bold ""
  warn "no admin token; skipping the node checks"
  warn "set JARVIS_ADMIN_TOKEN or run this from the repository"
  printf '\n'
  exit $problems
fi

bold ""
bold "Devices"

nodes=$(curl -s --max-time 4 -H "Authorization: Bearer $ADMIN" "$CORE/api/devices" 2>/dev/null)

if [ -z "$nodes" ]; then
  bad "could not read the device list"
elif printf '%s' "$nodes" | grep -q '"error":"unauthorized"'; then
  bad "admin token rejected"
else
  printf '%s' "$nodes" | node -e "
    let raw = '';
    process.stdin.on('data', (c) => (raw += c)).on('end', () => {
      const room = JSON.parse(raw);
      let issues = 0;

      if (!room.devices || room.devices.length === 0) {
        console.log('  \x1b[33m!\x1b[0m nobody has joined yet');
        console.log('');
        console.log('  Each person runs:  curl -s ' + process.argv[1] + '/join | bash');
        process.exit(1);
      }

      for (const device of room.devices) {
        const label = (String(device.number) + '  ' + (device.hostname || '')).padEnd(24);

        if (!device.online) {
          console.log('  \x1b[31m✗\x1b[0m ' + label + 'offline');
          issues++;
        } else if (!device.displayAwake) {
          // The failure no command can fix, so it is called out separately from a healthy
          // device rather than folded into 'online'.
          console.log('  \x1b[33m!\x1b[0m ' + label + 'online but the screen is LOCKED — unlock it now');
          issues++;
        } else if (device.stale) {
          console.log('  \x1b[33m!\x1b[0m ' + label + 'connected but not heartbeating');
          issues++;
        } else {
          const takeover = device.capabilities.includes('takeover');
          console.log(
            '  \x1b[32m✓\x1b[0m ' + label + (device.os || '?').padEnd(8) +
            String(device.rttMs ?? '?').padStart(4) + ' ms   ' + device.capabilities.length + ' caps' +
            (device.isWall ? '   [wall]' : '') +
            (device.muted ? '   [muted]' : '') +
            (takeover ? '' : '   \x1b[33m(no browser: cannot be taken over)\x1b[0m')
          );
          if (!takeover) issues++;
        }
      }

      console.log('');
      console.log('  ' + room.summary.online + ' of ' + room.summary.known + ' online' +
                  (room.wall ? ', wall is device ' + room.wall : ', no wall assigned'));
      process.exit(issues);
    });
  " "$CORE"
  node_issues=$?
  [ "$node_issues" -gt 0 ] && problems=$((problems + node_issues))
fi

# --- Failure-safe path -------------------------------------------------------------------
#
# The one control that must work. Checked last and checked for real, because a release that
# only works in theory is the difference between a recoverable demo and an unrecoverable one.

# --- Voice and personality --------------------------------------------------------------

bold ""
bold "JARVIS"

voice=$(curl -s --max-time 4 -H "Authorization: Bearer $ADMIN" "$CORE/api/voice" 2>/dev/null)
if [ -n "$voice" ]; then
  printf '%s' "$voice" | node -e "
    let raw = '';
    process.stdin.on('data', (c) => (raw += c)).on('end', () => {
      const v = JSON.parse(raw);

      if (v.available) {
        const how = v.provider + (v.voice ? ' / ' + v.voice : '');
        console.log('  \x1b[32m✓\x1b[0m voice: ' + how + (v.enabled ? '' : '  \x1b[33m(muted)\x1b[0m'));

        // The distinction that decides how the demo sounds. A robotic fallback still
        // counts as 'available', so saying only that would hide the thing worth knowing.
        if (!v.natural) {
          console.log('  \x1b[33m!\x1b[0m that is the fallback voice — set GEMINI_API_KEY or install piper');
        }
        if (v.cacheable) {
          console.log('  \x1b[32m✓\x1b[0m ' + v.cached + ' line(s) cached via ' + (v.player || 'no player'));
          if (!v.cached) console.log('       run scripts/warm-voice.sh so the scripted lines need no network');
        }
      } else {
        // Not fatal, but the demo is much flatter without it and the fix is one apt line.
        console.log('  \x1b[33m!\x1b[0m no voice here — JARVIS will be silent');
        console.log('       sudo apt install speech-dispatcher espeak-ng   # or set GEMINI_API_KEY');
      }

      const p = v.personality || {};
      if (p.loaded) {
        console.log('  \x1b[32m✓\x1b[0m personality: ' + p.name + ', ' + p.words + ' words');
      } else {
        console.log('  \x1b[33m!\x1b[0m no personality file — the model will use its client default');
      }
    });
  "
else
  warn "could not read /api/voice"
fi

bold ""
bold "Emergency release"

release=$(curl -s --max-time 4 -X POST -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"target":"ALL"}' "$CORE/api/release" 2>/dev/null)

if printf '%s' "$release" | grep -q '"dispatched"'; then
  ok "release(ALL) accepted"
else
  bad "release(ALL) did not respond correctly: ${release:-no response}"
fi

printf '\n'
if [ "$problems" -eq 0 ]; then
  printf '  \033[32m\033[1mroom ready\033[0m\n\n'
else
  printf '  \033[33m\033[1m%s issue(s) — see above\033[0m\n\n' "$problems"
fi

exit $problems
