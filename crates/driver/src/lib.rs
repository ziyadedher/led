#![warn(clippy::pedantic)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]

/// Build sha embedded by `build.rs`. Reported to the dash on each
/// startup via `panels.driver_version`.
pub const DRIVER_VERSION: &str = env!("LED_DRIVER_VERSION");

pub mod config;
pub mod display;
pub mod realtime;
pub mod sched;
pub mod sink;
pub mod state;
pub mod telemetry;
