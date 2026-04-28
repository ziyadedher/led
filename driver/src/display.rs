use std::sync::Arc;
use std::time::Instant;

use anyhow::Context;
use display_core::{text::TextFrame, Frame, Mode, PanelState};
use embedded_graphics::pixelcolor::Rgb888;
use embedded_graphics::prelude::DrawTarget;
use parking_lot::RwLock;
use rpi_led_panel::{RGBMatrix, RGBMatrixConfig};
use serde::{Deserialize, Serialize};
use tokio::task::block_in_place;

use crate::state::State;
use crate::telemetry::Metrics;

// Re-export the on-wire types so the rest of the driver crate can keep
// `use crate::display::TextEntry` etc.
pub use display_core::{
    FlashState, MarqueeOptions, RainbowOptions, Rgb, TextEntry, TextEntryColor, TextEntryOptions,
};

/// Driver-side panel: the renderer-relevant subset (scroll, pause,
/// flash) plus the DB fields we keep around for sync. The renderer
/// only reads [`RenderPanel`].
#[derive(PartialEq, Eq, Clone, Debug, Default, Deserialize, Serialize)]
pub struct Panel {
    /// Unique identifier of the panel.
    #[serde(skip_serializing)]
    pub id: String,
    /// Human-readable name for the panel.
    pub name: String,
    /// Number of lines to scroll the display by.
    pub scroll: i32,
    /// True if and only if the display has all effects paused.
    pub is_paused: bool,
    /// The current state of the flash effect.
    pub flash: FlashState,
    /// When the panel was last updated. Compared against the previous
    /// value to decide whether to re-pull entries.
    #[serde(skip_serializing)]
    pub last_updated: String,
}

pub async fn drive(
    config: RGBMatrixConfig,
    state: Arc<RwLock<State>>,
    metrics: Arc<Metrics>,
) -> anyhow::Result<()> {
    tracing::info!("Initializing display...");
    let (mut matrix, canvas) = RGBMatrix::new(config, 0).context("Matrix initialization failed")?;

    let mut step: usize = 0;
    loop {
        let frame_started = Instant::now();

        let mut canvas = canvas.clone();
        let snapshot = state.read().clone();

        let frame = Frame {
            mode: Mode::Text(TextFrame {
                entries: snapshot.entries,
                scroll: snapshot.panel.scroll,
            }),
            panel: PanelState {
                is_paused: snapshot.panel.is_paused,
                flash: snapshot.panel.flash.clone(),
            },
        };

        // Convert rpi-led-panel's anyhow-returning DrawTarget impl to a
        // typed error so display_core's signature matches.
        display_core::render(&frame, step, &mut MatrixCanvas(canvas.as_mut()))
            .map_err(|err| anyhow::anyhow!("render failed: {err}"))?;

        if !frame.panel.is_paused {
            step += 1;
        }

        block_in_place(|| matrix.update_on_vsync(canvas));
        metrics
            .frame_time_ms
            .record(frame_started.elapsed().as_secs_f64() * 1000.0, &[]);
    }
}

// Newtype wrapper so we can implement DrawTarget for an &mut Canvas
// (rpi-led-panel implements DrawTarget on Canvas itself).
struct MatrixCanvas<'a>(&'a mut rpi_led_panel::Canvas);

impl<'a> DrawTarget for MatrixCanvas<'a> {
    type Color = Rgb888;
    type Error = <rpi_led_panel::Canvas as DrawTarget>::Error;

    fn draw_iter<I>(&mut self, pixels: I) -> Result<(), Self::Error>
    where
        I: IntoIterator<Item = embedded_graphics::Pixel<Self::Color>>,
    {
        self.0.draw_iter(pixels)
    }
}

impl<'a> embedded_graphics::geometry::OriginDimensions for MatrixCanvas<'a> {
    fn size(&self) -> embedded_graphics::geometry::Size {
        self.0.size()
    }
}
