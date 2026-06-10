//! Falling-sand cellular automaton — grains pour, pile with angle of
//! repose, and periodically drain. `reset_minutes = 60` makes the
//! drain cycle an hourglass. State via `SimHost`.
//!
//! All randomness is integer hashing of a monotonic grain counter (or
//! cell coordinates), so driver and wasm sim agree pixel-for-pixel.
//! All timing is integer step counters at the nominal 60 steps/s —
//! an hourglass fill window of N minutes is exactly `N * 3600` steps.

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

fn d_color() -> Rgb { Rgb { r: 0xff, g: 0x8a, b: 0x2c } }
fn d_rainbow() -> bool { true }
fn d_pour() -> f32 { 1.0 }
fn d_reset() -> u32 { 0 }

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SandConfig {
    /// Grain color when `rainbow` is off.
    #[serde(default = "d_color")]
    pub color: Rgb,
    /// Cycle grain colors through the swatch rainbow (strata build up).
    #[serde(default = "d_rainbow")]
    pub rainbow: bool,
    /// Pour rate multiplier. Clamped [0.1, 4].
    #[serde(default = "d_pour")]
    pub pour_rate: f32,
    /// Minutes per fill/drain cycle; 0 = continuous recycle. 60 = a
    /// true hourglass. Clamped [0, 1440].
    #[serde(default = "d_reset")]
    pub reset_minutes: u32,
}

impl Default for SandConfig {
    fn default() -> Self {
        Self { color: d_color(), rainbow: d_rainbow(), pour_rate: d_pour(), reset_minutes: d_reset() }
    }
}

const W: usize = 64;
const H: usize = 64;
const STEPS_PER_SEC: u32 = 60;

/// Strata banding: the rainbow hue advances every this many grains.
const GRAINS_PER_BAND: u32 = 300;
/// Seven-hue rainbow for the strata bands.
const RAINBOW: [Rgb; 7] = [
    Rgb { r: 0xff, g: 0x2e, b: 0x2e }, // red
    Rgb { r: 0xff, g: 0x8a, b: 0x2c }, // orange
    Rgb { r: 0xff, g: 0xd9, b: 0x2e }, // yellow
    Rgb { r: 0x3d, g: 0xe6, b: 0x4f }, // green
    Rgb { r: 0x2e, g: 0xd9, b: 0xd9 }, // cyan
    Rgb { r: 0x3d, g: 0x6b, b: 0xff }, // blue
    Rgb { r: 0xb4, g: 0x4d, b: 0xff }, // violet
];

/// Spout sweep range and pacing: the pour point walks a triangle wave
/// across [`SWEEP_MIN`, `SWEEP_MAX`], advancing 1 px every
/// `SWEEP_DIV` steps (~13.6 s per full out-and-back).
const SWEEP_MIN: i32 = 6;
const SWEEP_MAX: i32 = 57;
const SWEEP_DIV: u32 = 8;
const SWEEP_SPAN: u32 = (SWEEP_MAX - SWEEP_MIN) as u32;
const SWEEP_PERIOD: u32 = 2 * SWEEP_SPAN * SWEEP_DIV;

/// Grain budget for a timed (hourglass) fill. Under a sweeping pour
/// the pile self-organizes into a dome at the angle of repose, whose
/// apex reaches the near-full row at ~3000 grains (measured) — so the
/// budget sits just under that and the window expires right as the
/// dome tops out.
const FILL_TARGET: u32 = 2900;
/// The pile is "near the spout" once a floor-supported column reaches
/// this row; the drain opens.
const NEAR_FULL_ROW: usize = 6;
/// The drain hole starts 4 px wide at bottom center and widens by
/// 1 px per side every this many steps (full width in ~18 s), so the
/// repose wedges at the edges collapse instead of lingering forever.
const HOLE_WIDEN_STEPS: u32 = 36;
/// Drain ends (hole closes, pour resumes) at this few grains left.
const DRAIN_FLOOR: u32 = 8;
/// Backstop: a drain phase never runs longer than this many steps.
const DRAIN_MAX_STEPS: u32 = 40 * STEPS_PER_SEC;

// Domain salts so the spawn-jitter, color-jitter, and tumble hash
// streams never collide even when their integer inputs do.
const SALT_SPAWN: u32 = 0x5A4D_5147;
const SALT_JITTER: u32 = 0x9B1D_E5C3;
const SALT_TUMBLE: u32 = 0x7E6B_2A91;

/// Cheap u32 finalizer (xorshift-multiply rounds, lowbias32-style).
/// Sole randomness source for the sim.
fn mix(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    h
}

fn hash2(a: u32, b: u32) -> u32 {
    mix(a.wrapping_mul(0x9e37_79b9) ^ mix(b))
}

