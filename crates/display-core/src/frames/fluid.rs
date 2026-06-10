//! Stable-fluids (Jos Stam, "Real-Time Fluid Dynamics for Games",
//! GDC 2003) velocity field advecting colored dye, with procedural
//! impulse injections. State via `SimHost`.
//!
//! Three injectors orbit the panel on slow Lissajous paths, each
//! pushing a velocity impulse along its path tangent and bleeding dye
//! (alternating between the two config colors). Per tick the solver
//! runs the classic grid pass — semi-Lagrangian advection of velocity
//! and dye plus a Gauss–Seidel pressure projection in a closed box —
//! so the two dyes fold and mix in incompressible swirls instead of
//! just smearing. Dye decays slightly every step so the panel never
//! saturates; the flow never settles because the injectors never stop
//! moving. All variation comes from integer hashes of the injector
//! index (and the `SimHost` seed), so driver and simulator agree
//! frame-for-frame.

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

fn d_color_a() -> Rgb { Rgb { r: 0xff, g: 0x8a, b: 0x2c } }
fn d_color_b() -> Rgb { Rgb { r: 0x4d, g: 0xa3, b: 0xff } }
fn d_swirl() -> f32 { 1.0 }
fn d_speed() -> f32 { 1.0 }

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FluidConfig {
    /// First dye color.
    #[serde(default = "d_color_a")]
    pub color_a: Rgb,
    /// Second dye color.
    #[serde(default = "d_color_b")]
    pub color_b: Rgb,
    /// Impulse strength. Clamped [0.2, 4].
    #[serde(default = "d_swirl")]
    pub swirl: f32,
    /// Sim rate multiplier. Clamped [0.1, 4].
    #[serde(default = "d_speed")]
    pub speed: f32,
}

impl Default for FluidConfig {
    fn default() -> Self {
        Self { color_a: d_color_a(), color_b: d_color_b(), swirl: d_swirl(), speed: d_speed() }
    }
}

/// Grid edge. The solver lattice matches the 64×64 panel one-to-one;
/// the outermost ring is the closed-box boundary (`set_bnd`).
const N: usize = 64;
const CELLS: usize = N * N;
/// Solver ticks per `advance` are capped here: the pressure solve is
/// the budget item (`PROJECT_ITERS` × ~4k cells × ~6 ops ≈ 350k ops
/// per tick), and `SimHost` can hand us up to 30 elapsed steps after
/// a render stall. Instead of running 30 solver passes in one frame
/// we run at most `MAX_TICKS` and scale each tick's `dt` to cover the
/// remaining steps — semi-Lagrangian advection is unconditionally
/// stable, so a catch-up tick with a larger `dt` just loses a little
/// accuracy instead of blowing the frame budget.
const MAX_TICKS: usize = 4;
/// Gauss–Seidel iterations for the pressure solve. 14 doesn't fully
/// converge, but at 64×64 the residual divergence reads as a faint
/// softness, not an error — the classic real-time tradeoff.
const PROJECT_ITERS: usize = 14;
/// Seconds per scene step at speed 1 (steps tick a nominal 60/s).
const BASE_DT: f32 = 1.0 / 60.0;
/// Orbiting dye/impulse sources. Odd count so the two dye colors get
/// an asymmetric split (a, b, a) and the mix never looks mirrored.
const INJECTORS: u32 = 3;
/// Injection footprint radius in cells.
const INJECT_RADIUS: f32 = 2.8;
/// Tangential acceleration at the injector center, cells/s² at
/// swirl 1. Tuned (harness-measured) so the steady-state flow peaks
/// around ~30 cells/s — liquid folding, not a washing machine.
const IMPULSE: f32 = 190.0;
/// Dye emitted per scene step at the injector center (channel max).
const DYE_RATE: f32 = 0.085;
/// Dye retained per scene step — the slow clear that keeps the panel
/// from saturating into a single mixed hue.
const DYE_FADE: f32 = 0.995;
/// Velocity retained per scene step. Numerical dissipation already
/// bleeds energy, but under constant forcing this floor keeps the
/// total momentum bounded for any swirl setting.
const VEL_DAMP: f32 = 0.998;

pub struct State {
    pub vx: Vec<f32>,
    pub vy: Vec<f32>,
    pub dye: Vec<[f32; 3]>,
    /// Scratch fields for the advect/project passes.
    vx0: Vec<f32>,
    vy0: Vec<f32>,
    p: Vec<f32>,
    div: Vec<f32>,
    dye0: Vec<[f32; 3]>,
    /// Injector path clock in scene steps. Wraps (u32) and is folded
    /// onto each oscillator's period in f64 before any trig, so path
    /// precision is independent of uptime.
    phase: u32,
    seed: u32,
}

