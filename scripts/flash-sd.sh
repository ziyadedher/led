#!/bin/bash
# Flash a Pi SD card with a fully-baked Pi OS Lite image. Everything
# (hostname, init.env, journald conf, service enables, regdomain,
# tailscale package) is set at flash time on the dev box — the Pi
# boots once and goes straight to multi-user.target.
#
# Usage: scripts/flash-sd.sh ID HOST DEVICE
#   ID     — panel name in Supabase (e.g. "alpha", "floater")
#   HOST   — hostname on the tailnet (e.g. "led-alpha")
#   DEVICE — block device of the SD card (e.g. /dev/sdb)
#
# Env (with defaults from the just dispatcher):
#   ARCH                — target arch for cross build
#                         (default arm-unknown-linux-gnueabihf, Pi Zero W)
#   WIFI_COUNTRY        — cfg80211 regdomain (default US)
#   OTEL_ENDPOINT       — OTel collector
#   OTEL_AUTHORIZATION  — OTel auth header (from secrets/fleet.sops.json)
set -euo pipefail

PANEL_ID="${1:?need panel id}"
HOST="${2:?need hostname}"
DEVICE="${3:?need device path}"

ARCH="${ARCH:-arm-unknown-linux-gnueabihf}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$REPO_ROOT"

load_secrets
load_tofu_outputs

: "${TAILSCALE_AUTHKEY:?need TAILSCALE_AUTHKEY in secrets/fleet.sops.json}"

QEMU_USER="$(qemu_user_static_for "$ARCH")"
[ -x "$QEMU_USER" ] \
    || { echo "ERROR: $QEMU_USER missing (Arch: pacman -S qemu-user-static qemu-user-static-binfmt)" >&2; exit 1; }

[ -b "$DEVICE" ] || { echo "ERROR: $DEVICE is not a block device" >&2; exit 1; }
if mount | awk '{print $1}' | grep -qE "^${DEVICE}p?[0-9]+\$|^${DEVICE}\$"; then
    echo "ERROR: $DEVICE or one of its partitions is mounted; unmount first." >&2
    exit 1
fi

sudo -v
size_bytes=$(sudo blockdev --getsize64 "$DEVICE")
size_gb=$((size_bytes / 1024 / 1024 / 1024))
if [ "$size_gb" -lt 2 ] || [ "$size_gb" -gt 256 ]; then
    echo "ERROR: $DEVICE is ${size_gb}GB; expected 2-256GB. Refusing." >&2
    exit 1
fi

echo
echo "About to OVERWRITE $DEVICE (${size_gb}GB)"
echo "  -> Pi OS Lite + led-driver baked in for host=$HOST id=$PANEL_ID"
read -r -p "Type the device path '$DEVICE' to confirm: " confirmation
[ "$confirmation" = "$DEVICE" ] || { echo "Aborted." >&2; exit 1; }

cached_image="$(download_image "$ARCH")"

echo "==> writing image to $DEVICE (this can take several minutes)"
xzcat "$cached_image" | sudo dd of="$DEVICE" bs=4M conv=fsync status=progress
sudo sync
sudo partprobe "$DEVICE"
sleep 2

if [[ "$DEVICE" =~ (mmcblk|nvme|loop)[0-9]+$ ]]; then
    boot_part="${DEVICE}p1"
    root_part="${DEVICE}p2"
else
    boot_part="${DEVICE}1"
    root_part="${DEVICE}2"
fi
[ -b "$boot_part" ] || { echo "ERROR: boot partition $boot_part not found after partprobe" >&2; exit 1; }
[ -b "$root_part" ] || { echo "ERROR: root partition $root_part not found after partprobe" >&2; exit 1; }

boot_mnt=$(mktemp -d)
root_mnt=$(mktemp -d)
cleanup() {
    sudo umount "$boot_mnt" 2>/dev/null || true
    sudo umount "$root_mnt" 2>/dev/null || true
    rmdir "$boot_mnt" "$root_mnt" 2>/dev/null || true
}
trap cleanup EXIT
sudo mount "$boot_part" "$boot_mnt"
sudo mount "$root_part" "$root_mnt"

# cmdline.txt: append cfg80211 regdomain (equivalent of running
# `raspi-config nonint do_wifi_country` on the Pi, but baked at
# flash time so we don't need a first-boot script).
cmdline=$(sudo tr -d '\n' < "$boot_mnt/cmdline.txt")
echo "$cmdline cfg80211.ieee80211_regdom=$WIFI_COUNTRY" \
    | sudo tee "$boot_mnt/cmdline.txt" > /dev/null

# /etc/led/init.env — runtime env file for led-wifi-setup and
# led-tailscale-init via EnvironmentFile=.
env_tmp=$(mktemp)
chmod 600 "$env_tmp"
{
    printf 'HOSTNAME=%q\n' "$HOST"
    printf 'PANEL_ID=%q\n'  "$PANEL_ID"
    printf 'WIFI_COUNTRY=%q\n' "$WIFI_COUNTRY"
    printf 'TAILSCALE_AUTHKEY=%q\n' "$TAILSCALE_AUTHKEY"
} > "$env_tmp"
sudo install -D -m 0600 "$env_tmp" "$root_mnt/etc/led/init.env"
rm -f "$env_tmp"

# Hostname.
echo "$HOST" | sudo tee "$root_mnt/etc/hostname" > /dev/null
sudo sed -i "s/^127\\.0\\.1\\.1.*/127.0.1.1\\t$HOST/" "$root_mnt/etc/hosts" || true

