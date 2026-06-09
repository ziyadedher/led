//! `led-wifi-setup` — WiFi onboarding for an LED matrix Pi.
//!
//! Runs on every boot. Flow:
//!
//! 1. If NetworkManager has a stored `led-wifi` connection, wait up to
//!    [`AUTOCONNECT_BUDGET`] for it to come up. Quick-path: returns
//!    in one [`CHECK_INTERVAL`] (~2s) when wifi is reachable; budget
//!    only burns when the network is gone.
//! 2. Otherwise (true first boot, or stored network unreachable):
//!    bring up an open AP named `led-setup-<id>`, serve a captive
//!    portal at `http://10.42.0.1`, and wait for the user to submit
//!    new credentials. On submit, tear down the AP, apply the
//!    SSID+PSK via `nmcli`, exit 0 once the client connection comes up.
//!
//! No persistent marker file is used: the per-boot
//! `has_stored_wifi_config()` + `wait_for_wifi()` handshake is the
//! single source of truth, so moving a configured panel to a new
//! location auto-recovers into setup mode without manual intervention.
//!
//! Modern phones (iOS 14+, Android 11+) detect captive portals when
//! joining a network without internet and auto-open the relevant
//! page; for the rare laptop case the user can browse to
//! `http://10.42.0.1` manually.
//!
//! All NetworkManager interaction happens via the `nmcli` shell tool
//! to keep this binary's surface area small (no D-Bus binding).

use std::path::Path;
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
const STORED_CONNECTION: &str = "led-wifi";
const ACTIVE_MARK: &str = "/run/led-wifi-setup.active";
const PORTAL_URL: &str = "10.42.0.1";
const CHECK_INTERVAL: Duration = Duration::from_secs(2);
const APPLY_TIMEOUT: Duration = Duration::from_secs(45);
/// How long to wait for NM to autoconnect to a stored network before
/// giving up and arming the captive portal. Tuned so a healthy boot
/// barely notices it (NM autoconnects within ~5–10s) while a moved
/// or de-credentialed panel re-enters setup within ~half a minute.
const AUTOCONNECT_BUDGET: Duration = Duration::from_secs(30);

#[derive(Parser)]
#[clap(about = "WiFi onboarding for an LED matrix Pi.")]
struct Args {
    /// Identifier rendered into the AP SSID, e.g. `led-setup-<id>`.
    #[clap(long, env = "LED_WIFI_SETUP_ID", default_value = "matrix")]
    id: String,

    /// 2-letter ISO country code applied via `iw reg` and to the WiFi connection.
    #[clap(long, env = "WIFI_COUNTRY", default_value = "CA")]
    country: String,
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

    set_country(&args.country).await.ok();

    // If we have a stored connection, give NM a window to bring it up
    // before assuming we need a fresh onboarding. has_stored_wifi_config
    // is the difference between "first boot" (skip the wait) and
    // "moved to a new location" (wait, then enter AP mode).
    if has_stored_wifi_config().await {
        tracing::info!(
            budget_secs = AUTOCONNECT_BUDGET.as_secs(),
            "stored '{STORED_CONNECTION}' present; waiting for autoconnect"
        );
        if wait_for_wifi(AUTOCONNECT_BUDGET).await {
            tracing::info!("connected via stored config; nothing to do");
            return Ok(());
        }
        tracing::warn!(
            "stored '{STORED_CONNECTION}' did not connect within budget — \
             entering setup mode (new location? credentials changed?)",
        );
    } else {
        tracing::info!("no stored '{STORED_CONNECTION}' connection; entering setup mode");
    }

    let ssid = format!("led-setup-{}", args.id);
    tracing::info!(%ssid, "bringing up onboarding AP");

    let networks = scan_networks().await.unwrap_or_default();
    tracing::info!(networks = networks.len(), "scanned");

    bring_up_ap(&ssid).await.context("bring up AP")?;
    write_active_marker(&ssid).await.ok();

