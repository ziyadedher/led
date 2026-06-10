//! Domain-warped FBM — `fbm(p + fbm(p + t))` palette-mapped; organic
//! lava-lamp flow. Pure function of (scene, step).
//!
//! Per pixel: the lattice coordinate `p·s` is displaced by a
//! vector-valued inner fBm (2 octaves per axis, its own drift clock)
//! and the warped point is sampled by a 3-octave outer fBm whose
//! lattice drifts on a second, differently-aimed clock — so the field
//! translates AND churns instead of just sliding. The scalar field
//! maps through a 256-entry palette LUT expanded at const time from
//! gradient stops (same scheme as `plasma.rs`).
//!
//! All variation comes from the same integer-hash value noise as
//! `fire.rs` (no RNG, no clock), so the ARM driver and the WASM sim
//! agree pixel-for-pixel at every step. Drift clocks are computed in
//! f64 and folded onto the noise lattice's exact period *before*
//! narrowing to f32, so precision is independent of uptime.

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub enum WarpPalette {
    /// Black → deep red → LED-orange → warm white.
    #[default]
    Ember,
    /// Black → deep green → phosphor → mint.
    Phosphor,
    /// Deep blue → cyan → violet.
    Aurora,
    /// Deep navy → teal → seafoam white.
    Ocean,
    /// Full hue wheel.
    Rainbow,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WarpScene {
    #[serde(default)]
    pub palette: WarpPalette,
    /// Flow rate. Clamped [0.05, 8].
    #[serde(default = "d_speed")]
    pub speed: f32,
    /// Spatial scale — higher = broader features. Clamped [0.25, 4].
    #[serde(default = "d_scale")]
    pub scale: f32,
}

fn d_speed() -> f32 { 1.0 }
fn d_scale() -> f32 { 1.0 }

impl Default for WarpScene {
    fn default() -> Self {
        Self { palette: WarpPalette::Ember, speed: d_speed(), scale: d_scale() }
    }
}

/* ─── tuning ───────────────────────────────────────────────────────
 *
 * Spatial unit is one base-octave lattice cell. At scale = 1 a cell
 * spans 16 px, so the 64×64 panel sees ~4 cells of the base octave
 * plus two finer octaves of detail — broad, liquid features rather
 * than busy texture. Dividing the frequency by `scale` makes higher
 * scale = broader.
 */

/// Base lattice frequency in cells per pixel at scale = 1.
const BASE_FREQ: f32 = 1.0 / 16.0;

/// Warp amplitude in lattice cells: the inner fBm (centered on 0,
/// span ±0.5) displaces the outer sample point by up to ±W/2 cells —
/// ±1 cell = ±16 px at scale 1, enough to fold blobs into tendrils.
const WARP_AMP: f32 = 2.0;

/// Outer-field drift in cells per step at speed = 1. ~1/480 cells per
/// step ⇒ one full lattice cell every ~8 s at the driver's 60
/// steps/s — the "full character change every ~8 s" pace. The two
/// clocks aim in different directions at different rates so the
/// translation never reads as a straight pan.
const DRIFT1: (f64, f64) = (0.001_63, -0.001_28);
/// Inner (warp-field) drift — slower and differently aimed, so the
/// displacement field churns underneath the translation.
const DRIFT2: (f64, f64) = (-0.000_92, 0.001_17);

/// Post-fBm contrast about the 0.5 mean. Summed octaves cluster
/// mid-range; this stretch spends the whole palette without hard
/// banding (the tails clamp).
const CONTRAST: f32 = 1.9;

/// The value-noise lattice wraps every 2^13 cells (`lattice` masks
/// its coordinates), making the field exactly periodic. That lets
/// the drift clocks be reduced modulo the period in f64 and only
/// then narrowed to f32 — a raw `step as f32` clock loses sub-step
/// increments past 2^24 steps (~3 days at 60 steps/s) and the flow
/// visibly quantizes, then freezes. The fold stays seamless in every
/// octave: octave k scales coordinates by 2^k, and 2^k·P is still a
/// multiple of the lattice period P.
const LATTICE_PERIOD: i32 = 1 << 13;

// Per-octave hash stream seeds — arbitrary odd constants. Two inner
// octaves per warp axis, three outer octaves.
const SEED_WX0: u32 = 0xa511_e9b3;
const SEED_WX1: u32 = 0x63d8_3595;
const SEED_WY0: u32 = 0x8163_5cb5;
const SEED_WY1: u32 = 0x2545_f491;
const SEED_F0: u32 = 0x9d2c_5681;
const SEED_F1: u32 = 0x5f35_6495;
const SEED_F2: u32 = 0x1f12_3bb5;

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
pub fn render<D>(scene: &WarpScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width, size.height);
    if w == 0 || h == 0 {
        return Ok(());
    }

    // NaN speed would freeze the clocks and NaN scale would flatten
    // every frequency — sanitize to defaults.
    let speed = finite_clamp(scene.speed, 0.05, 8.0, d_speed());
    let scale = finite_clamp(scene.scale, 0.25, 4.0, d_scale());
    let lut = palette_lut(scene.palette);

    let freq = BASE_FREQ / scale;

    // Drift clocks in f64, folded onto the periodic lattice (see
    // LATTICE_PERIOD) before narrowing to f32, so precision is
    // independent of uptime.
    let t = step as f64 * f64::from(speed);
    let p = f64::from(LATTICE_PERIOD);
    let off1x = (t * DRIFT1.0).rem_euclid(p) as f32;
    let off1y = (t * DRIFT1.1).rem_euclid(p) as f32;
    let off2x = (t * DRIFT2.0).rem_euclid(p) as f32;
    let off2y = (t * DRIFT2.1).rem_euclid(p) as f32;

    // Outer-octave samplers persist across the whole frame: the
    // warped sample point moves smoothly pixel-to-pixel, so the
    // four-corner hash fetch only reruns on a cell crossing.
    let mut f0 = Noise2::new(SEED_F0);
    let mut f1 = Noise2::new(SEED_F1);
    let mut f2 = Noise2::new(SEED_F2);

    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity((w * h) as usize);

    for y in 0..h {
        // Inner (warp) fBm sweeps an unwarped row, so the lattice y
        // band is fixed and `NoiseRow` caches the corner hashes
        // exactly like fire.rs.
        let wy = y as f32 * freq + off2y;
        let mut wx0 = NoiseRow::new(wy, SEED_WX0);
        let mut wx1 = NoiseRow::new(wy * 2.0, SEED_WX1);
        let mut wy0 = NoiseRow::new(wy, SEED_WY0);
        let mut wy1 = NoiseRow::new(wy * 2.0, SEED_WY1);

        let oy = y as f32 * freq + off1y;

        for x in 0..w {
            let wx = x as f32 * freq + off2x;
            // 2-octave inner fBm per axis, normalized to [0, 1] then
            // centered — a ±W/2-cell displacement vector.
            let dx = (wx0.sample(wx) + 0.5 * wx1.sample(wx * 2.0)) * (1.0 / 1.5) - 0.5;
            let dy = (wy0.sample(wx) + 0.5 * wy1.sample(wx * 2.0)) * (1.0 / 1.5) - 0.5;

            let sx = x as f32 * freq + off1x + WARP_AMP * dx;
            let sy = oy + WARP_AMP * dy;

            // 3-octave outer fBm, amplitudes 1 : ½ : ¼, → [0, 1].
            let v = (f0.sample(sx, sy)
                + 0.5 * f1.sample(sx * 2.0, sy * 2.0)
                + 0.25 * f2.sample(sx * 4.0, sy * 4.0))
                * (1.0 / 1.75);
            let v = ((v - 0.5) * CONTRAST + 0.5).clamp(0.0, 1.0);
            let [r, g, b] = lut[(v * 255.0) as usize];
            px.push(Pixel(Point::new(x as i32, y as i32), Rgb888::new(r, g, b)));
        }
    }

    canvas.draw_iter(px)
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

/// One octave of value noise evaluated along a row (fixed lattice y
/// band). Consecutive samples share lattice cells, so the four
/// corner hashes are only recomputed when the sweep crosses a cell
/// boundary — same caching as fire.rs.
struct NoiseRow {
    seed: u32,
    yi: i32,
    fy: f32,
    xi: i32,
    top0: f32,
    top1: f32,
    bot0: f32,
    bot1: f32,
}

impl NoiseRow {
    fn new(ny: f32, seed: u32) -> Self {
        let yi = floori(ny);
        let fy = smoothstep(ny - yi as f32);
        Self {
            seed,
            yi,
            fy,
            // Sentinel forcing a corner fetch on the first sample.
            xi: i32::MAX,
            top0: 0.0,
            top1: 0.0,
            bot0: 0.0,
            bot1: 0.0,
        }
    }

    #[allow(clippy::cast_precision_loss)]
    fn sample(&mut self, nx: f32) -> f32 {
        let xi = floori(nx);
        if xi != self.xi {
            self.xi = xi;
            self.top0 = lattice(xi, self.yi, self.seed);
            self.top1 = lattice(xi + 1, self.yi, self.seed);
            self.bot0 = lattice(xi, self.yi + 1, self.seed);
            self.bot1 = lattice(xi + 1, self.yi + 1, self.seed);
        }
        let fx = smoothstep(nx - xi as f32);
        let top = self.top0 + (self.top1 - self.top0) * fx;
        let bot = self.bot0 + (self.bot1 - self.bot0) * fx;
        top + (bot - top) * self.fy
    }
}

/// Free-roaming value-noise sampler for the warped (outer) field,
/// where the y band shifts per pixel and `NoiseRow` doesn't apply.
/// Corner hashes are cached on the current lattice cell; the warp is
/// smooth, so consecutive pixels usually land in the same cell.
struct Noise2 {
    seed: u32,
    xi: i32,
    yi: i32,
    c00: f32,
    c10: f32,
    c01: f32,
    c11: f32,
}

impl Noise2 {
    fn new(seed: u32) -> Self {
        Self {
            seed,
            // Sentinels forcing a corner fetch on the first sample.
            xi: i32::MAX,
            yi: i32::MAX,
            c00: 0.0,
            c10: 0.0,
            c01: 0.0,
            c11: 0.0,
        }
    }

    #[allow(clippy::cast_precision_loss)]
    fn sample(&mut self, nx: f32, ny: f32) -> f32 {
        let xi = floori(nx);
        let yi = floori(ny);
        if xi != self.xi || yi != self.yi {
            self.xi = xi;
            self.yi = yi;
            self.c00 = lattice(xi, yi, self.seed);
            self.c10 = lattice(xi + 1, yi, self.seed);
            self.c01 = lattice(xi, yi + 1, self.seed);
            self.c11 = lattice(xi + 1, yi + 1, self.seed);
        }
        let fx = smoothstep(nx - xi as f32);
        let fy = smoothstep(ny - yi as f32);
        let top = self.c00 + (self.c10 - self.c00) * fx;
        let bot = self.c01 + (self.c11 - self.c01) * fx;
        top + (bot - top) * fy
    }
}

/// 2-D integer hash → u32. A 3-round xorshift-multiply mixer in the
/// PCG family — the scene's only source of variation, shared bit-for-
/// bit by the ARM driver and the WASM sim.
#[allow(clippy::cast_sign_loss)]
fn hash2(x: i32, y: i32, seed: u32) -> u32 {
    let mut v = (x as u32).wrapping_mul(0x9e37_79b9) ^ (y as u32).wrapping_mul(0x85eb_ca6b) ^ seed;
    v ^= v >> 15;
    v = v.wrapping_mul(0x2c1b_3c6d);
    v ^= v >> 12;
    v = v.wrapping_mul(0x2972_5913);
    v ^= v >> 15;
    v
}

/// Lattice value in [0, 1) from the top 24 bits of the hash. Coords
/// wrap onto a LATTICE_PERIOD-cell torus (the power-of-two mask is
/// exact for negatives in two's complement), which is what makes the
/// drift-clock modular reduction in `render` seamless. The panel
/// only ever spans a handful of cells, so the repeat is invisible.
#[allow(clippy::cast_precision_loss)]
fn lattice(x: i32, y: i32, seed: u32) -> f32 {
    let (x, y) = (x & (LATTICE_PERIOD - 1), y & (LATTICE_PERIOD - 1));
    (hash2(x, y, seed) >> 8) as f32 * (1.0 / 16_777_216.0)
}

fn floori(v: f32) -> i32 {
    #[allow(clippy::cast_possible_truncation)]
    {
        v.floor() as i32
    }
}

/// Hermite fade for the interpolation weights — kills the lattice
/// grid that plain bilinear would show.
fn smoothstep(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/* ─── palettes ─────────────────────────────────────────────────────
 *
 * 256-entry RGB LUTs expanded at const time from gradient stops
 * `(index, rgb)` — the plasma.rs scheme. The contrast-stretched fBm
 * still peaks mid-range, so the dark palettes keep their low/mid
 * stops dim and reserve the hot colors for the ridges.
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

/// Deep navy → teal → seafoam white.
const OCEAN_LUT: [[u8; 3]; 256] = gradient_lut(&[
    (0, [1, 4, 20]),
    (90, [4, 28, 80]),
    (170, [14, 128, 128]),
    (220, [80, 210, 190]),
    (255, [225, 250, 245]),
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

fn palette_lut(palette: WarpPalette) -> &'static [[u8; 3]; 256] {
    match palette {
        WarpPalette::Ember => &EMBER_LUT,
        WarpPalette::Phosphor => &PHOSPHOR_LUT,
        WarpPalette::Aurora => &AURORA_LUT,
        WarpPalette::Ocean => &OCEAN_LUT,
        WarpPalette::Rainbow => &RAINBOW_LUT,
    }
}
