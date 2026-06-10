//! Raster-era fx: rotozoom, twister, copper bars, moiré, kefrens.
//!
//! All five are pure functions of `(scene, step)` — no caller-side
//! state, so the ARM driver and the WASM sim render identical frames
//! from the same step counter. They share one time base: phases live
//! in 8.8 fixed point (65536 = one full cycle) derived from `step`
//! with pure integer math ([`clock_mod`]), so nothing drifts or
//! quantizes at large step counts — a raw `step as f32` clock loses
//! sub-step increments past 2^24 steps (~3 days at 60 steps/s).
//!
//! Per-pixel work is integer where it matters: rotozoom's inner loop
//! is two adds and a shift, twister/copper/kefrens index the same
//! 256-entry Q10 sine LUT as `plasma.rs`. The per-frame scalars that
//! genuinely need float trig (rotozoom's matrix, moiré's foci) use
//! the const-fn Taylor sine from `shapes.rs` — pure f32 arithmetic,
//! deterministic across wasm32 and ARM — fed a pre-folded phase so
//! the argument is always small.
//!
//! Colors come from the shared `super::palette_lut`; everything that
//! would be black is simply not drawn (the dispatcher pre-clears the
//! canvas, and dim LED noise reads worse than true black).

use core::f32::consts::PI;

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};

use super::{palette_lut, FxScene};

const TAU: f32 = 2.0 * PI;

/* ─── shared time base ───────────────────────────────────────────── */

/// Animation clock folded onto `modulus` (a power of two). Computes
/// `step × speed × rate / 4096` in i128 so the product cannot
/// overflow at any uptime, then masks onto the period — the fold is
/// seamless because every consumer is periodic in exactly `modulus`
/// units. `rate` is in modulus-units per step at speed = 1 (×4096).
#[allow(clippy::cast_possible_truncation)]
fn clock_mod(step: usize, speed: f32, rate: i64, modulus: i64) -> i32 {
    let speed_fp = (speed * 4096.0) as i64;
    let t = i128::from(step as u64) * i128::from(speed_fp) * i128::from(rate) / 4096;
    (t & i128::from(modulus - 1)) as i32
}

/// 8.8 fixed-point phase (65536 = one full cycle) after `step` steps
/// at `rate` phase-units/step. A rate of 65536/N completes one cycle
/// every N steps at speed = 1 (driver steps ~60/s).
fn phase(step: usize, speed: f32, rate: i64) -> i32 {
    clock_mod(step, speed, rate, 1 << 16)
}

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight into render — so NaN speed falls back to 1.0
/// instead of zeroing every phase clock.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

fn speed_of(scene: &FxScene) -> f32 {
    finite_clamp(scene.speed, 0.05, 8.0, 1.0)
}

fn rgb(c: [u8; 3]) -> Rgb888 {
    Rgb888::new(c[0], c[1], c[2])
}

/* ─── rotozoom ─────────────────────────────────────────────────────
 *
 * Checkerboard texture (8 px cells, two palette shades) sampled via
 * the inverse transform: for each screen pixel, rotate by θ and
 * scale by 1/zoom to find the texel. θ revolves every ~11 s and the
 * zoom breathes over [0.5, 2] every ~21 s (non-commensurate periods,
 * so the motion never visibly loops); the texture also drifts so the
 * board slides even at the zoom extremes. Inner loop is pure 16.16
 * fixed point: two adds, two shifts, an XOR per pixel.
 */

