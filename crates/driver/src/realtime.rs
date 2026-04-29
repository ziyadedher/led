//! Supabase Realtime WebSocket subscriber.
//!
//! Subscribes to `postgres_changes` for our panel — both the `panels`
//! row (`id=eq.<panel_id>`) and the `entries` rows
//! (`panel_id=eq.<panel_id>`) — over `wss://<ref>.supabase.co/realtime/v1`.
//! Each event nudges the sync loop, which then re-pulls authoritative
//! state via PostgREST.
//!
//! The endpoint is part of the public `*.supabase.co` cert chain, so
//! tungstenite's webpki-roots-backed rustls config trusts it without
//! any custom CA — same chain PostgREST already rides on.
//!
//! Phoenix Channels protocol notes: messages are JSON objects with
//! `topic`/`event`/`payload`/`ref`/`join_ref`. Heartbeats go to topic
//! `phoenix`; the server boots us if it doesn't see one within ~60s.

use std::time::Duration;

use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::time::{interval, sleep};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const HEARTBEAT_PERIOD: Duration = Duration::from_secs(30);
const RECONNECT_BACKOFF: Duration = Duration::from_secs(5);

/// Run the listener forever. Sends `()` on `nudge_tx` whenever a
/// `postgres_changes` event arrives for our panel. Returns only on
/// unrecoverable errors — transient disconnects retry.
pub async fn run(
    supabase_url: String,
    anon_key: String,
    panel_id: String,
    nudge_tx: mpsc::Sender<()>,
) -> anyhow::Result<()> {
    let ws_url = build_ws_url(&supabase_url, &anon_key)?;

    loop {
        match connect_and_listen(&ws_url, &anon_key, &panel_id, &nudge_tx).await {
            Ok(()) => tracing::warn!("Realtime WebSocket closed cleanly, reconnecting"),
            Err(err) => tracing::warn!(error = ?err, "Realtime WebSocket failed, retrying"),
        }
        sleep(RECONNECT_BACKOFF).await;
    }
}

fn build_ws_url(supabase_url: &str, anon_key: &str) -> anyhow::Result<String> {
    let base = supabase_url.trim_end_matches('/');
    let scheme_swap = base
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| base.strip_prefix("http://").map(|rest| format!("ws://{rest}")))
        .with_context(|| format!("supabase_url has unrecognized scheme: {supabase_url}"))?;
    Ok(format!(
        "{scheme_swap}/realtime/v1/websocket?apikey={anon_key}&vsn=1.0.0"
    ))
}

async fn connect_and_listen(
    ws_url: &str,
    anon_key: &str,
    panel_id: &str,
    nudge_tx: &mpsc::Sender<()>,
) -> anyhow::Result<()> {
    tracing::info!("Connecting to Supabase Realtime...");
    let (mut ws, _resp) = connect_async(ws_url).await.context("realtime connect")?;

    // Topic must be unique per channel and start with `realtime:`.
    // The actual filter lives in the `config.postgres_changes` array.
    let topic = format!("realtime:driver:{panel_id}");
    let join = json!({
        "topic": topic,
        "event": "phx_join",
        "payload": {
            "config": {
                "postgres_changes": [
                    { "event": "*", "schema": "public", "table": "panels",
                      "filter": format!("id=eq.{panel_id}") },
                    { "event": "*", "schema": "public", "table": "entries",
                      "filter": format!("panel_id=eq.{panel_id}") }
                ]
            },
            "access_token": anon_key
        },
        "ref": "1",
        "join_ref": "1"
    });
    ws.send(Message::Text(join.to_string()))
        .await
        .context("send phx_join")?;
    tracing::info!(topic = %topic, "Realtime channel joined");

    // Refresh state on every fresh connection — covers initial startup
    // and the race window between drop and re-join where events would
    // otherwise be lost.
    let _ = nudge_tx.try_send(());

    let mut heartbeat = interval(HEARTBEAT_PERIOD);
    heartbeat.tick().await; // skip the immediate fire
    let mut next_ref: u64 = 2;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = json!({
                    "topic": "phoenix",
                    "event": "heartbeat",
                    "payload": {},
                    "ref": next_ref.to_string()
                });
                next_ref += 1;
                ws.send(Message::Text(hb.to_string()))
                    .await
                    .context("send heartbeat")?;
            }
            incoming = ws.next() => {
                let Some(msg) = incoming else { return Ok(()); };
                let msg = msg.context("ws recv")?;
                match msg {
                    Message::Text(text) => handle_event(&text, nudge_tx),
                    Message::Ping(payload) => {
                        ws.send(Message::Pong(payload)).await.ok();
                    }
                    Message::Close(_) => return Ok(()),
                    Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }
}

fn handle_event(text: &str, nudge_tx: &mpsc::Sender<()>) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        tracing::trace!(raw = %text, "Realtime: non-JSON frame ignored");
        return;
    };
    let event = value.get("event").and_then(Value::as_str).unwrap_or("");
    match event {
        "postgres_changes" => {
            // try_send so a slow consumer never blocks the listener.
            // sync.rs re-pulls canonical state — no need to parse the
            // payload's record/old_record diff.
            let _ = nudge_tx.try_send(());
        }
        "phx_error" | "phx_close" => {
            tracing::warn!(frame = %value, "Realtime control frame indicates trouble");
        }
        _ => {} // phx_reply, system, presence, etc.
    }
}
