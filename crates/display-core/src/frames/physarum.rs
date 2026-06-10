//! Physarum (slime mold) — agents sense/deposit/diffuse a pheromone
//! trail. State + stepping live here (shared by driver and wasm sim
//! via `SimHost`); render paints the trail map through a palette.
//!
//! Classic Jones 2010 rules tuned for 64×64: each agent samples the
//! trail at three probes (ahead and ±25° at ~5 px), turns toward the
//! strongest reading, moves ~1 px, and deposits; the field then gets
//! a 3×3 mean blur and multiplicative decay. The positive feedback
//! collapses the population into glowing vein networks that pulse
//! and reorganize forever. All randomness is integer-hash based
//! (seed + a wrapping draw counter), so driver and sim stay in step.

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

fn d_color() -> Rgb { Rgb { r: 0x5d, g: 0xff, b: 0xa9 } }
fn d_agents() -> u32 { 3000 }
fn d_decay() -> f32 { 0.94 }
fn d_speed() -> f32 { 1.0 }

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PhysarumConfig {
    /// Trail color (bright tip of the palette ramp).
    #[serde(default = "d_color")]
    pub color: Rgb,
    /// Agent population. Clamped [200, 8000] at init.
    #[serde(default = "d_agents")]
    pub agents: u32,
    /// Trail persistence per step in [0.80, 0.99].
    #[serde(default = "d_decay")]
    pub decay: f32,
    /// Sim rate multiplier. Clamped [0.1, 4].
    #[serde(default = "d_speed")]
    pub speed: f32,
}

impl Default for PhysarumConfig {
    fn default() -> Self {
        Self { color: d_color(), agents: d_agents(), decay: d_decay(), speed: d_speed() }
    }
}

const W: usize = 64;
const H: usize = 64;
const CELLS: usize = W * H;

/// Probe reach in pixels — the network's characteristic mesh size.
/// ~5 px gives vein spacing that reads clearly on a 64×64 panel.
const SENSE_DIST: f32 = 5.0;
/// Side probe offset from the heading (~25°).
const SENSE_ANGLE: f32 = 0.4363;
/// Steering applied per tick when a side probe wins (~22°).
const TURN: f32 = 0.3840;
/// Pheromone dropped per agent per tick.
const DEPOSIT: f32 = 1.0;

/// Cheap u32 finalizer (xorshift-multiply rounds, lowbias32-style).
/// Sole randomness source for the sim, as in `rain`/`starfield`.
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
/// instead of poisoning the trail field.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

/// Map a hash to [0, 1).
#[allow(clippy::cast_precision_loss)]
fn unit(h: u32) -> f32 {
    (h >> 8) as f32 / 16_777_216.0
}

/// Wrap a coordinate onto the torus and index it. `rem_euclid` can
/// round up to exactly `64.0` for tiny negatives, hence the `.min`.
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
fn cell(x: f32, y: f32) -> usize {
    let cx = (x.rem_euclid(W as f32) as usize).min(W - 1);
    let cy = (y.rem_euclid(H as f32) as usize).min(H - 1);
    cy * W + cx
}

struct Agent {
    x: f32,
    y: f32,
    heading: f32,
}

pub struct State {
    pub trail: Vec<f32>,
    /// Double buffer for the blur pass — avoids a 16 KB alloc per tick.
    scratch: Vec<f32>,
    agents: Vec<Agent>,
    agents_n: u32,
    seed: u32,
    /// Wrapping draw counter; `hash2(seed, ctr)` is the RNG stream.
    rng_ctr: u32,
}

impl State {
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn new(cfg: &PhysarumConfig, seed: u32) -> Self {
        let n = cfg.agents.clamp(200, 8000);
        let mut rng_ctr: u32 = 0;
        let mut draw = |salt: u32| {
            rng_ctr = rng_ctr.wrapping_add(1);
            hash2(seed ^ salt, rng_ctr)
        };
        // Full scatter with random headings: the field self-organizes
        // into a network within the first few seconds regardless.
        let agents = (0..n)
            .map(|_| Agent {
                x: unit(draw(0x5ca7_7e21)) * W as f32,
                y: unit(draw(0x5ca7_7e22)) * H as f32,
                heading: unit(draw(0x5ca7_7e23)) * core::f32::consts::TAU,
            })
            .collect();
        Self {
            trail: vec![0.0; CELLS],
            scratch: vec![0.0; CELLS],
            agents,
            agents_n: cfg.agents,
            seed,
            rng_ctr,
        }
    }

    /// True when `cfg` doesn't require a rebuild of the state.
    /// Only the population is structural; decay/speed/color are live.
    #[must_use]
    pub fn compatible(&self, cfg: &PhysarumConfig) -> bool {
        self.agents_n == cfg.agents
    }

    fn rand(&mut self) -> u32 {
        self.rng_ctr = self.rng_ctr.wrapping_add(1);
        hash2(self.seed, self.rng_ctr)
    }

