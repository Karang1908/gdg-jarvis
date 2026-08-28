#!/usr/bin/env bash
#
# Bring up JARVIS-NET and JARVIS Core on the Kali laptop.
#
#   sudo scripts/setup-kali.sh                 # check, generate tokens, create the hotspot
#   scripts/setup-kali.sh --tokens-only        # regenerate the registry, touch nothing else
#   scripts/setup-kali.sh --check              # report readiness, change nothing
#
# Implements SPEC.md §4. Every step is checked before it is taken, because the one thing
# this script must never do is half-configure the network an hour before a talk and leave
# no trace of which half.

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONFIG="$REPO_ROOT/core/config/nodes.json"

SSID="JARVIS-NET"
CONNECTION="JARVIS-NET"
PASSPHRASE="${JARVIS_WIFI_PASSPHRASE:-ArcReactor42!}"
NODES="MAIN ALPHA BETA GAMMA"

MODE="full"
case "${1:-}" in
  --tokens-only) MODE="tokens" ;;
  --check) MODE="check" ;;
  --help|-h)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
esac

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------------------

problems=0

bold ""
bold "JARVIS — Kali setup"
bold ""
bold "Preflight"

if command -v node >/dev/null 2>&1; then
  ok "node $(node -v)"
else
  fail "node is not installed — install it now, while this machine still has internet"
  problems=$((problems + 1))
fi

# Core has no dependencies by design (DEVIATIONS.md D1), so there is nothing to install and
# nothing that can be missing at the venue. Say so, because an operator who expects an
# npm install will otherwise go looking for one.
ok "core has no npm dependencies — nothing to install offline"

if command -v nmcli >/dev/null 2>&1; then
  ok "nmcli present"
else
  fail "nmcli not found; NetworkManager is required for the hotspot"
  problems=$((problems + 1))
fi

# The whole demo rests on this card being able to run as an access point. Checking it here
# is the difference between finding out now and finding out in front of an audience.
WIFI_IF=$(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}')
if [ -n "$WIFI_IF" ]; then
  ok "wifi interface: $WIFI_IF"
  if iw list 2>/dev/null | grep -A 15 "Supported interface modes" | grep -qw "AP"; then
    ok "adapter supports AP mode"
  else
    fail "adapter does not report AP mode — this card cannot host JARVIS-NET"
    warn "use a different adapter, or a phone hotspot with Core joined as a client"
    problems=$((problems + 1))
  fi
else
  fail "no wifi interface found"
  problems=$((problems + 1))
fi

if [ "$MODE" = "check" ]; then
  bold ""
  [ "$problems" -eq 0 ] && ok "ready" || fail "$problems problem(s) above"
  exit $((problems > 0))
fi

if [ "$problems" -gt 0 ] && [ "$MODE" = "full" ]; then
  bold ""
  fail "refusing to continue with $problems unresolved problem(s)"
  exit 1
fi

# ---------------------------------------------------------------------------------------
# Token registry
# ---------------------------------------------------------------------------------------

bold ""
bold "Node registry"

