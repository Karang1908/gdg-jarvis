#!/usr/bin/env bash
#
# JARVIS Node Agent — macOS
#
# Runs on a teammate's Mac and does exactly three things: enroll with Core, hold a command
# channel open, and execute the small set of actions it advertises. Nothing appears over
# the user's desktop until Core says so, and Ctrl+C takes it all away.
#
#   curl -s http://10.42.0.1:3000/join | bash
#
# That is the whole thing. No device name to remember and no token to type — Core bakes
# its own address and the join secret into the script when it serves it, and assigns this
# machine a number on arrival. The number is printed on enrollment.
#
# Written in bash rather than Python because /bin/bash is on every Mac and Python is not,
# and because a script piped from curl is never quarantined — no Gatekeeper prompt on
# someone else's laptop ten minutes before the talk. See DEVIATIONS.md D1.
#
# bash 3.2 compatible on purpose: that is what ships with macOS. No associative arrays,
# no mapfile, no ${var,,}.

set -uo pipefail

AGENT_VERSION="1.0.0"

# Replaced by Core when this script is served from /join. The literal below is the
# fallback for running the file directly out of a checkout.
CORE_DEFAULT="@@CORE_URL@@"
case "$CORE_DEFAULT" in
  @@*) CORE_DEFAULT="http://10.42.0.1:3000" ;;
esac

# Substituted by Core when this script is served from /join.
JOIN_SECRET_DEFAULT="@@JOIN_SECRET@@"
case "$JOIN_SECRET_DEFAULT" in
  @@*) JOIN_SECRET_DEFAULT="" ;;
esac

# ---------------------------------------------------------------------------------------
# Arguments
#
# There are none in the normal case. The flags exist for running out of a checkout, and
# for the presenter's machine, which passes --wall to claim the Command Wall.
# ---------------------------------------------------------------------------------------

CORE_URL="$CORE_DEFAULT"
JOIN_SECRET="${JARVIS_JOIN_SECRET:-$JOIN_SECRET_DEFAULT}"
WANTS_WALL=0
DEVICE_NAME=""

usage() {
  cat >&2 <<USAGE
JARVIS Node Agent ${AGENT_VERSION}

  curl -s http://10.42.0.1:3000/join | bash

  --server URL    Core address, when running from a checkout
  --secret S      join secret, when running from a checkout
  --name NAME     override the name shown on the wall (defaults to this Mac's name)
  --wall          this machine shows the Command Wall

Leave it running. Ctrl+C ends remote control immediately.
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server) CORE_URL="${2:-}"; shift 2 ;;
    --secret) JOIN_SECRET="${2:-}"; shift 2 ;;
    --name)   DEVICE_NAME="${2:-}"; shift 2 ;;
    --wall)   WANTS_WALL=1; shift ;;
    --help|-h) usage ;;
    *) shift ;;
  esac
done

if [ -z "$JOIN_SECRET" ] && [ -t 0 ]; then
  printf 'Join secret: ' >&2
  read -r JOIN_SECRET
fi

if [ -z "$JOIN_SECRET" ]; then
  echo "No join secret. Use the line Core printed, or pass --secret." >&2
  exit 2
fi

CORE_URL="${CORE_URL%/}"

# The name a human will read off the wall. ComputerName is the friendly one a Mac owner
# actually set ("Karan's Laptop"); hostname is the network name and is often uglier.
[ -n "$DEVICE_NAME" ] || DEVICE_NAME=$(scutil --get ComputerName 2>/dev/null || hostname)

# ---------------------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------------------

STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/jarvis-agent.XXXXXX") || exit 1
OVERLAY_PID_FILE="$STATE_DIR/overlay.pid"

# A profile directory unique to this run. This is what keeps release safe: a dedicated
# --user-data-dir forces a separate browser process tree, so terminating the overlay
# cannot touch the tabs the user had open. SPEC.md §16 calls this critical, and it is.
OVERLAY_PROFILE="$STATE_DIR/overlay-profile"

DEVICE_NUMBER=""
SESSION_ID=""
HEARTBEAT_MS=5000
CAFFEINATE_PID=""
HEARTBEAT_PID=""
STREAM_PID=""
RUNNING=1

# The command stream is read through a FIFO rather than a `curl | while read` pipeline.
#
# That is not a style choice. bash defers a trap until the current foreground command
# finishes, and an SSE stream never finishes — so with a pipeline, SIGTERM would sit
# unhandled and the overlay would outlive the agent. Reading from a FIFO makes the
# foreground command the `read` builtin, which a trapped signal *does* interrupt, so
# cleanup runs immediately.
#
# Interactive Ctrl+C happens to work either way, because the terminal signals the whole
# process group and curl dies with it. Anything else — a service manager, a wrapper
# script, scripts/start-mac.sh — signals only the agent, and would hang.
STREAM_FIFO="$STATE_DIR/stream" 

