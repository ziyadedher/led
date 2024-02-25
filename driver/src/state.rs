use std::{sync::Arc, time::Duration};

use postgrest::Postgrest;
use serde::{Deserialize, Serialize};
use tokio::{sync::RwLock, time::Instant};

use crate::display::{Panel, TextEntry};

const SUPABASE_POSTGREST_URL: &str = "https://ohowojanrhlzhgwuwkrd.supabase.co/rest/v1";
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ob3dvamFucmhsemhnd3V3a3JkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDg4ODIzOTQsImV4cCI6MjAyNDQ1ODM5NH0.cXhxyPzLcClJlbeOF9QbQ2txI7IJWrpifAK7esTt8Zc";

const REFRESH_PERIOD: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
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

async fn download(client: Postgrest) -> anyhow::Result<State> {
    log::info!("Downloading state...");
    let now = Instant::now();

    log::debug!("Downloading panel information...");
    let panels: Vec<Panel> = client
        .from("panels")
        .select("*")
        .eq("id", "75097deb-6b35-4db2-a49e-ad638de4256c")
        .execute()
        .await?
        .json()
        .await?;
    let panel = panels
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No panel found"))?;

    log::debug!("Downloading text entries...");
    let entries: Vec<TextEntry> = client
        .from("entries")
        .select("*")
        .eq("panel_id", "75097deb-6b35-4db2-a49e-ad638de4256c")
        .execute()
        .await?
        .json::<Vec<TextEntryResponse>>()
        .await?
        .iter()
        .map(|x| x.data.clone())
        .collect();

    log::info!("Downloaded state, got {} entries", entries.len());
    log::debug!("Downloaded state in {:?}", now.elapsed());
    Ok(State { panel, entries })
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
        match download(client.clone()).await {
            Ok(new_state) => {
                *state.write().await = new_state;
            }
            Err(err) => {
                log::warn!("Failed to download state: {}, trying again...", err);
            }
        }
    }
}
