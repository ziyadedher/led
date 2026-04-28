use std::sync::Arc;
use std::time::Instant;

use chrono::{Local, Timelike};
use display_core::{
    boot::BootFrame,
    clock::{ClockFrame, ClockTime},
    image::ImageFrame,
    life::{Lattice, LifeFrame},
    setup::SetupFrame,
    text::TextFrame,
    Frame, Mode, PanelState,
};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::Path;

use crate::sink::{MatrixSink, PixelBuffer};
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
    mut sink: Box<dyn MatrixSink>,
    state: Arc<RwLock<State>>,
    metrics: Arc<Metrics>,
) -> anyhow::Result<()> {
    tracing::info!("Initializing display...");
    let (width, height) = sink.dimensions();
    let mut buffer = PixelBuffer::new(width, height);

    let mut step: usize = 0;
    let mut life_state: Option<LifeState> = None;
    loop {
        let frame_started = Instant::now();

        let snapshot = state.read().clone();
        let frame = Frame {
            mode: build_mode(&snapshot, &mut life_state),
            panel: PanelState {
                is_paused: snapshot.panel.is_paused,
                flash: snapshot.panel.flash.clone(),
            },
        };

        // PixelBuffer's DrawTarget impl is Infallible — `render`
        // can't fail here, so unwrap is fine.
        display_core::render(&frame, step, &mut buffer).expect("infallible draw target");

        if !frame.panel.is_paused {
            step += 1;
        }

        sink.present(&buffer)?;
        metrics
            .frame_time_ms
            .record(frame_started.elapsed().as_secs_f64() * 1000.0, &[]);
    }
}

/// Read the wifi-setup marker file. wifi-setup writes this when it
/// brings the AP up and removes it on successful STA connect; the
/// content is two lines: the AP SSID and the portal URL. Absence =
/// not in setup mode.
fn read_setup_marker() -> Option<SetupFrame> {
    let path = Path::new("/run/led-wifi-setup.active");
    let raw = std::fs::read_to_string(path).ok()?;
    let mut lines = raw.lines();
    let ssid = lines.next()?.trim().to_string();
    let portal_url = lines
        .next()
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "10.42.0.1".to_string());
    if ssid.is_empty() {
        return None;
    }
    Some(SetupFrame {
        color: Rgb {
            r: 0xff,
            g: 0xb8,
            b: 0x4d,
        },
        ssid,
        portal_url,
    })
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
        // Reseed if stagnant. Two patterns to catch:
        //   - period-1 (still life, blinker that's somehow off): all
        //     four samples equal.
        //   - period-2 (e.g. blinker oscillating 4↔5): even-indexed
        //     samples equal AND odd-indexed samples equal.
        let pops = self.recent_populations;
        let warmed_up = pops[0] != 0;
        let period_one = pops[0] == pops[1] && pops[1] == pops[2] && pops[2] == pops[3];
        let period_two = pops[0] == pops[2] && pops[1] == pops[3] && pops[0] != pops[1];
        let stalled = warmed_up && (period_one || period_two);
        if stalled
            || self.generations >= LIFE_RESEED_GENERATIONS
            || self.lattice.population() < 5
        {
            self.reseed();
        }
    }
}

/// Pick the per-mode render input based on the panel's `mode`. Two
/// pre-conditions short-circuit the configured mode:
///   1. wifi-setup is running its onboarding AP — show the setup
///      frame (SSID + portal URL) so the user can join from a phone.
///   2. State sync hasn't resolved a panel id yet — show the boot
///      frame as a "we're alive, just waking up" indicator.
/// Falls back to text mode on unknown modes so a misconfigured
/// panel doesn't black out.
fn build_mode(snapshot: &State, life_state: &mut Option<LifeState>) -> Mode {
    if let Some(setup_frame) = read_setup_marker() {
        *life_state = None;
        return Mode::Setup(setup_frame);
    }
    if snapshot.panel.id.is_empty() {
        *life_state = None;
        return Mode::Boot(BootFrame::default());
    }
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

