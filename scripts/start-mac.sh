#!/usr/bin/env bash
#
# Run the whole system on one Mac.
#
#   scripts/start-mac.sh              # Core + this Mac enrolled as device 1
#   scripts/start-mac.sh --core-only  # Core only; enrol agents by hand
#   scripts/start-mac.sh --local      # bind to 127.0.0.1, nothing else can reach it
#   scripts/start-mac.sh --port 4000
#
# The Kali laptop in SPEC.md §4 is the access point *and* Core. Before that machine
# exists — or when rehearsing alone — the Mac can be both Core and a node, and everything
# except the private Wi-Fi works exactly as it will on the day.
#
# Teammates join the same network this Mac is on and enrol normally. The only thing
# missing is JARVIS-NET itself.
#
# Ctrl+C releases every screen and stops everything.

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT" || exit 1

CONFIG=".env"
PORT=3000
BIND=""
START_AGENT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --core-only) START_AGENT=0; shift ;;
    --local) BIND="127.0.0.1"; shift ;;
    --port) PORT="${2:-3000}"; shift 2 ;;
    --help|-h) sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------------------
# Where to listen
# ---------------------------------------------------------------------------------------

if [ -z "$BIND" ]; then
  # The address a phone or a teammate's laptop can actually reach. Binding to 127.0.0.1
  # would work perfectly on this machine and be invisible to every other one, which is a
  # confusing way to discover the controller does not load on your phone.
  BIND=$(ipconfig getifaddr en0 2>/dev/null)
  [ -n "$BIND" ] || BIND=$(ipconfig getifaddr en1 2>/dev/null)
  if [ -z "$BIND" ]; then
    warn "no LAN address found; falling back to 127.0.0.1 (this Mac only)"
    BIND="127.0.0.1"
  fi
fi

CORE_URL="http://$BIND:$PORT"

# ---------------------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------------------

bold ""
bold "J.A.R.V.I.S. — single-Mac mode"
bold ""

command -v node >/dev/null 2>&1 || { bad "node is not installed"; exit 1; }
ok "node $(node -v)"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  bad "port $PORT is already in use"
  warn "another Core is probably running:  pkill -f 'core/server.js'"
  exit 1
fi

if [ ! -f "$CONFIG" ] && [ -f .env.example ]; then
  cp .env.example "$CONFIG"
  warn "created .env from the example — edit it to set your own passwords"
fi

if ! node core/lib/settings.js --check 2>/dev/null; then
  bad "fix .env before starting:"
  node core/lib/settings.js --check 2>&1 | sed 's/^/    /'
  exit 1
fi
ok "settings loaded from .env"

ADMIN=$(node core/lib/settings.js admin)
JOIN_SECRET=$(node core/lib/settings.js join)

# ---------------------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------------------

CORE_PID=""
AGENT_PID=""

