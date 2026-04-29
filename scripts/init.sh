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
wifi_bin="target/$ARCH/release/led-wifi-setup"
[ -x "$driver_bin" ] || { echo "ERROR: $driver_bin missing — run \`just build\` first" >&2; exit 1; }
[ -x "$wifi_bin" ]   || { echo "ERROR: $wifi_bin missing — run \`just build\` first" >&2; exit 1; }

rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT
render_config_toml "$PANEL_ID" "/var/log/led/" "$rendered"

ssh "$USER@$HOST" 'mkdir -p /usr/local/etc/led /var/log/led /etc/NetworkManager/dnsmasq-shared.d /etc/sysctl.d'

# Static drop-ins. These can be updated freely — the affected
# services either consume them on next start or aren't running here
# (modprobe, sysctl).
scp service/alsa-blacklist.conf  "$USER@$HOST:/etc/modprobe.d/led-alsa-blacklist.conf"
scp service/captive-dnsmasq.conf "$USER@$HOST:/etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf"
scp service/disable-ipv6.conf    "$USER@$HOST:/etc/sysctl.d/99-led-disable-ipv6.conf"
scp "$rendered"                  "$USER@$HOST:/usr/local/etc/led/config.toml"

# Service units. Listed together so a unit-only fix (changed
# directives, no binary churn) lands without re-shipping binaries.
scp service/led-driver.service          "$USER@$HOST:/etc/systemd/system/led-driver.service"
scp service/led-wifi-setup.service      "$USER@$HOST:/etc/systemd/system/led-wifi-setup.service"
scp service/led-tailscale-init.service  "$USER@$HOST:/etc/systemd/system/led-tailscale-init.service"
scp service/led-tailscale-init          "$USER@$HOST:/usr/local/bin/led-tailscale-init"

# Binaries. scp can't overwrite the running ELF, so we ship as `.new`
# and atomic-rename. `install` preserves perms and hands the running
# process its old inode (still valid until restart) while exposing
# the new bytes under the canonical path for the next ExecStart.
# led-driver is restarted to pick up the new binary immediately.
# led-wifi-setup is also restarted: a healthy panel takes ~2s to
# reconfirm wifi is up and exit (the new flow polls
# has_active_wifi() on every run), so restart is a near-no-op rather
# than the disruption it would have been under the old marker-file
# behaviour.
scp "$driver_bin"  "$USER@$HOST:/usr/local/bin/led-driver.new"
scp "$wifi_bin"    "$USER@$HOST:/usr/local/bin/led-wifi-setup.new"
ssh "$USER@$HOST" 'install -m 0755 /usr/local/bin/led-driver.new     /usr/local/bin/led-driver \
    && install -m 0755 /usr/local/bin/led-wifi-setup.new /usr/local/bin/led-wifi-setup \
    && install -m 0755 /usr/local/bin/led-tailscale-init /usr/local/bin/led-tailscale-init \
    && rm /usr/local/bin/led-driver.new /usr/local/bin/led-wifi-setup.new \
    && systemctl daemon-reload \
    && systemctl enable led-driver.service led-wifi-setup.service led-tailscale-init.service \
    && systemctl restart led-driver.service led-wifi-setup.service'
echo "==> initialized $HOST (id=$PANEL_ID); led-driver + led-wifi-setup restarted with new binaries."
echo "    led-tailscale-init takes effect on the next boot (no in-place restart needed)."
echo "    if ALSA blacklist is new on this host, reboot before further deploys."
