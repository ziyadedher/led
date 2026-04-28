#!/bin/bash
# Runs INSIDE a raspbian rootfs chroot (via qemu-user-static). Adds
# Tailscale's apt repo + installs the package + cleans the apt cache.
# Used by `just flash-sd` to bake tailscale at flash time so first
# boot doesn't need network/apt for the install.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

codename=$(awk -F= '$1=="VERSION_CODENAME"{print $2}' /etc/os-release)
: "${codename:?couldn't read VERSION_CODENAME from /etc/os-release}"

curl -fsSL "https://pkgs.tailscale.com/stable/raspbian/${codename}.noarmor.gpg" \
    > /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL "https://pkgs.tailscale.com/stable/raspbian/${codename}.tailscale-keyring.list" \
    > /etc/apt/sources.list.d/tailscale.list

apt-get update
apt-get install -y --no-install-recommends tailscale
apt-get clean
rm -rf /var/lib/apt/lists/*
