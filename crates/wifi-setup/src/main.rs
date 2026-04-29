//! `led-wifi-setup` — first-boot WiFi onboarding for an LED matrix Pi.
//!
//! On boot, this binary checks whether NetworkManager already has a usable
//! WiFi connection. If yes, it exits 0 and the rest of the boot proceeds.
//! Otherwise it drops the Pi into "setup mode": brings up an open AP named
//! `led-setup-<id>`, serves a tiny captive-portal-style web app on
//! `http://10.42.0.1`, and waits for an HTTP submission. On submit it tears
//! down the AP, applies the chosen SSID + PSK via `nmcli`, and exits 0 only
//! when the client connection actually comes up.
//!
//! Modern phones (iOS 14+, Android 11+) detect captive portals when joining
//! a network without internet and auto-open the relevant page; for the rare
//! laptop case the user can browse to `http://10.42.0.1` manually.
//!
//! All NetworkManager interaction happens via the `nmcli` shell tool to keep
//! this binary's surface area small (no D-Bus binding).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use axum::extract::State;
use axum::response::{Html, Redirect};
use axum::routing::{get, post};
use axum::{Form, Router};
use clap::Parser;
use serde::Deserialize;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::Notify;

const AP_CONNECTION: &str = "led-setup-ap";
const CONNECTED_MARK: &str = "/var/lib/led-wifi-setup/configured";
const ACTIVE_MARK: &str = "/run/led-wifi-setup.active";
const PORTAL_URL: &str = "10.42.0.1";
const CHECK_INTERVAL: Duration = Duration::from_secs(2);
const APPLY_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Parser)]
#[clap(about = "First-boot WiFi onboarding for an LED matrix Pi.")]
struct Args {
    /// Identifier rendered into the AP SSID, e.g. `led-setup-<id>`.
    #[clap(long, env = "LED_WIFI_SETUP_ID", default_value = "matrix")]
    id: String,

    /// 2-letter ISO country code applied via `iw reg` and to the WiFi connection.
    #[clap(long, env = "WIFI_COUNTRY", default_value = "CA")]
    country: String,

    /// Marker file path; if it exists, the binary exits 0 immediately.
    #[clap(long, default_value = CONNECTED_MARK)]
    marker: PathBuf,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let args = Args::parse();

    if args.marker.exists() {
        tracing::info!("marker {:?} exists, exiting", args.marker);
        return Ok(());
    }

    if let Some(parent) = args.marker.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }

    set_country(&args.country).await.ok();

    if has_active_wifi().await? {
        tracing::info!("already connected to WiFi, marking configured");
        mark_configured(&args.marker).await?;
        return Ok(());
    }

    let ssid = format!("led-setup-{}", args.id);
    tracing::info!(%ssid, "no WiFi configured, bringing up onboarding AP");

    let networks = scan_networks().await.unwrap_or_default();
    tracing::info!(networks = networks.len(), "scanned");

    bring_up_ap(&ssid).await.context("bring up AP")?;
    write_active_marker(&ssid).await.ok();

    let shutdown = Arc::new(Notify::new());
    let app_state = Arc::new(AppState {
        networks,
        shutdown: shutdown.clone(),
        country: args.country.clone(),
        id: args.id.clone(),
    });

    let app = Router::new()
        .route("/", get(form))
        .route("/connect", post(connect_handler))
        // Captive-portal probe URLs from common OSes get a 302 to /.
        // The dnsmasq drop-in (service/captive-dnsmasq.conf) hijacks
        // DNS for every hostname to 10.42.0.1, so probes to e.g.
        // captive.apple.com or connectivitycheck.gstatic.com hit us
        // and the catch-all fallback redirects whatever path they
        // came in on. Some OSes are picky about the exact response
        // body (Android wants a non-204 status, macOS wants Safari
        // to render the redirect target), so 302→/ is the safest.
        .route("/hotspot-detect.html", get(captive_redirect))
        .route("/generate_204", get(captive_redirect))
        .route("/connecttest.txt", get(captive_redirect))
        .route("/ncsi.txt", get(captive_redirect))
        .route("/library/test/success.html", get(captive_redirect))
        .fallback(get(captive_redirect))
        .with_state(app_state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", 80))
        .await
        .context("bind :80")?;

    axum::serve(listener, app)
        .with_graceful_shutdown(async move { shutdown.notified().await })
        .await
        .context("axum serve")?;

    tear_down_ap().await.ok();
    clear_active_marker().await.ok();
    mark_configured(&args.marker).await?;
    tracing::info!("exiting after successful WiFi configuration");
    Ok(())
}

