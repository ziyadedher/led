# Default target architecture for the LED matrix Pis (Pi Zero W = armv6 hardfp).
# Override per-invocation: `just arch=aarch64-unknown-linux-musl build`.
arch := "arm-unknown-linux-gnueabihf"

# Non-sensitive runtime configuration. Exported so recipe shells inherit them.
# `secrets.sops.json` only holds genuinely-secret values. Override per-invocation
# (`just OTEL_ENDPOINT=… flash-sd …`) or via secrets.env if you need.
export OTEL_ENDPOINT := env_var_or_default("OTEL_ENDPOINT", "https://otel.ziyadedher.com")
export WIFI_COUNTRY := env_var_or_default("WIFI_COUNTRY", "US")

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
} else {
    "ERROR_UNKNOWN_ARCH"
}

# qemu-user-static binary that matches `arch` — used by flash-sd's
# chroot to apt-install tailscale into the rootfs. Arch's
# `qemu-user-static` package ships both.
qemu_user_static := if arch == "arm-unknown-linux-gnueabihf" {
    "/usr/bin/qemu-arm-static"
} else if arch == "aarch64-unknown-linux-musl" {
    "/usr/bin/qemu-aarch64-static"
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

# Flash an SD card with a fully provisioned image. Everything is baked
# at flash time on the dev box — no first-boot reconfigure step. Pi
# powers on, hits multi-user.target, our services come up. Tailscale
# joins, you SSH in via tailnet (no system sshd / pi user / userconf
# / authorized_keys plumbing — Tailscale SSH is the only entry).
#
# Pulls Supabase URL + anon key from `tofu output` and TAILSCALE_AUTHKEY
# from `secrets/fleet.sops.json`. Run `tofu -chdir=terraform apply`
# first if you haven't.
flash-sd id host device: build
    #!/usr/bin/env bash
    set -euo pipefail
    set -a
    eval "$(sops --decrypt secrets/admin.sops.json | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    eval "$(sops --decrypt secrets/fleet.sops.json | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    TF_VAR_tf_state_passphrase="$TF_STATE_PASSPHRASE"
    SUPABASE_URL=$(tofu -chdir=terraform output -raw supabase_url)
    SUPABASE_ANON_KEY=$(tofu -chdir=terraform output -raw anon_key)
    [ -f secrets.env ] && source secrets.env
    set +a
    : "${SUPABASE_URL:?tofu output supabase_url is empty — run \`tofu -chdir=terraform apply\` first}"
    : "${SUPABASE_ANON_KEY:?tofu output anon_key is empty — run \`tofu -chdir=terraform apply\` first}"
    : "${TAILSCALE_AUTHKEY:?need TAILSCALE_AUTHKEY in secrets/fleet.sops.json}"

    # qemu-user-static for the chroot apt-install step. Arch:
    # `pacman -S qemu-user-static qemu-user-static-binfmt`.
    [ -x "{{ qemu_user_static }}" ] \
        || { echo "ERROR: {{ qemu_user_static }} missing (Arch: pacman -S qemu-user-static qemu-user-static-binfmt)" >&2; exit 1; }

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

    # cmdline.txt: append cfg80211 regdomain. Equivalent to running
    # `raspi-config nonint do_wifi_country` on the Pi, but baked at
    # flash time so we don't need a first-boot script.
    cmdline=$(sudo tr -d '\n' < "$boot_mnt/cmdline.txt")
    echo "$cmdline cfg80211.ieee80211_regdom=$WIFI_COUNTRY" \
        | sudo tee "$boot_mnt/cmdline.txt" > /dev/null

    # /etc/led/init.env — runtime env file consumed by
    # led-wifi-setup and led-tailscale-init via EnvironmentFile=.
    env_tmp=$(mktemp)
    chmod 600 "$env_tmp"
    {
        printf 'HOSTNAME=%q\n' "{{ host }}"
        printf 'PANEL_ID=%q\n' "{{ id }}"
        printf 'WIFI_COUNTRY=%q\n' "$WIFI_COUNTRY"
        printf 'TAILSCALE_AUTHKEY=%q\n' "$TAILSCALE_AUTHKEY"
    } > "$env_tmp"
    sudo install -D -m 0600 "$env_tmp" "$root_mnt/etc/led/init.env"
    rm -f "$env_tmp"

    # Hostname.
    echo "{{ host }}" | sudo tee "$root_mnt/etc/hostname" > /dev/null
    sudo sed -i "s/^127\\.0\\.1\\.1.*/127.0.1.1\\t{{ host }}/" "$root_mnt/etc/hosts" || true

    # Persistent journald with 1-second sync — captures logs across
    # power yanks (which is most of our debug loop). Empty
    # /var/log/journal triggers persistent mode on Debian/Raspbian.
    sudo install -D -m 0644 service/journald-persistent.conf \
        "$root_mnt/etc/systemd/journald.conf.d/persistent.conf"
    sudo install -d -m 2755 "$root_mnt/var/log/journal"

    # Render config.toml + bake driver / wifi-setup / tailscale-init.
    cfg_tmp=$(mktemp)
    sed \
        -e "s|@@ID@@|{{ id }}|g" \
        -e "s|@@LOG_DIR@@|/var/log/led/|g" \
        -e "s|@@SUPABASE_URL@@|${SUPABASE_URL}|g" \
        -e "s|@@SUPABASE_ANON_KEY@@|${SUPABASE_ANON_KEY}|g" \
        -e "s|@@OTEL_ENDPOINT@@|${OTEL_ENDPOINT:-}|g" \
        -e "s|@@OTEL_AUTHORIZATION@@|${OTEL_AUTHORIZATION:-}|g" \
        service/config.toml.tmpl > "$cfg_tmp"
    sudo install -D -m 0644 "$cfg_tmp"                          "$root_mnt/usr/local/etc/led/config.toml"
    sudo install -D -m 0755 "{{ driver_bin }}"                  "$root_mnt/usr/local/bin/led-driver"
    sudo install -D -m 0755 "{{ wifi_bin }}"                    "$root_mnt/usr/local/bin/led-wifi-setup"
    sudo install -D -m 0755 service/led-tailscale-init          "$root_mnt/usr/local/bin/led-tailscale-init"
    sudo install -D -m 0644 service/led-driver.service          "$root_mnt/etc/systemd/system/led-driver.service"
    sudo install -D -m 0644 service/led-wifi-setup.service      "$root_mnt/etc/systemd/system/led-wifi-setup.service"
    sudo install -D -m 0644 service/led-tailscale-init.service  "$root_mnt/etc/systemd/system/led-tailscale-init.service"
    sudo install -D -m 0644 service/alsa-blacklist.conf         "$root_mnt/etc/modprobe.d/led-alsa-blacklist.conf"
    sudo install -D -m 0644 service/captive-dnsmasq.conf        "$root_mnt/etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf"
    sudo install -D -m 0644 service/disable-ipv6.conf           "$root_mnt/etc/sysctl.d/99-led-disable-ipv6.conf"
    rm -f "$cfg_tmp"

    # Mask raspbian's first-boot user setup. We don't write
    # userconf.txt and don't want a `pi` user; without this mask,
    # userconfig.service half-creates pi with /usr/sbin/nologin
    # which is harmless but noisy.
    sudo ln -sf /dev/null "$root_mnt/etc/systemd/system/userconfig.service"

    # Pre-install tailscale into the rootfs so first boot doesn't
    # need apt at all. We chroot via qemu-user-static and run the
    # official installer. Host clock is correct → apt signature
    # validation passes; on the Pi at first boot the package is
    # already there. Saves ~3min of first-boot apt work and removes
    # the time-sync dependency for tailscale-init.
    echo "==> pre-installing tailscale into the rootfs (~30s via qemu-user)"
    sudo install -m 0755 "{{ qemu_user_static }}" "$root_mnt{{ qemu_user_static }}"
    sudo mount --bind /proc "$root_mnt/proc"
    sudo mount --bind /sys  "$root_mnt/sys"
    sudo mount --bind /dev  "$root_mnt/dev"
    # raspbian ships /etc/resolv.conf as a symlink to
    # /run/systemd/resolve/stub-resolv.conf; cp-through would clobber
    # the host's. Save the symlink target, replace with a plain file
    # for the chroot, restore the symlink on cleanup.
    resolv_link=$(sudo readlink "$root_mnt/etc/resolv.conf" 2>/dev/null || true)
    sudo rm -f "$root_mnt/etc/resolv.conf"
    sudo install -m 0644 /etc/resolv.conf "$root_mnt/etc/resolv.conf"
    chroot_cleanup() {
        sudo umount "$root_mnt/dev"  2>/dev/null || true
        sudo umount "$root_mnt/sys"  2>/dev/null || true
        sudo umount "$root_mnt/proc" 2>/dev/null || true
        sudo rm -f  "$root_mnt{{ qemu_user_static }}"
        sudo rm -f  "$root_mnt/etc/resolv.conf"
        if [ -n "$resolv_link" ]; then
            sudo ln -sf "$resolv_link" "$root_mnt/etc/resolv.conf"
        fi
    }
    chroot_full_cleanup() {
        chroot_cleanup
        cleanup
    }
    trap chroot_full_cleanup EXIT
    sudo install -m 0755 service/install-tailscale-chroot.sh "$root_mnt/install-tailscale-chroot.sh"
    sudo chroot "$root_mnt" /install-tailscale-chroot.sh
    sudo rm -f "$root_mnt/install-tailscale-chroot.sh"
    chroot_cleanup
    trap cleanup EXIT

    # Enable our services. systemd-time-wait-sync stays as a soft
    # dep for tailscale-init's TLS cert validation — apt is gone
    # but cert validity windows still benefit from a synced clock.
    # Symlink targets follow where each unit's source lives: ours
    # under /etc/systemd/system, systemd-shipped under
    # /lib/systemd/system.
    sudo install -d -m 0755 "$root_mnt/etc/systemd/system/multi-user.target.wants"
    for unit in led-driver.service led-wifi-setup.service led-tailscale-init.service; do
        sudo ln -sf "/etc/systemd/system/$unit" \
            "$root_mnt/etc/systemd/system/multi-user.target.wants/$unit"
    done
    sudo ln -sf /lib/systemd/system/systemd-time-wait-sync.service \
        "$root_mnt/etc/systemd/system/multi-user.target.wants/systemd-time-wait-sync.service"

    sudo sync
    cleanup
    trap - EXIT

    echo
    echo "==> $dev ready. Insert into the Pi for {{ host }} ({{ id }}) and power it on."
    echo "    On first boot: led-wifi-setup brings up the captive-portal AP"
    echo "    (SSID 'led-setup-{{ id }}'), pick your home wifi from a phone,"
    echo "    led-tailscale-init joins the tailnet, you SSH in:"
    echo "        tailscale ssh root@{{ host }}"

# Re-init an existing Pi that's already on the tailnet (e.g. one provisioned
# before flash-sd existed). Pushes config + service unit + ALSA blacklist +
# binary. Use `flash-sd` for fresh hardware.
init host id user="root": build
    #!/usr/bin/env bash
    set -euo pipefail
    set -a
    eval "$(sops --decrypt secrets/admin.sops.json | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    eval "$(sops --decrypt secrets/fleet.sops.json | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    TF_VAR_tf_state_passphrase="$TF_STATE_PASSPHRASE"
    SUPABASE_URL=$(tofu -chdir=terraform output -raw supabase_url)
    SUPABASE_ANON_KEY=$(tofu -chdir=terraform output -raw anon_key)
    [ -f secrets.env ] && source secrets.env
    set +a
    rendered=$(mktemp)
    trap 'rm -f "$rendered"' EXIT
    sed \
        -e "s|@@ID@@|{{ id }}|g" \
        -e "s|@@LOG_DIR@@|/var/log/led/|g" \
        -e "s|@@SUPABASE_URL@@|${SUPABASE_URL}|g" \
        -e "s|@@SUPABASE_ANON_KEY@@|${SUPABASE_ANON_KEY}|g" \
        -e "s|@@OTEL_ENDPOINT@@|${OTEL_ENDPOINT:-}|g" \
        -e "s|@@OTEL_AUTHORIZATION@@|${OTEL_AUTHORIZATION:-}|g" \
        service/config.toml.tmpl > "$rendered"
    ssh "{{ user }}@{{ host }}" 'mkdir -p /usr/local/etc/led /var/log/led /etc/NetworkManager/dnsmasq-shared.d /etc/sysctl.d'
    scp service/alsa-blacklist.conf  "{{ user }}@{{ host }}:/etc/modprobe.d/led-alsa-blacklist.conf"
    scp service/captive-dnsmasq.conf "{{ user }}@{{ host }}:/etc/NetworkManager/dnsmasq-shared.d/captive-portal.conf"
    scp service/disable-ipv6.conf    "{{ user }}@{{ host }}:/etc/sysctl.d/99-led-disable-ipv6.conf"
    scp service/led-driver.service   "{{ user }}@{{ host }}:/etc/systemd/system/led-driver.service"
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

nspawn_dir := "dev/nspawn"

# Boot a minimal Debian-amd64 rootfs in systemd-nspawn with a real
# `wlan0` from mac80211_hwsim. Native execution — no qemu-user
# emulation — so dbus, NetworkManager, and our binaries all run on
# real syscalls. Tests the systemd boot flow + service unit + wifi-
# setup AP-mode behavior. Loses raspbian fidelity (no raspi-config,
# different NM version), which we don't need: the bug classes we
# can catch here are arch-independent (service ordering, NM
# interactions, our binaries' logic).
#
# led-tailscale-init NOT enabled (would burn a real authkey on a
# fake host). led-driver runs in --terminal sink (no GPIO).
#
# Requires: systemd-nspawn, debootstrap (Arch: pacman -S
# debootstrap), iw (Arch: pacman -S iw), mac80211_hwsim kernel
# module (built into modern Arch kernel).
nspawn host id:
    #!/usr/bin/env bash
    set -euo pipefail
    command -v systemd-nspawn >/dev/null \
        || { echo "ERROR: systemd-nspawn not in PATH (install systemd)" >&2; exit 1; }
    command -v debootstrap >/dev/null \
        || { echo "ERROR: debootstrap not installed (Arch: pacman -S debootstrap)" >&2; exit 1; }
    command -v iw >/dev/null \
        || { echo "ERROR: iw not in PATH (Arch: pacman -S iw)" >&2; exit 1; }
    modinfo mac80211_hwsim >/dev/null 2>&1 \
        || { echo "ERROR: mac80211_hwsim kernel module not available" >&2; exit 1; }

    set -a
    eval "$(sops --decrypt secrets/admin.sops.json | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    TF_VAR_tf_state_passphrase="$TF_STATE_PASSPHRASE"
    SUPABASE_URL=$(tofu -chdir=terraform output -raw supabase_url)
    SUPABASE_ANON_KEY=$(tofu -chdir=terraform output -raw anon_key)
    [ -f secrets.env ] && source secrets.env
    set +a
    : "${SUPABASE_URL:?tofu output supabase_url is empty}"
    : "${SUPABASE_ANON_KEY:?tofu output anon_key is empty}"

    # Native build for the host arch. Driver: terminal sink only
    # (no rpi feature → no GPIO/HUB75). Wifi-setup: default features.
    cargo build --release --no-default-features -p led-driver
    cargo build --release -p led-wifi-setup

    driver_bin="target/release/led-driver"
    wifi_bin="target/release/led-wifi-setup"
    [ -x "$driver_bin" ] || { echo "ERROR: $driver_bin missing after cargo build" >&2; exit 1; }
    [ -x "$wifi_bin" ]   || { echo "ERROR: $wifi_bin missing after cargo build" >&2; exit 1; }

    sudo -v

    mkdir -p {{ nspawn_dir }}
    rootfs="{{ nspawn_dir }}/{{ host }}-rootfs"
    netns="led-{{ host }}"

    if [ ! -f "$rootfs/etc/os-release" ]; then
        echo "==> debootstrapping Debian trixie minbase to $rootfs (one-time, ~250MB)"
        sudo mkdir -p "$rootfs"
        sudo debootstrap \
            --variant=minbase \
            --include=systemd,systemd-sysv,dbus,network-manager,wpasupplicant,iproute2,iputils-ping,ca-certificates,iw,procps,passwd \
            trixie "$rootfs" http://deb.debian.org/debian
    fi

    # Bake config + native binaries + service units. led-tailscale-init
    # NOT enabled.
    cfg_tmp=$(mktemp)
    sed \
        -e "s|@@ID@@|{{ id }}|g" \
        -e "s|@@LOG_DIR@@|/var/log/led/|g" \
        -e "s|@@SUPABASE_URL@@|${SUPABASE_URL}|g" \
        -e "s|@@SUPABASE_ANON_KEY@@|${SUPABASE_ANON_KEY}|g" \
        -e "s|@@OTEL_ENDPOINT@@||g" \
        -e "s|@@OTEL_AUTHORIZATION@@||g" \
        service/config.toml.tmpl > "$cfg_tmp"
    sudo install -D -m 0644 "$cfg_tmp"                       "$rootfs/usr/local/etc/led/config.toml"
    sudo install -D -m 0755 "$driver_bin"                    "$rootfs/usr/local/bin/led-driver"
    sudo install -D -m 0755 "$wifi_bin"                      "$rootfs/usr/local/bin/led-wifi-setup"
    sudo install -D -m 0644 service/led-driver.service       "$rootfs/etc/systemd/system/led-driver.service"
    sudo install -D -m 0644 service/led-wifi-setup.service   "$rootfs/etc/systemd/system/led-wifi-setup.service"
    rm -f "$cfg_tmp"

    # Debian's units mostly use ConditionVirtualization=!container so
    # we don't need the raspbian unit-mask wall. The one mask worth
    # keeping: getty@tty1 spams the nspawn console and isn't useful
    # since systemd-nspawn already gives us pid 1's stdout.
    sudo ln -sf /dev/null "$rootfs/etc/systemd/system/getty@tty1.service"

    # /etc/led/init.env — wifi-setup consumes PANEL_ID + WIFI_COUNTRY
    # via EnvironmentFile=. No TAILSCALE_AUTHKEY: led-tailscale-init
    # isn't enabled here.
    sudo install -d -m 0755 "$rootfs/etc/led"
    {
        printf 'HOSTNAME=%q\n' "{{ host }}"
        printf 'PANEL_ID=%q\n' "{{ id }}"
        printf 'WIFI_COUNTRY=%q\n' "$WIFI_COUNTRY"
    } | sudo tee "$rootfs/etc/led/init.env" > /dev/null
    sudo chmod 0600 "$rootfs/etc/led/init.env"

    # Driver runs in --terminal mode in the container (no GPIO).
    sudo sed -i 's|^ExecStart=.*|ExecStart=/usr/local/bin/led-driver --config /usr/local/etc/led/config.toml --terminal|' \
        "$rootfs/etc/systemd/system/led-driver.service"
    # Strip realtime CPU/IO knobs (nspawn won't grant SCHED_FIFO).
    sudo sed -i '/^CPUSchedulingPolicy/d; /^CPUSchedulingPriority/d; /^Nice/d; /^IOSchedulingClass/d; /^IOSchedulingPriority/d' \
        "$rootfs/etc/systemd/system/led-driver.service"

    # Enable both units. led-wifi-setup has its own After=NetworkManager
    # in the unit file so dependency ordering is already correct.
    sudo install -d -m 0755 "$rootfs/etc/systemd/system/multi-user.target.wants"
    sudo ln -sf /etc/systemd/system/led-driver.service     "$rootfs/etc/systemd/system/multi-user.target.wants/led-driver.service"
    sudo ln -sf /etc/systemd/system/led-wifi-setup.service "$rootfs/etc/systemd/system/multi-user.target.wants/led-wifi-setup.service"

    echo "{{ host }}" | sudo tee "$rootfs/etc/hostname" > /dev/null
    # No password / no authorized_keys — `machinectl shell led-test`
    # from the host gets us in without auth, which is what we want.

    # === wlan0 emulation via mac80211_hwsim ===
    # Create a private netns for the container; move one hwsim phy
    # into it so NM inside sees a real cfg80211 wlan0.
    cleanup_wifi() {
        if ip netns list 2>/dev/null | awk '{print $1}' | grep -qx "$netns"; then
            # Move any phys still in our netns back to the host (netns 1)
            for phy in $(sudo ip netns exec "$netns" iw dev 2>/dev/null | awk '/phy#/{gsub("#",""); print "phy"$2}'); do
                sudo ip netns exec "$netns" iw phy "$phy" set netns 1 2>/dev/null || true
            done
            sudo ip netns delete "$netns" 2>/dev/null || true
        fi
    }
    trap cleanup_wifi EXIT

    # Clean up any leftover netns from a previous failed run.
    sudo ip netns delete "$netns" 2>/dev/null || true

    # Snapshot existing phys, modprobe hwsim with 2 radios, find the
    # new ones. radios=2 leaves one available on the host for a
    # future hostapd "home wifi" simulator (phase 2).
    pre_phys=$(ls /sys/class/ieee80211 2>/dev/null | sort || true)
    if ! lsmod | awk '{print $1}' | grep -qx mac80211_hwsim; then
        echo "==> loading mac80211_hwsim radios=2"
        sudo modprobe mac80211_hwsim radios=2
        sleep 1
    fi
    post_phys=$(ls /sys/class/ieee80211 2>/dev/null | sort)
    new_phys=$(comm -13 <(printf '%s\n' "$pre_phys") <(printf '%s\n' "$post_phys") || true)
    if [ -z "$new_phys" ]; then
        # Module already loaded by a previous run — pick any
        # hwsim-driven phy that's still in the host netns and free.
        new_phys=$(for phy in /sys/class/ieee80211/*; do
            drv=$(readlink -f "$phy/device/driver" 2>/dev/null | xargs -r basename)
            [ "$drv" = "mac80211_hwsim" ] && basename "$phy"
        done)
    fi
    container_phy=$(printf '%s\n' "$new_phys" | head -n1)
    [ -n "$container_phy" ] || { echo "ERROR: no hwsim phy available for container" >&2; exit 1; }
    echo "==> assigning $container_phy as container's wlan0"

    sudo ip netns add "$netns"
    sudo ip netns exec "$netns" ip link set lo up
    sudo iw phy "$container_phy" set netns name "$netns"

    echo
    echo "==> booting nspawn machine={{ host }} (id={{ id }})"
    echo "    Network: private netns with hwsim wlan0 ($container_phy)."
    echo "             No host network → Supabase unreachable from"
    echo "             inside. Wifi-setup AP-mode is what we're"
    echo "             validating; STA-mode + hostapd in phase 2."
    echo "    Logs:    journalctl -u led-wifi-setup.service -f  (inside)"
    echo "             journalctl -u led-driver.service -f  (inside)"
    echo "    Quit:    poweroff (inside) or Ctrl-] x3 within 1s"
    echo
    sudo systemd-nspawn \
        --boot \
        --machine="{{ host }}" \
        --directory="$rootfs" \
        --network-namespace-path="/run/netns/$netns" \
        --resolv-conf=copy-host

# Run the driver natively (no Pi hardware needed) against the real
# Supabase project as the `dev` panel. Renders the matrix into your
# terminal via ANSI 24-bit half-blocks (▀ glyph: 64×32 char grid). OTel
# is disabled — logs only land in dev/log/. Edits in the dash propagate
# in realtime over the Supabase Realtime WebSocket, same as prod.
#
# Pulls Supabase URL + anon key from `tofu output` and overlays
# optional dev-only env from `secrets/dev.sops.json` when it exists
# (currently no required keys; OTel is force-disabled).
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    set -a
    eval "$(sops --decrypt secrets/admin.sops.json | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    if [ -f secrets/dev.sops.json ]; then
        eval "$(sops --decrypt secrets/dev.sops.json | jq -r 'to_entries[] | "\(.key)=\(.value | @sh)"')"
    fi
    TF_VAR_tf_state_passphrase="$TF_STATE_PASSPHRASE"
    SUPABASE_URL=$(tofu -chdir=terraform output -raw supabase_url)
    SUPABASE_ANON_KEY=$(tofu -chdir=terraform output -raw anon_key)
    [ -f secrets.env ] && source secrets.env
    set +a
    : "${SUPABASE_URL:?tofu output supabase_url is empty — run \`tofu -chdir=terraform apply\` first}"
    : "${SUPABASE_ANON_KEY:?tofu output anon_key is empty — run \`tofu -chdir=terraform apply\` first}"

    mkdir -p dev/log
    rendered="dev.toml"
    sed \
        -e "s|@@ID@@|dev|g" \
        -e "s|@@LOG_DIR@@|dev/log/|g" \
        -e "s|@@SUPABASE_URL@@|${SUPABASE_URL}|g" \
        -e "s|@@SUPABASE_ANON_KEY@@|${SUPABASE_ANON_KEY}|g" \
        -e "s|@@OTEL_ENDPOINT@@||g" \
        -e "s|@@OTEL_AUTHORIZATION@@||g" \
        service/config.toml.tmpl > "$rendered"

    cargo run -p led-driver --no-default-features -- \
        --config "$rendered" --terminal

# Thin wrapper for `tofu -chdir=terraform <args>` that decrypts
# TF_STATE_PASSPHRASE from sops and injects it as TF_VAR_tf_state_passphrase
# (the var the encryption block reads). Use for everything: `just tf init`,
# `just tf plan`, `just tf apply`, `just tf output -raw supabase_url`, …
tf *args:
    #!/usr/bin/env bash
    set -euo pipefail
    export TF_VAR_tf_state_passphrase=$(sops --decrypt secrets/admin.sops.json | jq -r '.TF_STATE_PASSPHRASE')
    tofu -chdir=terraform {{ args }}
