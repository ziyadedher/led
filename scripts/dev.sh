#!/bin/bash
# Run the driver natively against the real Supabase as the `dev`
# panel. Renders to terminal via ANSI half-blocks. OTel disabled,
# logs at dev/log/. Edits in the dash propagate via Realtime
# WebSocket — same path as prod.
#
# Usage: scripts/dev.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

cd "$REPO_ROOT"

load_secrets
load_tofu_outputs

mkdir -p dev/log
rendered="dev.toml"
# OTel force-disabled in dev (override any inherited value).
OTEL_ENDPOINT="" OTEL_AUTHORIZATION="" \
    render_config_toml "dev" "dev/log/" "$rendered"

cargo run -p led-driver --no-default-features -- \
    --config "$rendered" --terminal
