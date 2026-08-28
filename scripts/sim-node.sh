#!/usr/bin/env bash
#
# Synthetic JARVIS node.
#
# Registers, holds the command channel, heartbeats, and acknowledges everything — but
# never launches a browser or touches the operating system. It exists so the whole room
# can be exercised on one machine.
#
#   scripts/sim-node.sh BETA <token> [server]
#   scripts/sim-node.sh BETA <token> --os windows
#
# Two things this is genuinely for:
#
#   Rehearsing Core, the Command Wall, and the controller without borrowing four laptops.
#   A simulated GAMMA proves the wall renders four nodes and that a broadcast reaches all
#   of them long before anyone carries hardware to a venue.
#
#   Testing the Windows path from a Mac. Pass --os windows and Core resolves app names
#   against the Windows column of the allowlist, so a mistake in apps.json surfaces here
#   rather than on stage.
#
# It is deliberately not the real agent. It cannot prove that a takeover renders, that
# release restores a desktop, or that Chrome behaves — only real hardware does that, and
# docs/REHEARSAL.md says which tests require it.

set -uo pipefail

NODE_ID="${1:-}"
NODE_TOKEN="${2:-}"
CORE_URL="http://127.0.0.1:3000"
NODE_OS="macos"

shift 2 2>/dev/null || true
while [ $# -gt 0 ]; do
  case "$1" in
    --os) NODE_OS="${2:-macos}"; shift 2 ;;
    http://*|https://*) CORE_URL="$1"; shift ;;
    *) shift ;;
  esac
done

if [ -z "$NODE_ID" ] || [ -z "$NODE_TOKEN" ]; then
  echo "usage: scripts/sim-node.sh <NODE> <TOKEN> [server] [--os macos|windows]" >&2
  exit 2
fi

NODE_ID=$(printf '%s' "$NODE_ID" | tr '[:lower:]' '[:upper:]')
CORE_URL="${CORE_URL%/}"

# The full set, so Core never skips a command for a missing capability while rehearsing.
CAPS="takeover,release,identify,open_url,open_app,speak,set_volume"

STATE=$(mktemp -d "${TMPDIR:-/tmp}/jarvis-sim.XXXXXX") || exit 1

# Read through a FIFO for the same reason the real agent does: bash defers a trap until
# the foreground command finishes, and an SSE stream never finishes, so a piped read would
# leave this hanging on SIGTERM.
STREAM_FIFO="$STATE/stream"
STREAM_PID=""

decode() { printf '%b' "${1//%/\\x}"; }

post() {
  local endpoint="$1"; shift
  local args=()
  for pair in "$@"; do args+=(--data-urlencode "$pair"); done
  curl -s --max-time 10 -X POST "${args[@]}" "$CORE_URL$endpoint" 2>/dev/null
}

cleanup() {
  rm -f "$STATE/session"
  [ -n "$STREAM_PID" ] && kill "$STREAM_PID" 2>/dev/null
  [ -n "${HEARTBEAT_PID:-}" ] && kill "$HEARTBEAT_PID" 2>/dev/null
  rm -rf "$STATE" 2>/dev/null
  echo "sim $NODE_ID stopped" >&2
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

REG=$(post /api/agent/register \
  "node=$NODE_ID" "token=$NODE_TOKEN" "os=$NODE_OS" \
  "host=sim-$(printf '%s' "$NODE_ID" | tr '[:upper:]' '[:lower:]')" \
  "caps=$CAPS" "agent=sim-1.0.0")

case "$REG" in
  OK*) SESSION=$(printf '%s' "$REG" | awk '{print $2}') ;;
  *) echo "sim $NODE_ID: $REG" >&2; exit 1 ;;
esac

printf '%s' "$SESSION" > "$STATE/session"
echo "sim $NODE_ID registered as $NODE_OS ($CORE_URL)" >&2

# Heartbeat. Always reports the display as awake — a simulated node has no screen to lock,
# and claiming otherwise would put a false warning on the wall.
(
  seq=0
  while [ -f "$STATE/session" ]; do
    overlay=0
    [ -f "$STATE/overlay" ] && overlay=1
    post /api/agent/heartbeat \
      "node=$NODE_ID" "session=$SESSION" \
      "state=$([ "$overlay" = 1 ] && printf 'overlay' || printf 'ready')" \
      "overlay=$overlay" "awake=1" "seq=$seq" "rtt=4" >/dev/null
    seq=$((seq + 1))
    sleep 5
  done
) &
HEARTBEAT_PID=$!

mkfifo "$STREAM_FIFO" 2>/dev/null
curl -sN --no-buffer "$CORE_URL/api/agent/stream?node=$NODE_ID&session=$SESSION" \
  > "$STREAM_FIFO" 2>/dev/null &
STREAM_PID=$!

while IFS= read -r line; do
    case "$line" in
      'data: '*) ;;
      *) continue ;;
    esac

    payload="${line#data: }"
    cid=$(printf '%s' "$payload" | cut -f1)
    action=$(printf '%s' "$payload" | cut -f2)
    [ -n "$action" ] || continue

    # Track overlay state so the wall shows this node the way a real one would.
    case "$action" in
      takeover) : > "$STATE/overlay" ;;
      release) rm -f "$STATE/overlay" ;;
    esac

    echo "  $NODE_ID <- $action" >&2
    post /api/agent/ack \
      "node=$NODE_ID" "session=$SESSION" "cid=$cid" "status=success" "msg=simulated" >/dev/null
done < "$STREAM_FIFO"

kill "$STREAM_PID" 2>/dev/null
rm -f "$STATE/session"
kill "$HEARTBEAT_PID" 2>/dev/null
