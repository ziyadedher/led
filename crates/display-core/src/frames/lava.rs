//! Lava lamp — a handful of metaballs on closed-form sinusoidal
//! paths, summed as inverse-square fields and soft-thresholded into
//! blobs over a faint background glow. Blob paths are functions of
//! `step` (per-blob phases from integer hashes), so there's no
//! caller-side state and driver/sim render identically.

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

fn default_color() -> Rgb {
    // Molten LED-orange.
    Rgb {
        r: 0xff,
        g: 0x8a,
        b: 0x2c,
    }
}

fn default_glow() -> Rgb {
    // Deep ember backwash behind the blobs.
    Rgb {
        r: 0x1a,
        g: 0x04,
        b: 0x00,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LavaScene {
    /// Blob core color.
    #[serde(default = "default_color")]
    pub color: Rgb,
    /// Background glow color (the "lamp fluid").
    #[serde(default = "default_glow")]
    pub glow: Rgb,
    /// Concurrent blobs. Clamped to [2, 8] at render time.
    #[serde(default = "default_blob_count")]
    pub blob_count: u32,
    /// Drift rate. 1.0 = lava-lamp lazy; clamped to [0.05, 4].
    #[serde(default = "default_speed")]
    pub speed: f32,
    /// Threshold softness in [0, 1]: 0 = crisp blob edges, 1 = dreamy
    /// nebula falloff.
    #[serde(default = "default_goo")]
    pub goo: f32,
}

fn default_blob_count() -> u32 {
    5
}

fn default_speed() -> f32 {
    1.0
}

fn default_goo() -> f32 {
    0.5
}

impl Default for LavaScene {
    fn default() -> Self {
        Self {
            color: default_color(),
            glow: default_glow(),
            blob_count: default_blob_count(),
            speed: default_speed(),
            goo: default_goo(),
        }
    }
}

/// Metaball field threshold: summed field ≥ THRESHOLD is "inside" a
/// blob and renders the blob color.
const THRESHOLD: f32 = 1.0;
/// Per-blob field cutoff, as a multiple of the blob radius. At 3r the
/// inverse-square term has decayed to ~1/9; we shift each blob's term
/// so it hits exactly zero at the cutoff, so the cull leaves no seam.
const CUTOFF: f32 = 3.0;
/// Widest color→glow transition band (goo = 1) as a fraction of the
/// threshold. goo = 0 collapses the band to a hard edge.
const BAND_MAX: f32 = 0.85;
/// Field overshoot above threshold at which the "hot core"
/// white-shift saturates, in multiples of the threshold.
const HOT_RANGE: f32 = 3.0;
/// Max fraction of the gap toward white mixed into a fully hot core.
const HOT_MAX: f32 = 0.4;

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
pub fn render<D>(scene: &LavaScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let w = size.width as usize;
    let h = size.height as usize;
    if w == 0 || h == 0 {
        return Ok(());
    }
    let wf = w as f32;
    let hf = h as f32;
    // Blob radii are tuned for the 64×64 panel; scale for other sizes.
    let scale = wf.min(hf) / 64.0;

    let count = scene.blob_count.clamp(2, 8);
    // NaN speed would NaN the clock (no blobs render) and NaN goo
    // would kill the transition band — sanitize to defaults.
    let speed = finite_clamp(scene.speed, 0.05, 4.0, default_speed());
    let goo = finite_clamp(scene.goo, 0.0, 1.0, default_goo());

    // Animation clock in seconds at speed 1 (steps tick ~60/s). Kept
    // in f64 and folded per-oscillator in `sin01`: an f32 clock loses
    // sub-step increments past 2^24 steps (~3 days at 60 steps/s) and
    // the blob motion quantizes into visible jumps, then freezes.
    let t = step as f64 * f64::from(speed) / 60.0;

    // Accumulate the summed inverse-square field. Per-blob work is
    // bounded to a disc of radius CUTOFF·r — beyond it the (shifted)
    // term is zero — so the divide-heavy inner loop only touches
    // pixels near a blob instead of blob_count × the whole panel.
    let mut field = vec![0.0_f32; w * h];
    for i in 0..count {
        accumulate(&mut field, w, h, &blob(i, count, t, wf, hf, scale));
    }

    // Color mapping, precomputed once per frame. `low` is the bottom
    // of the goo transition band: below it the pixel is flat fluid
    // (`glow`); inside [low, threshold) the color smoothsteps from
    // glow up to the blob color; at/above threshold it's blob color,
    // pushed toward white as the field climbs (hot core).
    let band = THRESHOLD * BAND_MAX * goo;
    let low = THRESHOLD - band;
    let inv_band = if band > 1e-4 { 1.0 / band } else { 0.0 };
    let hot_inv = 1.0 / (THRESHOLD * HOT_RANGE);
    let (cr, cg, cb) = (
        f32::from(scene.color.r),
        f32::from(scene.color.g),
        f32::from(scene.color.b),
    );
    let (gr, gg, gb) = (
        f32::from(scene.glow.r),
        f32::from(scene.glow.g),
        f32::from(scene.glow.b),
    );
    let fluid = Rgb888::new(scene.glow.r, scene.glow.g, scene.glow.b);

    let mut px = Vec::with_capacity(w * h);
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let f = field[row + x];
            let color = if f >= THRESHOLD {
                let hot = ((f - THRESHOLD) * hot_inv).min(1.0) * HOT_MAX;
                Rgb888::new(
                    (cr + (255.0 - cr) * hot) as u8,
                    (cg + (255.0 - cg) * hot) as u8,
                    (cb + (255.0 - cb) * hot) as u8,
                )
            } else if f > low && inv_band > 0.0 {
                let m = (f - low) * inv_band;
                let m = m * m * (3.0 - 2.0 * m);
                Rgb888::new(
                    (gr + (cr - gr) * m) as u8,
                    (gg + (cg - gg) * m) as u8,
                    (gb + (cb - gb) * m) as u8,
                )
            } else {
                fluid
            };
            px.push(Pixel(Point::new(x as i32, y as i32), color));
        }
    }
    canvas.draw_iter(px)
}

