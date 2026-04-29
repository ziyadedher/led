#!/bin/bash
# Shared helpers sourced by scripts/{flash-sd,nspawn,dev,init}.sh.
# Centralises sops decryption, tofu output reads, and config.toml
# rendering so each entry script is a thin orchestration layer.
#
# Source from a script that already has `set -euo pipefail`.

# Resolve repo root from this file's location so callers can be run
# from anywhere.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$LIB_DIR")"

# Decrypt SOPS files into the current shell's environment. Always
# loads admin (TF_STATE_PASSPHRASE etc.); fleet is loaded only if
# the file exists (some scripts like `dev` don't need TAILSCALE_AUTHKEY).
load_secrets() {
    [ -f "$REPO_ROOT/secrets/admin.sops.json" ] \
        || { echo "ERROR: secrets/admin.sops.json missing" >&2; return 1; }
    set -a
    eval "$(sops --decrypt "$REPO_ROOT/secrets/admin.sops.json" | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    if [ -f "$REPO_ROOT/secrets/fleet.sops.json" ]; then
        eval "$(sops --decrypt "$REPO_ROOT/secrets/fleet.sops.json" | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    fi
    if [ -f "$REPO_ROOT/secrets/dev.sops.json" ]; then
        eval "$(sops --decrypt "$REPO_ROOT/secrets/dev.sops.json" | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    fi
    [ -f "$REPO_ROOT/secrets.env" ] && source "$REPO_ROOT/secrets.env"
    set +a
}

# Read SUPABASE_URL + SUPABASE_ANON_KEY from the encrypted tofu
# state. Caller must have already run `load_secrets` so
# TF_STATE_PASSPHRASE is set.
load_tofu_outputs() {
    export TF_VAR_tf_state_passphrase="${TF_STATE_PASSPHRASE:?run load_secrets first}"
    SUPABASE_URL=$(tofu -chdir="$REPO_ROOT/terraform" output -raw supabase_url)
    SUPABASE_ANON_KEY=$(tofu -chdir="$REPO_ROOT/terraform" output -raw anon_key)
    export SUPABASE_URL SUPABASE_ANON_KEY
    : "${SUPABASE_URL:?tofu output supabase_url is empty — run \`tofu -chdir=terraform apply\` first}"
    : "${SUPABASE_ANON_KEY:?tofu output anon_key is empty — run \`tofu -chdir=terraform apply\` first}"
}

# Render service/config.toml.tmpl to the given path. Args:
#   $1 — panel id (PANEL_ID for the driver)
#   $2 — log dir (e.g. /var/log/led/ for Pi, dev/log/ for dev recipe)
#   $3 — output path
# Reads SUPABASE_URL, SUPABASE_ANON_KEY, OTEL_ENDPOINT, OTEL_AUTHORIZATION,
# COLOR_ORDER from the env. Empty OTel envs render to empty strings
# (driver treats empty endpoint as "OTel disabled"); COLOR_ORDER
# defaults to RGB.
render_config_toml() {
    local panel_id="$1"
    local log_dir="$2"
    local out="$3"
    sed \
        -e "s|@@ID@@|${panel_id}|g" \
        -e "s|@@LOG_DIR@@|${log_dir}|g" \
        -e "s|@@SUPABASE_URL@@|${SUPABASE_URL}|g" \
        -e "s|@@SUPABASE_ANON_KEY@@|${SUPABASE_ANON_KEY}|g" \
        -e "s|@@OTEL_ENDPOINT@@|${OTEL_ENDPOINT:-}|g" \
        -e "s|@@OTEL_AUTHORIZATION@@|${OTEL_AUTHORIZATION:-}|g" \
        -e "s|@@COLOR_ORDER@@|${COLOR_ORDER:-RGB}|g" \
        "$REPO_ROOT/service/config.toml.tmpl" > "$out"
}

# Print the cached Pi OS image path for a given target arch,
# downloading it once into XDG_CACHE_HOME/led if missing.
download_image() {
    local target_arch="$1"
    local cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/led"
    local image_url
    case "$target_arch" in
        arm-unknown-linux-gnueabihf) image_url="https://downloads.raspberrypi.org/raspios_lite_armhf_latest" ;;
        aarch64-unknown-linux-musl)  image_url="https://downloads.raspberrypi.org/raspios_lite_arm64_latest"  ;;
        *) echo "ERROR: no Pi OS image URL mapped for arch=$target_arch" >&2; return 1 ;;
    esac
    mkdir -p "$cache_dir"
    local cached="$cache_dir/raspios-lite-${target_arch}.img.xz"
    if [ ! -f "$cached" ]; then
        echo "==> downloading Pi OS Lite for $target_arch" >&2
        curl --fail --location --progress-bar -o "$cached.tmp" "$image_url"
        mv "$cached.tmp" "$cached"
    fi
    printf '%s\n' "$cached"
}

# qemu-user-static binary that matches a target arch. Caller checks
# existence; this just prints the expected path.
qemu_user_static_for() {
    case "$1" in
        arm-unknown-linux-gnueabihf) echo "/usr/bin/qemu-arm-static" ;;
        aarch64-unknown-linux-musl)  echo "/usr/bin/qemu-aarch64-static" ;;
        *) echo "ERROR: no qemu-user-static mapped for arch=$1" >&2; return 1 ;;
    esac
}