#[derive(Clone)]
struct AppState {
    networks: Vec<Network>,
    shutdown: Arc<Notify>,
    country: String,
    id: String,
}

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
struct Network {
    ssid: String,
    signal: i32,
    security: String,
}

#[derive(Deserialize)]
struct ConnectForm {
    ssid: String,
    psk: String,
}

async fn captive_redirect() -> Redirect {
    Redirect::to("http://10.42.0.1/")
}

async fn form(State(state): State<Arc<AppState>>) -> Html<String> {
    let mut options = String::from(r#"<option value="" disabled selected>Pick a network…</option>"#);
    for n in &state.networks {
        if n.ssid.is_empty() {
            continue;
        }
        let signal_pct = n.signal.clamp(0, 100);
        options.push_str(&format!(
            r#"<option value="{ssid}">{ssid} ({signal}% — {sec})</option>"#,
            ssid = html_escape(&n.ssid),
            signal = signal_pct,
            sec = html_escape(&n.security),
        ));
    }

    Html(format!(
        r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LED matrix setup</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #111; color: #eee; }}
  h1 {{ font-size: 1.4em; margin: 0 0 4px; }}
  p.muted {{ color: #888; margin: 0 0 24px; font-size: 0.9em; }}
  form {{ display: grid; gap: 12px; max-width: 420px; margin: 0 auto; }}
  label {{ display: grid; gap: 4px; font-size: 0.9em; color: #bbb; }}
  select, input[type=text], input[type=password] {{
    padding: 12px; font-size: 1em; border-radius: 8px; border: 1px solid #333;
    background: #1c1c1c; color: #eee;
  }}
  button {{
    padding: 14px; font-size: 1em; border-radius: 8px; border: 0;
    background: #4d8eff; color: white; cursor: pointer; margin-top: 8px;
  }}
  button:disabled {{ opacity: 0.5; }}
  details {{ margin-top: 12px; color: #888; font-size: 0.9em; }}
  details input {{ width: 100%; box-sizing: border-box; }}
  .err {{ color: #ff6b6b; font-size: 0.9em; }}
</style>
</head>
<body>
  <h1>LED matrix WiFi setup</h1>
  <p class="muted">Pick a network and enter the password. The Pi will join it and finish setup automatically.</p>
  <form method="post" action="/connect">
    <label>Network
      <select name="ssid" required>
        {options}
      </select>
    </label>
    <label>Password
      <input type="password" name="psk" autocomplete="off" required minlength="8">
    </label>
    <details>
      <summary>Network not listed?</summary>
      <label style="margin-top:8px;">SSID
        <input type="text" name="ssid_manual" placeholder="enter SSID manually">
      </label>
    </details>
    <button type="submit">Connect</button>
  </form>
</body>
</html>"##
    ))
}

async fn connect_handler(
    State(state): State<Arc<AppState>>,
    Form(form): Form<ConnectForm>,
) -> (axum::http::StatusCode, Html<String>) {
    let ssid = form.ssid.trim().to_string();
    if ssid.is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Html("missing ssid".to_string()),
        );
    }
    let psk = form.psk;
    tracing::info!(%ssid, "applying network");

    let result = apply_network(&ssid, &psk, &state.country).await;
    match result {
        Ok(()) => {
            // Defer the actual shutdown briefly so the success page renders.
            let shutdown = state.shutdown.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                shutdown.notify_one();
            });
            (axum::http::StatusCode::OK, Html(success_page().to_string()))
        }
        Err(err) => {
            tracing::warn!(error = %err, "apply failed; restoring AP");
            // Bringing up a STA connection on wlan0 tears the AP down. If the
            // user's PSK is wrong, the STA attempt fails and we'd be stranded
            // without an AP. Restore it so they can reconnect and retry.
            let ap_ssid = format!("led-setup-{}", state.id);
            if let Err(reup) = bring_up_ap(&ap_ssid).await {
                tracing::error!(error = %reup, "failed to re-arm AP after STA failure");
            }
            (
                axum::http::StatusCode::OK,
                Html(error_page(&format!("{err:#}"))),
            )
        }
    }
}

fn success_page() -> &'static str {
    r##"<!doctype html>
<html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#111;color:#eee;padding:32px;text-align:center}</style>
</head>
<body>
<h1>WiFi configured ✓</h1>
<p>The Pi will finish setup and join the tailnet shortly. You can disconnect from this network.</p>
</body></html>"##
}

fn error_page(msg: &str) -> String {
    format!(
        r##"<!doctype html>
<html><head><meta charset="utf-8"><title>Couldn't connect</title>
<style>body{{font-family:-apple-system,system-ui,sans-serif;background:#111;color:#eee;padding:32px}}</style>
</head>
<body>
<h1>Couldn't connect</h1>
<p class="err">{msg}</p>
<p><a href="/" style="color:#4d8eff">Try again</a></p>
</body></html>"##,
        msg = html_escape(msg)
    )
}

async fn apply_network(ssid: &str, psk: &str, _country: &str) -> Result<()> {
    tear_down_ap().await.ok();

    // Remove any prior connection of the same name to keep state idempotent.
    let _ = nmcli(["connection", "delete", "led-wifi"]).await;

    // IPv6 is disabled on this connection. Reason: home routers
    // commonly hand out a SLAAC global address but don't actually
    // forward IPv6 upstream. With v6 enabled, NetworkManager sets it
    // as the default for routing+DNS; tailscaled then prefers the
    // AAAA record for controlplane.tailscale.com and stalls on TCP
    // connect for the full timeout. Disabling v6 entirely sidesteps
    // happy-eyeballs corner cases on cheap CPE.
    nmcli([
        "connection",
        "add",
        "type",
        "wifi",
        "ifname",
        "wlan0",
        "con-name",
        "led-wifi",
        "ssid",
        ssid,
        "wifi-sec.key-mgmt",
        "wpa-psk",
        "wifi-sec.psk",
        psk,
        "ipv6.method",
        "disabled",
        "connection.autoconnect",
        "yes",
    ])
    .await
    .context("nmcli connection add")?;

    nmcli(["connection", "up", "led-wifi"])
        .await
        .context("nmcli connection up")?;

    let deadline = tokio::time::Instant::now() + APPLY_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        if has_active_wifi().await.unwrap_or(false) {
            return Ok(());
        }
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
    bail!("timed out waiting for WiFi to come up after submitting credentials");
}

async fn bring_up_ap(ssid: &str) -> Result<()> {
    let _ = nmcli(["connection", "delete", AP_CONNECTION]).await;

    // OPEN AP: do NOT pass `wifi-sec.key-mgmt`. NetworkManager treats
    // `key-mgmt=none` as legacy WEP and demands a `wep-key0`, which fails
    // activation. Omitting the security block entirely yields a true
    // open network (which is what we want for the captive-portal flow).
    nmcli([
        "connection",
        "add",
        "type",
        "wifi",
        "ifname",
        "wlan0",
        "con-name",
        AP_CONNECTION,
        "ssid",
        ssid,
        "mode",
        "ap",
        "ipv4.method",
        "shared",
        "ipv4.addresses",
        "10.42.0.1/24",
        "ipv6.method",
        "ignore",
        "connection.autoconnect",
        "no",
    ])
    .await
    .context("nmcli AP add")?;

    nmcli(["connection", "up", AP_CONNECTION])
        .await
        .context("nmcli AP up")?;
    Ok(())
}

async fn tear_down_ap() -> Result<()> {
    let _ = nmcli(["connection", "down", AP_CONNECTION]).await;
    let _ = nmcli(["connection", "delete", AP_CONNECTION]).await;
    Ok(())
}

async fn scan_networks() -> Result<Vec<Network>> {
    // `--rescan yes` forces a fresh scan; safe before any AP is up.
    let out = Command::new("nmcli")
        .args([
            "-t",
            "-f",
            "SSID,SIGNAL,SECURITY",
            "device",
            "wifi",
            "list",
            "--rescan",
            "yes",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    if !out.status.success() {
        return Ok(Vec::new());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut networks: Vec<Network> = Vec::new();
    for line in text.lines() {
        // Fields are colon-separated, but SSIDs themselves may contain `:`
        // escaped as `\:`. nmcli `-t` handles this with backslash escapes.
        let parts = split_nmcli_terse(line);
        if parts.len() < 3 {
            continue;
        }
        let ssid = parts[0].clone();
        let signal: i32 = parts[1].parse().unwrap_or(0);
        let security = parts[2].clone();
        if ssid.is_empty() || ssid == "--" {
            continue;
        }
        if !networks.iter().any(|n| n.ssid == ssid) {
            networks.push(Network {
                ssid,
                signal,
                security,
            });
        }
    }
    networks.sort_by(|a, b| b.signal.cmp(&a.signal));
    Ok(networks)
}

fn split_nmcli_terse(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut iter = line.chars().peekable();
    while let Some(c) = iter.next() {
        if c == '\\' {
            if let Some(&next) = iter.peek() {
                cur.push(next);
                iter.next();
            }
        } else if c == ':' {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    out.push(cur);
    out
}

async fn has_active_wifi() -> Result<bool> {
    let out = Command::new("nmcli")
        .args(["-t", "-f", "TYPE,STATE", "device"])
        .output()
        .await?;
    if !out.status.success() {
        return Ok(false);
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let parts: Vec<&str> = line.splitn(2, ':').collect();
        if parts.len() == 2 && parts[0] == "wifi" && parts[1] == "connected" {
            // Make sure it's not just our AP that's "connected".
            let active = nmcli_value(["-t", "-f", "NAME,DEVICE", "connection", "show", "--active"])
                .await
                .unwrap_or_default();
            for entry in active.lines() {
                let bits: Vec<&str> = entry.splitn(2, ':').collect();
                if bits.len() == 2 && bits[1].starts_with("wlan") && bits[0] != AP_CONNECTION {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

async fn set_country(country: &str) -> Result<()> {
    let out = Command::new("iw")
        .args(["reg", "set", country])
        .output()
        .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("iw reg set {country}: {stderr}"));
    }
    Ok(())
}

async fn nmcli<I, S>(args: I) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let out = Command::new("nmcli").args(args).output().await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("nmcli failed: {}", stderr.trim()));
    }
    Ok(())
}

async fn nmcli_value<I, S>(args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let out = Command::new("nmcli").args(args).output().await?;
    if !out.status.success() {
        bail!("nmcli failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

async fn mark_configured(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    tokio::fs::write(path, b"").await?;
    Ok(())
}

/// Drop a marker file the led-driver reads to swap in the setup
/// frame. Two lines: SSID, portal URL. Lives in /run so it gets
/// nuked on reboot.
async fn write_active_marker(ssid: &str) -> Result<()> {
    let parent = Path::new(ACTIVE_MARK)
        .parent()
        .unwrap_or_else(|| Path::new("/run"));
    tokio::fs::create_dir_all(parent).await.ok();
    let body = format!("{ssid}\n{PORTAL_URL}\n");
    tokio::fs::write(ACTIVE_MARK, body).await?;
    Ok(())
}

async fn clear_active_marker() -> Result<()> {
    let _ = tokio::fs::remove_file(ACTIVE_MARK).await;
    Ok(())
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}