impl State {
    #[must_use]
    pub fn new(_cfg: &FluidConfig, seed: u32) -> Self {
        Self {
            vx: vec![0.0; CELLS],
            vy: vec![0.0; CELLS],
            dye: vec![[0.0; 3]; CELLS],
            vx0: vec![0.0; CELLS],
            vy0: vec![0.0; CELLS],
            p: vec![0.0; CELLS],
            div: vec![0.0; CELLS],
            dye0: vec![[0.0; 3]; CELLS],
            phase: 0,
            seed,
        }
    }

    #[must_use]
    pub fn compatible(&self, _cfg: &FluidConfig) -> bool { true }

    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_precision_loss)]
    pub fn advance(&mut self, cfg: &FluidConfig, elapsed_steps: usize) {
        if elapsed_steps == 0 {
            return;
        }
        // NaN swirl/speed would poison the whole velocity field (one
        // injected NaN advects everywhere) — sanitize to defaults.
        let swirl = finite_clamp(cfg.swirl, 0.2, 4.0, d_swirl());
        let speed = finite_clamp(cfg.speed, 0.1, 4.0, d_speed());

        // Spread the elapsed steps over at most MAX_TICKS solver
        // passes (see MAX_TICKS); chunks differ by at most one step.
        let ticks = elapsed_steps.min(MAX_TICKS);
        let mut remaining = elapsed_steps;
        for k in 0..ticks {
            let chunk = remaining / (ticks - k);
            remaining -= chunk;
            self.phase = self.phase.wrapping_add(chunk as u32);
            self.tick(cfg, swirl, speed, chunk);
        }
    }

    /// One solver pass covering `chunk` scene steps: inject → advect
    /// velocity → project → advect dye (with decay).
    #[allow(clippy::cast_precision_loss)]
    fn tick(&mut self, cfg: &FluidConfig, swirl: f32, speed: f32, chunk: usize) {
        let dt = BASE_DT * speed * chunk as f32;
        self.inject(cfg, swirl, speed, dt, chunk);

        // Velocity: advect the field through itself (no explicit
        // diffusion — bilinear semi-Lagrangian sampling dissipates
        // plenty at this resolution), then project out divergence.
        let damp = VEL_DAMP.powi(i32::try_from(chunk).unwrap_or(1));
        advect(&mut self.vx0, &self.vx, &self.vx, &self.vy, dt, damp);
        advect(&mut self.vy0, &self.vy, &self.vx, &self.vy, dt, damp);
        core::mem::swap(&mut self.vx, &mut self.vx0);
        core::mem::swap(&mut self.vy, &mut self.vy0);
        set_bnd(Bnd::ReflectX, &mut self.vx);
        set_bnd(Bnd::ReflectY, &mut self.vy);
        project(&mut self.vx, &mut self.vy, &mut self.p, &mut self.div);

        // Dye rides the projected field; decay folds in here.
        let fade = DYE_FADE.powi(i32::try_from(chunk).unwrap_or(1));
        advect_dye(&mut self.dye0, &self.dye, &self.vx, &self.vy, dt, fade);
        core::mem::swap(&mut self.dye, &mut self.dye0);
    }

    /// Add the per-tick injector impulses and dye. Trig cost is 4
    /// sin/cos per injector per tick (position + tangent) — 12 calls,
    /// never per cell.
    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_precision_loss)]
    #[allow(clippy::cast_sign_loss)]
    fn inject(&mut self, cfg: &FluidConfig, swirl: f32, speed: f32, dt: f32, chunk: usize) {
        use core::f32::consts::TAU;
        let nf = N as f32;
        // Path clock in seconds of sim time. Like lava, the speed
        // multiplier scales the clock directly (a live speed change
        // jumps the injector phase — accepted, matches siblings).
        let t = f64::from(self.phase) * f64::from(speed) / 60.0;
        let dye_amt = DYE_RATE * chunk as f32;

        for i in 0..INJECTORS {
            // Per-injector path constants from integer hashes, salted
            // with the SimHost seed so re-entry re-deals the orbits.
            let s = self.seed;
            let ax = nf * (0.24 + 0.12 * hash01(i ^ s, 0));
            let ay = nf * (0.24 + 0.12 * hash01(i ^ s, 1));
            let px = f64::from(9.0 + 8.0 * hash01(i ^ s, 2)); // seconds
            let py = f64::from(13.0 + 9.0 * hash01(i ^ s, 3));
            let ox = f64::from(hash01(i ^ s, 4));
            let oy = f64::from(hash01(i ^ s, 5));

            // Lissajous position and its analytic tangent.
            let cx = nf * 0.5 + ax * sin01(t / px + ox);
            let cy = nf * 0.5 + ay * sin01(t / py + oy);
            let tx = ax * (TAU / px as f32) * cos01(t / px + ox);
            let ty = ay * (TAU / py as f32) * cos01(t / py + oy);
            let len = (tx * tx + ty * ty).sqrt();
            if len < 1e-3 {
                continue; // momentarily stalled at a path corner
            }
            let dvx = tx / len * swirl * IMPULSE * dt;
            let dvy = ty / len * swirl * IMPULSE * dt;

            // Injectors alternate dye color: a, b, a.
            let c = if i % 2 == 0 { &cfg.color_a } else { &cfg.color_b };
            let dye = [
                f32::from(c.r) / 255.0 * dye_amt,
                f32::from(c.g) / 255.0 * dye_amt,
                f32::from(c.b) / 255.0 * dye_amt,
            ];

            // Stamp a soft disc of impulse + dye (interior cells only).
            let r2 = INJECT_RADIUS * INJECT_RADIUS;
            let lo = |c: f32| ((c - INJECT_RADIUS) as i32).max(1);
            let hi = |c: f32| ((c + INJECT_RADIUS) as i32).min(N as i32 - 2);
            for y in lo(cy)..=hi(cy) {
                let dy = y as f32 - cy;
                for x in lo(cx)..=hi(cx) {
                    let dx = x as f32 - cx;
                    let w = 1.0 - (dx * dx + dy * dy) / r2;
                    if w <= 0.0 {
                        continue;
                    }
                    let ij = y as usize * N + x as usize;
                    self.vx[ij] += dvx * w;
                    self.vy[ij] += dvy * w;
                    let d = &mut self.dye[ij];
                    d[0] = (d[0] + dye[0] * w).min(1.0);
                    d[1] = (d[1] + dye[1] * w).min(1.0);
                    d[2] = (d[2] + dye[2] * w).min(1.0);
                }
            }
        }
    }
}