generate_token() {
  # openssl is on every Kali; /dev/urandom is the fallback that needs nothing at all.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [ -f "$CONFIG" ] && [ "$MODE" != "tokens" ]; then
  warn "$CONFIG already exists; keeping the tokens already in it"
  warn "run with --tokens-only to replace them"
else
  # Never overwrite a registry without leaving the old one recoverable: teammates may
  # already be holding the tokens it contains.
  if [ -f "$CONFIG" ]; then
    backup="$CONFIG.$(date +%Y%m%d-%H%M%S).bak"
    cp "$CONFIG" "$backup"
    warn "previous registry saved to $(basename "$backup")"
  fi

  {
    printf '{\n'
    printf '  "admin": { "token": "%s" },\n' "$(generate_token)"
    printf '  "nodes": {\n'
    first=1
    for node in $NODES; do
      [ $first -eq 1 ] || printf ',\n'
      first=0
      if [ "$node" = "MAIN" ]; then
        printf '    "MAIN": { "token": "%s", "label": "Presenter Mac", "role": "wall" }' "$(generate_token)"
      else
        label=$(printf '%s' "$node" | cut -c1)$(printf '%s' "$node" | cut -c2- | tr '[:upper:]' '[:lower:]')
        printf '    "%s": { "token": "%s", "label": "%s" }' "$node" "$(generate_token)" "$label"
      fi
    done
    printf '\n  }\n}\n'
  } > "$CONFIG"

  chmod 600 "$CONFIG"
  ok "wrote $CONFIG (mode 600)"
fi

if [ "$MODE" = "tokens" ]; then
  bold ""
  ok "registry regenerated; restart Core to pick it up"
  exit 0
fi

# ---------------------------------------------------------------------------------------
# Hotspot
# ---------------------------------------------------------------------------------------

bold ""
bold "Hotspot"

if [ "$(id -u)" -ne 0 ]; then
  warn "not running as root; skipping hotspot setup"
  warn "re-run with sudo, or create it by hand:"
  printf '\n    sudo nmcli device wifi hotspot ifname %s con-name %s ssid %s band bg password %s\n\n' \
    "$WIFI_IF" "$CONNECTION" "$SSID" "'$PASSPHRASE'"
else
  if nmcli -t -f NAME connection show 2>/dev/null | grep -qx "$CONNECTION"; then
    ok "connection '$CONNECTION' already exists"
  else
    if nmcli device wifi hotspot ifname "$WIFI_IF" con-name "$CONNECTION" \
         ssid "$SSID" band bg password "$PASSPHRASE" >/dev/null 2>&1; then
      ok "created hotspot $SSID on $WIFI_IF"
    else
      fail "could not create the hotspot"
      exit 1
    fi
  fi

  # SPEC.md §4 asks for this. It is not actually required by the architecture — every path
  # is client to Core, never client to client — but leaving isolation on would silently
  # break anything added later that expects peers to see each other.
  nmcli connection modify "$CONNECTION" 802-11-wireless.ap-isolation no >/dev/null 2>&1 \
    && ok "client isolation disabled" \
    || warn "could not set ap-isolation (older NetworkManager); harmless for this demo"

  # 2.4 GHz on purpose. 5 GHz AP mode on Linux runs into DFS channels and regulatory
  # domains, and the traffic here is a few kilobytes of JSON per second.
  ok "band bg (2.4 GHz) — chosen for reliability, not throughput"

  nmcli connection down "$CONNECTION" >/dev/null 2>&1
  nmcli connection up "$CONNECTION" >/dev/null 2>&1 && ok "hotspot up"
fi

CORE_IP=$(ip -4 addr show "$WIFI_IF" 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)
[ -n "$CORE_IP" ] || CORE_IP="10.42.0.1"
ok "core address: $CORE_IP"

# ---------------------------------------------------------------------------------------
# Handover
# ---------------------------------------------------------------------------------------

ADMIN_TOKEN=$(node -e "process.stdout.write(require('$CONFIG').admin.token)" 2>/dev/null)

bold ""
bold "Start Core"
printf '\n    node core/server.js --host %s --port 3000\n' "$CORE_IP"

bold ""
bold "Give each teammate their line"
printf '\n'
for node in $NODES; do
  token=$(node -e "process.stdout.write(require('$CONFIG').nodes['$node'].token)" 2>/dev/null)
  printf '  %-6s macOS    curl -s http://%s:3000/join | bash -s %s %s\n' "$node" "$CORE_IP" "$node" "$token"
  printf '  %-6s Windows  $env:JARVIS_NODE="%s"; $env:JARVIS_TOKEN="%s"; iwr http://%s:3000/join.ps1 -UseBasicParsing | iex\n\n' \
    "" "$node" "$token" "$CORE_IP"
done

bold "Operator"
printf '\n    wall     http://%s:3000/wall/\n' "$CORE_IP"
printf '    control  http://%s:3000/control/\n' "$CORE_IP"
printf '    admin    %s\n\n' "${ADMIN_TOKEN:-see core/config/nodes.json}"

warn "these tokens are the keys to every enrolled laptop — hand them over in person"
printf '\n'
