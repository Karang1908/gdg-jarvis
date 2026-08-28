#!/usr/bin/env bash
#
# Bring up JARVIS-NET and JARVIS Core on the Kali laptop.
#
#   sudo scripts/setup-kali.sh                  # check, generate secrets, create the hotspot
#   scripts/setup-kali.sh --secrets-only        # regenerate secrets, touch nothing else
#   scripts/setup-kali.sh --check               # report readiness, change nothing
#
# Implements SPEC.md §4. Every step is checked before it is taken, because the one thing
# this script must never do is half-configure the network an hour before a talk and leave
# no trace of which half.

set -uo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONFIG="$REPO_ROOT/core/config/core.json"

SSID="${JARVIS_SSID:-JARVIS-NET}"
CONNECTION="$SSID"
PASSPHRASE="${JARVIS_WIFI_PASSPHRASE:-gdg@essentials2026}"

MODE="full"
case "${1:-}" in
  --secrets-only|--tokens-only) MODE="secrets" ;;
  --check) MODE="check" ;;
  --help|-h) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
    fail "adapter does not report AP mode — this card cannot host $SSID"
    warn "use a different adapter, or a phone hotspot with Core joined as a client"
    problems=$((problems + 1))
  fi
else
  fail "no wifi interface found"
  problems=$((problems + 1))
fi

# ---------------------------------------------------------------------------------------
# Internet uplink
#
# The brain runs here now: Core, the MCP server, and the AI client all live on this machine
# (DEVIATIONS.md D11). Wi-Fi is busy being the access point, so the LLM needs a second route
# out — ethernet, or a phone tethered over USB.
#
# Three separate things have to be true, and checking only the first is how you end up
# debugging on stage:
#
#   1. the route exists and is not the Wi-Fi card
#   2. it actually reaches the internet — a phone with no signal still installs a route
#   3. its subnet does not collide with 10.42.0.0/24, which would break the room silently
# ---------------------------------------------------------------------------------------

AP_SUBNET_PREFIX="10.42."

describe_uplink() {
  case "$1" in
    usb*|enp*u*|rndis*) printf 'tethered phone or USB adapter' ;;
    en*|eth*)           printf 'ethernet' ;;
    wl*|wlan*)          printf 'wifi' ;;
    *)                  printf 'unknown type' ;;
  esac
}

UPLINK=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)

if [ -z "$UPLINK" ]; then
  warn "no internet route — the local demo works fully, the AI layer will not"
  warn "tether a phone over USB, or plug in ethernet"
elif [ "$UPLINK" = "$WIFI_IF" ]; then
  warn "the only default route is $UPLINK, which is about to become the access point"
  warn "tether a phone over USB, or the LLM layer will have no internet"
else
  ok "internet uplink: $UPLINK ($(describe_uplink "$UPLINK"))"

  # A route is not connectivity. Probe something that answers fast and is not a captive
  # portal; a 204 with no body is unambiguous in a way that a 200 from a hotel splash page
  # is not.
  if curl -s --max-time 6 -o /dev/null -w '%{http_code}' \
       https://connectivitycheck.gstatic.com/generate_204 2>/dev/null | grep -q '^204$'; then
    ok "the internet is actually reachable through it"
  else
    warn "$UPLINK has a route but nothing answered — check the phone has signal,"
    warn "that tethering is still enabled, and that the cable is a data cable"
  fi

  # The one failure that looks like nothing. If the phone hands out 10.42.x.x, its route
  # and JARVIS-NET's overlap, and devices become unreachable in a way that looks like the
  # agents are broken rather than like a routing problem.
  UPLINK_ADDR=$(ip -4 addr show "$UPLINK" 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)
  case "$UPLINK_ADDR" in
    "$AP_SUBNET_PREFIX"*)
      fail "$UPLINK is on $UPLINK_ADDR, which collides with JARVIS-NET's ${AP_SUBNET_PREFIX}0.0/24"
      warn "change the phone's tethering subnet, or set JARVIS-NET to a different range"
      problems=$((problems + 1))
      ;;
    "") ;;
    *) ok "uplink subnet $UPLINK_ADDR does not collide with the access point" ;;
  esac
fi

