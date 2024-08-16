//! Utilities for interacting with the root user.

use std::process::Command;
use thiserror::Error;

/// Error types for root user operations.
#[derive(Error, Debug)]
pub enum RootError {
    /// Error when the program is not running as root.
    #[error("This program must be run as root")]
    NotRoot,
    /// Error when unable to determine user ID.
    #[error("Failed to determine user ID: {0}")]
    UidCheckFailed(String),
}

/// Ensures that the program is running as the root user.
///
/// This function checks if the current user is root by executing the `id -u` command
/// and comparing the output to "0" (the root user ID).
///
/// # Returns
///
/// Returns `Ok(())` if the program is running as root, otherwise returns an error.
///
/// # Errors
///
/// Returns a `RootError::NotRoot` if the program is not running as root.
/// Returns a `RootError::UidCheckFailed` if there's an error determining the user ID.
pub fn ensure_running_as_root() -> Result<(), RootError> {
    let output = Command::new("id")
        .arg("-u")
        .output()
        .map_err(|e| RootError::UidCheckFailed(e.to_string()))?;

    let uid = String::from_utf8(output.stdout)
        .map_err(|e| RootError::UidCheckFailed(e.to_string()))?
        .trim()
        .to_string();

    if uid != "0" {
        return Err(RootError::NotRoot);
    }

    Ok(())
}
