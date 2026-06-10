//! Field/fractal fx: tunnel, julia, chladni, aurora, black hole.
//!
//! All five are pure functions of `(scene, step)` — no caller-side
//! state, so the driver and the WASM sim render identical frames
//! from the same step counter. Shared idioms (matching plasma.rs /
//! fire.rs):
//!   - trig comes from a const-built sine LUT with linear interp
//!     (mul/add/floor only → bit-identical on wasm32 and ARM);
//!   - the step clock is folded onto each effect's natural period in
//!     f64 *before* dropping to f32, so nothing loses precision or
//!     degrades at step 2^24+;
//!   - configs arrive raw from persisted JSON, so `finite_clamp`
//!     sanitizes NaN speed instead of letting it poison the clock;
//!   - per-pixel spatial fields that never change for a panel size
//!     (tunnel angle/depth, radial distance) live in `OnceLock`s.

use core::f32::consts::PI;
use std::sync::OnceLock;

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};

use super::{palette_lut, FxScene};

/// Driver step rate; `step / STEP_HZ` is seconds of animation time.
const STEP_HZ: f64 = 60.0;

/* ─── shared helpers ─────────────────────────────────────────────── */

/// Animation clock in seconds (f64 — exact for any realistic step).
fn time_s(step: usize, speed: f32) -> f64 {
    let speed = finite_clamp(speed, 0.05, 8.0, 1.0);
    #[allow(clippy::cast_precision_loss)]
    let t = step as f64 / STEP_HZ;
    t * f64::from(speed)
}

/// Fold an unbounded f64 clock onto `[0, period)` and only then drop
/// to f32 — the folded value is small, so no precision cliff at huge
/// step counts.
#[allow(clippy::cast_possible_truncation)]
fn fold(t: f64, period: f64) -> f32 {
    t.rem_euclid(period) as f32
}

/// `f32::clamp` propagates NaN and the driver feeds raw persisted
/// configs straight into render — NaN falls back to `default`.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

/// Map an intensity in [0, 1] through the palette LUT. The bottom
/// quarter is additionally scaled toward black so palettes whose
/// 0-stop isn't dark (Rainbow starts at pure red) still render
/// zero-energy pixels as off — every effect here treats v = 0 as
/// "no light".
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
fn lut_shade(pal: &[[u8; 3]; 256], v: f32) -> Rgb888 {
    let v = if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
    let [r, g, b] = pal[(v * 255.0) as usize];
    let s = (v * 4.0).min(1.0);
    Rgb888::new(
        (f32::from(r) * s) as u8,
        (f32::from(g) * s) as u8,
        (f32::from(b) * s) as u8,
    )
}

/// Hermite smoothstep on [e0, e1].
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/* ─── sine LUT (turns) ───────────────────────────────────────────── */

/// 256 samples over one cycle plus a wrap entry for branch-free
/// lerp. Built at const time with the same Taylor `sin` as
/// plasma.rs; lerp error over 256 samples is < 1e-4.
const SIN_F: [f32; 257] = build_sin_f();

const fn build_sin_f() -> [f32; 257] {
    let mut out = [0.0f32; 257];
    let mut i = 0;
    while i < 257 {
        out[i] = sin_const((i % 256) as f32 * (2.0 * PI / 256.0));
        i += 1;
    }
    out
}

const fn fold_pi(x: f32) -> f32 {
    let mut x = x;
    while x > PI {
        x -= 2.0 * PI;
    }
    while x < -PI {
        x += 2.0 * PI;
    }
    x
}

const fn sin_const(x: f32) -> f32 {
    let x = fold_pi(x);
    let x2 = x * x;
    x * (1.0 - x2 / 6.0 + x2 * x2 / 120.0 - x2 * x2 * x2 / 5040.0
        + x2 * x2 * x2 * x2 / 362_880.0)
}

/// sin of a phase measured in turns (1.0 = full cycle).
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
#[allow(clippy::cast_precision_loss)]
fn sin_turns(t: f32) -> f32 {
    let p = (t - t.floor()) * 256.0;
    let i = (p as usize).min(255);
    let f = p - i as f32;
    SIN_F[i] + (SIN_F[i + 1] - SIN_F[i]) * f
}

fn cos_turns(t: f32) -> f32 {
    sin_turns(t + 0.25)
}

/* ─── hashing / 1D value noise ───────────────────────────────────── */

