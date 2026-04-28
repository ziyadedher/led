use std::sync::Arc;
use std::time::Instant;

use anyhow::Context;
use chrono::{Local, Timelike};
use display_core::{
    clock::{ClockFrame, ClockTime},
    image::ImageFrame,
    life::{Lattice, LifeFrame},
    text::TextFrame,
    Frame, Mode, PanelState,
};
use embedded_graphics::pixelcolor::Rgb888;
use embedded_graphics::prelude::DrawTarget;
use parking_lot::RwLock;
use rpi_led_panel::{RGBMatrix, RGBMatrixConfig};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::task::block_in_place;

use crate::state::State;
use crate::telemetry::Metrics;

// Re-export the on-wire types so the rest of the driver crate can keep
// `use crate::display::TextEntry` etc.
pub use display_core::{
    FlashState, MarqueeOptions, RainbowOptions, Rgb, TextEntry, TextEntryColor, TextEntryOptions,
};

/// Driver-side panel: the renderer-relevant subset (scroll, pause,
/// flash, mode) plus the DB fields we keep around for sync.
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
    /// Render mode: "text", "clock", … . Drives the dispatch in `drive`.
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Mode-specific configuration (e.g. clock format/color). Free-form
    /// jsonb; per-mode helpers parse the relevant subset.
    #[serde(default)]
    pub mode_config: JsonValue,
}

fn default_mode() -> String {
    "text".to_string()
}

pub async fn drive(
    config: RGBMatrixConfig,
    state: Arc<RwLock<State>>,
    metrics: Arc<Metrics>,
) -> anyhow::Result<()> {
    tracing::info!("Initializing display...");
    let (mut matrix, canvas) = RGBMatrix::new(config, 0).context("Matrix initialization failed")?;

    let mut step: usize = 0;
    let mut life_state: Option<LifeState> = None;
    loop {
        let frame_started = Instant::now();

        let mut canvas = canvas.clone();
        let snapshot = state.read().clone();

        let frame = Frame {
            mode: build_mode(&snapshot, &mut life_state),
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

/// Driver-local state for life mode. Held across frames so the
/// lattice can evolve between renders. Reset to None when the panel
/// switches away from life mode.
struct LifeState {
    lattice: Lattice,
    /// Frames since the last lattice step.
    frames_since_step: u32,
    /// Generations since last reseed.
    generations: u32,
    /// Last few populations — used to detect a stalled simulation
    /// (still life or short-period oscillator) so we can reseed.
    recent_populations: [u32; 4],
}

const LIFE_FRAMES_PER_STEP: u32 = 8; // ~8/60 s ≈ 130 ms.
const LIFE_RESEED_GENERATIONS: u32 = 1500;

impl LifeState {
    fn new(width: u8, height: u8) -> Self {
        let mut s = Self {
            lattice: Lattice::new(width, height),
            frames_since_step: 0,
            generations: 0,
            recent_populations: [0; 4],
        };
        s.reseed();
        s
    }

    fn reseed(&mut self) {
        let w = i32::from(self.lattice.width);
        let h = i32::from(self.lattice.height);
        for y in 0..h {
            for x in 0..w {
                // ~28% live density seeds interesting evolutions
                // without immediately collapsing.
                self.lattice.set(x, y, fastrand::f32() < 0.28);
            }
        }
        self.generations = 0;
        self.recent_populations = [0; 4];
    }

    fn advance(&mut self) {
        self.lattice = self.lattice.step();
        self.generations += 1;
        // Shift populations and record current.
        self.recent_populations.rotate_left(1);
        self.recent_populations[3] = self.lattice.population();
        // Reseed if stagnant: oscillating with period 1 or 2 is the
        // most common still-life pattern, both manifest as flat
        // population over the recent window.
        let stalled = self.recent_populations[0] != 0
            && self.recent_populations.iter().all(|p| *p == self.recent_populations[3]);
        if stalled
            || self.generations >= LIFE_RESEED_GENERATIONS
            || self.lattice.population() < 5
        {
            self.reseed();
        }
    }
}

/// Pick the per-mode render input based on the panel's `mode`. Falls
/// back to text mode on unknown modes so a misconfigured panel
/// doesn't black out — text is the lowest-surprise default.
fn build_mode(snapshot: &State, life_state: &mut Option<LifeState>) -> Mode {
    match snapshot.panel.mode.as_str() {
        "clock" => {
            *life_state = None;
            let mut frame: ClockFrame =
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default();
            let now = Local::now();
            frame.now = ClockTime {
                hour: now.hour() as u8,
                minute: now.minute() as u8,
                second: now.second() as u8,
            };
            Mode::Clock(frame)
        }
        "life" => {
            let s = life_state.get_or_insert_with(|| LifeState::new(64, 64));
            s.frames_since_step += 1;
            if s.frames_since_step >= LIFE_FRAMES_PER_STEP {
                s.frames_since_step = 0;
                s.advance();
            }
            Mode::Life(LifeFrame::from(&s.lattice))
        }
        "image" => {
            *life_state = None;
            let frame: ImageFrame =
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default();
            Mode::Image(frame)
        }
        _ => {
            *life_state = None;
            Mode::Text(TextFrame {
                entries: snapshot.entries.clone(),
                scroll: snapshot.panel.scroll,
            })
        }
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
