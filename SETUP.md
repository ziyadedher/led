# Setup

End-to-end bring-up of a new LED matrix Pi.

## Prerequisites (one-time, on your dev machine)

1. **Tools**: `just`, `cross`, Docker (for `cross`), `xz`, `parted`, `curl`, `ssh`/`scp`, Tailscale.
2. **Tailscale**: be logged into the same tailnet the matrix will join, and mint a reusable auth key (Settings → Keys → Generate auth key, reusable + non-ephemeral). Save it for `secrets.env`.
3. **Secrets**: copy and fill in.
   ```sh
   cp secrets.env.example secrets.env
   $EDITOR secrets.env
   ```
   `secrets.env` is gitignored. It needs:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY` — driver runtime
   - `OTEL_ENDPOINT` (optional) — `http://infra:4318` for OTLP/HTTP to your tailnet collector
   - `WIFI_SSID`, `WIFI_PSK`, `WIFI_COUNTRY` — first-boot WiFi config
   - `TAILSCALE_AUTHKEY` — first-boot tailnet join
   - `SSH_AUTHORIZED_KEYS_FILE` (optional) — defaults to `~/.ssh/id_ed25519.pub`
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

First boot takes ~2–3 min. The Pi runs `firstrun.sh`, which sets the hostname, configures WiFi (NetworkManager), installs Tailscale, joins the tailnet with the auth key, disables the system sshd, enables `led-driver.service`, then reboots into a normal boot. After that it's a regular tailnet host.

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
- **WiFi changes after deploy**: SSH in over Tailscale, edit `/etc/NetworkManager/system-connections/led-wifi.nmconnection` (Bookworm) and `nmcli connection up led-wifi`. A captive-portal fallback is on the v2 list.

## Solder note

Make sure both the GPIO 4 ↔ GPIO 18 jumper *and* the bottom two pads on the Bonnet are bridged for hardware PWM. Without these the panel timing is off and you'll see ghosting.
