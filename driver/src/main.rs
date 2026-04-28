#![warn(clippy::all)]
#![warn(clippy::pedantic)]
#![warn(clippy::cargo)]

use std::{path::PathBuf, sync::Arc};

use clap::Parser;
use parking_lot::RwLock;
use rpi_led_panel::{LedSequence, RGBMatrixConfig};
use tokio::task::JoinSet;

use led_driver::{
    config,
    display::drive,
    state::{self, State},
    telemetry,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, Layer};

/// LED driver for the Raspberry Pi.
#[derive(Parser)]
#[clap(author, version, about, long_about = None)]
struct Args {
    /// The configuration file path for the LED driver.
    #[clap(long, value_parser, default_value = "/usr/local/etc/led/config.toml")]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    human_panic::setup_panic!();

    let args = Args::parse();

    let config = config::load(&args.config)?;

    let (metrics, otel_log_layer, _telemetry_guard) = telemetry::init(
        config.otel_endpoint.as_deref(),
        config.otel_authorization.as_deref(),
        &config.id,
    )?;

    let (non_blocking, _file_guard) = tracing_appender::non_blocking(
        tracing_appender::rolling::hourly(&config.log_dir, "led.log"),
    );
    let console_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_ansi(true)
        .with_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        );
    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        );
    tracing_subscriber::registry()
        .with(console_layer)
        .with(file_layer)
        .with(otel_log_layer)
        .init();

    tracing::info!("Setting up configuration...");
    let matrix_config = RGBMatrixConfig {
        led_sequence: LedSequence::Rgb,
        ..Default::default()
    };

    tracing::info!("Initializing state...");
    let state = Arc::new(RwLock::new(State::default()));

    tracing::info!("Spawning tasks...");
    let mut tasks = JoinSet::new();
    tasks.spawn(drive(matrix_config, state.clone(), metrics.clone()));
    tasks.spawn(async move {
        state::sync(
            config.id,
            &config.supabase_url,
            &config.supabase_anon_key,
            state,
            metrics,
        )
        .await
    });

    tracing::info!("Waiting for tasks...");
    while let Some(result) = tasks.join_next().await {
        result??;
    }

    Ok(())
}