# Persistent journald with 1-second sync (captures logs across power
# yanks). Empty /var/log/journal triggers persistent mode.
sudo install -D -m 0644 service/journald-persistent.conf \
    "$root_mnt/etc/systemd/journald.conf.d/persistent.conf"
sudo install -d -m 2755 "$root_mnt/var/log/journal"

# Clear soft-blocked rfkill state shipped in the Pi OS Lite image
# (systemd-rfkill would otherwise restore wlan0 as soft-blocked).
sudo rm -f "$root_mnt"/var/lib/systemd/rfkill/*:wlan

# Drop NM state with WirelessEnabled=false (NM reads this independently
# of rfkill). Regenerated on first boot with wireless enabled.
sudo rm -f "$root_mnt/var/lib/NetworkManager/NetworkManager.state"

# Render config.toml + bake binaries / units / NM + sysctl drop-ins.
cfg_tmp=$(mktemp)
render_config_toml "$PANEL_ID" "/var/log/led/" "$cfg_tmp"
sudo install -D -m 0644 "$cfg_tmp"                                   "$root_mnt/usr/local/etc/led/config.toml"
sudo install -D -m 0755 "target/$ARCH/release/led-driver"             "$root_mnt/usr/local/bin/led-driver"
sudo install -D -m 0755 "target/$ARCH/release/led-wifi-setup"         "$root_mnt/usr/local/bin/led-wifi-setup"
sudo install -D -m 0755 service/led-tailscale-init                    "$root_mnt/usr/local/bin/led-tailscale-init"
sudo install -D -m 0644 service/led-driver.service                    "$root_mnt/etc/systemd/system/led-driver.service"
sudo install -D -m 0644 service/led-wifi-setup.service                "$root_mnt/etc/systemd/system/led-wifi-setup.service"
sudo install -D -m 0644 service/led-tailscale-init.service            "$root_mnt/etc/systemd/system/led-tailscale-init.service"
sudo install -D -m 0644 service/alsa-blacklist.conf                   "$root_mnt/etc/modprobe.d/led-alsa-blacklist.conf"
sudo install -D -m 0644 service/captive-dnsmasq.conf                  "$root_mnt/etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf"
sudo install -D -m 0644 service/disable-ipv6.conf                     "$root_mnt/etc/sysctl.d/99-led-disable-ipv6.conf"
rm -f "$cfg_tmp"

# Mask raspbian's first-boot user setup. We don't write
# userconf.txt and don't want a `pi` user; without this mask,
# userconfig.service half-creates pi with /usr/sbin/nologin.
sudo ln -sf /dev/null "$root_mnt/etc/systemd/system/userconfig.service"

# Pre-install tailscale into the rootfs so first boot skips apt.
# Chroot via qemu-user-static; the host's clock is correct so
# signature validation passes.
echo "==> pre-installing tailscale into the rootfs (~30s via qemu-user)"
sudo install -m 0755 "$QEMU_USER" "$root_mnt$QEMU_USER"
sudo mount --bind /proc "$root_mnt/proc"
sudo mount --bind /sys  "$root_mnt/sys"
sudo mount --bind /dev  "$root_mnt/dev"

# raspbian's /etc/resolv.conf is typically a symlink to
# /run/systemd/resolve/stub-resolv.conf; cp-through would clobber the
# host's. Save the link target, swap in a real file, restore on cleanup.
resolv_link=$(sudo readlink "$root_mnt/etc/resolv.conf" 2>/dev/null || true)
sudo rm -f "$root_mnt/etc/resolv.conf"
sudo install -m 0644 /etc/resolv.conf "$root_mnt/etc/resolv.conf"

chroot_cleanup() {
    sudo umount "$root_mnt/dev"  2>/dev/null || true
    sudo umount "$root_mnt/sys"  2>/dev/null || true
    sudo umount "$root_mnt/proc" 2>/dev/null || true
    sudo rm -f  "$root_mnt$QEMU_USER"
    sudo rm -f  "$root_mnt/etc/resolv.conf"
    if [ -n "$resolv_link" ]; then
        sudo ln -sf "$resolv_link" "$root_mnt/etc/resolv.conf"
    fi
}
chroot_full_cleanup() { chroot_cleanup; cleanup; }
trap chroot_full_cleanup EXIT

sudo install -m 0755 scripts/install-tailscale-chroot.sh "$root_mnt/install-tailscale-chroot.sh"
sudo chroot "$root_mnt" /install-tailscale-chroot.sh
sudo rm -f "$root_mnt/install-tailscale-chroot.sh"

chroot_cleanup
trap cleanup EXIT

# Enable our services + systemd-time-wait-sync. Symlink targets
# follow where each unit's source lives: ours under /etc/systemd/system,
# systemd-shipped under /lib/systemd/system.
sudo install -d -m 0755 "$root_mnt/etc/systemd/system/multi-user.target.wants"
for unit in led-driver.service led-wifi-setup.service led-tailscale-init.service; do
    sudo ln -sf "/etc/systemd/system/$unit" \
        "$root_mnt/etc/systemd/system/multi-user.target.wants/$unit"
done
sudo ln -sf /lib/systemd/system/systemd-time-wait-sync.service \
    "$root_mnt/etc/systemd/system/multi-user.target.wants/systemd-time-wait-sync.service"

sudo sync
cleanup
trap - EXIT

echo
echo "==> $DEVICE ready. Insert into the Pi for $HOST ($PANEL_ID) and power it on."
echo "    On first boot: led-wifi-setup brings up the captive-portal AP"
echo "    (SSID 'led-setup-$PANEL_ID'), pick your home wifi from a phone,"
echo "    led-tailscale-init joins the tailnet, you SSH in:"
echo "        tailscale ssh root@$HOST"
