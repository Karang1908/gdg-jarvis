#!/usr/bin/env bash
#
# Run the whole system on one Mac.
#
#   scripts/start-mac.sh              # Core + this Mac enrolled as device 1
#   scripts/start-mac.sh --core-only  # Core only; enrol agents by hand
#   scripts/start-mac.sh --local      # bind to 127.0.0.1, nothing else can reach it
#   scripts/start-mac.sh --port 4000
#
# This is the way it runs. Core, the microphone, the voice, the model and the MCP server all
# live on this Mac, and teammates join over whatever Wi-Fi the room is already on.
#
# SPEC.md §4 has a Kali laptop being both the access point and Core, and that still works —
# scripts/setup-kali.sh is for it. But a machine that is also an access point is a machine
# with a second job it can fail at, and it did: the hotspot dropped mid-demo and had to be
# restarted by hand, and being on an island of its own meant no internet for the voice or
# the model. Joining the room's own network removes both problems and a category of
# debugging with them.
#
# What it costs is the one guarantee an access point gave for free: that devices can reach
# each other. Plenty of venue and campus networks isolate clients, and on such a network the
# join line will simply time out. Test it from a phone before the day — see below.
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

# ---------------------------------------------------------------------------------------
# Can the room reach this Mac?
#
# The access point used to guarantee it. Ordinary Wi-Fi does not, and the two ways it fails
# are silent: a firewall that drops incoming connections, and a network that forbids devices
# from talking to each other at all. Neither announces itself — the join line simply hangs,
# which reads as the system being broken.
#
# The firewall can be checked from here. Client isolation cannot: proving it needs a second
# device, so this says so rather than pretending otherwise.
# ---------------------------------------------------------------------------------------

if [ "$BIND" != "127.0.0.1" ]; then
  FW=/usr/libexec/ApplicationFirewall/socketfilterfw
  if [ -x "$FW" ]; then
    if "$FW" --getblockall 2>/dev/null | grep -q "block all state set to enabled"; then
      bad "the firewall is set to block all incoming connections"
      warn "nobody will be able to join. System Settings > Network > Firewall"
      exit 1
    fi
    if "$FW" --getglobalstate 2>/dev/null | grep -q "enabled"; then
      # Fine in itself — node is usually allowed — but worth naming, because if joining
      # fails this is the first thing to rule out.
      ok "firewall on, not blocking everything"
    else
      ok "firewall off"
    fi
  fi

  LAN=$(ipconfig getifaddr "$(route -n get default 2>/dev/null | awk '/interface/{print $2}')" 2>/dev/null)
  [ -n "$LAN" ] && ok "this Mac is $LAN on the room's network" \
                || warn "could not work out this Mac's address — is Wi-Fi connected?"
fi

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
printf '  phone     %s/control/     ← same address; it is a remote, not a mic\n' "$CORE_URL"
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
  printf '  \033[1mTest this from a phone before the day.\033[0m Open the control page on one:\n'
  printf '\n'
  printf '    %s/control/\n' "$CORE_URL"
  printf '\n'
  printf '  If it loads, the room can reach this Mac and joining will work. If it hangs,\n'
  printf '  the network is keeping its clients apart — common on campus and venue Wi-Fi —\n'
  printf '  and no amount of fixing here will help. A phone hotspot that everyone joins,\n'
  printf '  this Mac included, is the way round it.\n'
  printf '\n'
  warn "use --local when you are working alone; nothing else can reach it then"
fi

bold ""
printf '  \033[2mCtrl+C releases every screen and stops everything.\033[0m\n\n'

# Hold the terminal. `wait` on Core specifically, so if Core dies the script notices
# instead of sitting on a dead system.
wait "$CORE_PID"
cleanup
