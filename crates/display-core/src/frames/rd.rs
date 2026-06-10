//! Gray-Scott reaction-diffusion — U/V chemical lattice growing
//! spots/stripes/coral. State + stepping shared via `SimHost`.
//!
//! Two chemicals diffuse on a 64×64 torus: U feeds in everywhere at
//! rate F, V eats U (`u·v²`) and is killed at rate F+k. Depending on
//! where (F, k) sits, the front between them freezes into mitosing
//! spots, labyrinthine stripes, or coral growth. With `drift` on,
//! (F, k) slowly orbits a small ellipse *around the configured
//! values* (the config is the orbit center, ±0.004 in F / ±0.002 in
//! k over ~90 s), so the pattern morphs between regimes forever.
//!
//! The sim self-heals: if V dies out (all-blue homogeneous state) or
//! floods the grid (near-saturation), the field is reseeded with
//! hash-placed blobs — deterministic via a reseed counter, so driver
//! and wasm sim stay in lockstep. All randomness is integer-hash
//! based (no RNG, no clock), as in `physarum`/`fire`.

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

fn d_color() -> Rgb { Rgb { r: 0x4d, g: 0xe0, b: 0xe0 } }
fn d_feed() -> f32 { 0.0545 }
fn d_kill() -> f32 { 0.062 }
fn d_drift() -> bool { true }
fn d_speed() -> f32 { 1.0 }

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RdConfig {
    /// Pattern color at full V concentration.
    #[serde(default = "d_color")]
    pub color: Rgb,
    /// Feed rate F. Clamped [0.01, 0.12].
    #[serde(default = "d_feed")]
    pub feed: f32,
    /// Kill rate k. Clamped [0.04, 0.08].
    #[serde(default = "d_kill")]
    pub kill: f32,
    /// Slowly wander (feed, kill) through pattern regimes.
    #[serde(default = "d_drift")]
    pub drift: bool,
    /// Sim substep multiplier. Clamped [0.1, 4].
    #[serde(default = "d_speed")]
    pub speed: f32,
}

impl Default for RdConfig {
    fn default() -> Self {
        Self { color: d_color(), feed: d_feed(), kill: d_kill(), drift: d_drift(), speed: d_speed() }
    }
}

const W: usize = 64;
const H: usize = 64;
const CELLS: usize = W * H;

/// Diffusion rates — the classic 2:1 ratio that makes the U front
/// outrun V and the patterns Turing-unstable. dt is folded in at 1.
const DU: f32 = 1.0;
const DV: f32 = 0.5;

/// Substeps per scene step at speed 1. Gray-Scott needs several
/// integration steps per frame to grow at a watchable pace.
const SUBSTEPS_PER_STEP: f32 = 4.0;
/// Substep cap per advance — bounds catch-up cost after a stall
/// (4096 cells × ~12 flops × 40 is the per-frame budget ceiling).
const MAX_SUBSTEPS: usize = 40;

/// Drift orbit: period in scene steps (~90 s at the nominal 60/s)
/// and half-axes of the (F, k) ellipse around the configured center.
const DRIFT_PERIOD: u32 = 5400;
const DRIFT_F_AMP: f32 = 0.004;
const DRIFT_K_AMP: f32 = 0.002;

/// Self-heal thresholds on total V: below `DEAD_SUM` the pattern has
/// died out (V decays exponentially to zero once extinct); above a
/// mean of `FILL_MEAN` per cell the grid has flooded into the dull
/// homogeneous state. Healthy patterns sit far inside both bounds
/// (mean V ≲ 0.2; a fresh seeding alone contributes ~150).
const DEAD_SUM: f32 = 0.05;
const FILL_MEAN: f32 = 0.35;

/// V level rendered at full `cfg.color`; spot cores overshoot into
/// the white tip. Below `V_CUTOFF` the pixel stays unlit — dim LED
/// noise reads worse than black.
const V_FULL: f32 = 0.4;
const V_CUTOFF: f32 = 0.02;