    pub fn advance(&mut self, cfg: &PhysarumConfig, elapsed_steps: usize) {
        let speed = finite_clamp(cfg.speed, 0.1, 4.0, d_speed());
        let decay = finite_clamp(cfg.decay, 0.80, 0.99, d_decay());
        for _ in 0..elapsed_steps {
            self.tick(speed, decay);
        }
    }

    /// One sim tick: sense → steer → move → deposit, then blur+decay.
    fn tick(&mut self, speed: f32, decay: f32) {
        let step_len = speed; // ~1 px per tick at speed 1
        for i in 0..self.agents.len() {
            let (x, y, heading) = {
                let a = &self.agents[i];
                (a.x, a.y, a.heading)
            };
            let probe = |da: f32| {
                let (s, c) = (heading + da).sin_cos();
                self.trail[cell(x + c * SENSE_DIST, y + s * SENSE_DIST)]
            };
            let front = probe(0.0);
            let left = probe(-SENSE_ANGLE);
            let right = probe(SENSE_ANGLE);

            // Classic steering: straight when ahead wins; random
            // flip when flanked on both sides; else toward the
            // stronger flank.
            let turn = if front >= left && front >= right {
                0.0
            } else if left > front && right > front {
                if self.rand() & 1 == 0 { -TURN } else { TURN }
            } else if left > right {
                -TURN
            } else {
                TURN
            };

            let a = &mut self.agents[i];
            // Fold onto one turn: an agent orbiting a trail loop turns
            // the same way forever, and an unbounded f32 heading loses
            // sub-TURN resolution past ~2^22 (the steering would
            // quantize away after days of uptime).
            a.heading = (a.heading + turn).rem_euclid(core::f32::consts::TAU);
            let (s, c) = a.heading.sin_cos();
            a.x = (a.x + c * step_len).rem_euclid(W as f32);
            a.y = (a.y + s * step_len).rem_euclid(H as f32);
            let idx = cell(a.x, a.y);
            self.trail[idx] += DEPOSIT;
        }

        // 3×3 mean blur (toroidal) into the scratch buffer, with the
        // multiplicative decay folded into the same pass.
        let k = decay / 9.0;
        for y in 0..H {
            let up = (y + H - 1) % H * W;
            let mid = y * W;
            let dn = (y + 1) % H * W;
            for x in 0..W {
                let xl = (x + W - 1) % W;
                let xr = (x + 1) % W;
                let sum = self.trail[up + xl] + self.trail[up + x] + self.trail[up + xr]
                    + self.trail[mid + xl] + self.trail[mid + x] + self.trail[mid + xr]
                    + self.trail[dn + xl] + self.trail[dn + x] + self.trail[dn + xr];
                self.scratch[mid + x] = sum * k;
            }
        }
        core::mem::swap(&mut self.trail, &mut self.scratch);
    }
}

/// Trail value → palette: black → color/3 → color → white-tipped in
/// the top ~15%. `t` is pre-normalized to [0, 1].
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
fn shade(color: Rgb, t: f32) -> Rgb888 {
    let ch = |c: u8, f: f32| (f32::from(c) * f) as u8;
    if t < 0.45 {
        // black → color/3
        let f = t / 0.45 / 3.0;
        Rgb888::new(ch(color.r, f), ch(color.g, f), ch(color.b, f))
    } else if t < 0.85 {
        // color/3 → color
        let f = (1.0 + 2.0 * (t - 0.45) / 0.40) / 3.0;
        Rgb888::new(ch(color.r, f), ch(color.g, f), ch(color.b, f))
    } else {
        // color → toward white at the very top
        let f = (t - 0.85) / 0.15 * 0.7;
        let lift = |c: u8| c + ((255.0 - f32::from(c)) * f) as u8;
        Rgb888::new(lift(color.r), lift(color.g), lift(color.b))
    }
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_precision_loss)]
pub fn render<D>(state: &State, cfg: &PhysarumConfig, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let decay = finite_clamp(cfg.decay, 0.80, 0.99, d_decay());
    // Steady-state mean trail per cell: total mass converges to
    // n·decay/(1−decay), spread over the grid. Veins concentrate
    // several × the mean, so a soft knee at ~2.5× mean puts them in
    // the bright half of the ramp while the background stays dark.
    let mean = (state.agents.len() as f32 * decay / (1.0 - decay) / CELLS as f32).max(0.5);
    let knee = mean * 2.5;

    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity(CELLS / 2);
    for (i, &v) in state.trail.iter().enumerate() {
        let t = v / (v + knee); // tone-map to [0, 1)
        if t < 0.04 {
            continue; // unlit beats dim noise on LEDs
        }
        let p = Point::new((i % W) as i32, (i / W) as i32);
        px.push(Pixel(p, shade(cfg.color, t)));
    }
    canvas.draw_iter(px)
}

