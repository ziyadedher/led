//! Driver configuration loaded from a TOML file at runtime.

use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Errors that can occur loading the driver config.
#[derive(Error, Debug)]
pub enum Error {
    /// Failed to read the configuration file from disk.
    #[error("config IO: {0}")]
    Io(#[from] std::io::Error),
    /// Failed to deserialize the configuration as TOML.
    #[error("config parse: {0}")]
    Parse(#[from] toml::de::Error),
}

/// Driver runtime configuration.
#[derive(Debug, serde::Deserialize)]
pub struct Config {
    /// Panel identifier within the Supabase data plane (the panel `name`).
    pub id: String,

    /// Directory for rolling log files.
    pub log_dir: PathBuf,

    /// Supabase PostgREST endpoint, e.g. `https://<project>.supabase.co/rest/v1`.
    pub supabase_url: String,

    /// Supabase API key (anon role) sent as the `apikey` header.
    pub supabase_anon_key: String,

    /// Direct Postgres connection string for LISTEN/NOTIFY-based push
    /// updates, e.g. `postgresql://postgres:PASS@db.<ref>.supabase.co:5432/postgres`.
    /// Required — the driver runs realtime-only.
    pub database_url: String,

    /// OTLP/HTTP endpoint for telemetry export, e.g. `http://infra:4318`.
    ///
    /// If absent or empty, telemetry export is disabled and the driver only
    /// logs locally.
    #[serde(default)]
    pub otel_endpoint: Option<String>,

    /// Optional `Authorization` header value sent on every OTLP request.
    /// Required by the HyperDX OTel collector at otel.ziyadedher.com.
    #[serde(default)]
    pub otel_authorization: Option<String>,
}

/// Load configuration from a TOML file.
///
/// # Errors
/// Returns [`Error::Io`] if the file can't be read, or [`Error::Parse`] if it
/// isn't valid TOML / doesn't match the [`Config`] schema.
pub fn load(path: &Path) -> Result<Config, Error> {
    tracing::debug!(path = %path.display(), "Loading configuration");
    let raw = fs::read_to_string(path)?;
    Ok(toml::from_str(&raw)?)
}