/// Cheap u32 finalizer (xorshift-multiply rounds, lowbias32-style).
/// Sole randomness source for the sim, as in `physarum`/`rain`.
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

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight into the sim — so NaN falls back to `default`
/// instead of poisoning the lattice.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

pub struct State {
    pub u: Vec<f32>,
    pub v: Vec<f32>,
    /// Double buffers for the diffusion pass — swapped each substep
    /// instead of allocating.
    u_back: Vec<f32>,
    v_back: Vec<f32>,
    seed: u32,
    /// Wrapping (F, k) orbit clock in scene steps, folded onto
    /// `DRIFT_PERIOD` so it never accumulates float error or drifts
    /// out of range with uptime.
    drift_phase: u32,
    /// Bumped on every self-heal; hashed with the seed to place the
    /// next generation of blobs somewhere new (but deterministic).
    reseed: u32,
    /// Fractional substep carry in [0, 1) — lets sub-integer substep
    /// rates (slow `speed`) advance smoothly without a float clock.
    carry: f32,
}

impl State {
    #[must_use]
    pub fn new(_cfg: &RdConfig, seed: u32) -> Self {
        let mut s = Self {
            u: vec![1.0; CELLS],
            v: vec![0.0; CELLS],
            u_back: vec![1.0; CELLS],
            v_back: vec![0.0; CELLS],
            seed,
            drift_phase: 0,
            reseed: 0,
            carry: 0.0,
        };
        s.seed_blobs();
        s
    }

    /// True when `cfg` doesn't require a rebuild of the state. Every
    /// RD parameter is live — morphing under slider moves is the
    /// point — so the lattice always survives a config change.
    #[must_use]
    pub fn compatible(&self, _cfg: &RdConfig) -> bool {
        true
    }