timestamp() { date '+%H:%M:%S'; }
say_log()   { printf '%s  %s\n' "$(timestamp)" "$*" >&2; }

# ---------------------------------------------------------------------------------------
# Wire decoding
# ---------------------------------------------------------------------------------------

# The whole agent-side protocol, in one line. Core percent-encodes every byte outside the
# unreserved set, so this cannot be tricked into producing an escape, a field separator,
# or a newline. See core/lib/wire.js for the encoder and the reasoning.
decode() { printf '%b' "${1//%/\\x}"; }

# ---------------------------------------------------------------------------------------
# Capability detection
# ---------------------------------------------------------------------------------------

# Chromium-family browsers, in preference order. A Mac with none of them simply does not
# advertise `takeover`, and Core refuses the action cleanly instead of the node silently
# doing nothing (SPEC.md §9, §15).
find_browser() {
  local candidate
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

BROWSER=$(find_browser) || BROWSER=""

build_capabilities() {
  local caps=""
  [ -n "$BROWSER" ] && caps="takeover,release,identify"
  command -v open     >/dev/null 2>&1 && caps="${caps:+$caps,}open_url,open_app"
  command -v say      >/dev/null 2>&1 && caps="${caps:+$caps,}speak"
  command -v osascript >/dev/null 2>&1 && caps="${caps:+$caps,}set_volume"
  printf '%s' "$caps"
}

CAPABILITIES=$(build_capabilities)

# ---------------------------------------------------------------------------------------
# Display state
# ---------------------------------------------------------------------------------------

# A locked screen renders nothing, no matter how correct the command dispatch was. The
# wake lock below prevents sleeping, but it cannot unlock a screen that was already
# locked when the agent started — so Core is told, and the wall shows it before the
# operator triggers a takeover rather than after. See DEVIATIONS.md D3.
display_awake() {
  if ioreg -n Root -d1 -a 2>/dev/null | grep -q 'CGSSessionScreenIsLocked'; then
    printf '0'
  else
    printf '1'
  fi
}

# -d display, -i idle, -m disk, -s system, -u assert user activity.
# -w ties its lifetime to ours, so the wake lock is released even on SIGKILL.
start_wake_lock() {
  if command -v caffeinate >/dev/null 2>&1; then
    caffeinate -dimsu -w $$ >/dev/null 2>&1 &
    CAFFEINATE_PID=$!
  fi
}

# ---------------------------------------------------------------------------------------
# Core calls
# ---------------------------------------------------------------------------------------

# --data-urlencode does the escaping, so no value assembled here can break out of its
# field regardless of what Core or the user put in it.
post() {
  local endpoint="$1"; shift
  local args=()
  local pair
  for pair in "$@"; do args+=(--data-urlencode "$pair"); done
  curl -s --max-time 10 -X POST "${args[@]}" "$CORE_URL$endpoint" 2>/dev/null
}

# As post(), but writes the round trip in milliseconds to stdout instead of the response.
#
# curl measures this itself. The obvious alternative, bracketing the call with `date`,
# does not work here: macOS date has no %N, so `date +%s%3N` yields a literal "%3N" and
# every reported latency would be nonsense.
post_timed() {
  local endpoint="$1"; shift
  local args=()
  local pair
  for pair in "$@"; do args+=(--data-urlencode "$pair"); done
  curl -s --max-time 10 -X POST "${args[@]}" -o /dev/null \
    -w '%{time_total}' "$CORE_URL$endpoint" 2>/dev/null |
    awk '{printf "%d", $1 * 1000}'
}

ack() {
  post /api/agent/ack \
    "device=$DEVICE_NUMBER" "session=$SESSION_ID" "cid=$1" "status=$2" "msg=${3:-}" >/dev/null
}

# ---------------------------------------------------------------------------------------
# Overlay
# ---------------------------------------------------------------------------------------

overlay_pid() {
  [ -f "$OVERLAY_PID_FILE" ] && cat "$OVERLAY_PID_FILE" 2>/dev/null || printf ''
}

overlay_running() {
  local pid
  pid=$(overlay_pid)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# --kiosk rather than --start-fullscreen: the latter is unreliable on macOS and leaves the
# window merely open. Launching the binary directly rather than through `open` is what
# gives us a PID to terminate later — see DEVIATIONS.md D6.
start_overlay() {
  local url="$1"

  case "$url" in
    http://*|https://*) ;;
    *) say_log "refusing overlay URL with a disallowed scheme"; return 1 ;;
  esac

  [ -n "$BROWSER" ] || return 1
  stop_overlay

  mkdir -p "$OVERLAY_PROFILE"
  "$BROWSER" \
    --user-data-dir="$OVERLAY_PROFILE" \
    --no-first-run \
    --no-default-browser-check \
    --disable-session-crashed-bubble \
    --disable-features=Translate,InfobarScreenshot \
    --kiosk \
    --app="$url" \
    >/dev/null 2>&1 &

  echo $! > "$OVERLAY_PID_FILE"
  return 0
}

# Terminate only our own overlay. The dedicated profile guarantees this process tree is
# separate from the user's browser, so their tabs survive — the reliability requirement
# in SPEC.md §16.
stop_overlay() {
  local pid
  pid=$(overlay_pid)
  [ -n "$pid" ] || return 0

  kill "$pid" 2>/dev/null

  # Give it a moment to go quietly, then insist.
  local waited=0
  while [ $waited -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.1
    waited=$((waited + 1))
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null

  # Backstop for helper processes that outlived the parent. Matching on the profile path
  # is safe because it is unique to this run and appears in no other process's arguments.
  pkill -f "$OVERLAY_PROFILE" 2>/dev/null

  rm -f "$OVERLAY_PID_FILE"
  return 0
}

# ---------------------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------------------

# The agent's own copy of the application allowlist. Core checks first and would refuse an
# unlisted name before dispatch; this second check means a node cannot be handed an
# executable path even by a Core that has been misconfigured. SPEC.md §13.
app_target() {
  case "$1" in
    chrome)     printf 'Google Chrome' ;;
    edge)       printf 'Microsoft Edge' ;;
    vscode)     printf 'Visual Studio Code' ;;
    spotify)    printf 'Spotify' ;;
    terminal)   printf 'Terminal' ;;
    calculator) printf 'Calculator' ;;
    notes)      printf 'Notes' ;;
    *) return 1 ;;
  esac
}

