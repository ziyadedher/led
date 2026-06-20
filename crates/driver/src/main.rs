#![warn(clippy::all)]
#![warn(clippy::pedantic)]
#![warn(clippy::cargo)]

use std::{path::PathBuf, sync::Arc};

use anyhow::Context;
use clap::Parser;
use parking_lot::RwLock;
use tokio::task::JoinSet;

use led_driver::{
    config,
    display::drive,
    sched,
    sink::{MatrixSink, TerminalMatrixSink},
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

    /// Render to the terminal (ANSI half-blocks) instead of the Pi
    /// matrix. Implied when the binary is built without `--features rpi`.
    /// Used by `just dev` for native iteration without flashing an SD.
    #[clap(long)]
    terminal: bool,
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
    // In terminal-sink mode the matrix renders to stdout, so writing
    // human-readable logs to stderr would smear them across the
    // canvas. Send the console layer to a sink (file_layer keeps a
    // record).
    let console_layer = if args.terminal {
        None
    } else {
        Some(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_ansi(true)
                .with_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
                ),
        )
    };
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
    let sink = build_sink(args.terminal, config.color_order.as_deref())?;

    tracing::info!("Initializing state...");
    let state = Arc::new(RwLock::new(State::default()));

    tracing::info!("Spawning tasks...");
    let mut tasks: JoinSet<anyhow::Result<()>> = JoinSet::new();

    // Render loop runs on a dedicated OS thread, NOT a tokio worker.
    // This is a single-thread-FIFO design: the renderer alone bumps
    // itself to SCHED_FIFO/locked memory; tokio workers + OTel +
    // reqwest all stay SCHED_OTHER so PID 1 systemd keeps getting
    // scheduled and the BCM2835 hardware watchdog keeps getting pet.
    let render_state = state.clone();
    let render_metrics = metrics.clone();
    let render_thread = std::thread::Builder::new()
        .name("led-render".into())
        .spawn(move || -> anyhow::Result<()> {
            // Promote SELF (this thread) to FIFO. Soft-fail: dev box,
            // qemu, or a missing LimitRTPRIO/CAP_SYS_NICE cause EPERM
            // here — better to render a flickery panel than to refuse
            // to start.
            if let Err(err) = sched::promote_current_thread_to_fifo(50) {
                tracing::warn!(
                    %err,
                    "render thread: SCHED_FIFO promotion failed; flicker may regress. \
                     Check LimitRTPRIO=50 in led-driver.service or that the binary has CAP_SYS_NICE."
                );
            }
            if let Err(err) = sched::lock_all_memory() {
                tracing::warn!(
                    %err,
                    "render thread: mlockall failed; page faults may cause flicker. \
                     Check LimitMEMLOCK=infinity in led-driver.service."
                );
            }
            drive(sink, render_state, render_metrics)
        })
        .context("spawn led-render thread")?;

    // Bridge the std::thread into the JoinSet via the blocking pool so
    // a renderer error/panic still surfaces in `join_next` and tears
    // the process down (Restart=always brings us back).
    tasks.spawn_blocking(move || {
        render_thread
            .join()
            .map_err(|panic| anyhow::anyhow!("led-render thread panicked: {panic:?}"))?
    });

    tasks.spawn(async move {
        state::sync(
            config.id,
            config.supabase_url,
            config.supabase_anon_key,
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

/// Pick the output backend. `--terminal` always wins (native dev).
/// Otherwise the running board decides: Pi 5 → RP1 PIO, everything
/// else → BCM register mmap (`rpi-led-panel`). The relevant backend
/// must be compiled in (`rpi` / `rpi5` features); a board with no
/// matching backend fails loudly with an actionable message.
fn build_sink(
    terminal: bool,
    color_order: Option<&str>,
) -> anyhow::Result<Box<dyn MatrixSink>> {
    if terminal {
        return Ok(Box::new(TerminalMatrixSink::new(64, 64, 30.0)));
    }
    let order = led_driver::color_order::from_config(color_order)
        .map_err(|e| anyhow::anyhow!(e))?;
    match led_driver::model::detect() {
        led_driver::model::PiModel::Pi5 => build_rp1_sink(order),
        led_driver::model::PiModel::Bcm => build_bcm_sink(order),
    }
}

#[cfg(feature = "rpi")]
fn build_bcm_sink(
    order: led_driver::color_order::ColorOrder,
) -> anyhow::Result<Box<dyn MatrixSink>> {
    use led_driver::sink::RpiMatrixSink;
    use rpi_led_panel::RGBMatrixConfig;
    let matrix_config = RGBMatrixConfig {
        led_sequence: order.into(),
        ..Default::default()
    };
    Ok(Box::new(RpiMatrixSink::new(matrix_config)?))
}

#[cfg(not(feature = "rpi"))]
fn build_bcm_sink(
    _order: led_driver::color_order::ColorOrder,
) -> anyhow::Result<Box<dyn MatrixSink>> {
    anyhow::bail!(
        "this board uses the BCM GPIO backend but the binary was built without the \
         `rpi` feature; rebuild with `--features rpi` or run with `--terminal`"
    )
}

#[cfg(feature = "rpi5")]
fn build_rp1_sink(
    order: led_driver::color_order::ColorOrder,
) -> anyhow::Result<Box<dyn MatrixSink>> {
    use led_driver::sink::Rp1PioSink;
    Ok(Box::new(Rp1PioSink::new(64, 64, order)?))
}

#[cfg(not(feature = "rpi5"))]
fn build_rp1_sink(
    _order: led_driver::color_order::ColorOrder,
) -> anyhow::Result<Box<dyn MatrixSink>> {
    anyhow::bail!(
        "detected a Raspberry Pi 5 (RP1 GPIO) but this binary was built without the \
         `rpi5` feature; rebuild with `--features rpi5`"
    )
}
