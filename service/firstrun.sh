#!/bin/bash
# Runs once on first boot, invoked via `systemd.run=` in cmdline.txt.
#
# Reads per-host config from /boot/firmware/firstrun.env, writes the runtime
# subset to /etc/led/init.env (deleted from /boot/firmware once translated),
# applies hostname + SSH key, and enables the services that handle WiFi
# onboarding, Tailscale join, and the driver itself. After exit, systemd
# reboots into normal multi-user mode where the services pick things up.
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
: "${WIFI_COUNTRY:?WIFI_COUNTRY unset}"
: "${TAILSCALE_AUTHKEY:?TAILSCALE_AUTHKEY unset}"
: "${AUTHORIZED_KEYS:?AUTHORIZED_KEYS unset}"
: "${PANEL_ID:?PANEL_ID unset}"

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

echo "[firstrun] enabling persistent journal with aggressive sync"
mkdir -p /var/log/journal
chmod 2755 /var/log/journal
# Force persistent storage and sync every second so we capture logs even
# when the Pi is power-cycled without a clean shutdown (which is most of
# our debug loop). Default `SyncIntervalSec=5min` means a quick yank after
# boot loses everything — that just bit us once.
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/persistent.conf <<'JOURNALD'
[Journal]
Storage=persistent
SyncIntervalSec=1s
ForwardToConsole=yes
TTYPath=/dev/tty1
JOURNALD

echo "[firstrun] runtime env -> /etc/led/init.env"
mkdir -p /etc/led
{
    printf 'HOSTNAME=%q\n' "$HOSTNAME"
    printf 'PANEL_ID=%q\n' "$PANEL_ID"
    printf 'WIFI_COUNTRY=%q\n' "$WIFI_COUNTRY"
    printf 'TAILSCALE_AUTHKEY=%q\n' "$TAILSCALE_AUTHKEY"
} > /etc/led/init.env
chmod 600 /etc/led/init.env

echo "[firstrun] WiFi country (regdomain)"
raspi-config nonint do_wifi_country "$WIFI_COUNTRY" 2>/dev/null || true

echo "[firstrun] enabling boot services"
systemctl daemon-reload
systemctl enable led-wifi-setup.service
systemctl enable led-tailscale-init.service
systemctl enable led-driver.service

echo "[firstrun] cleanup"
shred -u /boot/firmware/firstrun.env 2>/dev/null || rm -f /boot/firmware/firstrun.env
rm -f /boot/firmware/firstrun.sh
sed -i 's| systemd.run=[^ ]*||g; s| systemd.run_success_action=[^ ]*||g; s| systemd.unit=[^ ]*||g' /boot/firmware/cmdline.txt
sync

echo "[firstrun] done at $(date -u); rebooting"
sleep 2
reboot
