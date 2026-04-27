# Setup

End-to-end bring-up of a new LED matrix Pi.

## Prerequisites (one-time, on your dev machine)

1. **Tools**: `just`, `cross`, Docker (for `cross`), `xz`, `parted`, `curl`, `ssh`/`scp`, Tailscale.
2. **Tailscale**: be logged into the same tailnet the matrix will join, and mint a reusable auth key (Settings → Keys → Generate auth key, reusable + non-ephemeral). Save it for `secrets.env`.
3. **Secrets**: edit the SOPS-encrypted file.
   ```sh
   sops secrets.sops.env
   ```
   `secrets.sops.env` is committed encrypted (PGP, your key only — see `.sops.yaml`). The justfile decrypts it on the fly for any recipe that needs secrets. A gitignored `secrets.env` next to it acts as an optional local override (not required).

   Keys:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY` — driver runtime
   - `OTEL_ENDPOINT` (optional) — `http://infra:4318` for OTLP/HTTP to your tailnet collector
   - `WIFI_COUNTRY` — 2-letter ISO regdomain code (e.g. `CA`, `US`)
   - `TAILSCALE_AUTHKEY` — first-boot tailnet join
   - `SSH_AUTHORIZED_KEYS_FILE` (optional) — defaults to `~/.ssh/id_ed25519.pub`

   *No WiFi SSID/PSK*: those are entered by the user from a phone/laptop on first boot via the captive-portal AP that the Pi brings up. See "First boot" below.
4. **Workspace builds locally**: `just check`.

## Provisioning a new matrix

One command on your dev machine, then plug-and-power on the Pi.

### 1. Flash a fully provisioned SD card

Plug a 4–32 GB SD card into your dev machine, identify the device:

```sh
lsblk -o NAME,SIZE,TYPE,TRAN,MODEL
# expect e.g. `sdb 32G disk usb`
```

Then:

```sh
just flash-sd <id> <hostname> /dev/sdX
# e.g. just flash-sd kitchen led-echo /dev/sdb
```

This:
- cross-compiles the driver
- downloads & caches Pi OS Lite (`~/.cache/led/raspios-lite-<arch>.img.xz`)
- `dd`s it to the SD card (~5 min)
- bakes the driver binary, systemd unit, ALSA blacklist, and rendered `config.toml` into the rootfs
- drops a `firstrun.sh` + per-host `firstrun.env` into the boot partition

You'll be prompted to retype the device path before the destructive `dd`. The recipe refuses to run on devices outside 2–256 GB or anything currently mounted.

### 2. Insert the SD into the Pi and power on

First boot runs `firstrun.sh`, which applies hostname + SSH key, writes `/etc/led/init.env` with the runtime knobs, enables the boot-time services, and reboots. ~30s.

After that reboot:

1. **`led-wifi-setup.service`** runs first. If no WiFi connection is configured yet, the Pi brings up an open AP named `led-setup-<id>` and serves a captive-portal page on `http://10.42.0.1`.
2. Connect a phone/laptop to `led-setup-<id>`. iOS/Android usually auto-open the captive portal; if not, open `http://10.42.0.1` manually.
3. Pick your network from the dropdown, enter the password, hit Connect. The Pi tears down the AP, applies the WiFi connection, and the service exits successfully when the connection comes up.
4. **`led-tailscale-init.service`** runs next: `curl`-installs Tailscale, runs `tailscale up --auth-key=… --ssh`, disables the system sshd, then writes a marker file so it doesn't re-run.
5. **`led-driver.service`** finally starts.

Watch for it:

```sh
tailscale status | grep <hostname>
```

The driver starts on the second boot. Tail logs over Tailscale SSH if you want:

```sh
just logs <hostname>
```

If `firstrun.sh` failed for any reason, log into the Pi locally (the `pi` user is keyless without your SSH key, so you'd need a serial console or pull the SD) and read `/boot/firmware/firstrun.log`.

## Day-to-day

| Goal | Command |
|---|---|
| Push a new build to one matrix | `just deploy <hostname>` |
| Tail logs from a matrix | `just logs <hostname>` |
| Re-init an existing Pi (no SD reflash) | `just init <hostname> <id>` |
| Cross-compile only | `just build` |
| Local sanity check | `just check` |
| Force re-download of Pi OS image | `just refresh-image-cache` |
| Build/flash for aarch64 (Pi Zero 2 W / Pi 4) | `just arch=aarch64-unknown-linux-musl flash-sd …` |

## Architecture notes

- **Hardware**: Pi Zero W (BCM2835, armv6 hardfp) with an Adafruit RGB Matrix Bonnet driving HUB75. Default cross-compile target is `arm-unknown-linux-gnueabihf`. `armv7-unknown-linux-gnueabihf` is for Pi 3+; `aarch64-unknown-linux-musl` for Pi Zero 2 W / Pi 4 / Pi 5.
- **Data plane**: the driver pulls panel state and text entries from Supabase PostgREST every ~2.5 s, keyed by `id`. Updates from the dash become visible on the matrix on the next sync tick.
- **Observability**: the driver emits OTLP/HTTP metrics + logs to `OTEL_ENDPOINT` if set. `led.driver.heartbeat` is the liveness signal — query HyperDX/ClickHouse for it instead of polling `panels.last_seen` (which the driver no longer writes).
- **Updates**: push-based via `just deploy`. There's no on-device polling; the matrix only changes when you push.
- **WiFi changes after deploy**: SSH in over Tailscale and either edit `/etc/NetworkManager/system-connections/led-wifi.nmconnection` directly, or `rm /var/lib/led-wifi-setup/configured && systemctl restart led-wifi-setup` to re-arm the captive-portal flow.
- **WiFi onboarding**: handled by the in-house `led-wifi-setup` Rust binary using NetworkManager shared-mode AP + a tiny axum captive portal. No SSID/PSK is baked at flash time; the user enters them on first boot from any phone/laptop browser. Source: `wifi-setup/`.

## Solder note

Make sure both the GPIO 4 ↔ GPIO 18 jumper *and* the bottom two pads on the Bonnet are bridged for hardware PWM. Without these the panel timing is off and you'll see ghosting.
