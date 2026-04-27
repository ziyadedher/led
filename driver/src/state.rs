use std::{sync::Arc, time::Duration};

use parking_lot::RwLock;
use postgrest::Postgrest;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::display::{Panel, TextEntry};
use crate::telemetry::Metrics;

const REFRESH_PERIOD: Duration = Duration::from_millis(2500);

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

async fn get_panel_id(panel_name: &str, client: &Postgrest) -> anyhow::Result<String> {
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
            let new_panel = Panel {
                name: panel_name.to_string(),
                ..Default::default()
            };
            let created_panel: Panel = serde_json::from_str(
                &client
                    .from("panels")
                    .insert(serde_json::to_string(&new_panel)?)
                    .execute()
                    .await?
                    .text()
                    .await?,
            )?;
            Ok(created_panel.id)
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
    .iter()
    .map(|x| x.data.clone())
    .collect();

    tracing::info!("Downloaded state, got {} entries", entries.len());
    tracing::debug!("Downloaded state in {:?}", now.elapsed());
    Ok(Some(State { panel, entries }))
}

pub async fn sync(
    panel_name: String,
    supabase_url: &str,
    supabase_anon_key: &str,
    state: Arc<RwLock<State>>,
    metrics: Arc<Metrics>,
) -> anyhow::Result<()> {
    tracing::info!("Initializing state sync...");
    let postgrest_url = format!("{}/rest/v1", supabase_url.trim_end_matches('/'));
    let client = Postgrest::new(&postgrest_url).insert_header("apikey", supabase_anon_key);

    let panel_id = get_panel_id(&panel_name, &client).await?;
    tracing::info!("Using panel ID: {}", panel_id);

    tracing::info!(
        refresh_period_ms = REFRESH_PERIOD.as_millis() as u64,
        "Starting state sync loop"
    );
    let mut interval = tokio::time::interval(REFRESH_PERIOD);
    loop {
        interval.tick().await;

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
                tracing::warn!(error = %err, "Failed to download state, trying again");
            }
        }
        metrics
            .sync_duration_ms
            .record(started.elapsed().as_secs_f64() * 1000.0, &[]);
        metrics.heartbeat.add(1, &[]);
    }
}
