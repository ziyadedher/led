# Default target architecture for the LED matrix Pis (Pi Zero W = armv6 hardfp).
# Override per-invocation: `just arch=aarch64-unknown-linux-musl build`.
arch := "arm-unknown-linux-gnueabihf"

# Non-sensitive runtime configuration. Exported so recipe shells inherit them.
# `secrets.sops.json` only holds genuinely-secret values. Override per-invocation
# (`just OTEL_ENDPOINT=… flash-sd …`) or via secrets.env if you need.
export OTEL_ENDPOINT := env_var_or_default("OTEL_ENDPOINT", "https://otel.ziyadedher.com")
export WIFI_COUNTRY := env_var_or_default("WIFI_COUNTRY", "US")
export SSH_AUTHORIZED_KEYS_FILE := env_var_or_default("SSH_AUTHORIZED_KEYS_FILE", env_var("HOME") + "/.ssh/id_ed25519.pub")

# Local paths of the cross-compiled binaries for the current `arch`.
driver_bin := "target" / arch / "release" / "led-driver"
wifi_bin := "target" / arch / "release" / "led-wifi-setup"

# Cache for downloaded Pi OS images.
cache_dir := env_var_or_default("XDG_CACHE_HOME", env_var("HOME") + "/.cache") + "/led"

# Pi OS Lite image source matching the build target. _latest is a stable
# redirect to the current Bookworm release.
image_url := if arch == "arm-unknown-linux-gnueabihf" {
    "https://downloads.raspberrypi.org/raspios_lite_armhf_latest"
} else if arch == "aarch64-unknown-linux-musl" {
    "https://downloads.raspberrypi.org/raspios_lite_arm64_latest"
} else if arch == "aarch64-unknown-linux-gnu" {
    "https://downloads.raspberrypi.org/raspios_lite_arm64_latest"
} else {
    "ERROR_UNKNOWN_ARCH"
}

default:
    @just --list

# Cross-compile the driver and the WiFi onboarding binary. Requires `cross`
# (https://github.com/cross-rs/cross) and a running Docker daemon.
build:
    cross build --workspace --target {{ arch }} --release

# Sanity: the workspace builds for the host arch (no cross involved).
check:
    cargo check --workspace

# Download (and cache) the Pi OS Lite image matching `arch`. Prints the cached path on stdout.
_download-image:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "{{ image_url }}" = "ERROR_UNKNOWN_ARCH" ]; then
        echo "ERROR: no Pi OS image URL mapped for arch={{ arch }}" >&2
        exit 1
    fi
    mkdir -p "{{ cache_dir }}"
    cached="{{ cache_dir }}/raspios-lite-{{ arch }}.img.xz"
    if [ ! -f "$cached" ]; then
        echo "==> downloading Pi OS Lite for {{ arch }}" >&2
        curl --fail --location --progress-bar -o "$cached.tmp" "{{ image_url }}"
        mv "$cached.tmp" "$cached"
    fi
    printf '%s\n' "$cached"

# Drop the cached OS image so the next `flash-sd` re-downloads.
refresh-image-cache:
    rm -f "{{ cache_dir }}/raspios-lite-{{ arch }}.img.xz"

