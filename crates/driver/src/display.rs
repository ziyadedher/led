use std::sync::Arc;
use std::time::Instant;

use chrono::{Local, Timelike};
use chrono_tz::Tz;
use display_core::{
    boot::BootScene,
    clock::{ClockSceneConfig, ClockTime},
    gif::GifScene,
    image::ImageScene,
    life::{Lattice, LifeSceneConfig},
    pong::{PongSceneConfig, PongTime},
    setup::SetupScene,
    shapes::ShapesScene,
    sky::{SkySceneConfig, SkyTime},
    test::TestScene,
    text::TextScene,
    Scene, Mode, PanelState, SimHost,
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
// Not `Eq`: `brightness` is an f32. Manual `Default` so brightness
// defaults to full (1.0), not 0.0 — a derived default would render the
// pre-first-fetch boot screen black.
#[derive(PartialEq, Clone, Debug, Deserialize, Serialize)]
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
    /// True if and only if the panel is "off" — render is short-
    /// circuited to a black canvas without disturbing the configured
    /// mode/config. Composes with is_paused.
    #[serde(default)]
    pub is_off: bool,
    /// The current state of the flash effect.
    pub flash: FlashState,
    /// When the panel was last updated. Compared against the previous
    /// value to decide whether to re-pull entries.
    #[serde(skip_serializing)]
    pub last_updated: String,
    /// Render mode: "text", "clock", … . Drives the dispatch in `drive`.
    /// `panels.mode` is `not null default 'text'` server-side, so the
    /// field is always present on the wire — no serde default needed.
    pub mode: String,
    /// Mode-specific configuration (e.g. clock format/color). Free-form
    /// jsonb; per-mode helpers parse the relevant subset.
    #[serde(default)]
    pub mode_config: JsonValue,
    /// Final brightness multiplier in [0, 1] applied to every pixel.
    /// Defaults to full for rows predating the column.
    #[serde(default = "default_brightness")]
    pub brightness: f32,
}

fn default_brightness() -> f32 {
    1.0
}

impl Default for Panel {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            scroll: 0,
            is_paused: false,
            is_off: false,
            flash: FlashState::default(),
            last_updated: String::new(),
            mode: String::new(),
            mode_config: JsonValue::default(),
            brightness: 1.0,
        }
    }
}

/// Wall-clock source for the scene-animation `step`. display-core
/// renderers are written against a nominal 60 steps/s (gif frame
/// timing, marquee px/step, ambient-scene speeds), but the render
/// loop itself runs at whatever rate the sink imposes — the Zero W's
/// panel-refresh vsync, the Pi 5's DMA throughput — which varies with
/// hardware and matrix config. Counting loop iterations made every
/// animation's real-time speed processor-dependent; deriving `step`
/// from elapsed wall time pins it to 60 logical steps per second on
/// every backend. The loop itself stays free-running (on HUB75 the
/// present call IS the panel refresh — throttling it would change
/// brightness/flicker behavior).
struct StepClock {
    /// Fractional steps accumulated while unfrozen. f64 at 60/s is
    /// exact far beyond any plausible uptime.
    acc: f64,
    last: Instant,
}

impl StepClock {
    fn new() -> Self {
        Self {
            acc: 0.0,
            last: Instant::now(),
        }
    }

    /// Advance by elapsed wall time (unless `frozen`) and return the
    /// current step. Freezing (pause / off) holds the accumulator so
    /// animations resume exactly where they stopped.
    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_sign_loss)]
    fn tick(&mut self, frozen: bool) -> usize {
        let now = Instant::now();
        // Clamp pathological gaps (suspend, stalled sink) so a resume
        // nudges forward instead of fast-forwarding the scene.
        let dt = (now - self.last).as_secs_f64().min(0.25);
        self.last = now;
        if !frozen {
            self.acc += dt * 60.0;
        }
        self.acc as usize
    }
}

