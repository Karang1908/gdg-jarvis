#!/usr/bin/env bash
#
# Keep JARVIS-NET up.
#
#   sudo scripts/hotspot-watch.sh                 watch in this terminal
#   sudo scripts/hotspot-watch.sh --install       install it as a service and forget about it
#   sudo scripts/hotspot-watch.sh --uninstall
#
# The hotspot drops on its own. A laptop Wi-Fi card is built to save power, and saving power
# means going quiet — which for a card acting as an access point means the room falls off the
# network. NetworkManager will not necessarily bring it back: autoconnect gives up after a
# few tries by default, and a connection that went down cleanly is not something it retries
# at all.
#
# So two things here. Power saving is turned off on the interface, which removes the usual
# cause. And something watches, because "usual" is not "only" — during a demo the difference
# between a five-second gap and a dead room is whether anybody was watching.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

CONNECTION="${JARVIS_HOTSPOT_CONNECTION:-jarvis-net}"
EVERY="${JARVIS_HOTSPOT_CHECK_S:-10}"
UNIT=/etc/systemd/system/jarvis-hotspot.service

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

need_root() {
  [ "$(id -u)" = "0" ] && return 0
  bad "needs root: sudo $0 $*"
  exit 1
}

is_up() {
  nmcli -t -f NAME,STATE connection show --active 2>/dev/null \
    | grep -qx "$CONNECTION:activated"
}

# The card sleeping is the usual reason the room falls off. Disabling it on the connection
# survives reboots; the iw call handles the running interface right now.
stop_power_saving() {
  nmcli connection modify "$CONNECTION" 802-11-wireless.powersave 2 >/dev/null 2>&1
  # Infinite retries. The default gives up after a handful, which on a flaky card means it
  # gives up during the demo and not before it.
  nmcli connection modify "$CONNECTION" connection.autoconnect yes >/dev/null 2>&1
  nmcli connection modify "$CONNECTION" connection.autoconnect-retries 0 >/dev/null 2>&1

  local iface
  iface=$(nmcli -g GENERAL.DEVICES connection show "$CONNECTION" 2>/dev/null)
  [ -n "$iface" ] && iw dev "$iface" set power_save off >/dev/null 2>&1
}

install_service() {
  need_root --install

  if ! nmcli -t -f NAME connection show 2>/dev/null | grep -qx "$CONNECTION"; then
    bad "no connection called $CONNECTION — run scripts/setup-kali.sh first"
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
ExecStart=$(pwd)/scripts/hotspot-watch.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNITFILE

  systemctl daemon-reload
  systemctl enable --now jarvis-hotspot.service >/dev/null 2>&1

  if systemctl is-active --quiet jarvis-hotspot.service; then
    ok "installed and running — it will start itself on boot"
    printf '\n    systemctl status jarvis-hotspot     see what it is doing\n'
    printf '    journalctl -u jarvis-hotspot -f     watch it\n\n'
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

watch_forever() {
  need_root
  stop_power_saving

  printf 'watching %s every %ss\n' "$CONNECTION" "$EVERY"

  local revivals=0
  while true; do
    if ! is_up; then
      revivals=$((revivals + 1))
      printf '%s  %s is down — bringing it back (%d)\n' "$(date '+%H:%M:%S')" "$CONNECTION" "$revivals"
      nmcli connection up "$CONNECTION" >/dev/null 2>&1
      # A card that just dropped is often not ready instantly; give it a moment before the
      # next check so one hiccup does not become a tight loop of failed activations.
      sleep 5
      stop_power_saving
    fi
    sleep "$EVERY"
  done
}

case "${1:-}" in
  --install)   bold "JARVIS-NET watchdog"; install_service ;;
  --uninstall) bold "JARVIS-NET watchdog"; uninstall_service ;;
  --help|-h)   sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
  *)           watch_forever ;;
esac