/// Dye → pixels: sqrt gamma lifts the faint wisps the linear ramp
/// would crush to black on LEDs; near-black cells are skipped (dim
/// LED noise reads worse than black, and the canvas is pre-cleared).
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_sign_loss)]
pub fn render<D>(state: &State, _cfg: &FluidConfig, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let w = (size.width as usize).min(N);
    let h = (size.height as usize).min(N);

    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity(w * h);
    for y in 0..h {
        let row = y * N;
        for x in 0..w {
            let d = state.dye[row + x];
            let r = gamma8(d[0]);
            let g = gamma8(d[1]);
            let b = gamma8(d[2]);
            if r < 2 && g < 2 && b < 2 {
                continue;
            }
            px.push(Pixel(Point::new(x as i32, y as i32), Rgb888::new(r, g, b)));
        }
    }
    canvas.draw_iter(px)
}

/// sqrt-gamma channel map; dye is kept in [0, 1] by the sim but the
/// max(0) guards render against any stray negative from float error.
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
fn gamma8(v: f32) -> u8 {
    (v.max(0.0).sqrt() * 255.0).min(255.0) as u8
}

const fn idx(x: usize, y: usize) -> usize {
    y * N + x
}

/// Closed-box boundary fill for the outermost ring (Stam's set_bnd):
/// scalars copy their interior neighbor; the velocity component
/// normal to a wall reflects so flow can't leave the box.
#[derive(Clone, Copy, PartialEq)]
enum Bnd {
    Scalar,
    ReflectX,
    ReflectY,
}

fn set_bnd(mode: Bnd, f: &mut [f32]) {
    for i in 1..N - 1 {
        let sx = if mode == Bnd::ReflectX { -1.0 } else { 1.0 };
        let sy = if mode == Bnd::ReflectY { -1.0 } else { 1.0 };
        f[idx(0, i)] = sx * f[idx(1, i)];
        f[idx(N - 1, i)] = sx * f[idx(N - 2, i)];
        f[idx(i, 0)] = sy * f[idx(i, 1)];
        f[idx(i, N - 1)] = sy * f[idx(i, N - 2)];
    }
    f[idx(0, 0)] = 0.5 * (f[idx(1, 0)] + f[idx(0, 1)]);
    f[idx(N - 1, 0)] = 0.5 * (f[idx(N - 2, 0)] + f[idx(N - 1, 1)]);
    f[idx(0, N - 1)] = 0.5 * (f[idx(1, N - 1)] + f[idx(0, N - 2)]);
    f[idx(N - 1, N - 1)] = 0.5 * (f[idx(N - 2, N - 1)] + f[idx(N - 1, N - 2)]);
}

/// Backtrace the cell center through the velocity field (cells/s) and
/// clamp into the interior; returns the bilinear corner index + the
/// fractional weights.
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
fn backtrace(x: usize, y: usize, vx: &[f32], vy: &[f32], dt: f32) -> (usize, usize, f32, f32) {
    let ij = idx(x, y);
    let max = N as f32 - 1.5;
    let sx = (x as f32 - dt * vx[ij]).clamp(0.5, max);
    let sy = (y as f32 - dt * vy[ij]).clamp(0.5, max);
    let x0 = sx as usize; // truncation == floor (sx ≥ 0.5)
    let y0 = sy as usize;
    (x0, y0, sx - x0 as f32, sy - y0 as f32)
}

