#!/usr/bin/env bash

set -eux
set -o pipefail

sudo systemctl stop led-driver || true

sudo mkdir -p /opt/led
sudo chown led /opt/led
sudo chmod 755 /opt/led

if [ ! -f /etc/modprobe.d/alsa-blacklist.conf ]; then
    echo "blacklist snd_bcm2835" | sudo tee /etc/modprobe.d/alsa-blacklist.conf
    echo "Reboot the Raspberry Pi for the changes to take effect"
    exit 1
fi