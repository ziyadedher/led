#!/bin/bash
# Runs once on first boot, invoked via `systemd.run=` in cmdline.txt.
#
# Reads per-host config from /boot/firmware/firstrun.env (which is deleted
# after this script runs). On success the script removes itself, strips its
# `systemd.run=` hooks from cmdline.txt, and reboots into a normal multi-user
# boot with WiFi + Tailscale up and led-driver enabled.
set -eo pipefail
exec >> /boot/firmware/firstrun.log 2>&1
echo "[firstrun] starting at $(date -u)"

if [ ! -f /boot/firmware/firstrun.env ]; then
    echo "[firstrun] no firstrun.env, nothing to do"
    exit 0
fi

# shellcheck disable=SC1091
source /boot/firmware/firstrun.env

: "${HOSTNAME:?HOSTNAME unset in firstrun.env}"
: "${WIFI_SSID:?WIFI_SSID unset}"
: "${WIFI_PSK:?WIFI_PSK unset}"
: "${WIFI_COUNTRY:?WIFI_COUNTRY unset}"
: "${TAILSCALE_AUTHKEY:?TAILSCALE_AUTHKEY unset}"
: "${AUTHORIZED_KEYS:?AUTHORIZED_KEYS unset}"

echo "[firstrun] hostname"
hostnamectl set-hostname "$HOSTNAME"
echo "$HOSTNAME" > /etc/hostname
sed -i "s/^127\.0\.1\.1.*/127.0.1.1\t$HOSTNAME/" /etc/hosts || true

echo "[firstrun] user + ssh key"
FIRSTUSER=$(getent passwd 1000 | cut -d: -f1)
FIRSTUSERHOME=$(getent passwd 1000 | cut -d: -f6)
install -o "$FIRSTUSER" -g "$FIRSTUSER" -m 700 -d "$FIRSTUSERHOME/.ssh"
printf '%s\n' "$AUTHORIZED_KEYS" > "$FIRSTUSERHOME/.ssh/authorized_keys"
chown "$FIRSTUSER:$FIRSTUSER" "$FIRSTUSERHOME/.ssh/authorized_keys"
chmod 600 "$FIRSTUSERHOME/.ssh/authorized_keys"

echo "[firstrun] wifi country=$WIFI_COUNTRY"
raspi-config nonint do_wifi_country "$WIFI_COUNTRY" 2>/dev/null || true

echo "[firstrun] wifi connection (NetworkManager)"
nmcli connection add type wifi ifname wlan0 con-name led-wifi \
    ssid "$WIFI_SSID" \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "$WIFI_PSK" \
    connection.autoconnect yes
nmcli connection up led-wifi || true

echo "[firstrun] waiting for internet"
for i in $(seq 1 90); do
    if curl -fsS -o /dev/null -m 2 https://1.1.1.1 2>/dev/null; then
        echo "[firstrun] online after ${i}s"
        break
    fi
    sleep 1
done

echo "[firstrun] tailscale install + join"
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --auth-key="$TAILSCALE_AUTHKEY" --hostname="$HOSTNAME" --ssh

echo "[firstrun] disabling system sshd in favour of tailscale ssh"
systemctl disable --now ssh 2>/dev/null || true

echo "[firstrun] enabling led-driver"
systemctl daemon-reload
systemctl enable led-driver.service

echo "[firstrun] cleanup"
shred -u /boot/firmware/firstrun.env 2>/dev/null || rm -f /boot/firmware/firstrun.env
rm -f /boot/firmware/firstrun.sh
sed -i 's| systemd.run=[^ ]*||g; s| systemd.run_success_action=[^ ]*||g; s| systemd.unit=[^ ]*||g' /boot/firmware/cmdline.txt
sync

echo "[firstrun] done at $(date -u); rebooting"
sleep 2
reboot