/// Integer avalanche hash (fmix32) — exact on every target.
fn hash_u32(x: u32) -> u32 {
    let mut h = x.wrapping_mul(0x9E37_79B9) ^ 0x5BD1_E995;
    h ^= h >> 16;
    h = h.wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    h = h.wrapping_mul(0xC2B2_AE35);
    h ^ (h >> 16)
}

/// Uniform [0, 1) from a hash key.
#[allow(clippy::cast_precision_loss)]
fn rand01(key: u32) -> f32 {
    (hash_u32(key) >> 8) as f32 / 16_777_216.0
}

/// Noise lattice period — time arguments are folded onto this in
/// f64, so drift stays seamless and full-precision forever.
const NOISE_PERIOD: f64 = 256.0;

/// 1D value noise, periodic over `NOISE_PERIOD` lattice points,
/// smoothstep-interpolated.
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
fn vnoise(x: f32, seed: u32) -> f32 {
    let xf = x.floor();
    let i = (xf as i64).rem_euclid(256) as u32;
    let f = x - xf;
    let sf = f * f * (3.0 - 2.0 * f);
    let a = rand01(i.wrapping_add(seed.wrapping_mul(0x0100_0193)));
    let b = rand01(((i + 1) % 256).wrapping_add(seed.wrapping_mul(0x0100_0193)));
    a + (b - a) * sf
}

/* ─── tunnel ─────────────────────────────────────────────────────── */

/// Per-pixel polar LUT entry: angle in turns, depth ∝ 1/r in checker
/// cells, and the center-hole fade.
struct TunnelPx {
    ang: f32,
    depth: f32,
    fade: f32,
}

/// Cached for the first panel size seen (panels are 64×64); other
/// sizes rebuild per frame.
fn cached_tunnel(w: u32, h: u32) -> TunnelRef {
    static LUT: OnceLock<(u32, u32, Vec<TunnelPx>)> = OnceLock::new();
    let cached = LUT.get_or_init(|| (w, h, build_tunnel(w, h)));
    if cached.0 == w && cached.1 == h {
        TunnelRef::Cached(&cached.2)
    } else {
        TunnelRef::Owned(build_tunnel(w, h))
    }
}

enum TunnelRef {
    Cached(&'static [TunnelPx]),
    Owned(Vec<TunnelPx>),
}

#[allow(clippy::cast_precision_loss)]
fn build_tunnel(w: u32, h: u32) -> Vec<TunnelPx> {
    let cx = (w as f32 - 1.0) * 0.5;
    let cy = (h as f32 - 1.0) * 0.5;
    let mut out = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        let dy = y as f32 - cy;
        for x in 0..w {
            let dx = x as f32 - cx;
            let r = (dx * dx + dy * dy).sqrt().max(0.75);
            // Angle quantized only by f32 — far beyond the 256
            // angular steps needed for a smooth radial rush.
            let ang = dy.atan2(dx) / (2.0 * PI) + 0.5;
            // Depth in checker-cell units; 20/r gives ~5 visible
            // rings between the hole and the panel edge.
            let depth = 20.0 / r;
            // Dark hole in the middle, plus a mild brightening
            // toward the viewer (panel edge).
            let fade = smoothstep(2.5, 12.0, r) * (0.62 + 0.38 * (r / 26.0).min(1.0));
            out.push(TunnelPx { ang, depth, fade });
        }
    }
    out
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
pub fn tunnel<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as usize, size.height as usize);
    if w == 0 || h == 0 {
        return Ok(());
    }
    let pal = palette_lut(scene.palette);
    let t = time_s(step, scene.speed);

    // Forward rush: the checker is period-2 in depth, so fold the
    // scroll onto 2 cells. Slow twist folds onto one full turn.
    let scroll = fold(t * 2.4, 2.0);
    let rot = fold(t * 0.045, 1.0);

    let lut = cached_tunnel(size.width, size.height);
    let lut: &[TunnelPx] = match lut {
        TunnelRef::Cached(p) => p,
        TunnelRef::Owned(ref p) => p,
    };

    let mut px = Vec::with_capacity(w * h);
    for (i, tp) in lut.iter().enumerate() {
        let u = tp.depth + scroll;
        let v = (tp.ang + rot) * 8.0; // 8 angular checker sectors
        let cell = ((u.floor() as i64) + (v.floor() as i64)) & 1;
        // Soft gradient inside each depth cell sells the motion even
        // between cell flips.
        let ramp = u - u.floor();
        let base = if cell == 0 {
            0.34 + 0.10 * ramp
        } else {
            0.88 - 0.10 * ramp
        };
        let val = base * tp.fade;
        px.push(Pixel(
            Point::new((i % w) as i32, (i / w) as i32),
            lut_shade(&pal, val),
        ));
    }
    canvas.draw_iter(px)
}