/// One revolution every ~662 steps (~11 s).
const ROTO_SPIN: i64 = 99;
/// Zoom breath cycle ~1236 steps (~21 s).
const ROTO_ZOOM: i64 = 53;
/// Texture drift in 16.16 px/step (~0.18 / ~0.13 px/step), folded
/// onto the 16 px checker period (1 << 20 in 16.16).
const ROTO_DRIFT_U: i64 = 11_796;
const ROTO_DRIFT_V: i64 = 8_520;
const CHECKER_PERIOD_FP: i64 = 1 << 20;

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
pub fn rotozoom<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as i32, size.height as i32);
    if w == 0 || h == 0 {
        return Ok(());
    }
    let speed = speed_of(scene);
    let lut = palette_lut(scene.palette);
    // Two checker shades from the LUT: a deep tone and a hot tone —
    // high contrast in every palette without strobing pure white.
    let (ca, cb) = (rgb(lut[64]), rgb(lut[208]));

    let theta = phase(step, speed, ROTO_SPIN) as f32 * (TAU / 65536.0);
    let zoom = 1.25 + 0.75 * sin_const(phase(step, speed, ROTO_ZOOM) as f32 * (TAU / 65536.0));
    let inv = 1.0 / zoom;
    let (s, c) = (sin_const(theta) * inv, cos_const(theta) * inv);

    // Texture-space steps in 16.16: u = x·cosθ − y·sinθ scaled by
    // 1/zoom, v = x·sinθ + y·cosθ — so du/dy = −dvdx, dv/dy = dudx.
    let dudx = (c * 65536.0) as i32;
    let dvdx = (s * 65536.0) as i32;
    let drift_u = clock_mod(step, speed, ROTO_DRIFT_U, CHECKER_PERIOD_FP);
    let drift_v = clock_mod(step, speed, ROTO_DRIFT_V, CHECKER_PERIOD_FP);

    let xr = -0.5 * (w - 1) as f32;
    let yr = -0.5 * (h - 1) as f32;
    let (mut u_row, mut v_row) = (
        ((xr * c - yr * s) * 65536.0) as i32 + drift_u,
        ((xr * s + yr * c) * 65536.0) as i32 + drift_v,
    );

    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        let (mut u, mut v) = (u_row, v_row);
        for x in 0..w {
            // Cell parity of an 8 px checker = bit 3 of the texel
            // coordinate; arithmetic shifts floor correctly for
            // negative texels.
            let cell = ((u >> 19) ^ (v >> 19)) & 1;
            px.push(Pixel(Point::new(x, y), if cell == 0 { ca } else { cb }));
            u += dudx;
            v += dvdx;
        }
        u_row -= dvdx;
        v_row += dudx;
    }
    canvas.draw_iter(px)
}

/* ─── twister ──────────────────────────────────────────────────────
 *
 * A vertical column (~24 px wide on a 64 px panel) twisting about
 * its axis: per row, the four corner edges of a square bar project
 * to sin(a + i·90°)·half-width. A face between consecutive edges is
 * visible iff its projection runs left→right; each face gets a fixed
 * palette shade (the rotation reads as light), with a brighter seam
 * on the leading edge. Twist phase = time spin + a linear ramp down
 * the column + a slow sine bend, so the column writhes rather than
 * rotating rigidly.
 */

/// One revolution every ~360 steps (~6 s).
const TWIST_SPIN: i64 = 182;
/// Bend oscillation ~978 steps (~16 s).
const TWIST_BEND: i64 = 67;
/// Phase ramp per row: ~0.21 cycle of twist across 64 rows.
const TWIST_PER_ROW: i32 = 210;
/// Bend wave spatial frequency (~0.16 cycle across 64 rows) / depth
/// (±0.084 cycle ≈ ±30° of extra twist at the antinodes).
const BEND_FREQ: i32 = 160;
const BEND_DEPTH: i32 = 5_500;
/// Per-face palette shades — adjacent faces contrast so the silhouette
/// pops at every rotation angle.
const FACE_SHADE: [usize; 4] = [240, 160, 205, 125];

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
pub fn twister<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as i32, size.height as i32);
    if w == 0 || h == 0 {
        return Ok(());
    }
    let speed = speed_of(scene);
    let lut = palette_lut(scene.palette);
    let face = FACE_SHADE.map(|i| rgb(lut[i]));
    let seam = rgb(lut[252]);

    let half = (w * 3) / 16; // half-width in px: 12 on a 64-wide panel
    let cx_fp = ((w - 1) << 8) / 2;
    let t_spin = phase(step, speed, TWIST_SPIN);
    let t_bend = phase(step, speed, TWIST_BEND);

    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity((h * (2 * half + 2)) as usize);
    for y in 0..h {
        let a = t_spin
            + y * TWIST_PER_ROW
            + ((i32::from(sin_fp(y * BEND_FREQ + t_bend)) * BEND_DEPTH) >> 10);
        // The four projected edges in 8.8 screen-x, 90° apart.
        let e: [i32; 4] = core::array::from_fn(|i| {
            cx_fp + ((i32::from(sin_fp(a + (i as i32) * 0x4000)) * (half << 8)) >> 10)
        });
        for i in 0..4 {
            let (x0, x1) = (e[i], e[(i + 1) & 3]);
            if x1 <= x0 {
                continue; // back-facing
            }
            let xs = ((x0 + 255) >> 8).max(0);
            let xe = (x1 >> 8).min(w - 1);
            for x in xs..=xe {
                px.push(Pixel(Point::new(x, y), face[i]));
            }
            // Bright seam on the leading edge sells the 3D rotation.
            if xs < xe {
                px.push(Pixel(Point::new(xs, y), seam));
            }
        }
    }
    canvas.draw_iter(px)
}