# Flash an SD card with a fully provisioned image: Pi OS Lite + driver baked in,
# first-boot script for hostname/WiFi/Tailscale.
#
# Pulls Supabase URL + anon key from `tofu output` (so the source of truth
# is the TF state) and the rest from `secrets.sops.json` via SOPS. Run
# `tofu -chdir=terraform apply` first if you haven't.
flash-sd id host device: build
    #!/usr/bin/env bash
    set -euo pipefail
    set -a
    eval "$(sops --decrypt secrets.sops.json | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    TF_VAR_tf_state_passphrase="$TF_STATE_PASSPHRASE"
    SUPABASE_URL=$(tofu -chdir=terraform output -raw supabase_url)
    SUPABASE_ANON_KEY=$(tofu -chdir=terraform output -raw anon_key)
    PROJECT_REF=$(tofu -chdir=terraform output -raw project_ref)
    DB_PASSWORD=$(tofu -chdir=terraform output -raw db_password)
    DATABASE_URL="postgresql://postgres:${DB_PASSWORD}@db.${PROJECT_REF}.supabase.co:5432/postgres"
    [ -f secrets.env ] && source secrets.env
    set +a
    : "${SUPABASE_URL:?tofu output supabase_url is empty — run \`tofu -chdir=terraform apply\` first}"
    : "${SUPABASE_ANON_KEY:?tofu output anon_key is empty — run \`tofu -chdir=terraform apply\` first}"
    : "${TAILSCALE_AUTHKEY:?need TAILSCALE_AUTHKEY in secrets.sops.json}"
    [ -f "$SSH_AUTHORIZED_KEYS_FILE" ] || { echo "ERROR: $SSH_AUTHORIZED_KEYS_FILE missing" >&2; exit 1; }

    dev="{{ device }}"
    [ -b "$dev" ] || { echo "ERROR: $dev is not a block device" >&2; exit 1; }
    if mount | awk '{print $1}' | grep -qE "^${dev}p?[0-9]+$|^${dev}$"; then
        echo "ERROR: $dev or one of its partitions is mounted; unmount first." >&2
        exit 1
    fi

    sudo -v
    size_bytes=$(sudo blockdev --getsize64 "$dev")
    size_gb=$((size_bytes / 1024 / 1024 / 1024))
    if [ "$size_gb" -lt 2 ] || [ "$size_gb" -gt 256 ]; then
        echo "ERROR: $dev is ${size_gb}GB; expected 2-256GB. Refusing." >&2
        exit 1
    fi

    echo
    echo "About to OVERWRITE $dev (${size_gb}GB)"
    echo "  -> Pi OS Lite + led-driver baked in for host={{ host }} id={{ id }}"
    read -r -p "Type the device path '$dev' to confirm: " confirmation
    [ "$confirmation" = "$dev" ] || { echo "Aborted." >&2; exit 1; }

    cached_image=$(just arch={{ arch }} _download-image)

    echo "==> writing image to $dev (this can take several minutes)"
    xzcat "$cached_image" | sudo dd of="$dev" bs=4M conv=fsync status=progress
    sudo sync
    sudo partprobe "$dev"
    sleep 2

    if [[ "$dev" =~ (mmcblk|nvme|loop)[0-9]+$ ]]; then
        boot_part="${dev}p1"
        root_part="${dev}p2"
    else
        boot_part="${dev}1"
        root_part="${dev}2"
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

    # Per-host first-boot env (secrets land here; firstrun.sh translates into
    # /etc/led/init.env on the rootfs and deletes the boot copy).
    env_tmp=$(mktemp)
    chmod 600 "$env_tmp"
    {
        printf 'HOSTNAME=%q\n' "{{ host }}"
        printf 'PANEL_ID=%q\n' "{{ id }}"
        printf 'WIFI_COUNTRY=%q\n' "$WIFI_COUNTRY"
        printf 'TAILSCALE_AUTHKEY=%q\n' "$TAILSCALE_AUTHKEY"
        printf 'AUTHORIZED_KEYS=%q\n' "$(cat "$SSH_AUTHORIZED_KEYS_FILE")"
    } > "$env_tmp"
    sudo install -m 0600 "$env_tmp" "$boot_mnt/firstrun.env"
    rm -f "$env_tmp"

    sudo install -m 0755 service/firstrun.sh "$boot_mnt/firstrun.sh"

    cmdline=$(sudo tr -d '\n' < "$boot_mnt/cmdline.txt")
    new_cmdline="$cmdline systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target"
    echo "$new_cmdline" | sudo tee "$boot_mnt/cmdline.txt" > /dev/null

    # Bake driver + WiFi-onboarding runtime artefacts into the rootfs.
    cfg_tmp=$(mktemp)
    sed \
        -e "s|@@ID@@|{{ id }}|g" \
        -e "s|@@SUPABASE_URL@@|${SUPABASE_URL}|g" \
        -e "s|@@SUPABASE_ANON_KEY@@|${SUPABASE_ANON_KEY}|g" \
        -e "s|@@DATABASE_URL@@|${DATABASE_URL}|g" \
        -e "s|@@OTEL_ENDPOINT@@|${OTEL_ENDPOINT:-}|g" \
        -e "s|@@OTEL_AUTHORIZATION@@|${OTEL_AUTHORIZATION:-}|g" \
        service/config.toml.tmpl > "$cfg_tmp"
    sudo install -D -m 0644 "$cfg_tmp"                              "$root_mnt/usr/local/etc/led/config.toml"
    sudo install -D -m 0755 "{{ driver_bin }}"                      "$root_mnt/usr/local/bin/led-driver"
    sudo install -D -m 0755 "{{ wifi_bin }}"                        "$root_mnt/usr/local/bin/led-wifi-setup"
    sudo install -D -m 0755 service/led-tailscale-init              "$root_mnt/usr/local/bin/led-tailscale-init"
    sudo install -D -m 0644 service/led-driver.service              "$root_mnt/etc/systemd/system/led-driver.service"
    sudo install -D -m 0644 service/led-wifi-setup.service          "$root_mnt/etc/systemd/system/led-wifi-setup.service"
    sudo install -D -m 0644 service/led-tailscale-init.service      "$root_mnt/etc/systemd/system/led-tailscale-init.service"
    sudo install -D -m 0644 service/alsa-blacklist.conf             "$root_mnt/etc/modprobe.d/led-alsa-blacklist.conf"
    rm -f "$cfg_tmp"

    sudo sync
    cleanup
    trap - EXIT

    echo
    echo "==> $dev ready. Insert into the Pi for {{ host }} ({{ id }}) and power it on."
    echo "    First boot configures WiFi, Tailscale and the driver, then reboots."
    echo "    Watch for it on tailnet: tailscale status | grep {{ host }}"

