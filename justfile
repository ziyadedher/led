# Default target architecture for the LED matrix Pis (Pi Zero W = armv6 hardfp).
# Pi 5 builds set arch=aarch64-unknown-linux-musl (use the `*-pi5`
# recipes, which do this for you).
arch := "arm-unknown-linux-gnueabihf"

# The RP1 PIO backend (`rpi5`) is 64-bit-only and only needed on the
# Pi 5 image, so it's enabled automatically when targeting aarch64 and
# left out of the armv6 Zero W build (where the crate wouldn't compile).
features := if arch =~ "aarch64" { "--features rpi5" } else { "" }

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
# Builds the two deployed binaries explicitly (not `--workspace`) so the
# armv6 build never pulls in the 64-bit-only `rp1-pio` crate.
build:
    cross build -p led-driver -p led-wifi-setup --target {{ arch }} --release {{ features }}

# Sanity: the workspace builds for the host arch (no cross involved).
check:
    cargo check --workspace

# Drop the cached OS image so the next `flash-sd` re-downloads.
refresh-image-cache:
    rm -f "${XDG_CACHE_HOME:-$HOME/.cache}/led/raspios-lite-{{ arch }}.img.xz"

# Flash an SD card with a fully-baked Pi OS Lite image. Hostname,
# init.env, journald conf, service enables, regdomain, and tailscale
# package are all set at flash time. Pi boots once → multi-user.target.
# Pass `color-order=BGR` (or RBG/GRB/GBR/BRG) for panels whose hardware
# wires the channels differently. See scripts/flash-sd.sh.
flash-sd id host device color-order="RGB": build
    COLOR_ORDER="{{ color-order }}" scripts/flash-sd.sh "{{ id }}" "{{ host }}" "{{ device }}"

# Re-init an already-deployed Pi over SSH (Tailscale or LAN). Pushes
# config + service unit + driver binary and restarts the service.
# Pass `color-order=BGR` to fix a swapped-channel panel without a full
# re-flash. Use `flash-sd` for fresh hardware. See scripts/init.sh.
init host id color-order="RGB" user="root": build
    COLOR_ORDER="{{ color-order }}" scripts/init.sh "{{ host }}" "{{ id }}" "{{ user }}"

# Push a fresh binary to a host and restart the service.
deploy host user="root": build
    scp target/{{ arch }}/release/led-driver "{{ user }}@{{ host }}:/usr/local/bin/led-driver.new"
    ssh "{{ user }}@{{ host }}" 'install -m 0755 /usr/local/bin/led-driver.new /usr/local/bin/led-driver \
        && systemctl restart led-driver.service \
        && rm /usr/local/bin/led-driver.new'

# Pi 5 convenience wrappers. They re-invoke the matching recipe with
# `arch=aarch64-unknown-linux-musl`, which (a) cross-builds the right
# target, (b) auto-enables the `rpi5` RP1 PIO backend via `features`,
# and (c) makes flash-sd.sh fetch the 64-bit Pi OS image. The aarch64
# build carries both backends; the driver picks RP1 vs BCM at runtime.

# Flash a fresh Pi 5 SD card (64-bit image + RP1 PIO backend).
flash-sd-pi5 id host device color-order="RGB":
    just arch=aarch64-unknown-linux-musl flash-sd "{{ id }}" "{{ host }}" "{{ device }}" "{{ color-order }}"

# Build + deploy to a running Pi 5.
deploy-pi5 host user="root":
    just arch=aarch64-unknown-linux-musl deploy "{{ host }}" "{{ user }}"

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