/* ─── julia ──────────────────────────────────────────────────────── */

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
pub fn julia<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    const MAX_ITER: u32 = 28;
    const BAILOUT: f32 = 16.0;

    let size = canvas.size();
    let (w, h) = (size.width as usize, size.height as usize);
    if w == 0 || h == 0 {
        return Ok(());
    }
    let pal = palette_lut(scene.palette);
    let t = time_s(step, scene.speed);

    // c orbits the main cardioid rim once every ~40 s at speed 1;
    // the phase folds in f64 so the orbit never stutters.
    let phi = fold(t / 40.0, 1.0);
    let cr = 0.7885 * cos_turns(phi);
    let ci = 0.7885 * sin_turns(phi);

    // Map the panel to roughly [-1.6, 1.6]² (Julia sets live inside
    // |z| < 2).
    let cx = (w as f32 - 1.0) * 0.5;
    let cy = (h as f32 - 1.0) * 0.5;
    let inv = 1.6 / (w.min(h) as f32 * 0.5);

    let mut px = Vec::with_capacity(w * h);
    for y in 0..h {
        let zi0 = (y as f32 - cy) * inv;
        for x in 0..w {
            let mut zr = (x as f32 - cx) * inv;
            let mut zi = zi0;
            let mut r2 = zr * zr + zi * zi;
            let mut i = 0u32;
            while i < MAX_ITER && r2 < BAILOUT {
                let nzr = zr * zr - zi * zi + cr;
                zi = 2.0 * zr * zi + ci;
                zr = nzr;
                r2 = zr * zr + zi * zi;
                i += 1;
            }
            // Interior stays dark; the exterior gets a smooth
            // (fractional) escape count so the bands don't contour.
            let val = if i >= MAX_ITER {
                0.0
            } else {
                let nu = (i as f32 + 1.0 - (r2.ln() * 0.5).max(1.0).ln() / core::f32::consts::LN_2)
                    .max(0.0);
                // Compress toward the bright end so even fast-escape
                // "dust" phases of the orbit glow like a nebula
                // instead of going black.
                (nu / 22.0).clamp(0.0, 1.0).powf(0.55)
            };
            px.push(Pixel(
                Point::new(x as i32, y as i32),
                lut_shade(&pal, val),
            ));
        }
    }
    canvas.draw_iter(px)
}

/* ─── chladni ────────────────────────────────────────────────────── */

/// Integer mode pairs the plate morphs through; adjacent pairs share
/// scale so the metamorphosis stays readable.
const CHLADNI_PAIRS: [(u32, u32); 8] = [
    (1, 2),
    (1, 3),
    (2, 3),
    (1, 4),
    (3, 4),
    (2, 5),
    (3, 5),
    (4, 5),
];

/// cos(qπ·s) over `len` samples with s = (i + 0.5)/len. The cosine
/// (free-plate) form keeps the panel edges off the nodal set, so the
/// figure doesn't grow a permanently glowing frame the way the
/// clamped sin form does.
#[allow(clippy::cast_precision_loss)]
fn chladni_axis(q: u32, len: usize) -> Vec<f32> {
    (0..len)
        .map(|i| {
            let s = (i as f32 + 0.5) / len as f32;
            // cos(qπ·s) = sin(qπ·s + π/2); in turns: q·s/2 + 1/4.
            sin_turns(q as f32 * s * 0.5 + 0.25)
        })
        .collect()
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
pub fn chladni<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as usize, size.height as usize);
    if w == 0 || h == 0 {
        return Ok(());
    }
    let pal = palette_lut(scene.palette);
    let t = time_s(step, scene.speed);

    // ~7 s per mode pair at speed 1; the fractional part crossfades
    // the standing-wave amplitudes so nodal lines metamorphose
    // continuously instead of snapping.
    let n_pairs = CHLADNI_PAIRS.len() as f64;
    let u = fold(t / 7.0, n_pairs);
    let k = (u.floor() as usize) % CHLADNI_PAIRS.len();
    let f = u - u.floor();
    let s = f * f * (3.0 - 2.0 * f);

    let (n0, m0) = CHLADNI_PAIRS[k];
    let (n1, m1) = CHLADNI_PAIRS[(k + 1) % CHLADNI_PAIRS.len()];

    // 1D mode tables — per pixel work is four mul-adds.
    let xn0 = chladni_axis(n0, w);
    let xm0 = chladni_axis(m0, w);
    let xn1 = chladni_axis(n1, w);
    let xm1 = chladni_axis(m1, w);
    let yn0 = chladni_axis(n0, h);
    let ym0 = chladni_axis(m0, h);
    let yn1 = chladni_axis(n1, h);
    let ym1 = chladni_axis(m1, h);

    let mut px = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            let a0 = xn0[x] * ym0[y] + xm0[x] * yn0[y];
            let a1 = xn1[x] * ym1[y] + xm1[x] * yn1[y];
            let amp = (a0 + (a1 - a0) * s).abs(); // ∈ [0, 2]
            // Sand collects on the nodal lines: brightness is the
            // inverse of the standing-wave amplitude, shaped as a
            // Lorentzian line profile so the lines stay thin and
            // bright against a near-dark plate.
            let k = amp * 3.0;
            let glow = 1.0 / (1.0 + k * k);
            let val = 0.04 + 0.96 * glow;
            px.push(Pixel(
                Point::new(x as i32, y as i32),
                lut_shade(&pal, val),
            ));
        }
    }
    canvas.draw_iter(px)
}