/* ─── copper ───────────────────────────────────────────────────────
 *
 * Eight full-width horizontal gradient bars (7 px: bright core
 * fading to the edges through the LUT) bouncing on phase-offset
 * sines — two incommensurate sine terms per bar so the chain snakes
 * instead of swinging rigidly. Bars accumulate additively per row
 * with saturation, so crossings flare toward the palette's hot end;
 * that flare is the whole effect.
 */

const COPPER_BARS: i32 = 8;
/// Primary bounce ~504 steps (~8.4 s); secondary wobble ~314 steps.
const COPPER_RATE1: i64 = 130;
const COPPER_RATE2: i64 = 209;
/// Per-bar phase offsets (8.8 cycle units) for each sine term —
/// chosen so neighbours trail each other into a snake.
const COPPER_STEP1: i32 = 0x1F00;
const COPPER_STEP2: i32 = 0x1300;

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_sign_loss)]
pub fn copper<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as i32, size.height as i32);
    if w == 0 || h == 0 {
        return Ok(());
    }
    let speed = speed_of(scene);
    let lut = palette_lut(scene.palette);

    let mid_fp = ((h - 1) << 8) / 2;
    let amp1 = ((h / 2 - 8).max(0)) << 8; // 24 px throw on a 64-tall panel
    let amp2 = 4 << 8;
    let t1 = phase(step, speed, COPPER_RATE1);
    let t2 = phase(step, speed, COPPER_RATE2);

    // Additive per-row accumulator — bars are full-width, so a row is
    // one color.
    let mut rows = vec![[0u32; 3]; h as usize];
    for b in 0..COPPER_BARS {
        let yb = mid_fp
            + ((i32::from(sin_fp(t1 + b * COPPER_STEP1)) * amp1) >> 10)
            + ((i32::from(sin_fp(t2 + b * COPPER_STEP2)) * amp2) >> 10);
        let yc = yb >> 8;
        for r in (yc - 4)..=(yc + 4) {
            if r < 0 || r >= h {
                continue;
            }
            // Row-center distance to the bar center in 8.8 px;
            // triangular falloff to zero at 3.5 px (7 px bar).
            let d = ((r << 8) + 128 - yb).abs();
            let wgt = (896 - d).max(0);
            if wgt == 0 {
                continue;
            }
            let w256 = (wgt << 8) / 896; // 0..=256 core weight
            let c = lut[((255 * w256) >> 8) as usize];
            // Fade runs through the LUT; the extra linear cut on the
            // outer third forces full-value palettes (Rainbow, whose
            // LUT never goes dark) down to black at the bar edge.
            let m = (w256 * 3 / 2).min(256) as u32;
            for (acc, &ch) in rows[r as usize].iter_mut().zip(c.iter()) {
                *acc += (u32::from(ch) * m) >> 8;
            }
        }
    }

    let mut px: Vec<Pixel<Rgb888>> = Vec::new();
    for (y, acc) in rows.iter().enumerate() {
        if acc[0] + acc[1] + acc[2] < 9 {
            continue; // imperceptible — keep the background black
        }
        let c = Rgb888::new(
            acc[0].min(255) as u8,
            acc[1].min(255) as u8,
            acc[2].min(255) as u8,
        );
        for x in 0..w {
            px.push(Pixel(Point::new(x, y as i32), c));
        }
    }
    canvas.draw_iter(px)
}

