//! Hardware-agnostic LED-matrix render core.
//!
//! Whatever ends up on the panel comes from [`render`]. The Pi driver
//! and the in-browser simulator both call into here — same code, same
//! pixels, modulo the underlying [`DrawTarget`].
//!
//! Architecture: each render mode (text, clock, image, …) lives in
//! its own module and exposes its own per-mode frame type. The
//! top-level [`Frame`] tags which mode to dispatch to and carries
//! mode-independent panel state (flash, pause).

use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    primitives::{PrimitiveStyleBuilder, Rectangle},
};
use serde::{Deserialize, Serialize};

pub mod clock;
pub mod life;
pub mod text;

// Re-export the most-used text types so existing callers can grab
// them from the crate root without reaching into the module.
pub use text::{
    MarqueeOptions, RainbowOptions, Rgb, TextEntry, TextEntryColor, TextEntryOptions,
};

#[derive(PartialEq, Eq, Clone, Debug, Default, Deserialize, Serialize)]
pub struct FlashState {
    pub is_active: bool,
    pub on_steps: usize,
    pub total_steps: usize,
}

/// Mode-independent panel state. Flash + pause behave the same no
/// matter which mode is active — overlay applied after the per-mode
/// renderer runs.
#[derive(PartialEq, Eq, Clone, Debug, Default, Deserialize, Serialize)]
pub struct PanelState {
    pub is_paused: bool,
    pub flash: FlashState,
}

/// Tagged union over render modes. Externally-tagged so JSON looks
/// like `{ "Text": {...} }` — easy for the dash to construct
/// directly.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum Mode {
    Text(text::TextFrame),
    Clock(clock::ClockFrame),
    Life(life::LifeFrame),
}

impl Default for Mode {
    fn default() -> Self {
        Self::Text(text::TextFrame::default())
    }
}

/// One frame of input — what to render plus how the panel as a whole
/// is configured (paused, flashing).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Frame {
    pub mode: Mode,
    pub panel: PanelState,
}

/// Render one frame onto `canvas`. `step` is a monotonically
/// increasing tick counter that drives any animation. The Pi driver
/// calls this once per vsync; the WASM simulator calls it once per
/// requestAnimationFrame.
pub fn render<D>(frame: &Frame, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    canvas.clear(Rgb888::BLACK)?;

    match &frame.mode {
        Mode::Text(t) => text::render(t, step, canvas)?,
        Mode::Clock(c) => clock::render(c, canvas)?,
        Mode::Life(l) => life::render(l, canvas)?,
    }

    apply_flash(canvas, &frame.panel, step)?;
    Ok(())
}

fn apply_flash<D>(canvas: &mut D, panel: &PanelState, step: usize) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    if !panel.flash.is_active || panel.is_paused || panel.flash.total_steps == 0 {
        return Ok(());
    }
    let progress = step % panel.flash.total_steps;
    if progress >= panel.flash.on_steps {
        return Ok(());
    }
    let style = PrimitiveStyleBuilder::new()
        .fill_color(Rgb888::WHITE)
        .build();
    Rectangle::new(Point::zero(), canvas.size())
        .into_styled(style)
        .draw(canvas)?;
    Ok(())
}
