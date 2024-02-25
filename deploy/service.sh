#!/usr/bin/env bash

set -eux
set -o pipefail

sudo cp /opt/led/led-driver.service /etc/systemd/system/led-driver.service
sudo systemctl enable led-driver
sudo systemctl start led-driver