    let shutdown = Arc::new(Notify::new());
    let app_state = Arc::new(AppState {
        networks,
        shutdown: shutdown.clone(),
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
    tracing::info!("exiting after successful WiFi configuration");
    Ok(())
}

#[derive(Clone)]
struct AppState {
    networks: Vec<Network>,
    shutdown: Arc<Notify>,
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
    #[serde(default)]
    ssid: String,
    /// Manually-typed SSID (hidden network); overrides the dropdown.
    #[serde(default)]
    ssid_manual: String,
    /// "personal" (WPA-PSK) or "enterprise" (WPA-EAP / 802.1X). Empty
    /// defaults to personal.
    #[serde(default)]
    mode: String,
    // Personal:
    #[serde(default)]
    psk: String,
    // Enterprise (802.1X username/password — PEAP or TTLS):
    #[serde(default)]
    eap: String,
    #[serde(default)]
    phase2: String,
    #[serde(default)]
    identity: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    anonymous: String,
}

/// How to authenticate to the chosen network.
enum NetworkAuth {
    /// Open network — no security.
    Open,
    /// Personal password. `sae` selects WPA3 (key-mgmt `sae`) vs WPA2
    /// (`wpa-psk`); deriving this from the scanned security is what lets
    /// a WPA3-Personal network join — forcing `wpa-psk` makes a
    /// WPA3/SAE AP reject every BSS (ssid-not-found).
    Psk { psk: String, sae: bool },
    /// WPA/WPA2/WPA3-Enterprise (802.1X) with a username + password.
    /// `eap` is `peap`|`ttls`; `phase2` is the inner auth
    /// (`mschapv2`|`pap`). The server cert is not validated (no
    /// `ca-cert`), which is the pragmatic default for guest enterprise
    /// networks.
    Enterprise {
        eap: String,
        phase2: String,
        identity: String,
        password: String,
        anonymous: Option<String>,
    },
}

impl NetworkAuth {
    /// Short label for logs.
    fn kind(&self) -> &'static str {
        match self {
            NetworkAuth::Open => "open",
            NetworkAuth::Psk { sae: true, .. } => "psk-wpa3",
            NetworkAuth::Psk { sae: false, .. } => "psk-wpa2",
            NetworkAuth::Enterprise { .. } => "enterprise",
        }
    }
}

/// Personal key-management for a network given its scanned SECURITY
/// string (nmcli's `WPA2` / `WPA3` / `WPA2 WPA3` / `802.1X` / empty).
/// `None` when the network is open (caller maps that to no password).
fn psk_uses_sae(security: &str) -> bool {
    // A WPA3 (or WPA2/WPA3 transition) network supports SAE; pick it.
    // Pure WPA2/WPA1 uses WPA-PSK.
    security.to_ascii_uppercase().contains("WPA3")
}

fn is_open_security(security: &str) -> bool {
    let s = security.trim().to_ascii_uppercase();
    s.is_empty() || s == "--"
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
  fieldset {{ border: 1px solid #333; border-radius: 8px; padding: 12px; display: grid; gap: 12px; margin: 0; }}
  legend {{ color: #888; font-size: 0.85em; padding: 0 6px; }}
  .seg {{ display: flex; gap: 0; border: 1px solid #333; border-radius: 8px; overflow: hidden; }}
  .seg label {{ flex: 1; text-align: center; padding: 10px; cursor: pointer; color: #bbb; }}
  .seg input {{ position: absolute; opacity: 0; }}
  .seg input:checked + span {{ color: #fff; }}
  .seg label:has(input:checked) {{ background: #2a3550; }}
</style>
</head>
<body>
  <h1>LED matrix WiFi setup</h1>
  <p class="muted">Pick a network and sign in. The Pi will join it and finish setup automatically.</p>
  <form method="post" action="/connect">
    <label>Network
      <select name="ssid" required>
        {options}
      </select>
    </label>

    <div class="seg">
      <label><input type="radio" name="mode" value="personal" checked onchange="updateMode()"><span>Personal</span></label>
      <label><input type="radio" name="mode" value="enterprise" onchange="updateMode()"><span>Enterprise</span></label>
    </div>

    <div id="personal-fields">
      <label>Password
        <input type="password" name="psk" autocomplete="off" minlength="8">
      </label>
    </div>

    <fieldset id="enterprise-fields" hidden>
      <legend>Enterprise (802.1X) login</legend>
      <label>Username
        <input type="text" name="identity" autocomplete="username" placeholder="you@company.com">
      </label>
      <label>Password
        <input type="password" name="password" autocomplete="current-password">
      </label>
      <details>
        <summary>Advanced</summary>
        <label style="margin-top:8px;">EAP method
          <select name="eap">
            <option value="peap" selected>PEAP</option>
            <option value="ttls">TTLS</option>
          </select>
        </label>
        <label style="margin-top:8px;">Inner auth
          <select name="phase2">
            <option value="mschapv2" selected>MSCHAPv2</option>
            <option value="pap">PAP</option>
          </select>
        </label>
        <label style="margin-top:8px;">Anonymous identity (optional)
          <input type="text" name="anonymous" placeholder="anonymous@company.com">
        </label>
      </details>
    </fieldset>

    <details>
      <summary>Network not listed?</summary>
      <label style="margin-top:8px;">SSID
        <input type="text" name="ssid_manual" placeholder="enter SSID manually">
      </label>
    </details>
    <button type="submit">Connect</button>
  </form>
  <script>
    function updateMode() {{
      var ent = document.querySelector('input[name=mode]:checked').value === 'enterprise';
      var p = document.getElementById('personal-fields');
      var e = document.getElementById('enterprise-fields');
      p.hidden = ent; e.hidden = !ent;
      // Disabled inputs aren't submitted and skip validation, so the
      // hidden section's `required`/`minlength` can't block the form.
      p.querySelectorAll('input').forEach(function(i) {{ i.disabled = ent; }});
      e.querySelectorAll('input,select').forEach(function(i) {{ i.disabled = !ent; }});
    }}
    updateMode();
  </script>
</body>
</html>"##
    ))
}

async fn connect_handler(
    State(state): State<Arc<AppState>>,
    Form(form): Form<ConnectForm>,
) -> (axum::http::StatusCode, Html<String>) {
    // A manually-typed SSID (hidden network) overrides the dropdown.
    let ssid = {
        let manual = form.ssid_manual.trim();
        if manual.is_empty() {
            form.ssid.trim().to_string()
        } else {
            manual.to_string()
        }
    };
    if ssid.is_empty() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Html(error_page("Pick or enter a network name.")),
        );
    }

    let bad = |msg: &str| {
        (
            axum::http::StatusCode::BAD_REQUEST,
            Html(error_page(msg)),
        )
    };
    // The scanned security for the chosen SSID decides WPA2 vs WPA3 vs
    // open on the personal path. `None` = not in the scan (a manually-
    // typed/hidden SSID), which we treat as secured-unknown (require a
    // password, default WPA-PSK) rather than open.
    let scanned_security = state
        .networks
        .iter()
        .find(|n| n.ssid == ssid)
        .map(|n| n.security.clone());

    let auth = if form.mode == "enterprise" {
        let identity = form.identity.trim().to_string();
        let password = form.password;
        if identity.is_empty() || password.is_empty() {
            return bad("Enterprise networks need a username and password.");
        }
        let eap = if form.eap == "ttls" { "ttls" } else { "peap" }.to_string();
        let phase2 = if form.phase2 == "pap" { "pap" } else { "mschapv2" }.to_string();
        let anonymous = {
            let a = form.anonymous.trim();
            if a.is_empty() {
                None
            } else {
                Some(a.to_string())
            }
        };
        NetworkAuth::Enterprise { eap, phase2, identity, password, anonymous }
    } else if matches!(&scanned_security, Some(s) if is_open_security(s)) {
        // Scanned and genuinely open — no password needed.
        NetworkAuth::Open
    } else {
        if form.psk.is_empty() {
            return bad("Enter the network password.");
        }
        // WPA3 → SAE; WPA2/unknown → WPA-PSK.
        let sae = scanned_security
            .as_deref()
            .is_some_and(psk_uses_sae);
        NetworkAuth::Psk { psk: form.psk, sae }
    };
    tracing::info!(
        %ssid,
        security = scanned_security.as_deref().unwrap_or("(unscanned)"),
        kind = auth.kind(),
        "applying network"
    );

    let result = apply_network(&ssid, &auth).await;
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

async fn apply_network(ssid: &str, auth: &NetworkAuth) -> Result<()> {
    tear_down_ap().await.ok();

    // Remove any prior connection of the same name to keep state idempotent.
    let _ = nmcli(["connection", "delete", "led-wifi"]).await;

    // Build the `nmcli connection add` argument list. Common shell +
    // the per-auth security settings.
    let mut args: Vec<String> = [
        "connection", "add", "type", "wifi", "ifname", "wlan0", "con-name",
        "led-wifi", "ssid", ssid,
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();

    let mut push = |k: &str, v: &str| {
        args.push(k.to_string());
        args.push(v.to_string());
    };
    match auth {
        NetworkAuth::Open => {
            // No security block — see `bring_up_ap` for why key-mgmt
            // none is avoided.
        }
        NetworkAuth::Psk { psk, sae } => {
            // SAE = WPA3-Personal (the password goes in the same
            // wifi-sec.psk field; NM negotiates the mandatory PMF).
            // wpa-psk = WPA/WPA2. Forcing wpa-psk on a WPA3 network was
            // the bug that produced ssid-not-found.
            push("wifi-sec.key-mgmt", if *sae { "sae" } else { "wpa-psk" });
            push("wifi-sec.psk", psk);
        }
        NetworkAuth::Enterprise {
            eap,
            phase2,
            identity,
            password,
            anonymous,
        } => {
            push("wifi-sec.key-mgmt", "wpa-eap");
            push("802-1x.eap", eap);
            push("802-1x.phase2-auth", phase2);
            push("802-1x.identity", identity);
            push("802-1x.password", password);
            if let Some(anon) = anonymous {
                push("802-1x.anonymous-identity", anon);
            }
        }
    }
    // IPv6 is disabled on this connection. Reason: home routers
    // commonly hand out a SLAAC global address but don't actually
    // forward IPv6 upstream. With v6 enabled, NetworkManager sets it
    // as the default for routing+DNS; tailscaled then prefers the
    // AAAA record for controlplane.tailscale.com and stalls on TCP
    // connect for the full timeout. Disabling v6 entirely sidesteps
    // happy-eyeballs corner cases on cheap CPE.
    push("ipv6.method", "disabled");
    push("connection.autoconnect", "yes");

    nmcli(args).await.context("nmcli connection add")?;

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

/// Whether NetworkManager already has an `led-wifi` connection on
/// disk. Distinguishes "first boot, never onboarded" from "previously
/// onboarded, network might just be unreachable right now". On a
/// failed `nmcli` invocation we conservatively assume yes — better
/// to wait the budget out than to immediately tear into setup mode
/// while NM is still booting.
async fn has_stored_wifi_config() -> bool {
    let out = match Command::new("nmcli")
        .args(["-t", "-f", "NAME", "connection"])
        .output()
        .await
    {
        Ok(o) => o,
        Err(err) => {
            tracing::warn!(%err, "nmcli connection list failed; assuming stored config exists");
            return true;
        }
    };
    if !out.status.success() {
        return true;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|name| name == STORED_CONNECTION)
}

/// Poll [`has_active_wifi`] every [`CHECK_INTERVAL`] until either it
/// returns true or `budget` elapses. Returns `true` on success,
/// `false` on timeout. Quick-path: returns within one poll cycle when
/// wifi is already up.
async fn wait_for_wifi(budget: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if has_active_wifi().await.unwrap_or(false) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wpa3_networks_use_sae() {
        // WPA3-only and WPA2/WPA3 transition both support SAE.
        assert!(psk_uses_sae("WPA3"));
        assert!(psk_uses_sae("WPA2 WPA3"));
        assert!(psk_uses_sae("wpa3"));
        // Pure WPA2/WPA1 do not.
        assert!(!psk_uses_sae("WPA2"));
        assert!(!psk_uses_sae("WPA1 WPA2"));
        assert!(!psk_uses_sae(""));
    }

    #[test]
    fn open_security_detection() {
        assert!(is_open_security(""));
        assert!(is_open_security("  "));
        assert!(is_open_security("--"));
        assert!(!is_open_security("WPA2"));
        assert!(!is_open_security("WPA3"));
    }
}
