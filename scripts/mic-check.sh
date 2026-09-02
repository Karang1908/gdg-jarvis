#!/usr/bin/env bash
#
# Can this machine hear you?
#
#   scripts/mic-check.sh
#
# Records you, plays it back, and puts it through the same recogniser Core uses — then says
# which part is at fault, because "the mic does not work" has four very different causes and
# they need four different fixes:
#
#   nothing recorded        the device is wrong, muted, or busy
#   recorded but silent     the level is too low, or the wrong input is selected
#   audible but no words    the recogniser is not running, or the audio is noise
#   words come back         it works, and the problem is elsewhere
#
# Written after an evening lost to the third case: sox on that machine had only the
# pulseaudio driver, whose capture produced a steady noise floor and no voice, while
# arecord on the very same device recorded speech perfectly. Nothing in the stack said so.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

SECONDS_TO_RECORD="${1:-5}"
CLIP="$(mktemp -t jarvis-mic-XXXXXX).wav"
PORT="${JARVIS_WHISPER_PORT:-8910}"

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

cleanup() { rm -f "$CLIP"; }
trap cleanup EXIT

bold "1. Recording"

# arecord on Linux, sox everywhere else. This used to require arecord, which is ALSA and so
# does not exist on a Mac — where the whole system now runs.
if command -v arecord >/dev/null 2>&1; then
  RECORD_WITH=arecord
elif command -v rec >/dev/null 2>&1; then
  RECORD_WITH=rec
else
  bad "nothing here can record — install sox"
  exit 1
fi

printf '  say something for %s seconds, starting now...\n' "$SECONDS_TO_RECORD"
sleep 1
if [ "$RECORD_WITH" = arecord ]; then
  arecord -q -f S16_LE -c1 -r16000 -d "$SECONDS_TO_RECORD" "$CLIP" 2>/dev/null
else
  rec -q -c1 -r16000 -b16 "$CLIP" trim 0 "$SECONDS_TO_RECORD" 2>/dev/null
fi

BYTES=$(stat -c%s "$CLIP" 2>/dev/null || stat -f%z "$CLIP" 2>/dev/null || echo 0)
if [ "$BYTES" -lt 1000 ]; then
  bad "nothing was recorded ($BYTES bytes)"
  warn "the capture device is wrong, muted, or held by something else"
  warn "  arecord -l                 what devices exist"
  warn "  pactl get-default-source   what is selected"
  exit 1
fi
ok "recorded $BYTES bytes"

bold "2. Input gain"

if [ "$(uname)" = "Darwin" ]; then
  LEVEL=$(osascript -e 'input volume of (get volume settings)' 2>/dev/null)
  if [ -n "$LEVEL" ] && [ "$LEVEL" -lt 50 ] 2>/dev/null; then
    bad "the microphone input is at $LEVEL of 100"
    warn "too quiet to recognise, and nothing else will tell you:"
    warn "  osascript -e 'set volume input volume 90'"
  else
    ok "input gain ${LEVEL:-?} of 100"
  fi
fi

bold "3. Level"

PEAK=$(sox "$CLIP" -n stat 2>&1 | awk '/Maximum amplitude/{printf "%.3f", $3}')
RMS=$(sox "$CLIP" -n stat 2>&1 | awk '/RMS +amplitude/{printf "%.4f", $3}')
printf '  peak %s   rms %s\n' "${PEAK:-?}" "${RMS:-?}"

# 0.03 is the threshold sox's silence gate uses to decide someone started talking.
QUIET=$(awk -v p="${PEAK:-0}" 'BEGIN{print (p < 0.05) ? 1 : 0}')
HOT=$(awk -v p="${PEAK:-0}" 'BEGIN{print (p > 0.99) ? 1 : 0}')

if [ "$QUIET" = "1" ]; then
  bad "far too quiet — Core will never notice you started speaking"
  if [ "$(uname)" = "Darwin" ]; then
    warn "  osascript -e 'set volume input volume 90'"
  else
    warn "  pactl set-source-volume @DEFAULT_SOURCE@ 60%"
    warn "  amixer -c 0 sset 'Internal Mic Boost' 2"
  fi
elif [ "$HOT" = "1" ]; then
  warn "clipping — turn it down or the recogniser hears distortion"
  warn "  pactl set-source-volume @DEFAULT_SOURCE@ 40%"
else
  ok "a usable level"
fi

bold "4. Does it sound like you?"

PLAY_WITH=$(command -v aplay || command -v afplay || command -v play || true)
if [ -n "$PLAY_WITH" ]; then
  printf '  playing it back...\n'
  "$PLAY_WITH" "$CLIP" >/dev/null 2>&1
  ok "if that was your voice, the microphone is fine"
else
  warn "nothing here can play audio, skipping playback"
fi

bold "5. Can the recogniser read it?"

if ! curl -sf --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  warn "nothing listening on port $PORT — start Core, which starts the recogniser"
  exit 0
fi

HEARD=$(curl -s --max-time 90 -X POST "http://127.0.0.1:$PORT/inference" \
  -F "file=@$CLIP" -F 'response_format=json' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("text","").strip())' 2>/dev/null)

if [ -n "$HEARD" ]; then
  ok "it heard: \"$HEARD\""
  printf '\n  \033[32m\033[1mthe whole chain works\033[0m — if the room still does nothing,\n'
  printf '  the microphone is switched off. Open it from the phone, or:\n'
  printf '    curl -s -X POST -H "Authorization: Bearer $JARVIS_ADMIN_PASSWORD" \\\n'
  printf '      -H "Content-Type: application/json" -d "{\\"on\\":true}" \\\n'
  printf '      http://127.0.0.1:3000/api/mic\n\n'
else
  bad "the recogniser found no words in it"
  if [ "$QUIET" = "1" ]; then
    warn "no surprise at that level — fix the level first and run this again"
  else
    warn "audible to you but not to it usually means noise rather than speech"
    warn "keep the clip and listen closely: $CLIP"
    trap - EXIT
  fi
fi
