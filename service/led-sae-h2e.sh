#!/bin/sh
# Force WPA3-SAE hash-to-element (H2E) on the onboard wifi.
#
# The Broadcom brcmfmac firmware (BCM43455 on Pi Zero W / Pi 4 / Pi 5)
# offloads SAE to firmware, which only does the legacy hunting-and-pecking
# PWE method. WiFi-6 / enterprise WPA3 APs commonly *require* the newer
# hash-to-element method and reject hunt-and-peck association with
# status_code=16 ("timeout waiting for next frame in sequence").
#
# NetworkManager drives wpa_supplicant over D-Bus with no global config
# file, and NM 1.52 doesn't expose the `sae-pwe` per-connection property,
# so there's no declarative way to set it. wpa_supplicant in D-Bus mode
# also doesn't apply `sae_pwe` from a `-c` global config to interfaces NM
# registers. The one thing that works is setting it at runtime on the live
# interface: `wpa_cli set sae_pwe 2` (2 = offer both H2E and hunt-peck).
#
# This oneshot waits for wlan0 to appear in the supplicant, sets sae_pwe=2,
# then nudges the stored connection up so a WPA3 network that failed its
# first (pre-H2E) autoconnect attempt re-associates. Harmless on open /
# WPA2 / non-WPA3 networks.
for _ in $(seq 1 90); do
    if wpa_cli -i wlan0 set sae_pwe 2 >/dev/null 2>&1; then
        nmcli connection up led-wifi >/dev/null 2>&1 || true
        exit 0
    fi
    sleep 1
done
exit 0
