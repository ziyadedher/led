//! Demoscene plasma — four phase-shifted sine fields summed per
//! pixel and mapped through a palette. Pure function of `(scene,
//! step)`: no caller-side state, so the driver and the WASM sim
//! render identical frames from the same step counter.
//!
//! Implementation notes, driven by the Pi Zero W budget (single
//! ARM11 core, no NEON — per-pixel transcendentals are the enemy):
//!   1. all per-pixel math is integer: a 256-entry sine LUT (Q10
//!      amplitude, built at const time via the same Taylor `sin`
//!      trick as `shapes.rs`) indexed by 8.8 fixed-point phase;
//!   2. each sine term depends on only one coordinate (x, y, x+y,
//!      or radius), so per frame we precompute one small table per
//!      term and the inner loop is four lookups + adds + a shift;
//!   3. the radial distance field never changes for a given panel
//!      size, so it's cached in a `OnceLock` (64×64 → 8 KiB of
//!      quarter-pixel u16s) and the per-radius sine is rebuilt per
//!      frame over ~180 entries, not 4096;
//!   4. palettes are 256-entry RGB LUTs expanded at const time from
//!      a few gradient stops, so palette mapping is one index.
//!
//! Time phases are derived with pure i64 fixed-point from `step`,
//! never accumulated floats — identical on wasm32 and ARM, and no
//! precision drift at large step counts.

use core::f32::consts::PI;
use std::sync::OnceLock;

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

/// Palette presets, tuned for the instrument language rather than
/// raw HSV sweeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub enum PlasmaPalette {
    /// Black → deep red → LED-orange → warm white.
    #[default]
    Ember,
    /// Black → deep green → phosphor → mint white.
    Phosphor,
    /// Deep blue → cyan → violet.
    Aurora,
    /// Full hue wheel.
    Rainbow,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PlasmaScene {
    #[serde(default)]
    pub palette: PlasmaPalette,
    /// Animation rate. 1.0 = base drift; clamped to [0.05, 8] at
    /// render time (driver steps ~60/s).
    #[serde(default = "default_speed")]
    pub speed: f32,
    /// Spatial scale — higher = larger, lazier blobs. Clamped to
    /// [0.25, 4] at render time.
    #[serde(default = "default_scale")]
    pub scale: f32,
}

fn default_speed() -> f32 {
    1.0
}

fn default_scale() -> f32 {
    1.0
}

impl Default for PlasmaScene {
    fn default() -> Self {
        Self {
            palette: PlasmaPalette::Ember,
            speed: default_speed(),
            scale: default_scale(),
        }
    }
}

/* ─── tuning ───────────────────────────────────────────────────────
 *
 * Phases live in 8.8 fixed point where 65536 = one full sine cycle
 * (256 LUT entries × 256 subunits). Spatial frequencies are LUT
 * units per pixel at scale = 1; dividing by `scale` makes higher
 * scale = broader blobs. Chosen so each field fits ~1-1.6 cycles
 * across a 64 px panel — overlapping but never busy.
 */

/// LUT units advanced per step at speed = 1, in 8.8 fixed point.
/// 91/256 units per step → a full cycle every ~720 steps ≈ 12 s at
/// 60 fps: lava-lamp pace, never strobing.
const BASE_RATE_FP: i64 = 91;

