//! Raspberry Pi model detection.
//!
//! The Pi 5 moved all GPIO behind the RP1 south-bridge, so it needs a
//! completely different output backend (RP1 PIO state machine) than
//! the BCM-mmap path used on the Pi Zero W .. Pi 4. We detect the
//! model at startup and pick the backend; the older `rpi-led-panel`
//! crate does its own finer-grained detection within the BCM family,
//! so all we need here is "is this an RP1-era board (Pi 5) or not".

use std::fs;

/// Coarse board family — enough to choose an output backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiModel {
    /// Pi 5 / RP1-era: GPIO is behind the RP1 chip, driven via PIO.
    Pi5,
    /// Pi Zero W .. Pi 4: GPIO is a BCM SoC peripheral (`mmap` path).
    Bcm,
}

/// The device-tree model string, e.g. "Raspberry Pi 5 Model B Rev 1.1".
/// NUL-terminated in `/proc/device-tree/model`; trailing NUL trimmed.
fn device_tree_model() -> Option<String> {
    let raw = fs::read("/proc/device-tree/model").ok()?;
    let s = String::from_utf8_lossy(&raw);
    let trimmed = s.trim_end_matches('\0').trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Classify the running board. Defaults to [`PiModel::Bcm`] when the
/// model string is unavailable or unrecognised — the BCM backend is
/// the safe historical default and does its own model validation.
#[must_use]
pub fn detect() -> PiModel {
    classify(device_tree_model().as_deref())
}

fn classify(model: Option<&str>) -> PiModel {
    match model {
        Some(m) if m.contains("Raspberry Pi 5") => PiModel::Pi5,
        _ => PiModel::Bcm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_pi5_and_others() {
        assert_eq!(classify(Some("Raspberry Pi 5 Model B Rev 1.1")), PiModel::Pi5);
        assert_eq!(classify(Some("Raspberry Pi Zero W Rev 1.1")), PiModel::Bcm);
        assert_eq!(classify(Some("Raspberry Pi 4 Model B Rev 1.4")), PiModel::Bcm);
        assert_eq!(classify(None), PiModel::Bcm);
    }
}
