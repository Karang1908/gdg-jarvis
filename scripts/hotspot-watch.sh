#!/usr/bin/env bash
#
# Keep JARVIS-NET up.
#
#   sudo scripts/hotspot-watch.sh                 watch in this terminal
#   sudo scripts/hotspot-watch.sh --check         say what it sees, then exit
#   sudo scripts/hotspot-watch.sh --install       install as a service and forget about it
#   sudo scripts/hotspot-watch.sh --uninstall
#
# The hotspot drops on its own. A laptop Wi-Fi card is built to save power, and saving power
# means going quiet — which for a card acting as an access point means the room falls off the
# network. NetworkManager will not necessarily bring it back: autoconnect gives up after a
# few tries by default, and a connection that went down cleanly is not retried at all.
#
# Two lessons are built into this file, both learned the hard way.
#
# **Find the connection, do not assume its name.** The first version guessed "jarvis-net"
# while setup names it after the SSID, "JARVIS-NET". nmcli names are case sensitive, so it
# looked for something that did not exist, concluded the hotspot was down, failed to raise
# it, and reported that every ten seconds for as long as it ran.
#
# **Say what changed, not what is.** A watchdog that prints on every check is a watchdog
# nobody reads, and the one line that mattered is buried in a thousand identical ones. This
# one speaks when something changes, when something fails — with the reason — and otherwise
# only often enough to prove it is alive.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

EVERY="${JARVIS_HOTSPOT_CHECK_S:-10}"
HEARTBEAT_S="${JARVIS_HOTSPOT_HEARTBEAT_S:-900}"
UNIT=/etc/systemd/system/jarvis-hotspot.service

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

# Journald adds its own timestamps; a second one in the message is noise.
say()  { if [ -n "${INVOCATION_ID:-}" ]; then printf '%s\n' "$1"; else printf '%s  %s\n' "$(date '+%H:%M:%S')" "$1"; fi; }

need_root() {
  [ "$(id -u)" = "0" ] && return 0
  bad "needs root: sudo $0 ${*:-}"
  exit 1
}

# ---------------------------------------------------------------------------------------
# Which connection
#
# Asked for, then read from .env the way setup does, then found by looking for one actually
# configured as an access point. Guessing a name is what broke the first version.
# ---------------------------------------------------------------------------------------

