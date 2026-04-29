use std::{sync::Arc, time::Duration};

use parking_lot::RwLock;
use postgrest::Postgrest;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::display::{Panel, TextEntry};
use crate::telemetry::Metrics;

const HEARTBEAT_PERIOD: Duration = Duration::from_secs(30);

#[derive(PartialEq, Eq, Clone, Debug, Default, Deserialize, Serialize)]
pub struct State {
    /// Panel configuration.
    pub panel: Panel,
    /// List of text entries currently loaded on the display. Note that not all of them may be visible at once.
    pub entries: Vec<TextEntry>,
}

#[derive(Deserialize, Serialize)]
struct TextEntryResponse {
    data: TextEntry,
}

// Wall-clock cap on a single Postgrest request during the initial
// panel-id resolve. The postgrest crate uses async reqwest with no
// timeout by default, so without this we'd hang forever on a
// transient network blip. 15s is long enough to absorb DNS slow
// starts on a freshly-up wlan0 + a slow first TLS handshake to
// Supabase.
const PANEL_ID_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const PANEL_ID_RETRY_BACKOFF: Duration = Duration::from_secs(5);

/// Resolve our panel id, retrying forever on failure. Driver renders
/// the boot frame in the meantime; once this returns the realtime
/// listener spawns + sync starts.
async fn get_panel_id(panel_name: &str, client: &Postgrest) -> String {
    loop {
        match tokio::time::timeout(
            PANEL_ID_REQUEST_TIMEOUT,
            try_get_panel_id(panel_name, client),
        )
        .await
        {
            Ok(Ok(id)) => return id,
            Ok(Err(err)) => {
                tracing::warn!(error = %err, "panel id resolve failed, retrying");
            }
            Err(_) => {
                tracing::warn!(
                    timeout_s = PANEL_ID_REQUEST_TIMEOUT.as_secs(),
                    "panel id resolve timed out, retrying"
                );
            }
        }
        tokio::time::sleep(PANEL_ID_RETRY_BACKOFF).await;
    }
}

async fn try_get_panel_id(panel_name: &str, client: &Postgrest) -> anyhow::Result<String> {
    tracing::debug!("Getting panel ID for name {}...", panel_name);
    let panels: Vec<Panel> = serde_json::from_str(
        &client
            .from("panels")
            .select("*")
            .eq("name", panel_name)
            .execute()
            .await?
            .text()
            .await?,
    )?;

    match panels.len() {
        0 => {
            tracing::warn!("Panel not found, creating...");
            // `Default` for Panel leaves `mode = ""` (empty string), but the
            // dash and dispatch logic both expect `"text"`. Fill it explicitly
            // so freshly auto-created panels render text mode. mode_config
            // must be a JSON object too — the column is `not null` and our
            // Default for JsonValue is `Null`, which PostgREST refuses.
            let new_panel = Panel {
                name: panel_name.to_string(),
                mode: "text".to_string(),
                mode_config: serde_json::json!({}),
                ..Default::default()
            };
            let response = client
                .from("panels")
                .insert(serde_json::to_string(&new_panel)?)
                .execute()
                .await?;
            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                anyhow::bail!("panel insert returned {status}: {text}");
            }
            // Re-select by name; the insert response shape is `Prefer`-dependent.
            let _ = response.text().await;
            let panels: Vec<Panel> = serde_json::from_str(
                &client
                    .from("panels")
                    .select("*")
                    .eq("name", panel_name)
                    .execute()
                    .await?
                    .text()
                    .await?,
            )?;
            panels
                .into_iter()
                .next()
                .map(|p| p.id)
                .ok_or_else(|| anyhow::anyhow!("freshly-created panel disappeared on read-back"))
        }
        1 => {
            tracing::debug!("Panel found with ID {}", panels[0].id);
            Ok(panels[0].id.clone())
        }
        _ => Err(anyhow::anyhow!(
            "Multiple panels found with name {}",
            panel_name
        )),
    }
}

async fn touch_last_seen(panel_id: &str, client: &Postgrest) -> anyhow::Result<()> {
    let body = serde_json::json!({ "last_seen": chrono::Utc::now().to_rfc3339() }).to_string();
    let response = client
        .from("panels")
        .eq("id", panel_id)
        .update(body)
        .execute()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        anyhow::bail!("last_seen update returned {status}: {text}");
    }
    Ok(())
}

async fn report_driver_version(panel_id: &str, client: &Postgrest) -> anyhow::Result<()> {
    tracing::info!(version = crate::DRIVER_VERSION, "Reporting driver version");
    let body = serde_json::json!({ "driver_version": crate::DRIVER_VERSION }).to_string();
    let response = client
        .from("panels")
        .eq("id", panel_id)
        .update(body)
        .execute()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        anyhow::bail!("driver_version update returned {status}: {text}");
    }
    Ok(())
}