# Wait for a pid to actually go away, then insist. Returns 0 once it is gone.
stop_pid() {
  local pid="$1" waited=0
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  kill -TERM "$pid" 2>/dev/null
  while [ $waited -lt 40 ] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.1
    waited=$((waited + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
    return 1
  fi
  return 0
}

cleanup() {
  trap '' INT TERM   # a second Ctrl+C must not interrupt the teardown
  printf '\n'
  bold "stopping"

  # Order matters. The agent goes first, while Core is still up, so the release is
  # recorded and the wall reflects it. The agent's own trap closes the overlay; this only
  # has to make sure the agent itself actually dies.
  if [ -n "$AGENT_PID" ]; then
    stop_pid "$AGENT_PID" && ok "agent stopped, overlay closed" \
      || warn "agent needed SIGKILL; check for a stray overlay window"
  fi

  if [ -n "$CORE_PID" ]; then
    stop_pid "$CORE_PID" && ok "core stopped, room released" \
      || warn "core needed SIGKILL"
  fi

  # Belt and braces. If anything above did not do its job, a teammate is looking at a
  # fullscreen window right now, and a stray process is worth more than tidiness.
  local strays
  strays=$(pgrep -f 'jarvis-agent.sh --server' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$strays" != "0" ]; then
    pkill -f 'jarvis-agent.sh --server' 2>/dev/null
    warn "cleaned up $strays stray agent process(es)"
  fi

  printf '\n'
  exit 0
}
trap cleanup INT TERM

# ---------------------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------------------

node core/server.js --host "$BIND" --port "$PORT" &
CORE_PID=$!

# Poll rather than sleep: on a cold start Node takes a moment, and a fixed sleep is either
# too short on a busy machine or wasted time on an idle one.
for _ in $(seq 1 40); do
  curl -s --max-time 1 "$CORE_URL/healthz" >/dev/null 2>&1 && break
  kill -0 "$CORE_PID" 2>/dev/null || { bad "core exited during startup"; exit 1; }
  sleep 0.25
done

if ! curl -s --max-time 2 "$CORE_URL/healthz" >/dev/null 2>&1; then
  bad "core did not come up on $CORE_URL"
  cleanup
fi

# ---------------------------------------------------------------------------------------
# This Mac joins as a device
# ---------------------------------------------------------------------------------------

if [ "$START_AGENT" -eq 1 ]; then
  # Deliberately not piped through sed for a nicer prefix. For a backgrounded pipeline
  # bash sets $! to the *last* command in it, so AGENT_PID would be sed's — and Ctrl+C
  # would kill the prefixer while leaving the agent, and its fullscreen overlay, running.
  # That is the exact failure DEVIATIONS.md D4 exists to prevent.
  # --wall so this Mac shows the Command Wall. It joins first, so it becomes device 1.
  bash agent/jarvis-agent.sh --server "$CORE_URL" --secret "$JOIN_SECRET" --wall &
  AGENT_PID=$!
  sleep 2
fi

# ---------------------------------------------------------------------------------------
# What to do next
# ---------------------------------------------------------------------------------------

bold ""
bold "Open these"
printf '\n'
printf '  control   %s/control/     ← second window on this Mac\n' "$CORE_URL"
printf '  mic       %s/control/     ← use THIS one on a phone\n' "$(printf '%s' "$CORE_URL" | sed 's|^http://|https://|; s|:[0-9]*$|:3443|')"
printf '  wall      %s/wall/        ← optional; MAIN already becomes the wall\n' "$CORE_URL"
printf '\n'
printf '  admin token (paste into either page):\n'
printf '  \033[1m%s\033[0m\n' "$ADMIN"

bold ""
bold "Then"
printf '\n'
printf '  1. Open the controller, paste the token.\n'
printf '  2. Tap TAKE THE ROOM — this Mac goes fullscreen and becomes the Command Wall.\n'
printf '  3. Tap RELEASE ALL — your desktop comes back exactly as it was.\n'
printf '\n'
printf '  On the overlay itself: hold Escape for a second to release just that screen.\n'

if [ "$BIND" != "127.0.0.1" ]; then
  bold ""
  bold "Adding anyone else"
  printf '\n'
  printf '  They join the same Wi-Fi this Mac is on, then run one line.\n'
  printf '  The same line for everybody — no name, no token:\n'
  printf '\n'
  printf '    macOS     curl -s %s/join | bash\n' "$CORE_URL"
  printf '    Windows   iwr %s/join.ps1 -UseBasicParsing | iex\n' "$CORE_URL"
  printf '\n'
  printf '  They become device 2, 3, 4 ... in the order they join.\n'
  printf '\n'
  warn "this Mac is reachable at $BIND on your current network"
  warn "use --local when you are not rehearsing with other people"
fi

bold ""
printf '  \033[2mCtrl+C releases every screen and stops everything.\033[0m\n\n'

# Hold the terminal. `wait` on Core specifically, so if Core dies the script notices
# instead of sitting on a dead system.
wait "$CORE_PID"
cleanup