# WPA2 requires 8 characters. Checked here rather than at nmcli, whose failure for a short
# passphrase is not obviously about the passphrase.
if [ "${#PASSPHRASE}" -lt 8 ]; then
  fail "wifi passphrase must be at least 8 characters (WPA2 minimum)"
  problems=$((problems + 1))
else
  ok "wifi passphrase is ${#PASSPHRASE} characters"
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
# Secrets
# ---------------------------------------------------------------------------------------

bold ""
bold "Secrets"

generate() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [ -f "$CONFIG" ] && [ "$MODE" != "secrets" ]; then
  warn "$(basename "$CONFIG") already exists; keeping the secrets already in it"
  warn "run with --secrets-only to replace them"
else
  # Never overwrite without leaving the old one recoverable: teammates may already be
  # holding a join script carrying the secret it contains.
  if [ -f "$CONFIG" ]; then
    backup="$CONFIG.$(date +%Y%m%d-%H%M%S).bak"
    cp "$CONFIG" "$backup"
    warn "previous config saved to $(basename "$backup")"
  fi

  cat > "$CONFIG" <<JSON
{
  "admin": { "token": "$(generate)" },
  "join":  { "secret": "$(generate)" },
  "wifi":  { "ssid": "$SSID", "passphrase": "$PASSPHRASE" }
}
JSON

  chmod 600 "$CONFIG"
  ok "wrote $(basename "$CONFIG") (mode 600)"
fi

if [ "$MODE" = "secrets" ]; then
  bold ""
  ok "secrets regenerated; restart Core to pick them up"
  warn "every teammate must re-run the join line — the old secret no longer works"
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
    # The passphrase may have changed since it was created; make the live network match
    # the one this script is about to print on screen.
    nmcli connection modify "$CONNECTION" wifi-sec.psk "$PASSPHRASE" >/dev/null 2>&1 \
      && ok "passphrase updated to match this config"
  else
    if nmcli device wifi hotspot ifname "$WIFI_IF" con-name "$CONNECTION" \
         ssid "$SSID" band bg password "$PASSPHRASE" >/dev/null 2>&1; then
      ok "created hotspot $SSID on $WIFI_IF"
    else
      fail "could not create the hotspot"
      exit 1
    fi
  fi

  # SPEC.md §4 asks for this. It is not required by the architecture — every path is client
  # to Core, never client to client — but leaving isolation on would silently break
  # anything added later that expects peers to see each other.
  nmcli connection modify "$CONNECTION" 802-11-wireless.ap-isolation no >/dev/null 2>&1 \
    && ok "client isolation disabled" \
    || warn "could not set ap-isolation (older NetworkManager); harmless for this demo"

  # Survive a reboot on the day without anyone remembering to bring it back up.
  nmcli connection modify "$CONNECTION" connection.autoconnect yes >/dev/null 2>&1 \
    && ok "will come back automatically after a reboot"

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
bold "Tell everyone"
printf '\n'
printf '  1. Join Wi-Fi   \033[1m%s\033[0m   password  \033[1m%s\033[0m\n' "$SSID" "$PASSPHRASE"
printf '\n'
printf '  2. Run one line. The same line for everybody — no name, no token.\n'
printf '\n'
printf '     macOS     curl -s http://%s:3000/join | bash\n' "$CORE_IP"
printf '     Windows   iwr http://%s:3000/join.ps1 -UseBasicParsing | iex\n' "$CORE_IP"
printf '\n'
printf '  3. Leave it running. It prints the device number they were given.\n'

bold ""
bold "The AI layer"
printf '\n'
printf '  Core, the MCP server, and Antigravity all run here.\n'
printf '\n'
printf '    python3 -m venv .venv && .venv/bin/pip install -r mcp/requirements.txt\n'
printf '    scripts/install-mcp.sh\n'
printf '\n'
printf '  That registers the tools and installs the personality from\n'
printf '  core/config/personality.md. Edit that file to change who JARVIS is.\n'

bold ""
bold "Operator"
printf '\n    wall     http://%s:3000/wall/\n' "$CORE_IP"
printf '    control  http://%s:3000/control/\n' "$CORE_IP"
printf '    admin    \033[1m%s\033[0m\n\n' "${ADMIN_TOKEN:-see core/config/core.json}"

warn "the admin token is the key to every enrolled laptop — it is yours, not the room's"
printf '\n'
