//! Perspective starfield flying toward the viewer. Each star's
//! trajectory (angle, phase, base speed) derives from an integer hash
//! of its index, and its position is a closed-form function of
//! `step`, so the field is fully procedural — no caller-side state,
//! identical frames on driver and sim.

use core::f32::consts::TAU;

use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    primitives::{Line, PrimitiveStyle},
    Pixel,
};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

fn default_color() -> Rgb {
    Rgb {
        r: 0xff,
        g: 0xff,
        b: 0xff,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StarfieldScene {
    /// Star color when `thermal` is off.
    #[serde(default = "default_color")]
    pub color: Rgb,
    /// Flight speed. 1.0 = drift; above ~3 stars streak. Clamped to
    /// [0.1, 8] at render time.
    #[serde(default = "default_warp")]
    pub warp: f32,
    /// Concurrent stars. Clamped to [8, 256] at render time.
    #[serde(default = "default_density")]
    pub density: u32,
    /// Map approach speed to color (blue → white → orange) instead of
    /// the flat `color`.
    #[serde(default)]
    pub thermal: bool,
    /// Subtle per-star brightness shimmer at low warp.
    #[serde(default = "default_twinkle")]
    pub twinkle: bool,
}

fn default_warp() -> f32 {
    1.0
}

fn default_density() -> u32 {
    80
}

fn default_twinkle() -> bool {
    true
}

impl Default for StarfieldScene {
    fn default() -> Self {
        Self {
            color: default_color(),
            warp: default_warp(),
            density: default_density(),
            thermal: false,
            twinkle: default_twinkle(),
        }
    }
}

// One full center→rim flight takes ~6 s at warp 1 (60 steps/s), so
// the default field reads as a calm drift.
const BASE_RATE: f32 = 1.0 / 360.0;
// Above this apparent speed (warp × jitter) a star draws as a short
// Line instead of a single pixel.
const STREAK_THRESHOLD: f32 = 2.5;
// Streak tail length in progress-space per unit of warp × jitter.
// Combined with the rising radial velocity near the rim this turns
// into proper hyperspace lines at warp 6+.
const STREAK_SCALE: f32 = 0.012;
// Stars dimmer than this are skipped. Together with the smoothstep
// birth ramp it guarantees respawns never pop in visibly.
const MIN_BRIGHTNESS: f32 = 0.05;
// Twinkle wobble depth (± fraction of brightness) at low warp; the
// effect fades out entirely by TWINKLE_FADE_WARP.
const TWINKLE_DEPTH: f32 = 0.25;
const TWINKLE_FADE_WARP: f32 = 2.0;
// Apparent speed that pins the thermal ramp at full orange. Reached
// only at high warp near the rim, so a warp-1 field reads blue→white.
const THERMAL_FULL_SCALE: f32 = 6.0;

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
pub fn render<D>(scene: &StarfieldScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let cx = size.width as f32 / 2.0;
    let cy = size.height as f32 / 2.0;
    // Rim sits past the far corner so stars clear the panel fully
    // before wrapping back to a (dim) rebirth at the center.
    let r_max = (cx * cx + cy * cy).sqrt() + 2.0;

    // NaN warp would poison every star's position and brightness
    // (the panel goes blank) — sanitize to the default.
    let warp = finite_clamp(scene.warp, 0.1, 8.0, default_warp());
    let density = scene.density.clamp(8, 256);

    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity(density as usize);
    for i in 0..density {
        // Fixed per-star identity from integer hashes: direction,
        // depth-cycle phase, and a 0.7–1.3× speed jitter. The jitter
        // spread is what sells parallax — a few bright "near" stars
        // outrun the many dim "far" ones.
        let theta = hash_unit(i, 0) * TAU;
        let phase = hash_unit(i, 1);
        let jitter = 0.7 + 0.6 * hash_unit(i, 2);
        let speed = warp * jitter;

        // Closed-form flight: progress p ∈ [0, 1) cycles forever and
        // radius grows as p² — slow near the center, accelerating
        // toward the rim, the core "flying at you" perspective cue.
        let p = cycle(step, BASE_RATE * speed, phase);
        let r = p * p * r_max;

        // Birth ramp: smoothstep of p, so stars fade in from black
        // near the center instead of popping.
        let mut bright = p * p * (3.0 - 2.0 * p);
        if scene.twinkle && warp < TWINKLE_FADE_WARP {
            // Slow per-star triangle-wave shimmer, fading out as
            // warp approaches TWINKLE_FADE_WARP.
            let depth = TWINKLE_DEPTH * (TWINKLE_FADE_WARP - warp).min(1.0);
            let rate = 0.008 + 0.008 * hash_unit(i, 3);
            bright *= 1.0 + depth * tri(cycle(step, rate, hash_unit(i, 4)));
        }
        let bright = bright.clamp(0.0, 1.0);
        if bright < MIN_BRIGHTNESS {
            continue;
        }

        // Apparent (screen-space) speed: radial velocity scales with
        // d(p²)/dp = 2p, so rim stars run hotter than center ones.
        let (cr, cg, cb) = if scene.thermal {
            thermal_rgb(speed * 2.0 * p)
        } else {
            (
                f32::from(scene.color.r),
                f32::from(scene.color.g),
                f32::from(scene.color.b),
            )
        };
        let color = Rgb888::new(
            (cr * bright) as u8,
            (cg * bright) as u8,
            (cb * bright) as u8,
        );

        let (sin_t, cos_t) = theta.sin_cos();
        let x = cx + cos_t * r;
        let y = cy + sin_t * r;

        if speed > STREAK_THRESHOLD {
            // Hyperspace streak: line from where the star was a hair
            // of progress ago to where it is now. Out-of-bounds
            // pixels are ignored per the DrawTarget contract (same
            // as the shapes wireframes).
            let p0 = (p - STREAK_SCALE * speed).max(0.0);
            let r0 = p0 * p0 * r_max;
            Line::new(
                Point::new((cx + cos_t * r0) as i32, (cy + sin_t * r0) as i32),
                Point::new(x as i32, y as i32),
            )
            .into_styled(PrimitiveStyle::with_stroke(color, 1))
            .draw(canvas)?;
        } else {
            let xi = x as i32;
            let yi = y as i32;
            if xi >= 0 && yi >= 0 && (xi as u32) < size.width && (yi as u32) < size.height {
                px.push(Pixel(Point::new(xi, yi), color));
            }
        }
    }
    canvas.draw_iter(px)
}

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight into render — so NaN falls back to `default`
/// instead of poisoning the flight math downstream.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

/// Avalanche-style integer hash (lowbias32 derivative) salted per
/// attribute, so one star index yields several independent
/// pseudo-random fields with zero stored state.
fn hash32(i: u32, salt: u32) -> u32 {
    let mut x = i ^ salt.wrapping_mul(0x9E37_79B9);
    x ^= x >> 16;
    x = x.wrapping_mul(0x7FEB_352D);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846C_A68B);
    x ^= x >> 16;
    x
}

/// Hash mapped to [0, 1). Top 24 bits only — exactly representable
/// in an f32 mantissa.
#[allow(clippy::cast_precision_loss)]
fn hash_unit(i: u32, salt: u32) -> f32 {
    (hash32(i, salt) >> 8) as f32 / ((1u32 << 24) as f32)
}

/// Fractional part of `step × rate + phase`, accumulated in f64: an
/// f32 mantissa runs out around step ~10⁶ (a few hours of uptime)
/// and would quantize the motion into visible stutter.
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
fn cycle(step: usize, rate: f32, phase: f32) -> f32 {
    let x = step as f64 * f64::from(rate) + f64::from(phase);
    (x - x.floor()) as f32
}

/// Triangle wave mapping an already-wrapped [0, 1) input to [-1, 1].
fn tri(f: f32) -> f32 {
    4.0 * (f - 0.5).abs() - 1.0
}

/// Thermal tint: apparent speed → deep blue (slow) → white (mid) →
/// orange (fast). Returns 0–255 channel floats, pre-brightness.
fn thermal_rgb(apparent: f32) -> (f32, f32, f32) {
    const SLOW: (f32, f32, f32) = (60.0, 90.0, 255.0);
    const MID: (f32, f32, f32) = (255.0, 255.0, 255.0);
    const FAST: (f32, f32, f32) = (255.0, 150.0, 60.0);
    let t = (apparent / THERMAL_FULL_SCALE).clamp(0.0, 1.0);
    if t < 0.5 {
        lerp3(SLOW, MID, t * 2.0)
    } else {
        lerp3(MID, FAST, (t - 0.5) * 2.0)
    }
}

fn lerp3(a: (f32, f32, f32), b: (f32, f32, f32), t: f32) -> (f32, f32, f32) {
    (
        a.0 + (b.0 - a.0) * t,
        a.1 + (b.1 - a.1) * t,
        a.2 + (b.2 - a.2) * t,
    )
}
