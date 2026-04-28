//! Per-frame renderers. Each frame type lives in its own module; the
//! top-level [`crate::Mode`] enum tags which one to dispatch to.

pub mod boot;
pub mod clock;
pub mod image;
pub mod life;
pub mod setup;
pub mod text;
