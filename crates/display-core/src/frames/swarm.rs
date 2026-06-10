//! Boids flocking with additive light trails. State via `SimHost`.
//!
//! Classic Reynolds rules (separation / alignment / cohesion) plus a
//! slowly wandering Lissajous attractor so the flock tours the panel,
//! and an occasional hash-scheduled "startle" impulse so it scatters
//! and reforms. Each boid stamps a trail cell per step; the trail
//! decays multiplicatively into crisp comet tails. All randomness is
//! integer-hash derived from (seed, index, tick) — driver and wasm
//! sim step identically.

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

fn d_color() -> Rgb { Rgb { r: 0x4d, g: 0xa3, b: 0xff } }
fn d_count() -> u32 { 60 }
fn d_trail() -> f32 { 0.90 }
fn d_speed() -> f32 { 1.0 }

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SwarmConfig {
    /// Boid/trail color.
    #[serde(default = "d_color")]
    pub color: Rgb,
    /// Flock size. Clamped [10, 200].
    #[serde(default = "d_count")]
    pub count: u32,
    /// Trail persistence per step in [0.5, 0.98].
    #[serde(default = "d_trail")]
    pub trail: f32,
    /// Flight speed multiplier. Clamped [0.1, 4].
    #[serde(default = "d_speed")]
    pub speed: f32,
}

impl Default for SwarmConfig {
    fn default() -> Self {
        Self { color: d_color(), count: d_count(), trail: d_trail(), speed: d_speed() }
    }
}

/// Sim lattice edge — the state is fixed 64×64 regardless of canvas.
const SIZE: usize = 64;
const SIZE_F: f32 = 64.0;

/// Separation radius² — push apart inside ~4 px (strong, short).
const SEP_R2: f32 = 16.0;
/// Alignment/cohesion radius² — flock-sense inside ~9 px.
const FLOCK_R2: f32 = 81.0;
/// Separation weight on the summed inverse-square push.
const SEP_W: f32 = 0.10;
/// Alignment weight toward the neighborhood's mean velocity.
const ALI_W: f32 = 0.05;
/// Cohesion weight toward the neighborhood's centroid.
const COH_W: f32 = 0.004;
/// Pull toward the wandering attractor — weak, just a travel bias.
const ATTRACT_W: f32 = 0.0015;
/// Attractor Lissajous periods in steps (~11 s / ~17 s at 60/s);
/// coprime-ish so the path precesses instead of repeating.
const ATTRACT_PX: u64 = 660;
const ATTRACT_PY: u64 = 1020;
/// Startle scheduling: one impulse per 10 s window, at a hashed
/// offset within the window, lasting STARTLE_TICKS steps.
const STARTLE_WINDOW: u64 = 600;
const STARTLE_TICKS: u64 = 18;
/// Peak per-step repulsion accel at the startle point.
const STARTLE_W: f32 = 0.5;
/// Edge soft-turn: steer-away band width and full-depth accel.
const EDGE_MARGIN: f32 = 6.0;
const EDGE_W: f32 = 0.12;
/// Base speed bounds in px/step (before the cfg.speed multiplier).
const V_MIN: f32 = 0.3;
const V_MAX: f32 = 1.1;
/// Trail cells below this are flushed to zero (skipped at render).
const TRAIL_FLOOR: f32 = 0.01;
/// Trail brightness at the ramp knee (trail = 0.5 → color·0.6).
const KNEE: f32 = 0.6;
/// White mix-in for boid heads over their own trail color.
const HEAD_WHITE: f32 = 0.55;

pub struct Boid {
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
}

pub struct State {
    pub boids: Vec<Boid>,
    pub trail: Vec<f32>,
    seed: u32,
    tick: u64,
}

impl State {
    #[must_use]
    pub fn new(cfg: &SwarmConfig, seed: u32) -> Self {
        let n = cfg.count.clamp(10, 200);
        let boids = (0..n)
            .map(|i| {
                let k = seed.wrapping_add(i);
                let ang = core::f32::consts::TAU * hash01(k, 2);
                let mag = 0.5 + 0.4 * hash01(k, 3);
                Boid {
                    x: 4.0 + 56.0 * hash01(k, 0),
                    y: 4.0 + 56.0 * hash01(k, 1),
                    vx: ang.cos() * mag,
                    vy: ang.sin() * mag,
                }
            })
            .collect();
        Self { boids, trail: vec![0.0; SIZE * SIZE], seed, tick: 0 }
    }

    /// True when `cfg` doesn't require a rebuild of the state.
    #[must_use]
    pub fn compatible(&self, cfg: &SwarmConfig) -> bool {
        self.boids.len() == cfg.count.clamp(10, 200) as usize
    }