/// One blob's per-frame constants: center, radius² (field strength),
/// squared cutoff radius, and the field value at the cutoff (the
/// shift that zeroes the term there).
struct Blob {
    cx: f32,
    cy: f32,
    r2: f32,
    cut2: f32,
    tail: f32,
}

/// Closed-form blob position + size at time `t` (seconds). All
/// per-blob constants come from integer hashes of the blob index, so
/// the motion is a pure function of (scene, step).
#[allow(clippy::cast_precision_loss)]
fn blob(i: u32, count: u32, t: f64, w: f32, h: f32, scale: f32) -> Blob {
    let r = (6.0 + 8.0 * hash01(i, 0)) * scale;

    // Horizontal: even lanes (so blobs spread regardless of count)
    // with per-blob jitter, plus a gentle 7–13 s sway.
    let lane_w = w / count as f32;
    let lane = lane_w * (i as f32 + 0.5) + (hash01(i, 1) - 0.5) * lane_w * 0.8;
    let sway_amp = w * (0.05 + 0.10 * hash01(i, 2));
    let sway_period = 7.0 + 6.0 * hash01(i, 3);
    let cx = lane + sway_amp * sin01(t / f64::from(sway_period) + f64::from(hash01(i, 4)));

    // Vertical is the dominant axis: a slow full-panel rise/sink
    // spanning ~72–88% of the height, period 15–30 s at speed 1.
    let rise_amp = h * (0.36 + 0.08 * hash01(i, 5));
    let rise_period = 15.0 + 15.0 * hash01(i, 6);
    let cy = h * 0.5 + rise_amp * sin01(t / f64::from(rise_period) + f64::from(hash01(i, 7)));

    let r2 = r * r;
    let cut2 = (CUTOFF * r) * (CUTOFF * r);
    Blob {
        cx,
        cy,
        r2,
        cut2,
        tail: r2 / (cut2 + 1.0),
    }
}

/// Add one blob's field contribution: r² / (d² + 1) − tail, clamped
/// at zero. Iteration is restricted to the cutoff *disc* (per-row
/// x-span from one sqrt) — on the Pi Zero W the f32 divide is the hot
/// op, so the win is touching ~πR² pixels per blob instead of w×h.
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
fn accumulate(field: &mut [f32], w: usize, h: usize, b: &Blob) {
    let cut = b.cut2.sqrt();
    let y0 = ((b.cy - cut) as i32).max(0);
    let y1 = ((b.cy + cut) as i32).min(h as i32 - 1);
    for y in y0..=y1 {
        let dy = y as f32 - b.cy;
        let dy2 = dy * dy;
        let rem = b.cut2 - dy2;
        if rem <= 0.0 {
            continue;
        }
        let half = rem.sqrt();
        let x0 = ((b.cx - half) as i32).max(0);
        let x1 = ((b.cx + half) as i32).min(w as i32 - 1);
        if x0 > x1 {
            continue;
        }
        let row = y as usize * w;
        let mut dx = x0 as f32 - b.cx;
        for cell in &mut field[row + x0 as usize..=row + x1 as usize] {
            let f = b.r2 / (dx * dx + dy2 + 1.0) - b.tail;
            if f > 0.0 {
                *cell += f;
            }
            dx += 1.0;
        }
    }
}

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight into render — so NaN falls back to `default`
/// instead of poisoning the field math downstream.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

/// `sin(TAU·x)` where `x` is a cycle count: the fold to [0, 1)
/// happens in f64 *before* the f32 sine ever sees the argument, so
/// oscillator precision is independent of how large the clock has
/// grown (f64 holds exact integers to 2^53 — centuries of steps).
#[allow(clippy::cast_possible_truncation)]
fn sin01(x: f64) -> f32 {
    use core::f32::consts::TAU;
    (((x - x.floor()) as f32) * TAU).sin()
}

/// Deterministic per-blob constant in [0, 1): an integer avalanche
/// hash of (blob index, salt). No RNG anywhere — driver and simulator
/// must render identical frames from (scene, step) alone.
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
