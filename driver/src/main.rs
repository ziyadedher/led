#![warn(clippy::pedantic)]

use std::{
    env,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::Context;
use argh::FromArgs;
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use human_panic::setup_panic;
use rpi_led_panel::{LedSequence, RGBMatrixConfig};
use serde::{Deserialize, Serialize};
use tokio::{fs, join, spawn, sync::RwLock};
use tower_http::{
    cors::{self, CorsLayer},
    trace::TraceLayer,
};
use tracing_subscriber::prelude::*;

use led_driver::{
    display::{drive, State},
    routes::construct,
};

/// Configuration for the LED driver.
#[derive(Debug, FromArgs)]
struct Args {
    /// path to the cache file
    #[argh(option)]
    cache_path: PathBuf,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct Cache {
    state: Option<State>,
}

async fn load_cache(path: &Path) -> anyhow::Result<Cache> {
    log::debug!("Checking if cache file exists at {}...", path.display());
    if !path.exists() {
        log::warn!(
            "Could not find cache at {}, so creating and using an empty cache...",
            path.display()
        );
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .await
                .context("could not create path to cache file")?;
        }
        save_cache(path, &Cache::default()).await?;
    }

    log::debug!("Loading cache from {}...", path.display());
    let cache = serde_json::from_str(
        &fs::read_to_string(path)
            .await
            .context("could not read cache file")?,
    );
    match cache {
        Ok(cache) => {
            log::trace!("Loaded cache: {cache:#?}");
            Ok(cache)
        }
        Err(err) => {
            log::warn!(
                "Could not deserialize cache file at {}, wiping it and trying again...",
                path.display()
            );
            log::debug!("Cache deserialization error: {err}");
            save_cache(path, &Cache::default()).await?;
            serde_json::from_str(
                &fs::read_to_string(path)
                    .await
                    .context("could not read cache file")?,
            )
            .context("could not deserialize cache file")
        }
    }
}

async fn save_cache(path: &Path, cache: &Cache) -> anyhow::Result<()> {
    log::debug!("Saving cache to {}...", path.display());
    fs::write(
        path,
        serde_json::to_string_pretty(cache).context("could not serialize cache")?,
    )
    .await
    .context("could not write to cache file")?;
    log::trace!("Saved cache: {cache:#?}");

    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    setup_panic!();
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let config = RGBMatrixConfig {
        led_sequence: LedSequence::Bgr,
        ..Default::default()
    };
    let Args { cache_path } = argh::from_env();

    let cache = load_cache(&cache_path).await?;
    let state = Arc::new(RwLock::new(cache.state.unwrap_or_default()));

    let save_state = {
        let state = state.clone();

        async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));

            loop {
                interval.tick().await;
                log::debug!("Saving state...");
                let state = state.read().await.clone();
                let cache = Cache { state: Some(state) };
                if let Err(err) = save_cache(&cache_path.clone(), &cache).await {
                    log::error!("Could not save cache: {err}");
                }
            }
        }
    };

    let rustls_config = RustlsConfig::from_pem_file(
        "/etc/letsencrypt/live/driver.led.ziyadedher.com/fullchain.pem",
        "/etc/letsencrypt/live/driver.led.ziyadedher.com/privkey.pem",
    )
    .await?;
    let server = axum_server::bind_rustls("0.0.0.0:3001".parse()?, rustls_config).serve(
        Router::new()
            .merge(construct(state.clone()))
            .layer(TraceLayer::new_for_http())
            .layer(
                CorsLayer::new()
                    .allow_origin(cors::Any)
                    .allow_methods(cors::Any)
                    .allow_headers(cors::Any),
            )
            .into_make_service(),
    );

    let driver_task = spawn(drive(config, state));
    let server_task = spawn(server);
    let save_state_task = spawn(save_state);

    let (driver_res, server_res, save_state_res) = join!(driver_task, server_task, save_state_task);
    driver_res??;
    server_res??;
    save_state_res?;

    Ok(())
}