/* ─── aurora ─────────────────────────────────────────────────────── */

/// One curtain layer: lateral noise frequency, horizontal drift rate
/// (lattice units / s, sign = direction), top position/amplitude as
/// fractions of panel height, tail length fraction, additive gain.
struct Curtain {
    freq: f32,
    drift: f64,
    base: f32,
    amp: f32,
    tail: f32,
    gain: f32,
    seed: u32,
}

const CURTAINS: [Curtain; 3] = [
    // Back: broad, slow, dim.
    Curtain { freq: 0.055, drift: 0.9, base: 0.10, amp: 0.34, tail: 0.62, gain: 0.50, seed: 11 },
    // Mid: counter-drifting.
    Curtain { freq: 0.085, drift: -1.6, base: 0.16, amp: 0.38, tail: 0.50, gain: 0.72, seed: 29 },
    // Front: narrow folds, fastest, brightest.
    Curtain { freq: 0.130, drift: 2.7, base: 0.24, amp: 0.42, tail: 0.40, gain: 1.00, seed: 47 },
];

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
pub fn aurora<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as usize, size.height as usize);
    if w == 0 || h == 0 {
        return Ok(());
    }
    let pal = palette_lut(scene.palette);
    let t = time_s(step, scene.speed);
    let hf = h as f32;

    let mut acc = vec![0.0f32; w * h];
    for c in &CURTAINS {
        // Drift offsets fold onto the noise lattice period in f64 —
        // seamless forever, full precision at any step.
        let d0 = fold(t * c.drift, NOISE_PERIOD);
        let d1 = fold(t * c.drift * 1.73 + 37.0, NOISE_PERIOD);
        let d2 = fold(t * c.drift * 0.61 + 91.0, NOISE_PERIOD);
        for x in 0..w {
            let xf = x as f32;
            // Two octaves of value noise shape the curtain's lower
            // edge; a third drives the per-fold brightness shimmer.
            let n = 0.65 * vnoise(xf * c.freq + d0, c.seed)
                + 0.35 * vnoise(xf * c.freq * 2.3 + d1, c.seed ^ 0x5555);
            let shimmer = 0.45 + 0.55 * vnoise(xf * c.freq * 1.6 + d2, c.seed ^ 0xAAAA);
            let top = hf * (c.base + c.amp * n);
            let tail = (hf * c.tail).max(1.0);
            let peak = c.gain * shimmer;
            for y in 0..h {
                let d = y as f32 - top;
                // Soft top over ~2.5 px, quadratic tail below the
                // crest — the classic curtain profile.
                let b = if d < 0.0 {
                    (1.0 + d / 2.5).max(0.0)
                } else {
                    let fall = (1.0 - d / tail).max(0.0);
                    fall * fall
                };
                acc[y * w + x] += peak * b;
            }
        }
    }

    let mut px = Vec::with_capacity(w * h);
    for (i, &a) in acc.iter().enumerate() {
        // Crests of overlapping curtains push into the palette's hot
        // band; the body sits mid-LUT (teal/green for Aurora).
        let val = (a * 0.62).min(1.0).powf(0.85);
        px.push(Pixel(
            Point::new((i % w) as i32, (i / w) as i32),
            lut_shade(&pal, val),
        ));
    }
    canvas.draw_iter(px)
}

/* ─── black hole ─────────────────────────────────────────────────── */

