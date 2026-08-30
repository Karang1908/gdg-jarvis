#!/usr/bin/env bash
#
# Everything, in one command.
#
#   npm test
#   scripts/test.sh
#
# Nine suites. The first four always run; the MCP one needs a Python venv with the SDK and
# is skipped with a note rather than a failure if there is not one, because it depends on
# something outside this repository.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

FAILED=0

printf '\n\033[1m1/9  wire encoding\033[0m\n'
node core/test/wire.test.js || FAILED=1

# Before the API suite, because these are pure and fast: if what a sentence means is wrong,
# nothing downstream is worth reading.
printf '\n\033[1m2/9  spoken intents\033[0m\n'
node core/test/intents.test.js || FAILED=1

printf '\n\033[1m3/9  the controller\033[0m\n'
node core/test/control.test.js || FAILED=1

printf '\n\033[1m4/9  transcription requests\033[0m\n'
node core/test/ears.test.js || FAILED=1

# Both are about latency more than correctness: a line that drifted out of the warmed list
# is a live synthesis every time it is spoken.
printf '\n\033[1m5/9  warmed phrases\033[0m\n'
node core/test/phrases.test.js || FAILED=1

printf '\n\033[1m6/9  the voice budget\033[0m\n'
node core/test/voice.test.js || FAILED=1

printf '\n\033[1m7/9  the agy runner\033[0m\n'
node core/test/ask.test.js || FAILED=1

printf '\n\033[1m8/9  API, end to end\033[0m\n'
node core/test/api.test.js || FAILED=1

printf '\n\033[1m9/9  MCP tools\033[0m\n'
PYTHON=""
for candidate in .venv/bin/python venv/bin/python; do
  [ -x "$candidate" ] && "$candidate" -c 'import mcp' >/dev/null 2>&1 && PYTHON="$candidate" && break
done

if [ -z "$PYTHON" ]; then
  printf '  \033[33m·\033[0m skipped — no venv with the MCP SDK\n'
  printf '      python3 -m venv .venv && .venv/bin/pip install -r mcp/requirements.txt\n'
else
  # The MCP suite talks to a live Core with devices attached, so stand one up for it. A
  # spare port and a throwaway .env, so a running demo is never disturbed.
  PORT=3878
  ENVFILE=$(mktemp)
  cat > "$ENVFILE" <<ENV
JARVIS_ADMIN_PASSWORD=test-admin-password
JARVIS_JOIN_SECRET=test-join-secret
JARVIS_WIFI_PASSWORD=test-passphrase
JARVIS_VOICE_PROVIDER=espeak
ENV

  node core/server.js --host 127.0.0.1 --port "$PORT" --env "$ENVFILE" >/dev/null 2>&1 &
  CORE_PID=$!

  cleanup() {
    kill "$CORE_PID" 2>/dev/null
    pkill -f "sim-node.sh .* --server http://127.0.0.1:$PORT" 2>/dev/null
    rm -f "$ENVFILE"
  }
  trap cleanup EXIT

  for i in $(seq 1 40); do
    curl -s --max-time 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
    sleep 0.25
  done

  for name in "Karan Mac:macos" "Ravi-PC:windows" "anita-mbp:macos"; do
    bash scripts/sim-node.sh "${name%%:*}" --os "${name##*:}" \
      --server "http://127.0.0.1:$PORT" --secret test-join-secret >/dev/null 2>&1 &
    sleep 0.4
  done
  sleep 2

  # Scene commands need somewhere to land, so attach an overlay stream per device.
  for d in 1 2 3; do
    URL=$(curl -s -X POST "http://127.0.0.1:$PORT/api/overlay/url" \
      -H 'Authorization: Bearer test-admin-password' -H 'Content-Type: application/json' \
      -d "{\"node\":\"$d\"}" | node -e "let x='';process.stdin.on('data',c=>x+=c).on('end',()=>{try{process.stdout.write(JSON.parse(x).url||'')}catch(e){}})")
    [ -n "$URL" ] && curl -sN "$(printf '%s' "$URL" | sed 's|/overlay/?|/api/overlay/stream?|')" >/dev/null 2>&1 &
    sleep 0.2
  done
  sleep 1

  JARVIS_CORE_URL="http://127.0.0.1:$PORT" JARVIS_ADMIN_TOKEN=test-admin-password \
    "$PYTHON" mcp/test_tools.py || FAILED=1
fi

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32m\033[1mall suites passed\033[0m\n\n'
else
  printf '\033[31m\033[1msomething failed above\033[0m\n\n'
fi
exit $FAILED
