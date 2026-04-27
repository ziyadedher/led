//! OpenTelemetry export for the LED driver.
//!
//! Wires up OTLP/HTTP export of metrics and logs to a configured collector
//! endpoint. When no endpoint is configured the providers are still installed
//! but never see network traffic, which keeps call sites uniform.
//!
//! Metric instruments live on [`Metrics`], constructed once and shared across
//! tasks via `Arc`. Logs come through the existing `tracing` pipeline by way
//! of `opentelemetry-appender-tracing`.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use opentelemetry::global;
use opentelemetry::metrics::{Counter, Gauge, Histogram, Meter};
use opentelemetry::KeyValue;
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_otlp::{LogExporter, MetricExporter, Protocol, WithExportConfig};
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::Resource;
use opentelemetry_semantic_conventions::resource::{
    HOST_NAME, SERVICE_INSTANCE_ID, SERVICE_NAME, SERVICE_VERSION,
};
use tracing::Subscriber;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

const SERVICE_NAME_VALUE: &str = "led-driver";
const METRIC_EXPORT_INTERVAL: Duration = Duration::from_secs(10);

/// Metric instruments shared across the driver's tasks.
///
/// Constructing these instruments is non-trivial; they should be created once
/// and cloned (each instrument is internally `Arc`-backed).
pub struct Metrics {
    /// Counter incremented every successful sync iteration. Liveness signal.
    pub heartbeat: Counter<u64>,
    /// Histogram of display loop iteration time in milliseconds.
    pub frame_time_ms: Histogram<f64>,
    /// Histogram of state sync round-trip time in milliseconds.
    pub sync_duration_ms: Histogram<f64>,
    /// Gauge of the number of text entries currently loaded.
    pub entries_loaded: Gauge<u64>,
}

impl Metrics {
    fn new(meter: &Meter) -> Self {
        Self {
            heartbeat: meter
                .u64_counter("led.driver.heartbeat")
                .with_description("Counter incremented each sync iteration; liveness signal.")
                .build(),
            frame_time_ms: meter
                .f64_histogram("led.driver.frame_time_ms")
                .with_description("Time taken to render and flush a single frame.")
                .with_unit("ms")
                .build(),
            sync_duration_ms: meter
                .f64_histogram("led.driver.sync_duration_ms")
                .with_description("Time taken for a state sync round-trip to the backend.")
                .with_unit("ms")
                .build(),
            entries_loaded: meter
                .u64_gauge("led.driver.entries_loaded")
                .with_description("Number of text entries currently loaded for display.")
                .build(),
        }
    }
}

/// RAII guard for the OTel providers. Drop it during shutdown to flush.
pub struct TelemetryGuard {
    meter_provider: Option<SdkMeterProvider>,
    logger_provider: Option<SdkLoggerProvider>,
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        if let Some(provider) = self.meter_provider.take() {
            if let Err(err) = provider.shutdown() {
                eprintln!("OTel meter provider shutdown failed: {err}");
            }
        }
        if let Some(provider) = self.logger_provider.take() {
            if let Err(err) = provider.shutdown() {
                eprintln!("OTel logger provider shutdown failed: {err}");
            }
        }
    }
}

/// Build an OTLP/HTTP-protobuf telemetry pipeline.
///
/// Returns the metric instruments, an additional `tracing` layer that bridges
/// log events into OTLP (or `None` if disabled), and a guard that flushes the
/// pipeline on drop. The returned layer is already filtered to avoid OTel's
/// own log events feeding back into the pipeline.
///
/// When `endpoint` is `None`, no exporters are installed: metric instruments
/// still record values into the local SDK pipeline but no data leaves the
/// process, and no log layer is returned.
pub fn init<S>(
    endpoint: Option<&str>,
    instance_id: &str,
) -> anyhow::Result<(
    Arc<Metrics>,
    Option<Box<dyn Layer<S> + Send + Sync>>,
    TelemetryGuard,
)>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    let resource = build_resource(instance_id);

    let Some(endpoint) = endpoint else {
        let meter_provider = SdkMeterProvider::builder()
            .with_resource(resource)
            .build();
        global::set_meter_provider(meter_provider.clone());
        let metrics = Arc::new(Metrics::new(&global::meter(SERVICE_NAME_VALUE)));
        return Ok((
            metrics,
            None,
            TelemetryGuard {
                meter_provider: Some(meter_provider),
                logger_provider: None,
            },
        ));
    };

    let metric_exporter = MetricExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(format!("{}/v1/metrics", endpoint.trim_end_matches('/')))
        .build()
        .context("Failed to build OTLP metric exporter")?;
    let reader = PeriodicReader::builder(metric_exporter)
        .with_interval(METRIC_EXPORT_INTERVAL)
        .build();
    let meter_provider = SdkMeterProvider::builder()
        .with_reader(reader)
        .with_resource(resource.clone())
        .build();
    global::set_meter_provider(meter_provider.clone());

    let log_exporter = LogExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_endpoint(format!("{}/v1/logs", endpoint.trim_end_matches('/')))
        .build()
        .context("Failed to build OTLP log exporter")?;
    let logger_provider = SdkLoggerProvider::builder()
        .with_resource(resource)
        .with_batch_exporter(log_exporter)
        .build();
    let log_layer = OpenTelemetryTracingBridge::new(&logger_provider);

    let metrics = Arc::new(Metrics::new(&global::meter(SERVICE_NAME_VALUE)));

    let layer: Box<dyn Layer<S> + Send + Sync> = Box::new(log_layer.with_filter(otel_log_filter()));

    Ok((
        metrics,
        Some(layer),
        TelemetryGuard {
            meter_provider: Some(meter_provider),
            logger_provider: Some(logger_provider),
        },
    ))
}

fn build_resource(instance_id: &str) -> Resource {
    Resource::builder()
        .with_attributes([
            KeyValue::new(SERVICE_NAME, SERVICE_NAME_VALUE),
            KeyValue::new(SERVICE_VERSION, env!("CARGO_PKG_VERSION")),
            KeyValue::new(SERVICE_INSTANCE_ID, instance_id.to_string()),
            KeyValue::new(
                HOST_NAME,
                hostname::get()
                    .map(|h| h.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ),
        ])
        .build()
}

fn otel_log_filter() -> tracing_subscriber::filter::Targets {
    tracing_subscriber::filter::Targets::new()
        .with_default(tracing::Level::INFO)
        .with_target("hyper", tracing::Level::WARN)
        .with_target("hyper_util", tracing::Level::WARN)
        .with_target("opentelemetry", tracing::Level::WARN)
        .with_target("opentelemetry_sdk", tracing::Level::WARN)
        .with_target("opentelemetry-http", tracing::Level::WARN)
        .with_target("opentelemetry_appender_tracing", tracing::Level::WARN)
        .with_target("reqwest", tracing::Level::WARN)
        .with_target("tonic", tracing::Level::WARN)
        .with_target("tower", tracing::Level::WARN)
        .with_target("h2", tracing::Level::WARN)
}