fn hash3(a: u32, b: u32, c: u32) -> u32 {
    mix(hash2(a, b) ^ c.wrapping_mul(0x85eb_ca6b))
}

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight in — so NaN falls back to `default` instead of
/// poisoning the fixed-point pour accumulator.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() { default } else { v.clamp(lo, hi) }
}

/// Scale `color` by a Q8 factor (256 = full; >256 brightens, clamped).
#[allow(clippy::cast_possible_truncation)]
fn scale(color: Rgb, q8: u32) -> Rgb888 {
    let s = |c: u8| ((u32::from(c) * q8) >> 8).min(255) as u8;
    Rgb888::new(s(color.r), s(color.g), s(color.b))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Filling,
    Draining,
}

pub struct State {
    /// 0 = empty; otherwise low nibble = rainbow palette index + 1
    /// (the stratum the grain was deposited in) and high nibble =
    /// per-grain brightness jitter, both fixed at spawn.
    pub grid: Vec<u8>,
    reset_minutes: u32,
    phase: Phase,
    /// Wrapping global step counter — spout sweep + scan parity.
    step: u32,
    /// Steps elapsed in the current phase (fill budget, hole width).
    phase_steps: u32,
    /// Total grains ever deposited — drives strata + per-grain hashes.
    grains: u32,
    /// Grains currently on the grid.
    filled: u32,
    /// Q16 fractional pour accumulator (whole part spawns grains).
    pour_acc: u32,
    /// Current spout column, cached for render.
    spout_x: i32,
}

impl State {
    #[must_use]
    pub fn new(cfg: &SandConfig, seed: u32) -> Self {
        Self {
            grid: vec![0; W * H],
            reset_minutes: cfg.reset_minutes,
            phase: Phase::Filling,
            // Seed only picks where the sweep starts and which hue
            // opens the strata — the dynamics are config-driven.
            step: mix(seed) % SWEEP_PERIOD,
            phase_steps: 0,
            grains: mix(seed ^ SALT_JITTER) % (GRAINS_PER_BAND * 7),
            filled: 0,
            pour_acc: 0,
            spout_x: SWEEP_MIN,
        }
    }

    /// True when `cfg` doesn't require a rebuild of the state.
    /// `rainbow`/`color`/`pour_rate` apply live; only the cycle
    /// window restructures the sim.
    #[must_use]
    pub fn compatible(&self, cfg: &SandConfig) -> bool {
        self.reset_minutes == cfg.reset_minutes
    }

    pub fn advance(&mut self, cfg: &SandConfig, elapsed_steps: usize) {
        let pour = finite_clamp(cfg.pour_rate, 0.1, 4.0, d_pour());
        // The only float→int crossing: the live pour rate in Q16
        // grains/step. Everything after this is exact integer math.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let pour_q16 = (pour * 65536.0) as u32;
        for _ in 0..elapsed_steps {
            self.tick(pour_q16);
        }
    }

    fn tick(&mut self, pour_q16: u32) {
        self.spout_x = SWEEP_MIN + Self::sweep_offset(self.step);
        if self.phase == Phase::Draining {
            self.despawn_hole();
        }
        self.settle();
        if self.phase == Phase::Filling {
            self.pour(pour_q16);
        }
        self.transition();
        self.step = self.step.wrapping_add(1);
        self.phase_steps = self.phase_steps.saturating_add(1);
    }

    /// Triangle wave 0..=SWEEP_SPAN — the spout walks out and back.
    #[allow(clippy::cast_possible_wrap)]
    fn sweep_offset(step: u32) -> i32 {
        let pos = (step / SWEEP_DIV) % (2 * SWEEP_SPAN);
        (if pos < SWEEP_SPAN { pos } else { 2 * SWEEP_SPAN - pos }) as i32
    }

    /// Fill window in steps for hourglass mode; `None` = continuous.
    fn fill_budget(&self) -> Option<u32> {
        let minutes = self.reset_minutes.min(1440);
        (minutes > 0).then(|| minutes * 60 * STEPS_PER_SEC)
    }

    /// Accumulate this tick's pour and spawn the whole grains.
    fn pour(&mut self, pour_q16: u32) {
        let rate_q16 = match self.fill_budget() {
            // Hourglass: meter the remaining grain budget over the
            // remaining window so the panel fills across exactly the
            // configured minutes (self-correcting integer division —
            // lost or early grains re-spread over what's left).
            Some(budget) => {
                let remaining = budget.saturating_sub(self.phase_steps).max(1);
                let need = FILL_TARGET.saturating_sub(self.filled);
                (need.saturating_mul(65536) / remaining).min(4 << 16)
            }
            None => pour_q16,
        };
        self.pour_acc = self.pour_acc.saturating_add(rate_q16);
        while self.pour_acc >= 1 << 16 {
            self.pour_acc -= 1 << 16;
            self.spawn();
        }
    }