find_connection() {
  local candidate

  if [ -n "${JARVIS_HOTSPOT_CONNECTION:-}" ]; then
    printf '%s' "$JARVIS_HOTSPOT_CONNECTION"
    return 0
  fi

  # setup-kali.sh names the connection after the SSID.
  if [ -f .env ]; then
    candidate=$(grep -E '^JARVIS_SSID=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
    if [ -n "$candidate" ] && nmcli -t -f NAME connection show 2>/dev/null | grep -qxF "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  fi

  # Whatever is actually set up as an access point, whatever it is called.
  candidate=$(nmcli -t -f NAME connection show 2>/dev/null | while IFS= read -r name; do
    [ -z "$name" ] && continue
    if [ "$(nmcli -g 802-11-wireless.mode connection show "$name" 2>/dev/null)" = "ap" ]; then
      printf '%s' "$name"
      break
    fi
  done)

  [ -n "$candidate" ] && printf '%s' "$candidate" && return 0
  return 1
}

is_up() {
  nmcli -t -f NAME,STATE connection show --active 2>/dev/null | grep -qxF "$CONNECTION:activated"
}

# Why it is down, in as many words as nmcli will give.
reason_down() {
  local iface state
  iface=$(nmcli -g GENERAL.DEVICES connection show "$CONNECTION" 2>/dev/null | head -1)
  if [ -z "$iface" ]; then
    iface=$(nmcli -t -f DEVICE,TYPE device status 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}')
  fi
  [ -z "$iface" ] && { printf 'no wifi interface'; return; }

  state=$(nmcli -t -f DEVICE,STATE device status 2>/dev/null | awk -F: -v d="$iface" '$1==d{print $2; exit}')
  printf '%s is %s' "$iface" "${state:-unknown}"
}

stop_power_saving() {
  nmcli connection modify "$CONNECTION" 802-11-wireless.powersave 2 >/dev/null 2>&1
  nmcli connection modify "$CONNECTION" connection.autoconnect yes >/dev/null 2>&1
  nmcli connection modify "$CONNECTION" connection.autoconnect-retries 0 >/dev/null 2>&1

  local iface
  iface=$(nmcli -g GENERAL.DEVICES connection show "$CONNECTION" 2>/dev/null | head -1)
  [ -n "$iface" ] && iw dev "$iface" set power_save off >/dev/null 2>&1
}

# ---------------------------------------------------------------------------------------
# What it does
# ---------------------------------------------------------------------------------------

report() {
  bold "JARVIS-NET watchdog"
  if [ -z "${CONNECTION:-}" ]; then
    bad "no access point connection found"
    warn "run scripts/setup-kali.sh first, or name it:"
    warn "  JARVIS_HOTSPOT_CONNECTION='My Hotspot' sudo $0"
    printf '\n  connections on this machine:\n'
    nmcli -t -f NAME,TYPE connection show 2>/dev/null | sed 's/^/    /'
    return 1
  fi

  ok "watching \"$CONNECTION\""
  if is_up; then
    ok "up now"
  else
    warn "down now — $(reason_down)"
  fi

  local ps
  ps=$(nmcli -g 802-11-wireless.powersave connection show "$CONNECTION" 2>/dev/null)
  [ "$ps" = "2" ] && ok "power saving disabled" || warn "power saving is '$ps' — 2 means off, and off is what keeps it up"

  local retries
  retries=$(nmcli -g connection.autoconnect-retries connection show "$CONNECTION" 2>/dev/null)
  [ "$retries" = "0" ] && ok "retries unlimited" || warn "retries limited to '$retries' — it will give up eventually"
  return 0
}

watch_forever() {
  need_root

  if [ -z "${CONNECTION:-}" ]; then
    say "no access point connection found — run scripts/setup-kali.sh, or set JARVIS_HOTSPOT_CONNECTION"
    say "connections here: $(nmcli -t -f NAME connection show 2>/dev/null | paste -sd', ')"
    exit 1
  fi

  stop_power_saving
  say "watching \"$CONNECTION\" every ${EVERY}s"

  local was_up=-1        # -1 so the first pass always reports where it started
  local down_since=0
  local failures=0
  local backoff=0
  local last_beat
  last_beat=$(date +%s)
  local revivals=0

  while true; do
    local now
    now=$(date +%s)

    if is_up; then
      if [ "$was_up" != "1" ]; then
        if [ "$down_since" -gt 0 ]; then
          say "back up after $((now - down_since))s (revival $revivals)"
        else
          say "up"
        fi
        was_up=1
        down_since=0
        failures=0
        backoff=0
        last_beat=$now
      elif [ $((now - last_beat)) -ge "$HEARTBEAT_S" ]; then
        # Rare, and only so silence is distinguishable from a dead watchdog.
        say "still up (revived $revivals times so far)"
        last_beat=$now
      fi
      sleep "$EVERY"
      continue
    fi

    # Down. Said once on the way down, not on every check.
    if [ "$was_up" != "0" ]; then
      say "DOWN — $(reason_down)"
      was_up=0
      down_since=$now
      failures=0
      backoff=0
    fi

    if [ "$backoff" -gt 0 ]; then
      backoff=$((backoff - EVERY))
      sleep "$EVERY"
      continue
    fi

    revivals=$((revivals + 1))
    local err
    err=$(nmcli connection up "$CONNECTION" 2>&1 >/dev/null)

    if is_up; then
      # The "back up" line comes from the top of the loop on the next pass.
      stop_power_saving
      sleep 2
      continue
    fi

    failures=$((failures + 1))
    # Only the first few failures are worth a line each; after that it is the same failure.
    if [ "$failures" -le 3 ]; then
      say "could not bring it up: ${err:-no reason given}"
    elif [ $((failures % 30)) = 0 ]; then
      say "still failing after $failures attempts: ${err:-no reason given}"
    fi

    # Back off so a hard failure is not a tight loop, up to a minute.
    backoff=$(( failures * EVERY ))
    [ "$backoff" -gt 60 ] && backoff=60
    sleep "$EVERY"
  done
}

install_service() {
  need_root --install

  if [ -z "${CONNECTION:-}" ]; then
    report
    exit 1
  fi

  stop_power_saving
  ok "power saving off, retries unlimited"

  cat > "$UNIT" <<UNITFILE
[Unit]
Description=Keep the JARVIS-NET hotspot up
After=NetworkManager.service
Wants=NetworkManager.service

[Service]
Type=simple
Environment=JARVIS_HOTSPOT_CONNECTION=$CONNECTION
ExecStart=$(pwd)/scripts/hotspot-watch.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITFILE

  systemctl daemon-reload
  systemctl enable --now jarvis-hotspot.service >/dev/null 2>&1

  if systemctl is-active --quiet jarvis-hotspot.service; then
    ok "installed and watching \"$CONNECTION\" — starts itself on boot"
    printf '\n    journalctl -u jarvis-hotspot -f     watch it\n\n'
  else
    bad "installed but not running"
    systemctl status jarvis-hotspot.service --no-pager | tail -5
  fi
}

uninstall_service() {
  need_root --uninstall
  systemctl disable --now jarvis-hotspot.service >/dev/null 2>&1
  rm -f "$UNIT"
  systemctl daemon-reload
  ok "removed"
}

CONNECTION=$(find_connection || true)

case "${1:-}" in
  --install)   install_service ;;
  --uninstall) bold "JARVIS-NET watchdog"; uninstall_service ;;
  --check)     report ;;
  --help|-h)   sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//' ;;
  *)           watch_forever ;;
esac