/// Horizontal field: ~1.6 cycles across 64 px at scale = 1.
const FREQ_X: f32 = 6.4;
/// Vertical field, deliberately non-commensurate with `FREQ_X`.
const FREQ_Y: f32 = 4.6;
/// Diagonal (x + y) field; the sum spans ~2× the panel width.
const FREQ_DIAG: f32 = 3.2;
/// Radial field over distance-from-center (~45 px max on 64×64).
const FREQ_RAD: f32 = 7.4;

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
pub fn render<D>(scene: &PlasmaScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as usize, size.height as usize);
    if w == 0 || h == 0 {
        return Ok(());
    }

    // NaN speed would zero the phase clock and NaN scale would
    // flatten every spatial frequency — sanitize to defaults.
    let speed = finite_clamp(scene.speed, 0.05, 8.0, default_speed());
    let scale = finite_clamp(scene.scale, 0.25, 4.0, default_scale());
    let pal = palette_lut(scene.palette);

    // Time phase in 8.8 fixed point, computed fresh from `step` each
    // frame (i64 throughout, so no float drift at large steps). Each
    // term drifts at a different integer-ratio rate so the composite
    // field never visually locks into a repeating loop.
    let speed_fp = (speed * 4096.0) as i64;
    let t = (step as i64) * speed_fp * BASE_RATE_FP / 4096;
    let t1 = (t & 0xFFFF) as i32;
    let t2 = ((t * 7 / 10) & 0xFFFF) as i32;
    let t3 = ((t * 13 / 10) & 0xFFFF) as i32;
    let t4 = ((t * 9 / 10) & 0xFFFF) as i32;

    // Spatial frequencies in 8.8 fixed units per pixel.
    let inv_scale = 256.0 / scale;
    let fx = (FREQ_X * inv_scale) as i32;
    let fy = (FREQ_Y * inv_scale) as i32;
    let fd = (FREQ_DIAG * inv_scale) as i32;
    let fr = (FREQ_RAD * inv_scale) as i32;

    // Each term varies along exactly one axis, so the per-pixel work
    // collapses into table lookups built once per frame.
    let s1: Vec<i16> = (0..w)
        .map(|x| sin_fp(x as i32 * fx + t1))
        .collect();
    let s2: Vec<i16> = (0..h)
        .map(|y| sin_fp(y as i32 * fy + t2))
        .collect();
    let s3: Vec<i16> = (0..w + h - 1)
        .map(|d| sin_fp(d as i32 * fd + t3))
        .collect();

    // Radial term: distance-from-center in quarter pixels (cached —
    // it never changes for a panel size), then a per-radius sine
    // table so the inner loop stays multiplication-free. The `- t4`
    // makes this field drift opposite the others, which is what
    // gives plasma its "breathing" interference look.
    let radial = cached_radial(size.width, size.height);
    let radial: &[u16] = match radial {
        RadialRef::Cached(r) => r,
        RadialRef::Owned(ref r) => r,
    };
    let max_rq = radial.iter().copied().max().unwrap_or(0) as usize;
    let s4: Vec<i16> = (0..=max_rq)
        .map(|rq| sin_fp(((rq as i32 * fr) >> 2) - t4))
        .collect();

    // Sum ∈ [-4096, 4096] (four Q10 sines) → palette index 0..=255.
    let mut px = Vec::with_capacity(w * h);
    let mut i = 0;
    for y in 0..h {
        let row = i32::from(s2[y]);
        for x in 0..w {
            let sum = i32::from(s1[x])
                + row
                + i32::from(s3[x + y])
                + i32::from(s4[radial[i] as usize]);
            let idx = ((sum + 4096) >> 5).min(255) as usize;
            let [r, g, b] = pal[idx];
            px.push(Pixel(Point::new(x as i32, y as i32), Rgb888::new(r, g, b)));
            i += 1;
        }
    }
    canvas.draw_iter(px)
}

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight into render — so NaN falls back to `default`
/// instead of poisoning the fixed-point conversions downstream.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

/// Sine of an 8.8 fixed-point phase (65536 = full cycle), Q10
/// amplitude. Arithmetic shift + mask handles negative phases.
fn sin_fp(phase: i32) -> i16 {
    SIN_LUT[((phase >> 8) & 0xFF) as usize]
}

/* ─── radial distance cache ──────────────────────────────────────── */