    /// Drop one grain at the spout (±1 px hash jitter). A blocked
    /// spawn cell loses the grain — the pile has reached the spout.
    #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap, clippy::cast_sign_loss)]
    fn spawn(&mut self) {
        let dx = (hash2(self.grains, SALT_SPAWN) % 3) as i32 - 1;
        let x = (self.spout_x + dx).clamp(0, W as i32 - 1) as usize;
        if self.grid[x] != 0 {
            return;
        }
        let band = ((self.grains / GRAINS_PER_BAND) % 7) as u8 + 1;
        let jitter = (hash2(self.grains, SALT_JITTER) % 16) as u8;
        self.grid[x] = band | (jitter << 4);
        self.grains = self.grains.wrapping_add(1);
        self.filled += 1;
    }

    /// One gravity pass, bottom-up. The column scan direction
    /// alternates per tick so diagonal slides carry no left/right
    /// bias; ties between down-left and down-right are hash-decided.
    #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap, clippy::cast_sign_loss)]
    fn settle(&mut self) {
        let rightward = self.step & 1 == 0;
        for y in (0..H - 1).rev() {
            for sx in 0..W {
                let x = if rightward { sx } else { W - 1 - sx };
                let i = y * W + x;
                let grain = self.grid[i];
                if grain == 0 {
                    continue;
                }
                if self.grid[i + W] == 0 {
                    self.grid[i + W] = grain;
                    self.grid[i] = 0;
                    continue;
                }
                // Blocked below: angle of repose — tumble diagonally.
                let left_first = hash3(x as u32, y as u32, self.step ^ SALT_TUMBLE) & 1 == 0;
                let dirs = if left_first { [-1i32, 1] } else { [1, -1] };
                for d in dirs {
                    let nx = x as i32 + d;
                    if nx < 0 || nx >= W as i32 {
                        continue;
                    }
                    let ni = (y + 1) * W + nx as usize;
                    if self.grid[ni] == 0 {
                        self.grid[ni] = grain;
                        self.grid[i] = 0;
                        break;
                    }
                }
            }
        }
    }

    /// Despawn grains over the bottom drain hole. The hole widens
    /// from the center as the drain runs (see [`HOLE_WIDEN_STEPS`]).
    #[allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
    fn despawn_hole(&mut self) {
        let half = (2 + self.phase_steps / HOLE_WIDEN_STEPS).min(32) as i32;
        let floor = (H - 1) * W;
        for x in (32 - half).max(0)..(32 + half).min(W as i32) {
            let i = floor + x as usize;
            if self.grid[i] != 0 {
                self.grid[i] = 0;
                self.filled -= 1;
            }
        }
    }

    /// True when some pile column reaches [`NEAR_FULL_ROW`]. Resting
    /// grains always have occupied cells straight down to the floor
    /// (a grain only rests on a blocked cell), while a falling stream
    /// never does — so requiring floor support distinguishes "the
    /// pile is here" from "a stream is passing through".
    fn near_full(&self) -> bool {
        'columns: for x in 0..W {
            for y in NEAR_FULL_ROW..H {
                if self.grid[y * W + x] == 0 {
                    continue 'columns;
                }
            }
            return true;
        }
        false
    }

    fn transition(&mut self) {
        match self.phase {
            Phase::Filling => {
                let out_of_time = self.fill_budget().is_some_and(|b| self.phase_steps >= b);
                if out_of_time || self.near_full() {
                    self.phase = Phase::Draining;
                    self.phase_steps = 0;
                    self.pour_acc = 0;
                }
            }
            Phase::Draining => {
                if self.filled <= DRAIN_FLOOR || self.phase_steps >= DRAIN_MAX_STEPS {
                    self.phase = Phase::Filling;
                    self.phase_steps = 0;
                }
            }
        }
    }
}

#[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
pub fn render<D>(state: &State, cfg: &SandConfig, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity(state.filled as usize + 1);

    // Faint spout dot while pouring — grains drawn later overwrite it.
    if state.phase == Phase::Filling {
        let pour_color = if cfg.rainbow {
            RAINBOW[((state.grains / GRAINS_PER_BAND) % 7) as usize]
        } else {
            cfg.color
        };
        px.push(Pixel(Point::new(state.spout_x, 0), scale(pour_color, 90)));
    }

    for y in 0..H {
        for x in 0..W {
            let grain = state.grid[y * W + x];
            if grain == 0 {
                continue;
            }
            let base = if cfg.rainbow {
                RAINBOW[usize::from((grain & 0x0f) - 1) % 7]
            } else {
                cfg.color
            };
            // Per-grain ±15% brightness jitter (Q8 218..=293) keeps
            // solid-color piles from reading as a flat slab.
            let q8 = 218 + u32::from(grain >> 4) * 5;
            px.push(Pixel(Point::new(x as i32, y as i32), scale(base, q8)));
        }
    }
    canvas.draw_iter(px)
}