    pub fn advance(&mut self, cfg: &SwarmConfig, elapsed_steps: usize) {
        let keep = finite_clamp(cfg.trail, 0.5, 0.98, d_trail());
        let dt = finite_clamp(cfg.speed, 0.1, 4.0, d_speed());
        for _ in 0..elapsed_steps {
            self.step(keep, dt);
        }
    }

    /// One sim tick: decay trail, run boids rules, integrate, deposit.
    /// `dt` is the speed multiplier applied as time dilation (scales
    /// both acceleration and displacement), so the flock traces the
    /// same shapes faster instead of just flying with longer legs.
    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_precision_loss)]
    #[allow(clippy::cast_sign_loss)]
    fn step(&mut self, keep: f32, dt: f32) {
        self.tick = self.tick.wrapping_add(1);
        let t = self.tick;

        for cell in &mut self.trail {
            *cell *= keep;
            if *cell < TRAIL_FLOOR {
                *cell = 0.0;
            }
        }

        // Wandering attractor on a Lissajous figure of the wrapping
        // tick counter, folded per-axis onto its period.
        let ax = 32.0 + 22.0 * sin_period(t, ATTRACT_PX, hash01(self.seed, 10));
        let ay = 32.0 + 22.0 * sin_period(t, ATTRACT_PY, hash01(self.seed, 11));

        // Hash-scheduled startle: each window picks an offset and a
        // panic point; consecutive events land ~8–15 s apart.
        let win = (t / STARTLE_WINDOW) as u32;
        let off = (hash01(win, self.seed ^ 5)
            * ((STARTLE_WINDOW - STARTLE_TICKS - 1) as f32)) as u64;
        let phase = t % STARTLE_WINDOW;
        let startle = (phase >= off && phase < off + STARTLE_TICKS).then(|| {
            (
                8.0 + 48.0 * hash01(win, self.seed ^ 6),
                8.0 + 48.0 * hash01(win, self.seed ^ 7),
            )
        });

        // O(n²) neighbor rules against a pre-step snapshot so update
        // order can't bias the flock.
        let snap: Vec<(f32, f32, f32, f32)> =
            self.boids.iter().map(|b| (b.x, b.y, b.vx, b.vy)).collect();
        for (i, b) in self.boids.iter_mut().enumerate() {
            let (mut sx, mut sy) = (0.0_f32, 0.0_f32);
            let (mut avx, mut avy) = (0.0_f32, 0.0_f32);
            let (mut acx, mut acy) = (0.0_f32, 0.0_f32);
            let mut near = 0u32;
            for (j, &(ox, oy, ovx, ovy)) in snap.iter().enumerate() {
                if j == i {
                    continue;
                }
                let dx = b.x - ox;
                let dy = b.y - oy;
                let d2 = dx * dx + dy * dy;
                if d2 >= FLOCK_R2 {
                    continue;
                }
                near += 1;
                avx += ovx;
                avy += ovy;
                acx += ox;
                acy += oy;
                if d2 < SEP_R2 {
                    let inv = 1.0 / (d2 + 0.05);
                    sx += dx * inv;
                    sy += dy * inv;
                }
            }

            let mut fx = sx * SEP_W + (ax - b.x) * ATTRACT_W;
            let mut fy = sy * SEP_W + (ay - b.y) * ATTRACT_W;
            if near > 0 {
                let inv = 1.0 / near as f32;
                fx += (avx * inv - b.vx) * ALI_W + (acx * inv - b.x) * COH_W;
                fy += (avy * inv - b.vy) * ALI_W + (acy * inv - b.y) * COH_W;
            }
            if let Some((px, py)) = startle {
                let dx = b.x - px;
                let dy = b.y - py;
                let d = (dx * dx + dy * dy).sqrt().max(1.0);
                let fall = (1.0 - d / 72.0).max(0.0) * STARTLE_W / d;
                fx += dx * fall;
                fy += dy * fall;
            }
            // Soft-turn away from edges — bounces read better than
            // wrapping for a flock.
            if b.x < EDGE_MARGIN {
                fx += EDGE_W * (EDGE_MARGIN - b.x) / EDGE_MARGIN;
            } else if b.x > SIZE_F - 1.0 - EDGE_MARGIN {
                fx -= EDGE_W * (b.x - (SIZE_F - 1.0 - EDGE_MARGIN)) / EDGE_MARGIN;
            }
            if b.y < EDGE_MARGIN {
                fy += EDGE_W * (EDGE_MARGIN - b.y) / EDGE_MARGIN;
            } else if b.y > SIZE_F - 1.0 - EDGE_MARGIN {
                fy -= EDGE_W * (b.y - (SIZE_F - 1.0 - EDGE_MARGIN)) / EDGE_MARGIN;
            }

            b.vx += fx * dt;
            b.vy += fy * dt;
            let v2 = b.vx * b.vx + b.vy * b.vy;
            if v2 > V_MAX * V_MAX {
                let s = V_MAX / v2.sqrt();
                b.vx *= s;
                b.vy *= s;
            } else if v2 < V_MIN * V_MIN {
                if v2 > 1e-8 {
                    let s = V_MIN / v2.sqrt();
                    b.vx *= s;
                    b.vy *= s;
                } else {
                    // Degenerate standstill — kick along a hashed axis.
                    let ang = core::f32::consts::TAU * hash01(i as u32, self.seed ^ 9);
                    b.vx = ang.cos() * V_MIN;
                    b.vy = ang.sin() * V_MIN;
                }
            }

            b.x += b.vx * dt;
            b.y += b.vy * dt;
            // Backstop for fast overshoot past the soft-turn band.
            if b.x < 0.0 {
                b.x = 0.0;
                b.vx = b.vx.abs();
            } else if b.x > SIZE_F - 1.0 {
                b.x = SIZE_F - 1.0;
                b.vx = -b.vx.abs();
            }
            if b.y < 0.0 {
                b.y = 0.0;
                b.vy = b.vy.abs();
            } else if b.y > SIZE_F - 1.0 {
                b.y = SIZE_F - 1.0;
                b.vy = -b.vy.abs();
            }

            self.trail[b.y as usize * SIZE + b.x as usize] = 1.0;
        }
    }
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_sign_loss)]
pub fn render<D>(state: &State, cfg: &SwarmConfig, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let w = (size.width as usize).min(SIZE);
    let h = (size.height as usize).min(SIZE);
    let (cr, cg, cb) = (
        f32::from(cfg.color.r),
        f32::from(cfg.color.g),
        f32::from(cfg.color.b),
    );

    // Trail ramp: black → color·KNEE over the lower half, then up to
    // full color — keeps comet tails readable without washing out.
    let mut px = Vec::with_capacity(w * h / 4 + state.boids.len());
    for y in 0..h {
        let row = y * SIZE;
        for x in 0..w {
            let v = state.trail[row + x];
            if v < TRAIL_FLOOR {
                continue;
            }
            let v = v.min(1.0);
            let m = if v < 0.5 {
                v * (KNEE / 0.5)
            } else {
                KNEE + (v - 0.5) * ((1.0 - KNEE) / 0.5)
            };
            px.push(Pixel(
                Point::new(x as i32, y as i32),
                Rgb888::new((cr * m) as u8, (cg * m) as u8, (cb * m) as u8),
            ));
        }
    }

    // Boid heads after the trail so they overwrite it: the flock's
    // own color pushed toward white.
    let head = Rgb888::new(
        (cr + (255.0 - cr) * HEAD_WHITE) as u8,
        (cg + (255.0 - cg) * HEAD_WHITE) as u8,
        (cb + (255.0 - cb) * HEAD_WHITE) as u8,
    );
    for b in &state.boids {
        let x = b.x.round() as i32;
        let y = b.y.round() as i32;
        if x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h {
            px.push(Pixel(Point::new(x, y), head));
        }
    }
    canvas.draw_iter(px)
}

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight into the sim — NaN falls back to `default`.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() { default } else { v.clamp(lo, hi) }
}

/// Sine of the wrapping tick counter folded onto `period` steps. The
/// integer modulo happens before any float conversion, so phase
/// precision never degrades as the counter grows.
#[allow(clippy::cast_precision_loss)]
fn sin_period(tick: u64, period: u64, phase: f32) -> f32 {
    use core::f32::consts::TAU;
    let frac = (tick % period) as f32 / period as f32 + phase;
    (frac.fract() * TAU).sin()
}

/// Deterministic constant in [0, 1): an integer avalanche hash of
/// (index, salt). No RNG anywhere — driver and simulator must step
/// identical states from (cfg, seed, tick) alone.
#[allow(clippy::cast_precision_loss)]
fn hash01(i: u32, salt: u32) -> f32 {
    let mut x = i
        .wrapping_mul(0x9E37_79B9)
        .wrapping_add(salt.wrapping_mul(0x85EB_CA6B));
    x ^= x >> 16;
    x = x.wrapping_mul(0x7FEB_352D);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846C_A68B);
    x ^= x >> 16;
    (x as f32) / 4_294_967_296.0
}
