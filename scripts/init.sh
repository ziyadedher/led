#!/bin/bash
# Re-init an already-deployed Pi over SSH (Tailscale or LAN). Pushes
# the latest config + service unit + binary and restarts the driver.
# Use `flash-sd` for fresh hardware.
#
# Usage: scripts/init.sh HOST PANEL_ID [USER]
set -euo pipefail

HOST="${1:?need hostname}"
PANEL_ID="${2:?need panel id}"
USER="${3:-root}"
ARCH="${ARCH:-arm-unknown-linux-gnueabihf}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$REPO_ROOT"

load_secrets
load_tofu_outputs

driver_bin="target/$ARCH/release/led-driver"
[ -x "$driver_bin" ] || { echo "ERROR: $driver_bin missing — run \`just build\` first" >&2; exit 1; }

rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT
render_config_toml "$PANEL_ID" "/var/log/led/" "$rendered"

ssh "$USER@$HOST" 'mkdir -p /usr/local/etc/led /var/log/led /etc/NetworkManager/dnsmasq-shared.d /etc/sysctl.d'
scp service/alsa-blacklist.conf  "$USER@$HOST:/etc/modprobe.d/led-alsa-blacklist.conf"
scp service/captive-dnsmasq.conf "$USER@$HOST:/etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf"
scp service/disable-ipv6.conf    "$USER@$HOST:/etc/sysctl.d/99-led-disable-ipv6.conf"
scp service/led-driver.service   "$USER@$HOST:/etc/systemd/system/led-driver.service"
scp "$rendered"                  "$USER@$HOST:/usr/local/etc/led/config.toml"
# scp can't overwrite the running ELF; ship as .new and atomic-rename
# under the running service, then restart so the new image takes
# effect. `install` preserves perms, hands the running process its
# old inode (still valid until restart), and exposes the new bytes
# under the canonical path for the next ExecStart.
scp "$driver_bin"                "$USER@$HOST:/usr/local/bin/led-driver.new"
ssh "$USER@$HOST" 'install -m 0755 /usr/local/bin/led-driver.new /usr/local/bin/led-driver \
    && rm /usr/local/bin/led-driver.new \
    && systemctl daemon-reload \
    && systemctl enable led-driver.service \
    && systemctl restart led-driver.service'
echo "==> initialized $HOST (id=$PANEL_ID); led-driver restarted with new binary"
echo "    if ALSA blacklist is new on this host, reboot before further deploys."