async fn maybe_download(
    panel_id: &str,
    last_updated: &str,
    client: &Postgrest,
) -> anyhow::Result<Option<State>> {
    tracing::info!("Downloading state...");
    let now = Instant::now();
    tracing::debug!("Downloading panel information...");
    let panels: Vec<Panel> = serde_json::from_str(
        &client
            .from("panels")
            .select("*")
            .eq("id", panel_id)
            .execute()
            .await?
            .text()
            .await?,
    )?;
    let panel = panels
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No panel found"))?;

    if panel.last_updated == last_updated {
        tracing::debug!("State is up to date, skipping download");
        return Ok(None);
    }

    tracing::debug!("Downloading text entries...");
    let entries: Vec<TextEntry> = serde_json::from_str::<Vec<TextEntryResponse>>(
        &client
            .from("entries")
            .select("*")
            .eq("panel_id", panel_id)
            .order("order.asc")
            .execute()
            .await?
            .text()
            .await?,
    )?
    .into_iter()
    .map(|x| x.data)
    .collect();

    tracing::info!("Downloaded state, got {} entries", entries.len());
    tracing::debug!("Downloaded state in {:?}", now.elapsed());
    Ok(Some(State { panel, entries }))
}

pub async fn sync(
    panel_name: String,
    supabase_url: String,
    supabase_anon_key: String,
    state: Arc<RwLock<State>>,
    metrics: Arc<Metrics>,
) -> anyhow::Result<()> {
    tracing::info!("Initializing state sync...");
    let postgrest_url = format!("{}/rest/v1", supabase_url.trim_end_matches('/'));
    let client = Postgrest::new(&postgrest_url).insert_header("apikey", &supabase_anon_key);

    let panel_id = get_panel_id(&panel_name, &client).await;
    tracing::info!("Using panel ID: {}", panel_id);

    // Stamp our build version on the panel row so the dash can flag
    // Pis running an older binary than the rest of the fleet. Best
    // effort — a failure here doesn't block startup.
    if let Err(err) = report_driver_version(&panel_id, &client).await {
        tracing::warn!(error = %err, "couldn't write driver_version");
    }

    // Realtime subscriber: each postgres_changes event for our panel
    // pushes a nudge here. The subscriber also nudges on every fresh
    // connection (initial startup + reconnect after drop), so we
    // always do a full pull when the channel comes up.
    let (nudge_tx, mut nudge_rx) = mpsc::channel::<()>(8);
    {
        let url = supabase_url.clone();
        let key = supabase_anon_key.clone();
        let panel_id = panel_id.clone();
        let tx = nudge_tx.clone();
        tokio::spawn(async move {
            if let Err(err) = crate::realtime::run(url, key, panel_id, tx).await {
                tracing::error!(error = %err, "realtime subscriber exited (unrecoverable)");
            }
        });
    }

    // Heartbeat: bump the metric (telemetry liveness) and write
    // panels.last_seen (dash liveness) on the same cadence. The dash
    // marks panels offline when last_seen is stale — independent of
    // last_updated, which only moves when entry data changes.
    let heartbeat_metrics = metrics.clone();
    let heartbeat_client = client.clone();
    let heartbeat_panel_id = panel_id.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(HEARTBEAT_PERIOD);
        loop {
            tick.tick().await;
            heartbeat_metrics.heartbeat.add(1, &[]);
            if let Err(err) = touch_last_seen(&heartbeat_panel_id, &heartbeat_client).await {
                tracing::warn!(error = %err, "couldn't update last_seen");
            }
        }
    });

    tracing::info!("Sync loop running — pulling on realtime nudges");
    while let Some(()) = nudge_rx.recv().await {
        // Drain any coalesced nudges; we only need one pull.
        while nudge_rx.try_recv().is_ok() {}

        let started = Instant::now();
        let last_updated = state.read().panel.last_updated.clone();
        match maybe_download(&panel_id, &last_updated, &client).await {
            Ok(None) => {}
            Ok(Some(new_state)) => {
                metrics
                    .entries_loaded
                    .record(new_state.entries.len() as u64, &[]);
                let mut state_write = state.write();
                *state_write = new_state;
            }
            Err(err) => {
                tracing::warn!(error = %err, "pull failed; will retry on next nudge");
            }
        }
        metrics
            .sync_duration_ms
            .record(started.elapsed().as_secs_f64() * 1000.0, &[]);
    }
    Ok(())
}
