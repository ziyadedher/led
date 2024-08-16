use std::{sync::Arc, time::Duration};

use parking_lot::RwLock;
use postgrest::Postgrest;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::display::{Panel, TextEntry};

const SUPABASE_POSTGREST_URL: &str = "https://ohowojanrhlzhgwuwkrd.supabase.co/rest/v1";
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ob3dvamFucmhsemhnd3V3a3JkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDg4ODIzOTQsImV4cCI6MjAyNDQ1ODM5NH0.cXhxyPzLcClJlbeOF9QbQ2txI7IJWrpifAK7esTt8Zc";

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

async fn maybe_download(last_updated: String, client: &Postgrest) -> anyhow::Result<Option<State>> {
    log::info!("Downloading state...");
    let now = Instant::now();
    log::debug!("Downloading panel information...");
    let panels: Vec<Panel> = serde_json::from_str(
        &client
            .from("panels")
            .select("*")
            .eq("id", "75097deb-6b35-4db2-a49e-ad638de4256c")
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
        log::debug!("State is up to date, skipping download");
        return Ok(None);
    }

    log::debug!("Downloading text entries...");
    let entries: Vec<TextEntry> = serde_json::from_str::<Vec<TextEntryResponse>>(
        &client
            .from("entries")
            .select("*")
            .eq("panel_id", "75097deb-6b35-4db2-a49e-ad638de4256c")
            .order("order.asc")
            .execute()
            .await?
            .text()
            .await?,
    )?
    .iter()
    .map(|x| x.data.clone())
    .collect();

    log::debug!("Setting liveness...");
    client
        .from("panels")
        .update(format!(
            "{{ \"last_seen\": \"{}\" }}",
            chrono::Utc::now().to_rfc3339()
        ))
        .eq("id", "75097deb-6b35-4db2-a49e-ad638de4256c")
        .execute()
        .await?;

    log::info!("Downloaded state, got {} entries", entries.len());
    log::debug!("Downloaded state in {:?}", now.elapsed());
    Ok(Some(State { panel, entries }))
}

pub async fn sync(state: Arc<RwLock<State>>) -> anyhow::Result<()> {
    log::info!("Initializing state sync...");
    let client = Postgrest::new(SUPABASE_POSTGREST_URL).insert_header("apikey", SUPABASE_ANON_KEY);

    log::info!(
        "Starting state sync loop ({}ms refresh period)...",
        REFRESH_PERIOD.as_millis()
    );
    let mut interval = tokio::time::interval(REFRESH_PERIOD);
    loop {
        interval.tick().await;
        let last_updated = state.read().panel.last_updated.clone();
        match maybe_download(last_updated, &client).await {
            Ok(None) => {}
            Ok(Some(new_state)) => {
                let mut state_write = state.write();
                *state_write = new_state;
            }
            Err(err) => {
                log::warn!("Failed to download state: {}, trying again...", err);
            }
        }
    }
}