pub async fn drive(
    mut sink: Box<dyn MatrixSink>,
    state: Arc<RwLock<State>>,
    metrics: Arc<Metrics>,
) -> anyhow::Result<()> {
    tracing::info!("Initializing display...");
    let (width, height) = sink.dimensions();
    let mut buffer = PixelBuffer::new(width, height);

    let mut clock = StepClock::new();
    let mut life_state: Option<LifeState> = None;
    // Persistent state for the simulation modes (physarum, rd, fluid,
    // sand, swarm) — display-core owns the stepping; we just keep the
    // host alive across frames.
    let mut sims = SimHost::default();
    let mut config_cache = ConfigCache::default();
    // Most recent clock sample. Frozen while the panel is paused so
    // the displayed time doesn't advance even though render() is
    // still running.
    let mut last_clock_now: Option<ClockTime> = None;
    loop {
        let frame_started = Instant::now();

        // Hold the read lock only long enough to build the frame input;
        // cache covers the heavy parse path.
        let (mode, panel_state, step) = {
            let snapshot = state.read();
            let panel_state = PanelState {
                is_paused: snapshot.panel.is_paused,
                is_off: snapshot.panel.is_off,
                flash: snapshot.panel.flash.clone(),
                brightness: snapshot.panel.brightness,
            };
            let step = clock.tick(panel_state.is_paused || panel_state.is_off);
            let mode = build_mode(
                &snapshot,
                step,
                &mut life_state,
                &mut config_cache,
                &mut last_clock_now,
            );
            (mode, panel_state, step)
        };
        let frame = Scene { mode, panel: panel_state };

        // PixelBuffer's DrawTarget impl is Infallible — `render`
        // can't fail here, so unwrap is fine.
        display_core::render_with_sims(&frame, step, &mut sims, &mut buffer)
            .expect("infallible draw target");

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
fn read_setup_marker() -> Option<SetupScene> {
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
    Some(SetupScene {
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
    /// Scene step at which the lattice last advanced. Generation
    /// pacing is measured in (wall-clock-derived) steps, not loop
    /// iterations — the loop runs at the sink's refresh rate, which
    /// varies by hardware.
    last_step: usize,
    /// Generations since last reseed.
    generations: u32,
    /// Last few populations — used to detect a stalled simulation
    /// (still life or short-period oscillator) so we can reseed.
    recent_populations: [u32; 4],
}

/// Reseed after this many generations; period-1/2 checks below catch
/// shorter stalls (oscillators, still-lifes).
const LIFE_RESEED_GENERATIONS: u32 = 1500;

/// Look up an IANA timezone (e.g. "America/Los_Angeles") and return
/// the current local time there. Falls back to system local time
/// when the timezone string is missing or doesn't parse.
fn sample_time(timezone: Option<&str>) -> ClockTime {
    let (h, m, s) = if let Some(tz_str) = timezone.filter(|s| !s.is_empty()) {
        match tz_str.parse::<Tz>() {
            Ok(tz) => {
                let now = chrono::Utc::now().with_timezone(&tz);
                (now.hour(), now.minute(), now.second())
            }
            Err(_) => {
                let now = Local::now();
                (now.hour(), now.minute(), now.second())
            }
        }
    } else {
        let now = Local::now();
        (now.hour(), now.minute(), now.second())
    };
    // chrono returns u32 for HMS but they fit in u8 (max 59). `try_from`
    // here documents the invariant and avoids a silent wrap if chrono
    // ever returns something pathological.
    ClockTime {
        hour: u8::try_from(h).unwrap_or(0),
        minute: u8::try_from(m).unwrap_or(0),
        second: u8::try_from(s).unwrap_or(0),
    }
}

impl LifeState {
    fn new(width: u8, height: u8, step: usize) -> Self {
        let mut s = Self {
            lattice: Lattice::new(width, height),
            // Anchor to the current step so a panel that switches into
            // life mode after days of uptime doesn't try to "catch up"
            // millions of generations.
            last_step: step,
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

/// Caches the parsed config for immutable-payload modes (image /
/// paint / gif / shapes / test) keyed on `(mode, last_updated)`.
/// Re-parsing 720KB jsonb per frame burns the Pi Zero W's frame
/// budget; cache hits are a Vec<u8> memcpy.
///
/// Cache invariant — `last_updated` must bump on every `mode_config`
/// write; this is enforced by convention in `dash/utils/actions.ts`,
/// not by the type system.
#[derive(Default)]
struct ConfigCache {
    /// `(mode, last_updated)` of the value held in `parsed`.
    key: Option<(String, String)>,
    parsed: Option<CachedConfig>,
}

enum CachedConfig {
    Image(Arc<ImageScene>),
    Gif(Arc<GifScene>),
    Shapes(ShapesScene),
    Test(TestScene),
}

impl ConfigCache {
    /// Return the cached parsed config if `(mode, last_updated)`
    /// matches the snapshot; otherwise reparse from `mode_config` and
    /// stash the result.
    fn fetch<'a>(
        &'a mut self,
        mode: &str,
        last_updated: &str,
        mode_config: &JsonValue,
    ) -> &'a CachedConfig {
        let want = (mode.to_owned(), last_updated.to_owned());
        if self.key.as_ref() != Some(&want) || self.parsed.is_none() {
            let parsed = match mode {
                "gif" => CachedConfig::Gif(Arc::new(
                    serde_json::from_value(mode_config.clone()).unwrap_or_default(),
                )),
                "image" | "paint" => CachedConfig::Image(Arc::new(
                    serde_json::from_value(mode_config.clone()).unwrap_or_default(),
                )),
                "shapes" => CachedConfig::Shapes(
                    serde_json::from_value(mode_config.clone()).unwrap_or_default(),
                ),
                "test" => CachedConfig::Test(
                    serde_json::from_value(mode_config.clone()).unwrap_or_default(),
                ),
                _ => unreachable!("ConfigCache::fetch only handles cached modes"),
            };
            self.key = Some(want);
            self.parsed = Some(parsed);
        }
        self.parsed
            .as_ref()
            .expect("just populated by the branch above")
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
fn build_mode(
    snapshot: &State,
    step: usize,
    life_state: &mut Option<LifeState>,
    config_cache: &mut ConfigCache,
    last_clock_now: &mut Option<ClockTime>,
) -> Mode {
    if let Some(setup_frame) = read_setup_marker() {
        *life_state = None;
        return Mode::Setup(setup_frame);
    }
    if snapshot.panel.id.is_empty() {
        *life_state = None;
        return Mode::Boot(BootScene::default());
    }
    match snapshot.panel.mode.as_str() {
        "clock" => {
            *life_state = None;
            // Tiny payload — cheaper to parse than to manage in the
            // cache, and `now` shifts every frame anyway so we'd
            // rebuild Mode::Clock either way.
            let config: ClockSceneConfig =
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default();
            // Freeze the clock when the panel is paused — without
            // this, sample_time runs every frame and the displayed
            // time keeps advancing even though every other animated
            // mode honours the freeze via the static `step`.
            let now = if snapshot.panel.is_paused {
                last_clock_now.unwrap_or_else(|| sample_time(config.timezone.as_deref()))
            } else {
                let sampled = sample_time(config.timezone.as_deref());
                *last_clock_now = Some(sampled);
                sampled
            };
            Mode::Clock(config.into_frame(now))
        }
        "life" => {
            let config: LifeSceneConfig =
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default();
            let interval = (config.step_interval_frames.max(1)) as usize;
            let s = life_state.get_or_insert_with(|| LifeState::new(64, 64, step));
            // Advance one generation per elapsed interval of scene
            // steps. StepClock clamps per-frame elapsed time, so this
            // catch-up loop is bounded (~15 steps worst case).
            while step.saturating_sub(s.last_step) >= interval {
                s.last_step += interval;
                s.advance();
            }
            Mode::Life(config.into_frame(&s.lattice))
        }
        "image" | "paint" => {
            *life_state = None;
            match config_cache.fetch(
                snapshot.panel.mode.as_str(),
                snapshot.panel.last_updated.as_str(),
                &snapshot.panel.mode_config,
            ) {
                CachedConfig::Image(arc) => Mode::Image(Arc::clone(arc)),
                _ => unreachable!("cache returns the variant we asked for"),
            }
        }
        "gif" => {
            *life_state = None;
            match config_cache.fetch(
                "gif",
                snapshot.panel.last_updated.as_str(),
                &snapshot.panel.mode_config,
            ) {
                CachedConfig::Gif(arc) => Mode::Gif(Arc::clone(arc)),
                _ => unreachable!("cache returns the variant we asked for"),
            }
        }
        "shapes" => {
            *life_state = None;
            match config_cache.fetch(
                "shapes",
                snapshot.panel.last_updated.as_str(),
                &snapshot.panel.mode_config,
            ) {
                CachedConfig::Shapes(frame) => Mode::Shapes(frame.clone()),
                _ => unreachable!("cache returns the variant we asked for"),
            }
        }
        "test" => {
            *life_state = None;
            match config_cache.fetch(
                "test",
                snapshot.panel.last_updated.as_str(),
                &snapshot.panel.mode_config,
            ) {
                CachedConfig::Test(frame) => Mode::Test(frame.clone()),
                _ => unreachable!("cache returns the variant we asked for"),
            }
        }
        // Stateless ambient scenes — pure functions of (config, step).
        // Configs are a handful of scalars, so per-frame parse (like
        // clock) is cheaper than threading them through ConfigCache.
        "plasma" => {
            *life_state = None;
            Mode::Plasma(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        "fire" => {
            *life_state = None;
            Mode::Fire(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        "rain" => {
            *life_state = None;
            Mode::Rain(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        "starfield" => {
            *life_state = None;
            Mode::Starfield(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        "lava" => {
            *life_state = None;
            Mode::Lava(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        "warp" => {
            *life_state = None;
            Mode::Warp(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        "fx" => {
            *life_state = None;
            Mode::Fx(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        // Time-injected scenes (mirrors clock): config persisted,
        // `now` sampled here each frame. Sky math is UTC-based; pong
        // shows local wall-clock score.
        "sky" => {
            *life_state = None;
            let config: SkySceneConfig =
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default();
            let utc = chrono::Utc::now();
            #[allow(clippy::cast_possible_truncation)]
            let now = SkyTime {
                year: chrono::Datelike::year(&utc),
                month: chrono::Datelike::month(&utc) as u8,
                day: chrono::Datelike::day(&utc) as u8,
                hour: chrono::Timelike::hour(&utc) as u8,
                minute: chrono::Timelike::minute(&utc) as u8,
            };
            Mode::Sky(config.into_frame(now))
        }
        "pong" => {
            *life_state = None;
            let config: PongSceneConfig =
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default();
            let local = sample_time(None);
            Mode::Pong(config.into_frame(PongTime {
                hour: local.hour,
                minute: local.minute,
                second: local.second,
            }))
        }
        // Stateful sims: payload is just the parsed config; the
        // render path advances state via the SimHost.
        "physarum" => {
            *life_state = None;
            Mode::Physarum(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        "rd" => {
            *life_state = None;
            Mode::Rd(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        "fluid" => {
            *life_state = None;
            Mode::Fluid(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        "sand" => {
            *life_state = None;
            Mode::Sand(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        "swarm" => {
            *life_state = None;
            Mode::Swarm(
                serde_json::from_value(snapshot.panel.mode_config.clone()).unwrap_or_default(),
            )
        }
        _ => {
            *life_state = None;
            Mode::Text(TextScene {
                entries: snapshot.entries.clone(),
                scroll: snapshot.panel.scroll,
            })
        }
    }
}