# Re-init an existing Pi that's already on the tailnet (e.g. one provisioned
# before flash-sd existed). Pushes config + service unit + ALSA blacklist +
# binary. Use `flash-sd` for fresh hardware.
init host id user="root": build
    #!/usr/bin/env bash
    set -euo pipefail
    set -a
    eval "$(sops --decrypt secrets.sops.json | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    TF_VAR_tf_state_passphrase="$TF_STATE_PASSPHRASE"
    SUPABASE_URL=$(tofu -chdir=terraform output -raw supabase_url)
    SUPABASE_ANON_KEY=$(tofu -chdir=terraform output -raw anon_key)
    PROJECT_REF=$(tofu -chdir=terraform output -raw project_ref)
    DB_PASSWORD=$(tofu -chdir=terraform output -raw db_password)
    DATABASE_URL="postgresql://postgres:${DB_PASSWORD}@db.${PROJECT_REF}.supabase.co:5432/postgres"
    [ -f secrets.env ] && source secrets.env
    set +a
    rendered=$(mktemp)
    trap 'rm -f "$rendered"' EXIT
    sed \
        -e "s|@@ID@@|{{ id }}|g" \
        -e "s|@@SUPABASE_URL@@|${SUPABASE_URL}|g" \
        -e "s|@@SUPABASE_ANON_KEY@@|${SUPABASE_ANON_KEY}|g" \
        -e "s|@@DATABASE_URL@@|${DATABASE_URL}|g" \
        -e "s|@@OTEL_ENDPOINT@@|${OTEL_ENDPOINT:-}|g" \
        -e "s|@@OTEL_AUTHORIZATION@@|${OTEL_AUTHORIZATION:-}|g" \
        service/config.toml.tmpl > "$rendered"
    ssh "{{ user }}@{{ host }}" 'mkdir -p /usr/local/etc/led /var/log/led'
    scp service/alsa-blacklist.conf "{{ user }}@{{ host }}:/etc/modprobe.d/led-alsa-blacklist.conf"
    scp service/led-driver.service  "{{ user }}@{{ host }}:/etc/systemd/system/led-driver.service"
    scp "$rendered"                  "{{ user }}@{{ host }}:/usr/local/etc/led/config.toml"
    scp {{ driver_bin }}             "{{ user }}@{{ host }}:/usr/local/bin/led-driver"
    ssh "{{ user }}@{{ host }}" 'chmod 0755 /usr/local/bin/led-driver \
        && systemctl daemon-reload \
        && systemctl enable led-driver.service'
    echo "==> initialized {{ host }} (id={{ id }})"
    echo "    if ALSA blacklist is new on this host, reboot before 'just deploy'."

# Push a fresh binary to a host and restart the service.
deploy host user="root": build
    scp {{ driver_bin }} "{{ user }}@{{ host }}:/usr/local/bin/led-driver.new"
    ssh "{{ user }}@{{ host }}" 'install -m 0755 /usr/local/bin/led-driver.new /usr/local/bin/led-driver \
        && systemctl restart led-driver.service \
        && rm /usr/local/bin/led-driver.new'

# Tail the driver service journal on a host.
logs host user="root":
    ssh "{{ user }}@{{ host }}" journalctl -u led-driver.service -f

# Thin wrapper for `tofu -chdir=terraform <args>` that decrypts
# TF_STATE_PASSPHRASE from sops and injects it as TF_VAR_tf_state_passphrase
# (the var the encryption block reads). Use for everything: `just tf init`,
# `just tf plan`, `just tf apply`, `just tf output -raw supabase_url`, …
tf *args:
    #!/usr/bin/env bash
    set -euo pipefail
    export TF_VAR_tf_state_passphrase=$(sops --decrypt secrets.sops.json | jq -r '.TF_STATE_PASSPHRASE')
    tofu -chdir=terraform {{ args }}