/// Semi-Lagrangian advection of a scalar field, with a flat retention
/// multiplier folded into the write (velocity damping / dye fade).
fn advect(dst: &mut [f32], src: &[f32], vx: &[f32], vy: &[f32], dt: f32, keep: f32) {
    for y in 1..N - 1 {
        for x in 1..N - 1 {
            let (x0, y0, fx, fy) = backtrace(x, y, vx, vy, dt);
            let i00 = idx(x0, y0);
            let top = src[i00] + (src[i00 + 1] - src[i00]) * fx;
            let i10 = i00 + N;
            let bot = src[i10] + (src[i10 + 1] - src[i10]) * fx;
            dst[idx(x, y)] = (top + (bot - top) * fy) * keep;
        }
    }
}

/// Same backtrace for the rgb dye field; fades and clamps each
/// channel on the way through so the dye can never saturate past 1.
fn advect_dye(
    dst: &mut [[f32; 3]],
    src: &[[f32; 3]],
    vx: &[f32],
    vy: &[f32],
    dt: f32,
    fade: f32,
) {
    for y in 1..N - 1 {
        for x in 1..N - 1 {
            let (x0, y0, fx, fy) = backtrace(x, y, vx, vy, dt);
            let i00 = idx(x0, y0);
            let i10 = i00 + N;
            let out = &mut dst[idx(x, y)];
            for c in 0..3 {
                let top = src[i00][c] + (src[i00 + 1][c] - src[i00][c]) * fx;
                let bot = src[i10][c] + (src[i10 + 1][c] - src[i10][c]) * fx;
                out[c] = ((top + (bot - top) * fy) * fade).clamp(0.0, 1.0);
            }
        }
    }
    // Boundary ring: dye just mirrors inward so the walls don't read
    // as a black frame.
    for i in 1..N - 1 {
        dst[idx(0, i)] = dst[idx(1, i)];
        dst[idx(N - 1, i)] = dst[idx(N - 2, i)];
        dst[idx(i, 0)] = dst[idx(i, 1)];
        dst[idx(i, N - 1)] = dst[idx(i, N - 2)];
    }
}

/// Pressure projection (Helmholtz–Hodge): solve ∇²p = ∇·v with
/// `PROJECT_ITERS` Gauss–Seidel sweeps, then subtract ∇p to leave the
/// divergence-free part. This is what turns smear into swirl.
fn project(vx: &mut [f32], vy: &mut [f32], p: &mut [f32], div: &mut [f32]) {
    for y in 1..N - 1 {
        for x in 1..N - 1 {
            let ij = idx(x, y);
            div[ij] = -0.5 * (vx[ij + 1] - vx[ij - 1] + vy[ij + N] - vy[ij - N]);
            p[ij] = 0.0;
        }
    }
    set_bnd(Bnd::Scalar, div);
    set_bnd(Bnd::Scalar, p);

    for _ in 0..PROJECT_ITERS {
        for y in 1..N - 1 {
            for x in 1..N - 1 {
                let ij = idx(x, y);
                p[ij] = (div[ij] + p[ij - 1] + p[ij + 1] + p[ij - N] + p[ij + N]) * 0.25;
            }
        }
        set_bnd(Bnd::Scalar, p);
    }

    for y in 1..N - 1 {
        for x in 1..N - 1 {
            let ij = idx(x, y);
            vx[ij] -= 0.5 * (p[ij + 1] - p[ij - 1]);
            vy[ij] -= 0.5 * (p[ij + N] - p[ij - N]);
        }
    }
    set_bnd(Bnd::ReflectX, vx);
    set_bnd(Bnd::ReflectY, vy);
}

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight into the sim — so NaN falls back to `default`
/// instead of poisoning the velocity field downstream.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

/// `sin(TAU·x)` / `cos(TAU·x)` where `x` is a cycle count: the fold
/// to [0, 1) happens in f64 *before* the f32 trig sees the argument,
/// so oscillator precision is independent of how large the phase
/// clock has grown.
#[allow(clippy::cast_possible_truncation)]
fn sin01(x: f64) -> f32 {
    use core::f32::consts::TAU;
    (((x - x.floor()) as f32) * TAU).sin()
}

#[allow(clippy::cast_possible_truncation)]
fn cos01(x: f64) -> f32 {
    use core::f32::consts::TAU;
    (((x - x.floor()) as f32) * TAU).cos()
}

/// Deterministic per-injector constant in [0, 1): an integer
/// avalanche hash of (injector index ^ seed, salt). No RNG anywhere —
/// driver and simulator must evolve identical fields from
/// (config, seed, steps) alone.
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