const BH_PARTICLES: u32 = 120;
/// Dark void radius / photon ring radius, px.
const BH_VOID_R: f32 = 4.0;
const BH_RING_R: f32 = 6.2;

/// Bilinear splat of `b` at (x, y) into the accumulation field.
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
fn splat(acc: &mut [f32], w: usize, h: usize, x: f32, y: f32, b: f32) {
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = x - x0;
    let fy = y - y0;
    let (xi, yi) = (x0 as i64, y0 as i64);
    for (dx, dy, wgt) in [
        (0, 0, (1.0 - fx) * (1.0 - fy)),
        (1, 0, fx * (1.0 - fy)),
        (0, 1, (1.0 - fx) * fy),
        (1, 1, fx * fy),
    ] {
        let (px, py) = (xi + dx, yi + dy);
        if px >= 0 && py >= 0 && (px as usize) < w && (py as usize) < h {
            acc[py as usize * w + px as usize] += b * wgt;
        }
    }
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
pub fn black_hole<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as usize, size.height as usize);
    if w == 0 || h == 0 {
        return Ok(());
    }
    let pal = palette_lut(scene.palette);
    let t = time_s(step, scene.speed);

    let cx = (w as f32 - 1.0) * 0.5;
    let cy = (h as f32 - 1.0) * 0.5;
    let r_out = (w.max(h) as f32) * 0.66; // spawn just past the rim
    let r_in = 2.6; // disappears inside the void

    let mut acc = vec![0.0f32; w * h];
    for i in 0..BH_PARTICLES {
        let hsh = hash_u32(i.wrapping_mul(0x9E37_79B1));
        // Inspiral duration 5–12 s at speed 1, phase-offset so the
        // disk is always populated.
        let t_orbit = 5.0 + 7.0 * f64::from(rand01(hsh ^ 0x01));
        let dir = if hsh & 1 == 0 { 1.0f32 } else { -1.0 };
        let u = t / t_orbit + f64::from(rand01(hsh ^ 0x02));
        // Cycle index re-seeds the entry angle each respawn so the
        // shimmer never settles into a fixed pattern. (u.floor() as
        // u32 wraps at large t — harmless, it's hash input.)
        let cycle = u.floor() as i64 as u32;
        let theta0 = rand01(hash_u32(i ^ cycle.wrapping_mul(0x632B_E5AB)));

        // Closed-form inspiral, evaluated at trailing time samples
        // for a motion-blurred streak.
        let p_head = (u - u.floor()) as f32;
        let dp = (1.1 / 60.0 / t_orbit) as f32;
        for (g, wgt) in [
            (0u32, 1.0f32),
            (1, 0.66),
            (2, 0.42),
            (3, 0.26),
            (4, 0.15),
        ] {
            let p = p_head - dp * g as f32;
            if !(0.0..1.0).contains(&p) {
                continue; // ghost predates this respawn
            }
            let q = 1.0 - p;
            // Radius plunges with dr/dp → ∞ at the center; angular
            // rate diverges the same way (frame-dragging look).
            let r = r_in + (r_out - r_in) * q.powf(0.55);
            let theta = theta0 + dir * (0.6 * p + 0.9 * -(q + 0.04).ln());
            let x = cx + r * cos_turns(theta);
            let y = cy + r * sin_turns(theta);
            // Brightness rises as the particle accelerates inward;
            // short fade-in at the rim so respawns don't pop.
            let b = (0.16 + 0.84 * p * p) * (p * 14.0).min(1.0) * wgt;
            splat(&mut acc, w, h, x, y, b * 0.85);
        }
    }

    let mut px = Vec::with_capacity(w * h);
    for y in 0..h {
        let dy = y as f32 - cy;
        for x in 0..w {
            let dx = x as f32 - cx;
            let r = (dx * dx + dy * dy).sqrt();
            // Thin photon ring + faint disk haze, then the event
            // horizon masks everything to black.
            let ring = (1.0 - (r - BH_RING_R).abs() / 1.5).max(0.0);
            let haze = 0.05 * (1.0 - r / 30.0).max(0.0).powi(2);
            let void = smoothstep(BH_VOID_R - 1.0, BH_VOID_R + 0.6, r);
            let a = acc[y * w + x] + ring * ring * 0.85 + haze;
            let val = a.min(1.0).sqrt() * void;
            px.push(Pixel(
                Point::new(x as i32, y as i32),
                lut_shade(&pal, val),
            ));
        }
    }
    canvas.draw_iter(px)
}
