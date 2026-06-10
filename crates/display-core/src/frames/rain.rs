//! Matrix digital rain — per-column pixel streams with a bright head
//! and an exponentially decaying tail. Column speeds, offsets, and
//! flicker derive from integer hashes of the column index, so the
//! whole effect is a pure function of `(scene, step)` with no
//! caller-side state.

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

fn default_color() -> Rgb {
    // Phosphor green, obviously.
    Rgb {
        r: 0x5d,
        g: 0xff,
        b: 0xa9,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RainScene {
    #[serde(default = "default_color")]
    pub color: Rgb,
    /// Fraction of columns carrying an active stream, in [0, 1].
    #[serde(default = "default_density")]
    pub density: f32,
    /// Fall rate. 1.0 = base; clamped to [0.1, 4] at render time.
    #[serde(default = "default_speed")]
    pub speed: f32,
    /// Tail length in pixels. Clamped to [2, 48] at render time.
    #[serde(default = "default_tail")]
    pub tail: u32,
}

fn default_density() -> f32 {
    0.5
}

fn default_speed() -> f32 {
    1.0
}

fn default_tail() -> u32 {
    14
}

impl Default for RainScene {
    fn default() -> Self {
        Self {
            color: default_color(),
            density: default_density(),
            speed: default_speed(),
            tail: default_tail(),
        }
    }
}

// Domain salts so the per-column, per-pass, and per-frame hash
// streams never collide even when their integer inputs do.
const SALT_COLUMN: u32 = 0x52A1_4ED5;
const SALT_ACTIVE: u32 = 0xA511_E9B3;
const SALT_FLICKER: u32 = 0xF1C8_E195;

/// Cheap u32 finalizer (xorshift-multiply rounds, lowbias32-style).
/// Sole randomness source for the scene — everything derives from
/// hashing small integers, so frames are identical on driver and sim.
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
/// configs straight into render — so NaN falls back to `default`
/// instead of zeroing the fixed-point conversions downstream.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

/// Scale `color` by a Q8 brightness factor (256 = full).
fn scale(color: Rgb, q8: u32) -> Rgb888 {
    let q8 = q8.min(256);
    Rgb888::new(
        ((u32::from(color.r) * q8) >> 8) as u8,
        ((u32::from(color.g) * q8) >> 8) as u8,
        ((u32::from(color.b) * q8) >> 8) as u8,
    )
}

/// Blend `color` ~70% of the way toward white — the stream head.
fn head_color(color: Rgb) -> Rgb888 {
    let lift = |c: u8| c + (((255 - u32::from(c)) * 179) >> 8) as u8;
    Rgb888::new(lift(color.r), lift(color.g), lift(color.b))
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
#[allow(clippy::cast_possible_wrap)]
pub fn render<D>(scene: &RainScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let height = size.height as i32;

    // NaN speed would freeze every stream and NaN density would
    // blank the panel — sanitize to defaults.
    let speed = finite_clamp(scene.speed, 0.1, 4.0, default_speed());
    let tail = scene.tail.clamp(2, 48) as i32;
    let density = finite_clamp(scene.density, 0.0, 1.0, default_density());
    let density_pct = (density * 100.0).round() as u32;

    // Global fall rate in Q8 px/step at a 1.0× column: 0.5 px/step
    // (~30 px/s) at speed 1, so a stream crosses the panel in ~2 s.
    let fall_q8 = (speed * 128.0) as u64;

    let mut px: Vec<Pixel<Rgb888>> = Vec::new();
    for x in 0..size.width {
        let h = hash2(x, SALT_COLUMN);
        // Per-column speed multiplier, 0.5–1.5× in Q8.
        let col_q8 = 128 + u64::from(h % 257);
        // Spawn gap: dead travel above the panel before the head
        // re-enters. Hash-varied per column so cycle lengths differ
        // and respawns never synchronize across the panel.
        let gap = 8 + ((h >> 9) % 41) as i32; // 8..=48 px
        let cycle = (height + tail + gap) as u64;
        let phase = u64::from(h >> 14) % cycle;

        // Closed-form head travel; u64 keeps `step * Q8 * Q8` exact.
        let total = ((step as u64 * fall_q8 * col_q8) >> 16) + phase;
        let pass = (total / cycle) as u32;
        // Density gates which columns carry a stream THIS pass; the
        // active set reshuffles every time a column's cycle wraps.
        if hash3(x, pass, SALT_ACTIVE) % 100 >= density_pct {
            continue;
        }

        // Head enters above the top (negative y while inside the
        // gap) and exits `tail` px below the bottom so the tail
        // fully drains before the column goes dark.
        let head_y = (total % cycle) as i32 - gap;
        if head_y >= 0 && head_y < height {
            px.push(Pixel(Point::new(x as i32, head_y), head_color(scene.color)));
        }

        // Tail above the head: exponential decay (×200/256 ≈ 0.78
        // per pixel) with a ±15% hash flicker at ~15 Hz so the
        // streams shimmer like glyphs changing.
        let mut base_q8: u32 = 235;
        for i in 1..=tail {
            base_q8 = (base_q8 * 200) >> 8;
            if base_q8 < 10 {
                break; // below ~4% brightness — invisible on the panel
            }
            let y = head_y - i;
            if y < 0 {
                break; // rest of the tail is above the panel
            }
            if y >= height {
                continue; // head below panel; tail still draining in
            }
            let flicker = 85 + hash3(x, y as u32, (step / 4) as u32 ^ SALT_FLICKER) % 31;
            px.push(Pixel(
                Point::new(x as i32, y),
                scale(scene.color, base_q8 * flicker / 100),
            ));
        }
    }
    canvas.draw_iter(px)
}
