#!/bin/bash
# Boot a Debian-amd64 rootfs in systemd-nspawn with mac80211_hwsim
# wlan0 in a private netns. Tests the systemd flow + service unit +
# wifi-setup AP-mode without touching real hardware.
#
# Usage: scripts/nspawn.sh HOST ID
set -euo pipefail

HOST="${1:?need hostname}"
PANEL_ID="${2:?need panel id}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$REPO_ROOT"

# Prereqs.
command -v systemd-nspawn >/dev/null \
    || { echo "ERROR: systemd-nspawn not in PATH (install systemd)" >&2; exit 1; }
command -v debootstrap >/dev/null \
    || { echo "ERROR: debootstrap not installed (Arch: pacman -S debootstrap)" >&2; exit 1; }
command -v iw >/dev/null \
    || { echo "ERROR: iw not in PATH (Arch: pacman -S iw)" >&2; exit 1; }
modinfo mac80211_hwsim >/dev/null 2>&1 \
    || { echo "ERROR: mac80211_hwsim kernel module not available" >&2; exit 1; }

load_secrets
load_tofu_outputs

# Native build for the host arch. Driver: terminal sink only (no rpi
# feature → no GPIO/HUB75). Wifi-setup: default features.
cargo build --release --no-default-features -p led-driver
cargo build --release -p led-wifi-setup

driver_bin="target/release/led-driver"
wifi_bin="target/release/led-wifi-setup"
[ -x "$driver_bin" ] || { echo "ERROR: $driver_bin missing after cargo build" >&2; exit 1; }
[ -x "$wifi_bin" ]   || { echo "ERROR: $wifi_bin missing after cargo build" >&2; exit 1; }

sudo -v

NSPAWN_DIR="dev/nspawn"
mkdir -p "$NSPAWN_DIR"
rootfs="$NSPAWN_DIR/$HOST-rootfs"
netns="led-$HOST"

if [ ! -f "$rootfs/etc/os-release" ]; then
    echo "==> debootstrapping Debian trixie minbase to $rootfs (one-time, ~250MB)"
    sudo mkdir -p "$rootfs"
    sudo debootstrap \
        --variant=minbase \
        --include=systemd,systemd-sysv,dbus,network-manager,wpasupplicant,iproute2,iputils-ping,ca-certificates,iw,procps,passwd \
        trixie "$rootfs" http://deb.debian.org/debian
fi

# Bake config + native binaries + service units. led-tailscale-init
# NOT enabled (would burn a real authkey on a fake host).
cfg_tmp=$(mktemp)
# OTel disabled in nspawn, so render with empty OTEL envs.
OTEL_ENDPOINT="" OTEL_AUTHORIZATION="" render_config_toml "$PANEL_ID" "/var/log/led/" "$cfg_tmp"
sudo install -D -m 0644 "$cfg_tmp"                       "$rootfs/usr/local/etc/led/config.toml"
sudo install -D -m 0755 "$driver_bin"                    "$rootfs/usr/local/bin/led-driver"
sudo install -D -m 0755 "$wifi_bin"                      "$rootfs/usr/local/bin/led-wifi-setup"
sudo install -D -m 0644 service/led-driver.service       "$rootfs/etc/systemd/system/led-driver.service"
sudo install -D -m 0644 service/led-wifi-setup.service   "$rootfs/etc/systemd/system/led-wifi-setup.service"
rm -f "$cfg_tmp"

# Debian's units mostly use ConditionVirtualization=!container so we
# don't need the raspbian unit-mask wall. Mask getty@tty1 since it
# spams the nspawn console.
sudo ln -sf /dev/null "$rootfs/etc/systemd/system/getty@tty1.service"

# /etc/led/init.env — wifi-setup consumes PANEL_ID + WIFI_COUNTRY via
# EnvironmentFile=. No TAILSCALE_AUTHKEY: tailscale-init isn't enabled.
sudo install -d -m 0755 "$rootfs/etc/led"
{
    printf 'HOSTNAME=%q\n' "$HOST"
    printf 'PANEL_ID=%q\n' "$PANEL_ID"
    printf 'WIFI_COUNTRY=%q\n' "$WIFI_COUNTRY"
} | sudo tee "$rootfs/etc/led/init.env" > /dev/null
sudo chmod 0600 "$rootfs/etc/led/init.env"