enum RadialRef {
    Cached(&'static [u16]),
    Owned(Vec<u16>),
}

/// Distance-from-center per pixel in quarter-pixel units. Cached for
/// the first panel size seen (in practice the only one — panels are
/// 64×64); any other size falls back to a per-frame build.
fn cached_radial(w: u32, h: u32) -> RadialRef {
    static RADIAL: OnceLock<(u32, u32, Vec<u16>)> = OnceLock::new();
    let cached = RADIAL.get_or_init(|| (w, h, build_radial(w, h)));
    if cached.0 == w && cached.1 == h {
        RadialRef::Cached(&cached.2)
    } else {
        RadialRef::Owned(build_radial(w, h))
    }
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
fn build_radial(w: u32, h: u32) -> Vec<u16> {
    let cx = (w as f32 - 1.0) * 0.5;
    let cy = (h as f32 - 1.0) * 0.5;
    let mut out = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        let dy = y as f32 - cy;
        for x in 0..w {
            let dx = x as f32 - cx;
            // IEEE sqrt is correctly rounded, so this is identical
            // on the wasm sim and the ARM driver.
            out.push(((dx * dx + dy * dy).sqrt() * 4.0) as u16);
        }
    }
    out
}

/* ─── sine LUT ─────────────────────────────────────────────────────
 *
 * 256 entries over one full cycle, Q10 amplitude (±1024). Built at
 * const time with the same Taylor-series `sin` used by shapes.rs for
 * its torus tables — const-context trig isn't in std, and ~1e-5
 * error is far below one LUT quantum.
 */

const SIN_LUT: [i16; 256] = build_sin_lut();

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
    x * (1.0
        - x2 / 6.0
        + x2 * x2 / 120.0
        - x2 * x2 * x2 / 5040.0
        + x2 * x2 * x2 * x2 / 362880.0)
}

/* ─── palettes ─────────────────────────────────────────────────────
 *
 * Each palette is a 256-entry RGB LUT expanded at const time from a
 * handful of gradient stops `(index, rgb)`. The field's sum-of-sines
 * distribution peaks mid-range, so the "mostly dark" palettes keep
 * their low/mid stops dim and reserve the hot colors for the top
 * quarter — only the ridges of the field light up.
 */

type Stop = (u8, [u8; 3]);

/// Piecewise-linear gradient expansion. Stops must be sorted by
/// index, start at 0 and end at 255.
const fn gradient_lut(stops: &[Stop]) -> [[u8; 3]; 256] {
    let mut out = [[0u8; 3]; 256];
    let mut seg = 0;
    while seg + 1 < stops.len() {
        let (p0, c0) = stops[seg];
        let (p1, c1) = stops[seg + 1];
        let span = if p1 > p0 { (p1 - p0) as i32 } else { 1 };
        let mut i = p0 as i32;
        while i <= p1 as i32 {
            let f = i - p0 as i32;
            let mut ch = 0;
            while ch < 3 {
                let a = c0[ch] as i32;
                let b = c1[ch] as i32;
                out[i as usize][ch] = (a + (b - a) * f / span) as u8;
                ch += 1;
            }
            i += 1;
        }
        seg += 1;
    }
    out
}

/// Black → deep red → LED-orange (255,138,44) → warm white.
const EMBER_LUT: [[u8; 3]; 256] = gradient_lut(&[
    (0, [0, 0, 0]),
    (100, [26, 2, 0]),
    (170, [150, 22, 2]),
    (220, [255, 138, 44]),
    (255, [255, 220, 180]),
]);

/// Black → deep green → phosphor (93,255,169) → mint white.
const PHOSPHOR_LUT: [[u8; 3]; 256] = gradient_lut(&[
    (0, [0, 0, 0]),
    (100, [0, 22, 8]),
    (170, [10, 130, 55]),
    (220, [93, 255, 169]),
    (255, [226, 255, 240]),
]);

/// Near-black blue → deep blue → cyan → violet — northern-lights
/// drift, never dropping to full black.
const AURORA_LUT: [[u8; 3]; 256] = gradient_lut(&[
    (0, [2, 3, 14]),
    (90, [8, 28, 96]),
    (160, [18, 180, 170]),
    (215, [140, 92, 230]),
    (255, [80, 36, 150]),
]);

/// Full hue wheel at max saturation/value.
const RAINBOW_LUT: [[u8; 3]; 256] = gradient_lut(&[
    (0, [255, 0, 0]),
    (43, [255, 255, 0]),
    (85, [0, 255, 0]),
    (128, [0, 255, 255]),
    (170, [0, 0, 255]),
    (213, [255, 0, 255]),
    (255, [255, 0, 0]),
]);

fn palette_lut(palette: PlasmaPalette) -> &'static [[u8; 3]; 256] {
    match palette {
        PlasmaPalette::Ember => &EMBER_LUT,
        PlasmaPalette::Phosphor => &PHOSPHOR_LUT,
        PlasmaPalette::Aurora => &AURORA_LUT,
        PlasmaPalette::Rainbow => &RAINBOW_LUT,
    }
}
