//! Configuration definitions and utilities for the LED driver and associated services.
//!
//! This module provides a `Config` struct that defines the configuration for the LED driver and related services like
//! `led-driverup`. It also provides utilities for saving and loading this configuration to and from a file.

use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;
use toml;

/// Represents the various errors that can occur during configuration operations.
///
/// This enum encapsulates different types of errors that might be encountered when working with configuration files
/// including I/O errors and config serialization and deserialization errors.
#[derive(Error, Debug)]
pub enum Error {
    /// Represents an I/O error that occurred during file operations.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Represents an error that occurred during config serialization.
    #[error("Config serialization error: {0}")]
    Ser(#[from] toml::ser::Error),

    /// Represents an error that occurred during config deserialization.
    #[error("Config deserialization error: {0}")]
    De(#[from] toml::de::Error),
}

/// Configuration for the LED driver and associated services.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct Config {
    /// Unique identifier for this LED matrix.
    pub id: String,

    /// Path at which to install the LED driver binary.
    pub install_path: PathBuf,

    /// Path to a directory that will store various log files for the LED driver.
    pub log_dir: PathBuf,

    /// Supabase PostgREST endpoint, e.g. `https://<project>.supabase.co/rest/v1`.
    pub supabase_url: String,

    /// Supabase API key (anon role) sent as the `apikey` header.
    pub supabase_anon_key: String,

    /// OTLP endpoint for telemetry export (HTTP/protobuf, e.g. `http://infra:4318`).
    ///
    /// If `None`, telemetry export is disabled and the driver only logs locally.
    #[serde(default)]
    pub otel_endpoint: Option<String>,
}

/// Saves the given configuration to a file at the given path.
///
/// Will create the file and directory tree if it doesn't exist, or overwrite it if it does.
///
/// # Errors
///
/// This function will return a `Error` if the configuration cannot be serialized to TOML or if the file cannot be
/// written for whatever reason.
///
/// # Examples
///
/// ```no_run
/// use led_driver_common::config::{save_config, Config};
/// use std::path::Path;
///
/// # pub fn main() -> Result<(), Error> {
/// let config = Config {
///     id: "my-led-matrix".to_string(),
///     install_path: Path::new("/usr/local/bin/led-driver").to_path_buf(),
///     log_dir: Path::new("/var/log/led-driver").to_path_buf(),
///     supabase_url: "https://example.supabase.co/rest/v1".to_string(),
///     supabase_anon_key: "...".to_string(),
///     otel_endpoint: None,
/// };
/// save_config(&config, Path::new("config.toml"))?;
/// # Ok(())
/// # }
/// ```
pub fn save_config(config: &Config, path: &Path) -> Result<(), Error> {
    tracing::debug!("Saving configuration to {:?}...", path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let config_str = toml::to_string(config)?;
    fs::write(path, config_str)?;
    tracing::debug!("Configuration saved successfully");
    Ok(())
}

/// Loads a configuration from a file at the given path.
///
/// # Errors
///
/// This function will return a `Error` if the file cannot be read, is not valid TOML, or doesn't match the expected
/// configuration struct ([Config]).
///
/// # Examples
///
/// ```no_run
/// use led_driver_common::config::load_config;
/// use std::path::Path;
///
/// # pub fn main() -> Result<(), Error> {
/// let config = load_config(Path::new("config.toml"))?;
/// # Ok(())
/// # }
/// ```
pub fn load_config(path: &Path) -> Result<Config, Error> {
    tracing::debug!("Loading configuration from {:?}...", path);
    let config_str = fs::read_to_string(path)?;
    let config: Config = toml::from_str(&config_str)?;
    tracing::debug!("Configuration loaded successfully");
    Ok(config)
}