do_open_app() {
  local target
  target=$(app_target "$1") || { ack "$2" failed "app not allowlisted on this node"; return; }

  if open -a "$target" >/dev/null 2>&1; then
    ack "$2" success "$target launched"
  else
    ack "$2" failed "$target is not installed"
  fi
}

do_open_url() {
  case "$1" in
    http://*|https://*) ;;
    *) ack "$2" failed "scheme not allowed"; return ;;
  esac

  if open "$1" >/dev/null 2>&1; then
    ack "$2" success "opened"
  else
    ack "$2" failed "open failed"
  fi
}

# The JARVIS voice.
#
# Daniel is the only serious British male voice macOS ships, and it is the closest thing
# available offline. The tuning matters as much as the voice: JARVIS is measured and low,
# so the rate is pulled below conversational and the pitch dropped a little. `[[pbas n]]`
# is a Speech Synthesis command embedded in the text, not a shell construct.
JARVIS_VOICE="${JARVIS_VOICE:-Daniel}"
JARVIS_RATE="${JARVIS_RATE:-165}"
JARVIS_PITCH="${JARVIS_PITCH:-38}"

# `say -v Nonexistent` does not fail — it silently falls back to the system voice, so a
# typo would go unnoticed until the demo sounded wrong. Check the installed list instead.
voice_installed() {
  say -v '?' 2>/dev/null | grep -q "^$1 "
}

if ! voice_installed "$JARVIS_VOICE"; then
  say_log "voice '$JARVIS_VOICE' is not installed; using the system default"
  JARVIS_VOICE=""
fi

do_speak() {
  local text="$1" voice="$2" cid="$3"

  # A voice named by Core overrides the default, but only if it exists here. The name
  # reaches `say` as a flag value, so it is also checked against a character set that
  # cannot become one.
  local chosen="$JARVIS_VOICE"
  if [ -n "$voice" ] && printf '%s' "$voice" | grep -q '^[A-Za-z ()]\{1,32\}$'; then
    if voice_installed "$voice"; then chosen="$voice"; fi
  fi

  # The text is a single quoted argument and never touches a shell.
  if [ -n "$chosen" ]; then
    say -v "$chosen" -r "$JARVIS_RATE" "[[pbas $JARVIS_PITCH]]$text" >/dev/null 2>&1
  else
    say -r "$JARVIS_RATE" "$text" >/dev/null 2>&1
  fi
  ack "$cid" success "spoken"
}