/* ─── moiré ────────────────────────────────────────────────────────
 *
 * Two sets of concentric rings (5.5 px spacing) centered on foci
 * that orbit the panel center in opposite directions at different
 * rates. A pixel lights where the ring parities differ (the XOR
 * interference pattern); brightness is graded by the fractional ring
 * distance of both fields (triangle wave — peak mid-ring, dark at
 * the boundaries) so the fringes shimmer instead of strobing, and by
 * distance to the nearer focus so the pattern has depth.
 */

/// Focus 1 orbit ~936 steps (~15.6 s); focus 2 counter-orbits in
/// ~1337 steps (~22 s).
const MOIRE_RATE1: i64 = 70;
const MOIRE_RATE2: i64 = 49;
/// Ring spacing in px.
const RING_SPACING: f32 = 5.5;

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
pub fn moire<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as i32, size.height as i32);
    if w == 0 || h == 0 {
        return Ok(());
    }
    let speed = speed_of(scene);
    let lut = palette_lut(scene.palette);

    let cx = (w - 1) as f32 * 0.5;
    let cy = (h - 1) as f32 * 0.5;
    // Different orbit radii and a quarter-cycle static offset keep
    // the foci from ever coinciding (coincident foci → equal ring
    // fields → an all-dark frame).
    let orbit1 = w.min(h) as f32 * 0.24; // ~15 px at 64×64
    let orbit2 = w.min(h) as f32 * 0.16; // ~10 px
    let a1 = phase(step, speed, MOIRE_RATE1) as f32 * (TAU / 65536.0);
    let a2 = (phase(step, speed, MOIRE_RATE2) + 0x4000) as f32 * (TAU / 65536.0);
    let (f1x, f1y) = (cx + orbit1 * cos_const(a1), cy + orbit1 * sin_const(a1));
    // Mirrored orbit = opposite rotation direction.
    let (f2x, f2y) = (cx + orbit2 * cos_const(a2), cy - orbit2 * sin_const(a2));

    let inv_ring = 1.0 / RING_SPACING;
    let tri = |t: f32| 1.0 - (2.0 * t - 1.0).abs();

    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity((w * h / 2) as usize);
    for y in 0..h {
        let dy1 = (y as f32 - f1y) * (y as f32 - f1y);
        let dy2 = (y as f32 - f2y) * (y as f32 - f2y);
        for x in 0..w {
            let dx1 = x as f32 - f1x;
            let dx2 = x as f32 - f2x;
            // Ring coordinate of each field (distance / spacing).
            let r1 = (dx1 * dx1 + dy1).sqrt() * inv_ring;
            let r2 = (dx2 * dx2 + dy2).sqrt() * inv_ring;
            let (i1, i2) = (r1 as i32, r2 as i32);
            if (i1 ^ i2) & 1 == 0 {
                continue; // parities agree → dark
            }
            // Shimmer: bright mid-ring, soft at ring boundaries.
            let b = 0.5 * (tri(r1 - i1 as f32) + tri(r2 - i2 as f32));
            // Depth: fade with distance to the nearer focus.
            let g = (1.15 - r1.min(r2) * RING_SPACING / 96.0).clamp(0.45, 1.0);
            let idx = ((60.0 + 195.0 * b) * g) as usize;
            px.push(Pixel(Point::new(x, y), rgb(lut[idx])));
        }
    }
    canvas.draw_iter(px)
}

