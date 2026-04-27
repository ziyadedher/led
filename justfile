set dotenv-load := true
set dotenv-required := false

# Default target architecture for the LED matrix Pis (Pi Zero W = armv6 hardfp).
# Override per-invocation: `just arch=aarch64-unknown-linux-musl build`.
arch := "arm-unknown-linux-gnueabihf"

# Local path of the cross-compiled binary for the current `arch`.
bin := "target" / arch / "release" / "led-driver"

default:
    @just --list

# Cross-compile the driver. Requires `cross` (https://github.com/cross-rs/cross) and a running Docker daemon.
build:
    cross build --package led-driver --target {{ arch }} --release

# Sanity: the workspace builds for the host arch (no cross involved).
check:
    cargo check --workspace

# First-time install on a fresh Pi: ALSA blacklist, systemd unit, rendered config, binary.
# Requires SUPABASE_URL, SUPABASE_ANON_KEY (and optional OTEL_ENDPOINT) in env or secrets.env.
init host id user="root": build
    #!/usr/bin/env bash
    set -euo pipefail
    : "${SUPABASE_URL:?set SUPABASE_URL in secrets.env or env}"
    : "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY in secrets.env or env}"
    rendered=$(mktemp)
    trap 'rm -f "$rendered"' EXIT
    sed \
        -e "s|@@ID@@|{{ id }}|g" \
        -e "s|@@SUPABASE_URL@@|${SUPABASE_URL}|g" \
        -e "s|@@SUPABASE_ANON_KEY@@|${SUPABASE_ANON_KEY}|g" \
        -e "s|@@OTEL_ENDPOINT@@|${OTEL_ENDPOINT:-}|g" \
        service/config.toml.tmpl > "$rendered"
    ssh "{{ user }}@{{ host }}" 'mkdir -p /usr/local/etc/led /var/log/led'
    scp service/alsa-blacklist.conf "{{ user }}@{{ host }}:/etc/modprobe.d/led-alsa-blacklist.conf"
    scp service/led-driver.service  "{{ user }}@{{ host }}:/etc/systemd/system/led-driver.service"
    scp "$rendered"                  "{{ user }}@{{ host }}:/usr/local/etc/led/config.toml"
    scp {{ bin }}                    "{{ user }}@{{ host }}:/usr/local/bin/led-driver"
    ssh "{{ user }}@{{ host }}" 'chmod 0755 /usr/local/bin/led-driver \
        && systemctl daemon-reload \
        && systemctl enable led-driver.service'
    echo "==> initialized {{ host }} (id={{ id }})"
    echo "    if ALSA blacklist is new on this host, reboot before 'just deploy'."

# Push a fresh binary to a host and restart the service.
deploy host user="root": build
    scp {{ bin }} "{{ user }}@{{ host }}:/usr/local/bin/led-driver.new"
    ssh "{{ user }}@{{ host }}" 'install -m 0755 /usr/local/bin/led-driver.new /usr/local/bin/led-driver \
        && systemctl restart led-driver.service \
        && rm /usr/local/bin/led-driver.new'

# Tail the driver service journal on a host.
logs host user="root":
    ssh "{{ user }}@{{ host }}" journalctl -u led-driver.service -f
