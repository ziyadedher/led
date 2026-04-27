# Setup

End-to-end bring-up of a new LED matrix Pi.

## Prerequisites (one-time, on your dev machine)

1. **Tools**: `just`, `cross`, Docker (for `cross`), `ssh`, `scp`, Tailscale.
2. **Tailscale**: be logged into the same tailnet the matrix will join, with a reusable auth key minted in the Tailscale admin console (Settings → Keys → Generate auth key, mark it reusable + ephemeral=false).
3. **Secrets**: copy the secrets template and fill it in.
   ```sh
   cp secrets.env.example secrets.env  # if you don't have it yet
   $EDITOR secrets.env
   ```
   `secrets.env` is gitignored. It needs:
   - `SUPABASE_URL` — `https://<project>.supabase.co/rest/v1`
   - `SUPABASE_ANON_KEY` — anon JWT for the project
   - `OTEL_ENDPOINT` (optional) — e.g. `http://infra:4318` for OTLP/HTTP to your tailnet collector
4. **Workspace builds locally**: `just check`.

## Provisioning a new matrix

These four steps take a brand-new SD card and a Pi to a working matrix on the tailnet.

### 1. Flash Raspberry Pi OS Lite (32-bit) with Pi Imager

Use the Imager's gear-icon customization (or `Ctrl+Shift+X`):

| Field | Value |
|---|---|
| Hostname | `led-<name>` (e.g. `led-echo`) |
| Username | `pi` |
| Password | something random; it'll only matter if you ever lose tailnet access |
| WiFi SSID + PSK | the network the matrix will live on |
| WiFi country | your country code |
| Locale + keyboard | your preferences |
| Enable SSH → public-key only | paste your dev machine's public key |

Flash, eject, slot the card into the Pi, power on. First boot takes 1–2 minutes.

### 2. Join the tailnet

SSH in once over the local network:

```sh
ssh pi@led-<name>.local
```

On the Pi, install Tailscale and join (one line — replace `<auth-key>` with your reusable auth key):

```sh
curl -fsSL https://tailscale.com/install.sh | sh \
  && sudo tailscale up --ssh --auth-key=<auth-key> \
  && sudo systemctl disable --now ssh
```

This installs Tailscale, joins the tailnet with Tailscale SSH, and disables the default sshd so all future access goes via Tailscale.

In the Tailscale admin console, mark the new node's key expiry as disabled.

### 3. Initialize the driver from your dev machine

Pick a panel id (the `name` your matrix is keyed under in the dash; e.g. `floater`, `kitchen`, `office-back`).

```sh
just init led-<name> <id>
```

This cross-compiles the driver, then over Tailscale SSH:

- installs the binary to `/usr/local/bin/led-driver`
- writes `/etc/systemd/system/led-driver.service`
- writes `/etc/modprobe.d/led-alsa-blacklist.conf` (frees DMA from `snd_bcm2835` for the panel library)
- renders `/usr/local/etc/led/config.toml` from `service/config.toml.tmpl` using `secrets.env`
- enables but does **not** start the service

### 4. Reboot to apply the ALSA blacklist, then deploy

```sh
ssh root@led-<name> reboot          # only needed on first install
just deploy led-<name>
```

`deploy` rebuilds, pushes the binary, and restarts the service.

## Day-to-day

| Goal | Command |
|---|---|
| Push a new build to one matrix | `just deploy led-<name>` |
| Tail logs from a matrix | `just logs led-<name>` |
| Cross-compile only | `just build` |
| Local sanity check | `just check` |
| Build for aarch64 (Pi Zero 2 W / Pi 4) | `just arch=aarch64-unknown-linux-musl build` |

## Architecture notes

- **Hardware**: Pi Zero W (BCM2835, armv6 hardfp) with an Adafruit RGB Matrix Bonnet driving HUB75. The cross-compile target `arm-unknown-linux-gnueabihf` is the right one — `armv7-unknown-linux-gnueabihf` is for Pi 3+.
- **Data plane**: the driver pulls panel state and text entries from Supabase PostgREST every ~2.5 s, keyed by `id`. Updates from the dash become visible on the matrix on the next sync tick.
- **Observability**: the driver emits OTLP/HTTP metrics + logs to `OTEL_ENDPOINT` if set. `led.driver.heartbeat` is the liveness signal — query HyperDX/ClickHouse for it instead of polling `panels.last_seen` (which the driver no longer writes).
- **Updates**: push-based via `just deploy`. There's no on-device polling; the matrix only changes when you push.
- **WiFi changes after deploy**: SSH in over Tailscale, edit `/etc/NetworkManager/system-connections/` (Bookworm) and restart `NetworkManager`. A captive-portal fallback is on the v2 list.

## Solder note

Make sure both the GPIO 4 ↔ GPIO 18 jumper *and* the bottom two pads on the Bonnet are bridged for hardware PWM. Without these the panel timing is off and you'll see ghosting.