do_set_volume() {
  case "$1" in
    ''|*[!0-9]*) ack "$2" failed "volume must be an integer"; return ;;
  esac
  [ "$1" -le 100 ] || { ack "$2" failed "volume out of range"; return; }

  osascript -e "set volume output volume $1" >/dev/null 2>&1
  ack "$2" success "volume $1"
}

# identify() with no overlay already on screen: open one, let it flash, close it again.
# Backgrounded so the timer cannot block the command channel. SPEC.md §21.
do_identify_transient() {
  local url="$1" duration_ms="$2" cid="$3"

  case "$duration_ms" in
    ''|*[!0-9]*) duration_ms=4000 ;;
  esac

  start_overlay "$url" || { ack "$cid" unsupported "no browser on this node"; return; }
  ack "$cid" success "identifying"

  (
    sleep "$(awk "BEGIN{print $duration_ms/1000}")"
    # Only clear it if nothing else took over in the meantime.
    [ -f "$STATE_DIR/held" ] || stop_overlay
  ) &
}

# ---------------------------------------------------------------------------------------
# Command handling
# ---------------------------------------------------------------------------------------

handle_command() {
  local line="$1"

  local cid action
  cid=$(printf '%s' "$line" | cut -f1)
  action=$(printf '%s' "$line" | cut -f2)
  [ -n "$action" ] || return

  # Arguments arrive as key=value fields from field 3 on.
  local url="" delay="" app="" text="" voice="" level="" duration=""
  local field key value
  local index=3
  while :; do
    field=$(printf '%s' "$line" | cut -f$index)
    [ -n "$field" ] || break
    key="${field%%=*}"
    value=$(decode "${field#*=}")
    case "$key" in
      url) url="$value" ;;
      delay) delay="$value" ;;
      app) app="$value" ;;
      text) text="$value" ;;
      voice) voice="$value" ;;
      level) level="$value" ;;
      duration) duration="$value" ;;
    esac
    index=$((index + 1))
  done

  case "$action" in
    takeover)
      # The stagger that makes JARVIS look like it is propagating across the room. Delay
      # is relative to receipt, never an absolute time — the laptops' clocks do not agree.
      if [ -n "$delay" ] && [ "$delay" -gt 0 ] 2>/dev/null; then
        sleep "$(awk "BEGIN{print $delay/1000}")"
      fi
      touch "$STATE_DIR/held"
      if start_overlay "$url"; then
        ack "$cid" success "overlay up"
      else
        ack "$cid" unsupported "no browser on this node"
      fi
      ;;

    release)
      rm -f "$STATE_DIR/held"
      stop_overlay
      ack "$cid" success "released"
      ;;

    identify)
      if [ -n "$url" ]; then
        do_identify_transient "$url" "$duration" "$cid"
      else
        ack "$cid" unsupported "overlay handles identify"
      fi
      ;;

    open_app)  do_open_app "$app" "$cid" ;;
    open_url)  do_open_url "$url" "$cid" ;;
    speak)     do_speak "$text" "$voice" "$cid" ;;
    set_volume) do_set_volume "$level" "$cid" ;;
    ping)      ack "$cid" success "pong" ;;

    *)
      # An action this agent does not implement is refused by name rather than ignored,
      # so the wall shows a reason instead of a command that silently went nowhere.
      ack "$cid" unsupported "$action"
      ;;
  esac
}

# ---------------------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------------------

# Runs as its own process because the command loop blocks on the stream. Reports the
# round trip of its previous POST, measured entirely with this machine's own clock, so no
# two machines' clocks are ever subtracted from one another.
heartbeat_loop() {
  local seq=0 rtt=0 interval
  interval=$(awk "BEGIN{print $HEARTBEAT_MS/1000}")

  while [ -f "$STATE_DIR/session" ]; do
    local overlay_flag=0
    overlay_running && overlay_flag=1

    local measured
    measured=$(post_timed /api/agent/heartbeat \
      "device=$DEVICE_NUMBER" "session=$SESSION_ID" \
      "state=$([ "$overlay_flag" = 1 ] && printf 'overlay' || printf 'ready')" \
      "overlay=$overlay_flag" "awake=$(display_awake)" \
      "seq=$seq" "rtt=$rtt")

    # Reported on the *next* heartbeat, since this one has already been sent.
    case "$measured" in
      ''|*[!0-9]*) ;;
      *) rtt="$measured" ;;
    esac

    seq=$((seq + 1))
    sleep "$interval"
  done
}

# ---------------------------------------------------------------------------------------
# Registration and the command channel
# ---------------------------------------------------------------------------------------

