#!/usr/bin/env bash
#
# Synthetic JARVIS device.
#
# Enrolls, holds the command channel, heartbeats, and acknowledges everything — but never
# launches a browser or touches the operating system. It exists so the whole room can be
# exercised on one machine.
#
#   scripts/sim-node.sh "Ravi-PC" --os windows
#   scripts/sim-node.sh "anita-mbp"
#   scripts/sim-node.sh "lab-3" --server http://10.42.0.1:3000 --secret <secret>
#
# The name is what appears on the wall; Core assigns the number. With no --secret it reads
# one from core/config/core.json, so on the Core machine it needs no arguments beyond a
# name.
#
# Two things this is genuinely for:
#
#   Rehearsing Core, the Command Wall, and the controller without borrowing four laptops.
#   Six simulated devices prove the wall still composes at six, which is the sort of thing
#   nobody discovers until the sixth person joins.
#
#   Testing the Windows path from a Mac. Pass --os windows and Core resolves app names
#   against the Windows column of the allowlist, so a mistake in apps.json surfaces here
#   rather than on stage.
#
# It is deliberately not the real agent. It cannot prove that a takeover renders, that
# release restores a desktop, or that Chrome behaves — only real hardware does that, and
# docs/REHEARSAL.md says which tests require it.

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

DEVICE_NAME="${1:-}"
CORE_URL="http://127.0.0.1:3000"
NODE_OS="macos"
JOIN_SECRET="${JARVIS_JOIN_SECRET:-}"
WANTS_WALL=0

shift 2>/dev/null || true
while [ $# -gt 0 ]; do
  case "$1" in
    --os) NODE_OS="${2:-macos}"; shift 2 ;;
    --secret) JOIN_SECRET="${2:-}"; shift 2 ;;
    --server) CORE_URL="${2:-}"; shift 2 ;;
    --wall) WANTS_WALL=1; shift ;;
    http://*|https://*) CORE_URL="$1"; shift ;;
    *) shift ;;
  esac
done

if [ -z "$DEVICE_NAME" ]; then
  echo "usage: scripts/sim-node.sh <name> [--os macos|windows|linux] [--server URL] [--secret S] [--wall]" >&2
  exit 2
fi

# Running on the Core machine is the common case, so read the secret rather than making
# the operator paste it into every simulated device.
if [ -z "$JOIN_SECRET" ] && [ -f "$REPO_ROOT/core/config/core.json" ]; then
  JOIN_SECRET=$(node -e "process.stdout.write(require('$REPO_ROOT/core/config/core.json').join.secret)" 2>/dev/null)
fi

if [ -z "$JOIN_SECRET" ]; then
  echo "no join secret; pass --secret or run from the machine holding core/config/core.json" >&2
  exit 2
fi

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
  echo "sim \"$DEVICE_NAME\" stopped" >&2
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

REG=$(post /api/agent/register \
  "secret=$JOIN_SECRET" "os=$NODE_OS" "host=$DEVICE_NAME" \
  "wall=$WANTS_WALL" "caps=$CAPS" "agent=sim-1.0.0")

case "$REG" in
  OK*)
    DEVICE_NUMBER=$(printf '%s' "$REG" | awk '{print $2}')
    SESSION=$(printf '%s' "$REG" | awk '{print $3}')
    ;;
  *) echo "sim \"$DEVICE_NAME\": $REG" >&2; exit 1 ;;
esac

printf '%s' "$SESSION" > "$STATE/session"
echo "sim \"$DEVICE_NAME\" is device $DEVICE_NUMBER ($NODE_OS)" >&2

# Heartbeat. Always reports the display as awake — a simulated node has no screen to lock,
# and claiming otherwise would put a false warning on the wall.
(
  seq=0
  while [ -f "$STATE/session" ]; do
    overlay=0
    [ -f "$STATE/overlay" ] && overlay=1
    post /api/agent/heartbeat \
      "device=$DEVICE_NUMBER" "session=$SESSION" \
      "state=$([ "$overlay" = 1 ] && printf 'overlay' || printf 'ready')" \
      "overlay=$overlay" "awake=1" "seq=$seq" "rtt=4" >/dev/null
    seq=$((seq + 1))
    sleep 5
  done
) &
HEARTBEAT_PID=$!

mkfifo "$STREAM_FIFO" 2>/dev/null
curl -sN --no-buffer "$CORE_URL/api/agent/stream?device=$DEVICE_NUMBER&session=$SESSION" \
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

    echo "  device $DEVICE_NUMBER <- $action" >&2
    post /api/agent/ack \
      "device=$DEVICE_NUMBER" "session=$SESSION" "cid=$cid" "status=success" "msg=simulated" >/dev/null
done < "$STREAM_FIFO"

kill "$STREAM_PID" 2>/dev/null
rm -f "$STATE/session"
kill "$HEARTBEAT_PID" 2>/dev/null
