//! Postgres LISTEN/NOTIFY listener.
//!
//! Subscribes to the `panel_change` channel emitted by the migration
//! triggers on `entries` and `panels`. Each notification carries the
//! affected panel id; we filter against ours and signal the sync loop
//! to re-pull state. Reconnects on connection loss; the sync loop's
//! polling fallback covers any gap.

use std::time::Duration;

use anyhow::Context as _;
use futures_channel::mpsc as futures_mpsc;
use futures_util::{stream, SinkExt as _, StreamExt as _};
use rustls::ClientConfig;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_postgres::{AsyncMessage, Config as PgConfig};
use tokio_postgres_rustls::MakeRustlsConnect;

const RECONNECT_BACKOFF: Duration = Duration::from_secs(5);

/// Run the listener forever. Sends `()` on `nudge_tx` whenever a
/// `panel_change` notification arrives matching `panel_id`. Returns
/// only on unrecoverable errors — transient disconnects retry.
pub async fn run(
    database_url: String,
    panel_id: String,
    nudge_tx: mpsc::Sender<()>,
) -> anyhow::Result<()> {
    let pg_config: PgConfig = database_url
        .parse()
        .context("parse database_url as Postgres connection string")?;
    let tls = make_tls()?;

    loop {
        match connect_and_listen(&pg_config, &tls, &panel_id, &nudge_tx).await {
            Ok(()) => {
                // Stream ended cleanly (rare). Reconnect after backoff.
                tracing::warn!("Postgres LISTEN stream ended, reconnecting");
            }
            Err(err) => {
                tracing::warn!(error = %err, "Postgres LISTEN failed, retrying");
            }
        }
        sleep(RECONNECT_BACKOFF).await;
    }
}

async fn connect_and_listen(
    pg_config: &PgConfig,
    tls: &MakeRustlsConnect,
    panel_id: &str,
    nudge_tx: &mpsc::Sender<()>,
) -> anyhow::Result<()> {
    tracing::info!("Connecting to Postgres for LISTEN/NOTIFY...");
    let (client, mut connection) = pg_config
        .connect(tls.clone())
        .await
        .context("Postgres connect")?;

    // tokio-postgres's Connection drives I/O and exposes async messages
    // (notifications, notices) only via `poll_message`. Wrap it in a
    // stream and forward into a channel so the main task can `await`.
    let (mut msg_tx, mut msg_rx) = futures_mpsc::unbounded::<AsyncMessage>();
    let stream = stream::poll_fn(move |cx| connection.poll_message(cx));
    tokio::spawn(async move {
        let mut s = std::pin::pin!(stream);
        while let Some(msg) = s.next().await {
            let Ok(msg) = msg else { break };
            if msg_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    client
        .batch_execute("LISTEN panel_change")
        .await
        .context("LISTEN panel_change")?;
    tracing::info!(panel_id, "Postgres LISTEN active");

    // Nudge once on every fresh connection — covers initial startup
    // and the race window between a dropped subscription and the
    // re-LISTEN where notifications would otherwise be lost.
    let _ = nudge_tx.try_send(());

    while let Some(msg) = msg_rx.next().await {
        if let AsyncMessage::Notification(n) = msg {
            if n.channel() == "panel_change" && n.payload() == panel_id {
                // try_send so a slow consumer never blocks the listener.
                let _ = nudge_tx.try_send(());
            }
        }
    }
    Ok(())
}

fn make_tls() -> anyhow::Result<MakeRustlsConnect> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(MakeRustlsConnect::new(config))
}