register() {
  local response
  response=$(post /api/agent/register \
    "secret=$JOIN_SECRET" "os=macos" "host=$DEVICE_NAME" \
    "wall=$WANTS_WALL" "caps=$CAPABILITIES" "agent=$AGENT_VERSION")

  case "$response" in
    OK*)
      DEVICE_NUMBER=$(printf '%s' "$response" | awk '{print $2}')
      SESSION_ID=$(printf '%s' "$response" | awk '{print $3}')
      HEARTBEAT_MS=$(printf '%s' "$response" | awk '{print $4}')
      [ -n "$HEARTBEAT_MS" ] || HEARTBEAT_MS=5000
      return 0
      ;;
    REJECT*)
      say_log "Core refused this device: $(printf '%s' "$response" | awk '{print $2}')"
      return 1
      ;;
    '')
      return 2
      ;;
    *)
      say_log "unexpected reply from Core: $response"
      return 2
      ;;
  esac
}

banner() {
  cat >&2 <<BANNER

    JARVIS NODE AGENT

    You are device:  $DEVICE_NUMBER
    Name:            $DEVICE_NAME
    Core:            $CORE_URL
    Capabilities:    ${CAPABILITIES:-none}
    Overlay:         ${BROWSER:-no chromium-family browser found}
    Status:          READY

    Nothing will appear on your screen until the presenter takes the room.
    Ctrl+C ends remote control immediately.

BANNER
}

# ---------------------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------------------

# The single most important function in this file.
#
# Without it, a crashed or interrupted agent leaves a teammate looking at a fullscreen
# overlay they cannot dismiss, in a dark room, mid-presentation. Trapped on every exit
# path. See DEVIATIONS.md D4.
cleanup() {
  [ "$RUNNING" = "1" ] || return
  RUNNING=0

  rm -f "$STATE_DIR/session" "$STATE_DIR/held"
  stop_overlay

  [ -n "$STREAM_PID" ] && kill "$STREAM_PID" 2>/dev/null
  [ -n "$HEARTBEAT_PID" ] && kill "$HEARTBEAT_PID" 2>/dev/null
  [ -n "$CAFFEINATE_PID" ] && kill "$CAFFEINATE_PID" 2>/dev/null

  rm -rf "$STATE_DIR" 2>/dev/null
  say_log "JARVIS agent stopped; this machine is no longer under remote control."
}
trap cleanup EXIT
# INT and TERM get their own handler that exits. Left to the EXIT trap alone, bash would
# run cleanup and then carry on round the reconnect loop, so Ctrl+C would tear the overlay
# down and immediately reconnect — the opposite of what the person pressing it wants.
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM HUP

# ---------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------

start_wake_lock

say_log "joining $CORE_URL as \"$DEVICE_NAME\""

backoff=1
while [ "$RUNNING" = "1" ]; do
  register
  registration=$?

  if [ $registration -eq 0 ]; then
    backoff=1
    printf '%s' "$SESSION_ID" > "$STATE_DIR/session"

    heartbeat_loop &
    HEARTBEAT_PID=$!

    banner

    # The command channel. curl reconnects nothing on its own; when the stream ends we
    # fall out of this loop, re-register, and come back — which is what makes a Wi-Fi blip
    # a two-second gap rather than a dead node.
    rm -f "$STREAM_FIFO"
    mkfifo "$STREAM_FIFO" 2>/dev/null

    curl -sN --no-buffer "$CORE_URL/api/agent/stream?device=$DEVICE_NUMBER&session=$SESSION_ID" \
      > "$STREAM_FIFO" 2>/dev/null &
    STREAM_PID=$!

    while IFS= read -r line; do
      case "$line" in
        'data: '*) handle_command "${line#data: }" ;;
        ':'*|'retry:'*|'') ;;
      esac
    done < "$STREAM_FIFO"

    kill "$STREAM_PID" 2>/dev/null
    STREAM_PID=""
    rm -f "$STREAM_FIFO"
    rm -f "$STATE_DIR/session"
    [ -n "$HEARTBEAT_PID" ] && kill "$HEARTBEAT_PID" 2>/dev/null
    [ "$RUNNING" = "1" ] && say_log "connection to Core lost; reconnecting"
  else
    # A refusal is permanent — a wrong token will still be wrong in two seconds — so stop
    # rather than hammer Core with a retry loop the operator has to notice in the log.
    [ $registration -eq 1 ] && exit 1
    say_log "Core unreachable; retrying in ${backoff}s"
  fi

  [ "$RUNNING" = "1" ] || break
  sleep "$backoff"
  backoff=$((backoff * 2))
  [ "$backoff" -gt 15 ] && backoff=15
done