# Driver runs in --terminal mode (no GPIO inside container).
sudo sed -i 's|^ExecStart=.*|ExecStart=/usr/local/bin/led-driver --config /usr/local/etc/led/config.toml --terminal|' \
    "$rootfs/etc/systemd/system/led-driver.service"
# Strip realtime CPU/IO knobs (nspawn won't grant SCHED_FIFO).
sudo sed -i '/^CPUSchedulingPolicy/d; /^CPUSchedulingPriority/d; /^Nice/d; /^IOSchedulingClass/d; /^IOSchedulingPriority/d' \
    "$rootfs/etc/systemd/system/led-driver.service"

sudo install -d -m 0755 "$rootfs/etc/systemd/system/multi-user.target.wants"
sudo ln -sf /etc/systemd/system/led-driver.service     "$rootfs/etc/systemd/system/multi-user.target.wants/led-driver.service"
sudo ln -sf /etc/systemd/system/led-wifi-setup.service "$rootfs/etc/systemd/system/multi-user.target.wants/led-wifi-setup.service"

echo "$HOST" | sudo tee "$rootfs/etc/hostname" > /dev/null
# No password / authorized_keys — `machinectl shell $HOST` from the
# host gets us in without auth.

# === wlan0 emulation via mac80211_hwsim ===
# Create a private netns; move one hwsim phy into it so NM inside
# sees a real cfg80211 wlan0.
cleanup_wifi() {
    if ip netns list 2>/dev/null | awk '{print $1}' | grep -qx "$netns"; then
        for phy in $(sudo ip netns exec "$netns" iw dev 2>/dev/null | awk '/phy#/{gsub("#",""); print "phy"$2}'); do
            sudo ip netns exec "$netns" iw phy "$phy" set netns 1 2>/dev/null || true
        done
        sudo ip netns delete "$netns" 2>/dev/null || true
    fi
}
trap cleanup_wifi EXIT

# Clean up any leftover netns from a previous failed run.
sudo ip netns delete "$netns" 2>/dev/null || true

# Snapshot existing phys, modprobe hwsim with 2 radios, find the new
# ones. radios=2 leaves one available on the host for a future
# hostapd "home wifi" simulator (phase 2).
pre_phys=$(ls /sys/class/ieee80211 2>/dev/null | sort || true)
if ! lsmod | awk '{print $1}' | grep -qx mac80211_hwsim; then
    echo "==> loading mac80211_hwsim radios=2"
    sudo modprobe mac80211_hwsim radios=2
    sleep 1
fi
post_phys=$(ls /sys/class/ieee80211 2>/dev/null | sort)
new_phys=$(comm -13 <(printf '%s\n' "$pre_phys") <(printf '%s\n' "$post_phys") || true)
if [ -z "$new_phys" ]; then
    # Module was already loaded — pick any hwsim-driven phy in the
    # host netns.
    new_phys=$(for phy in /sys/class/ieee80211/*; do
        drv=$(readlink -f "$phy/device/driver" 2>/dev/null | xargs -r basename)
        [ "$drv" = "mac80211_hwsim" ] && basename "$phy"
    done)
fi
container_phy=$(printf '%s\n' "$new_phys" | head -n1)
[ -n "$container_phy" ] || { echo "ERROR: no hwsim phy available for container" >&2; exit 1; }
echo "==> assigning $container_phy as container's wlan0"

sudo ip netns add "$netns"
sudo ip netns exec "$netns" ip link set lo up
sudo iw phy "$container_phy" set netns name "$netns"

echo
echo "==> booting nspawn machine=$HOST (id=$PANEL_ID)"
echo "    Network: private netns with hwsim wlan0 ($container_phy)."
echo "             No host network → Supabase unreachable from inside."
echo "             Wifi-setup AP-mode is what we're validating;"
echo "             STA-mode + hostapd in phase 2."
echo "    Logs:    journalctl -u led-wifi-setup.service -f  (inside)"
echo "             journalctl -u led-driver.service -f  (inside)"
echo "    Quit:    poweroff (inside) or Ctrl-] x3 within 1s"
echo
sudo systemd-nspawn \
    --boot \
    --machine="$HOST" \
    --directory="$rootfs" \
    --network-namespace-path="/run/netns/$netns" \
    --resolv-conf=copy-host