/* ─── kefrens ──────────────────────────────────────────────────────
 *
 * The alien-hair weave (the Kefrens / Walker raster-bar trick): the
 * frame is built from a single 1-row line buffer that is *never
 * cleared between rows*. Walking y top→bottom, a 4 px bar is drawn
 * into the buffer at x = center + two summed sines of (y, t), then
 * the buffer is emitted as that row — every previous bar position
 * persists below, weaving the hair. The buffer is rebuilt from black
 * each frame, so the effect stays a pure function of (scene, step).
 */

/// Sine drift rates: ~437 steps (~7.3 s) and ~630 steps (~10.5 s),
/// the second term counter-drifting (subtracted) so the hair crosses
/// itself instead of swaying in one piece.
const KEF_RATE1: i64 = 150;
const KEF_RATE2: i64 = 104;
/// Spatial frequencies along y: ~0.61 / ~1.46 cycles across 64 rows
/// — the bar sweeps the panel several times per frame, which is what
/// densifies the weave.
const KEF_K1: i32 = 620;
const KEF_K2: i32 = 1_490;
/// 4 px bar: darker edges around a bright 2 px core.
const KEF_PROFILE: [usize; 4] = [135, 255, 235, 135];

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_sign_loss)]
pub fn kefrens<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as i32, size.height as i32);
    if w == 0 || h == 0 {
        return Ok(());
    }
    let speed = speed_of(scene);
    let lut = palette_lut(scene.palette);

    let cx_fp = ((w - 1) << 8) / 2;
    let amp1 = (w * 5 / 16) << 8; // 20 px on a 64-wide panel
    let amp2 = (w * 5 / 32) << 8; // 10 px
    let t1 = phase(step, speed, KEF_RATE1);
    let t2 = phase(step, speed, KEF_RATE2);

    // The classic persistent raster line — carried row to row,
    // rebuilt from black each frame.
    let mut line: Vec<[u8; 3]> = vec![[0; 3]; w as usize];
    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        let x_fp = cx_fp
            + ((i32::from(sin_fp(y * KEF_K1 + t1)) * amp1) >> 10)
            + ((i32::from(sin_fp(y * KEF_K2 - t2)) * amp2) >> 10);
        let x0 = (x_fp >> 8) - 1;
        for (i, &shade) in KEF_PROFILE.iter().enumerate() {
            let x = x0 + i as i32;
            if x >= 0 && x < w {
                line[x as usize] = lut[shade];
            }
        }
        for (x, c) in line.iter().enumerate() {
            if (c[0] | c[1] | c[2]) == 0 {
                continue; // never touched by a bar — stays black
            }
            px.push(Pixel(Point::new(x as i32, y), rgb(*c)));
        }
    }
    canvas.draw_iter(px)
}

/* ─── sine tables ──────────────────────────────────────────────────
 *
 * Same machinery as plasma.rs / shapes.rs: a 256-entry Q10 sine LUT
 * for the integer paths, plus the const-fn Taylor sine for the few
 * per-frame f32 scalars (const-context trig isn't in std, and the
 * ~1e-5 error is far below one LUT quantum — crucially it is also
 * identical on wasm32 and ARM, unlike libm's sin).
 */

/// Sine of an 8.8 fixed-point phase (65536 = full cycle), Q10
/// amplitude. Arithmetic shift + mask handles negative phases.
fn sin_fp(phase: i32) -> i16 {
    SIN_LUT[((phase >> 8) & 0xFF) as usize]
}

const SIN_LUT: [i16; 256] = build_sin_lut();

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
const fn build_sin_lut() -> [i16; 256] {
    let mut out = [0i16; 256];
    let mut i = 0;
    while i < 256 {
        let x = (i as f32) * (2.0 * PI / 256.0);
        out[i] = (sin_const(x) * 1024.0) as i16;
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
    // 7-term Taylor; remainders past x^11/11! are < 1e-5 over [-π, π].
    x * (1.0 - x2 / 6.0 + x2 * x2 / 120.0 - x2 * x2 * x2 / 5040.0
        + x2 * x2 * x2 * x2 / 362_880.0)
}

const fn cos_const(x: f32) -> f32 {
    sin_const(x + PI / 2.0)
}
