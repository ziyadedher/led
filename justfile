# Default target architecture for the LED matrix Pis (Pi Zero W = armv6 hardfp).
# Override per-invocation: `just arch=aarch64-unknown-linux-musl build`.
arch := "arm-unknown-linux-gnueabihf"

# Non-sensitive runtime config. Exported so scripts inherit them
# without re-declaring; sensitive values live in secrets/*.sops.json
# and are pulled by scripts/lib.sh::load_secrets.
export OTEL_ENDPOINT := env_var_or_default("OTEL_ENDPOINT", "https://otel.ziyadedher.com")
export WIFI_COUNTRY := env_var_or_default("WIFI_COUNTRY", "US")
# Surface `arch` to scripts that need to vary by target arch (flash-sd
# picks the right qemu-user-static, the right cross-build target, etc.).
export ARCH := arch

default:
    @just --list

# Cross-compile the driver and the WiFi onboarding binary. Requires `cross`
# (https://github.com/cross-rs/cross) and a running Docker daemon.
build:
    cross build --workspace --target {{ arch }} --release

# Sanity: the workspace builds for the host arch (no cross involved).
check:
    cargo check --workspace

# Drop the cached OS image so the next `flash-sd` re-downloads.
refresh-image-cache:
    rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/led/raspios-lite-{{ arch }}.img.xz"

# Flash an SD card with a fully-baked Pi OS Lite image. Hostname,
# init.env, journald conf, service enables, regdomain, and tailscale
# package are all set at flash time. Pi boots once → multi-user.target.
# See scripts/flash-sd.sh for details.
flash-sd id host device: build
    scripts/flash-sd.sh "{{ id }}" "{{ host }}" "{{ device }}"

# Re-init an already-deployed Pi over SSH (Tailscale or LAN). Pushes
# config + service unit + driver binary and restarts the service.
# Use `flash-sd` for fresh hardware. See scripts/init.sh.
init host id user="root": build
    scripts/init.sh "{{ host }}" "{{ id }}" "{{ user }}"

# Push a fresh binary to a host and restart the service.
deploy host user="root": build
    scp target/{{ arch }}/release/led-driver "{{ user }}@{{ host }}:/usr/local/bin/led-driver.new"
    ssh "{{ user }}@{{ host }}" 'install -m 0755 /usr/local/bin/led-driver.new /usr/local/bin/led-driver \
        && systemctl restart led-driver.service \
        && rm /usr/local/bin/led-driver.new'

# Tail the driver service journal on a host.
logs host user="root":
    ssh "{{ user }}@{{ host }}" journalctl -u led-driver.service -f

# Boot a Debian-amd64 rootfs in systemd-nspawn with a hwsim wlan0
# in a private netns. Tests systemd flow + service unit + wifi-setup
# AP-mode without real hardware. See scripts/nspawn.sh.
#
# Requires: systemd-nspawn, debootstrap (Arch: pacman -S debootstrap),
# iw (Arch: pacman -S iw), mac80211_hwsim kernel module.
nspawn host id:
    scripts/nspawn.sh "{{ host }}" "{{ id }}"

# Run the driver natively against the real Supabase as the `dev`
# panel. Renders to terminal via ANSI half-blocks. OTel disabled,
# logs at dev/log/. See scripts/dev.sh.
dev:
    scripts/dev.sh

# Thin wrapper for `tofu -chdir=terraform <args>` that decrypts
# TF_STATE_PASSPHRASE from sops and injects it as TF_VAR_tf_state_passphrase
# (the var the encryption block reads). Use for everything: `just tf init`,
# `just tf plan`, `just tf apply`, `just tf output -raw supabase_url`, …
tf *args:
    #!/usr/bin/env bash
    set -euo pipefail
    export TF_VAR_tf_state_passphrase=$(sops --decrypt secrets/admin.sops.json | jq -r '.TF_STATE_PASSPHRASE')
    tofu -chdir=terraform {{ args }}