    /// Reset to the U-saturated field and stamp several hash-placed
    /// V blobs (radius ~3, toroidal) for the reaction to grow from.
    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_possible_wrap)]
    fn seed_blobs(&mut self) {
        self.u.fill(1.0);
        self.v.fill(0.0);
        let gen = self.seed.wrapping_add(self.reseed.wrapping_mul(0x9e37_79b9));
        let blobs = 4 + (hash2(gen, 0xb10b) & 3); // 4..=7
        for i in 0..blobs {
            let h = hash2(gen, i);
            let cx = (h % W as u32) as usize;
            let cy = ((h >> 8) % H as u32) as usize;
            for dy in 0..7usize {
                let y = (cy + dy + H - 3) % H;
                for dx in 0..7usize {
                    let (rx, ry) = (dx as i32 - 3, dy as i32 - 3);
                    if rx * rx + ry * ry <= 9 {
                        self.v[y * W + (cx + dx + W - 3) % W] = 1.0;
                    }
                }
            }
        }
    }

    #[allow(clippy::cast_precision_loss)]
    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_sign_loss)]
    pub fn advance(&mut self, cfg: &RdConfig, elapsed_steps: usize) {
        if elapsed_steps == 0 {
            return;
        }
        let speed = finite_clamp(cfg.speed, 0.1, 4.0, d_speed());
        let mut feed = finite_clamp(cfg.feed, 0.01, 0.12, d_feed());
        let mut kill = finite_clamp(cfg.kill, 0.04, 0.08, d_kill());

        // Orbit (F, k) around the configured center. The phase clock
        // always runs (so toggling drift resumes mid-orbit), wrapping
        // on its period to stay uptime-proof.
        self.drift_phase = (self.drift_phase + elapsed_steps as u32) % DRIFT_PERIOD;
        if cfg.drift {
            let ang = self.drift_phase as f32 / DRIFT_PERIOD as f32 * core::f32::consts::TAU;
            feed = (feed + DRIFT_F_AMP * ang.cos()).clamp(0.01, 0.12);
            kill = (kill + DRIFT_K_AMP * ang.sin()).clamp(0.04, 0.08);
        }

        // Substep budget: 4·speed per scene step, fractional part
        // carried (bounded < 1), total capped — excess from a stall
        // is dropped, not deferred.
        let budget = SUBSTEPS_PER_STEP * speed * elapsed_steps as f32 + self.carry;
        let substeps = budget as usize;
        self.carry = budget - substeps as f32;
        for _ in 0..substeps.min(MAX_SUBSTEPS) {
            self.substep(feed, kill);
        }

        // Self-heal: reseed when V has died out or flooded the grid.
        let v_sum: f32 = self.v.iter().sum();
        if v_sum < DEAD_SUM || v_sum > FILL_MEAN * CELLS as f32 {
            self.reseed = self.reseed.wrapping_add(1);
            self.seed_blobs();
        }
    }

    /// One Gray-Scott integration step (dt = 1): 3×3 Laplacian
    /// (corners 0.05, edges 0.2, center −1) on the torus, then the
    /// reaction terms, clamped to [0, 1] for unconditional stability.
    fn substep(&mut self, feed: f32, kill: f32) {
        let (u, v) = (&self.u, &self.v);
        let (un, vn) = (&mut self.u_back, &mut self.v_back);
        for y in 0..H {
            let mid = y * W;
            let up = (y + H - 1) % H * W;
            let dn = (y + 1) % H * W;
            for x in 0..W {
                let xl = (x + W - 1) % W;
                let xr = (x + 1) % W;
                let uc = u[mid + x];
                let vc = v[mid + x];
                let lap_u = 0.05 * (u[up + xl] + u[up + xr] + u[dn + xl] + u[dn + xr])
                    + 0.2 * (u[up + x] + u[dn + x] + u[mid + xl] + u[mid + xr])
                    - uc;
                let lap_v = 0.05 * (v[up + xl] + v[up + xr] + v[dn + xl] + v[dn + xr])
                    + 0.2 * (v[up + x] + v[dn + x] + v[mid + xl] + v[mid + xr])
                    - vc;
                let r = uc * vc * vc;
                un[mid + x] = (uc + (DU * lap_u - r + feed * (1.0 - uc))).clamp(0.0, 1.0);
                vn[mid + x] = (vc + (DV * lap_v + r - (feed + kill) * vc)).clamp(0.0, 1.0);
            }
        }
        core::mem::swap(&mut self.u, &mut self.u_back);
        core::mem::swap(&mut self.v, &mut self.v_back);
    }
}

/// V level → palette: black → 0.4·color → color → white-tipped in
/// the top ~15%. `t` is pre-normalized to [0, 1].
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
fn shade(color: Rgb, t: f32) -> Rgb888 {
    let ch = |c: u8, f: f32| (f32::from(c) * f) as u8;
    if t < 0.45 {
        // black → 0.4·color
        let f = t / 0.45 * 0.4;
        Rgb888::new(ch(color.r, f), ch(color.g, f), ch(color.b, f))
    } else if t < 0.85 {
        // 0.4·color → color
        let f = 0.4 + 0.6 * (t - 0.45) / 0.40;
        Rgb888::new(ch(color.r, f), ch(color.g, f), ch(color.b, f))
    } else {
        // color → toward white at the spot cores
        let f = (t - 0.85) / 0.15 * 0.7;
        let lift = |c: u8| c + ((255.0 - f32::from(c)) * f) as u8;
        Rgb888::new(lift(color.r), lift(color.g), lift(color.b))
    }
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
pub fn render<D>(state: &State, cfg: &RdConfig, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity(CELLS / 2);
    for (i, &v) in state.v.iter().enumerate() {
        if v < V_CUTOFF {
            continue; // unlit beats dim noise on LEDs
        }
        let t = (v / V_FULL).min(1.0);
        let p = Point::new((i % W) as i32, (i / W) as i32);
        px.push(Pixel(p, shade(cfg.color, t)));
    }
    canvas.draw_iter(px)
}
