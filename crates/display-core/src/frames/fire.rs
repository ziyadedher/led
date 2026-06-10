//! Fire — value-noise flame shaped by a vertical gradient, mapped
//! through a heat palette. Stateless (a pure function of `step`)
//! rather than the classic propagation buffer, so the driver and the
//! WASM sim stay in lockstep with zero caller-side state.
//!
//! Per pixel: `heat = profile(y)^1.5` carved by 3-octave value noise
//! sampled from a field that scrolls upward over time (the boil) and
//! shears sideways with `wind` (tips lean more than the base). Heat
//! maps through a 256-entry palette LUT; below a small cutoff the
//! panel stays unlit — dim LED noise reads worse than black. All
//! variation comes from an integer hash (no RNG, no clock), so the
//! driver and the simulator agree pixel-for-pixel at every step.

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub enum FirePalette {
    /// Black → red → orange → yellow → white. The Doom look.
    #[default]
    Classic,
    /// Black → deep blue → cyan → white. Gas burner.
    Gas,
    /// Black → deep green → phosphor → mint. CRT fire.
    Phosphor,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FireScene {
    #[serde(default)]
    pub palette: FirePalette,
    /// Flame height / seed temperature in [0, 1]. Clamped at render.
    #[serde(default = "default_intensity")]
    pub intensity: f32,
    /// Lateral bias in [-1, 1]; negative leans left. Clamped at render.
    #[serde(default)]
    pub wind: f32,
    /// Occasional detached sparks above the flame tips.
    #[serde(default = "default_embers")]
    pub embers: bool,
}

fn default_intensity() -> f32 {
    0.8
}

fn default_embers() -> bool {
    true
}

impl Default for FireScene {
    fn default() -> Self {
        Self {
            palette: FirePalette::Classic,
            intensity: default_intensity(),
            wind: 0.0,
            embers: default_embers(),
        }
    }
}

// Spatial frequency of the base noise octave in lattice cells per
// pixel — ~9×7 px features read as flame tongues at 64×64.
const FREQ_X: f32 = 1.0 / 9.0;
const FREQ_Y: f32 = 1.0 / 7.0;
// Upward scroll of the noise field in px/step (~21 px/s at the
// driver's ~60 steps/s): one base lattice cell every ~0.33 s and a
// full panel traversal in ~3 s — a visible boil without strobing.
const RISE: f32 = 0.35;
// Horizontal noise drift in px/step at |wind| = 1 — the flame
// streams sideways under wind rather than just leaning.
const WIND_DRIFT: f32 = 0.45;
// Shear: sampling-column lean in px per px of height at |wind| = 1.
// Grows with height, so tips lean while the base stays anchored.
const WIND_SHEAR: f32 = 0.35;
// Noise carves up to this much heat out of the vertical profile
// where the field is "cold" — what breaks tongues off the gradient.
const NOISE_BITE: f32 = 0.45;
// Post-carve gain pushing surviving heat back toward white-hot.
const HEAT_GAIN: f32 = 1.35;
// Below this heat the pixel stays black (the canvas is pre-cleared).
const HEAT_CUTOFF: f32 = 0.05;
// Concurrent ember slots; each cycles through hash-derived respawns
// and only ~5/8 of cycles actually spawn, so the population breathes.
const EMBER_SLOTS: i32 = 6;
// The value-noise lattice wraps every 2^13 cells (`lattice` masks its
// coordinates), making the field exactly periodic. That lets the
// scroll/drift clocks be reduced modulo the field period in f64 and
// only then narrowed to f32 — a raw `step as f32` clock loses
// sub-step increments past 2^24 steps (~3 days at the driver's
// 60 steps/s) and the boil visibly quantizes, then freezes.
const LATTICE_PERIOD: i32 = 1 << 13;

// Per-octave / ember hash stream seeds — arbitrary odd constants.
const SEED_OCT0: u32 = 0x9d2c_5681;
const SEED_OCT1: u32 = 0x5f35_6495;
const SEED_OCT2: u32 = 0x1f12_3bb5;
const SEED_EMBER: u32 = 0x6c07_8965;

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_sign_loss)]
pub fn render<D>(scene: &FireScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width, size.height);
    if w == 0 || h == 0 {
        return Ok(());
    }

    // NaN wind would poison every noise sample (the whole flame
    // renders black) — sanitize to defaults.
    let intensity = finite_clamp(scene.intensity, 0.0, 1.0, default_intensity());
    let wind = finite_clamp(scene.wind, -1.0, 1.0, 0.0);
    if intensity < 0.005 {
        // Nothing burns; the dispatcher already cleared to black.
        return Ok(());
    }

    let lut = build_palette(scene.palette);
    // Clocks in f64, folded onto the periodic noise field (see
    // LATTICE_PERIOD) before narrowing to f32, so precision is
    // independent of uptime. The fold is seamless: the lattice
    // repeats exactly once per period in every octave.
    let t = step as f64;
    let scroll =
        (t * f64::from(RISE)).rem_euclid(f64::from(LATTICE_PERIOD) / f64::from(FREQ_Y)) as f32;
    let drift = (f64::from(wind) * t * f64::from(WIND_DRIFT))
        .rem_euclid(f64::from(LATTICE_PERIOD) / f64::from(FREQ_X)) as f32;
    let hf = h as f32;

    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity((w * h) as usize);

    for y in 0..h {
        // Vertical profile: 1.0 at the bottom row, 0 at
        // (1 - intensity) of the panel height from the top. ^1.5 so
        // the base reads solid while the tips thin out.
        let yn = (y + 1) as f32 / hf;
        let prof = (yn - (1.0 - intensity)) / intensity;
        if prof <= 0.0 {
            continue;
        }
        let prof = prof.min(1.0);
        let prof = prof * prof.sqrt();

        let up = (h - 1 - y) as f32;
        let shear = wind * up * WIND_SHEAR;
        let ny = (y as f32 + scroll) * FREQ_Y;

        let mut oct0 = NoiseRow::new(ny, SEED_OCT0);
        let mut oct1 = NoiseRow::new(ny * 2.0, SEED_OCT1);
        let mut oct2 = NoiseRow::new(ny * 4.0, SEED_OCT2);

        for x in 0..w {
            let nx = (x as f32 + shear + drift) * FREQ_X;
            // 3-octave fBm, amplitudes 1 : ½ : ¼, normalized to [0, 1].
            let n = (oct0.sample(nx) + 0.5 * oct1.sample(nx * 2.0) + 0.25 * oct2.sample(nx * 4.0))
                * (1.0 / 1.75);
            let heat = ((prof - (1.0 - n) * NOISE_BITE) * HEAT_GAIN).clamp(0.0, 1.0);
            if heat < HEAT_CUTOFF {
                continue;
            }
            px.push(Pixel(
                Point::new(x as i32, y as i32),
                lut[(heat * 255.0) as usize],
            ));
        }
    }

    if scene.embers {
        push_embers(&mut px, &lut, step, w, h, intensity, wind);
    }

    canvas.draw_iter(px)
}

/// Sparse hash-derived spark particles above the flame tips. Each
/// slot lives on its own fixed-length cycle; the (slot, cycle) hash
/// picks the spawn column, jitter, climb and whether the cycle fires
/// at all — pure in `step`, no retained particle state.
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_sign_loss)]
fn push_embers(
    px: &mut Vec<Pixel<Rgb888>>,
    lut: &[Rgb888; 256],
    step: usize,
    w: u32,
    h: u32,
    intensity: f32,
    wind: f32,
) {
    // Mean flame-top row; sparks spawn around it and climb a few px.
    let tip_y = (1.0 - intensity) * h as f32;
    for i in 0..EMBER_SLOTS {
        // Per-slot lifetime (84..148 steps ≈ 1.4–2.5 s), fixed across
        // cycles so step → (cycle, phase) stays a pure division.
        let life = 84 + (hash2(i, -1, SEED_EMBER) % 64) as usize;
        let cycle = step / life;
        let ph = (step % life) as f32 / life as f32;

        let hsh = hash2(i, cycle as i32, SEED_EMBER);
        // ~5/8 of cycles spawn; the rest stay dark so the sparks
        // don't march in lockstep.
        if (hsh >> 29) >= 5 {
            continue;
        }

        let x0 = (hsh % w) as f32;
        let jitter = ((hsh >> 8) % 5) as f32 - 2.0;
        let climb = 6.0 + ((hsh >> 16) % 5) as f32;

        let x = x0 + wind * ph * 8.0;
        let y = (tip_y + jitter).max(2.0) - ph * climb;
        // Quick ramp-in, linear fade-out over the lifetime.
        let fade = (ph * 6.0).min(1.0) * (1.0 - ph);
        let heat = 0.95 * fade;
        if heat < HEAT_CUTOFF || x < 0.0 || y < 0.0 {
            continue;
        }
        let (xi, yi) = (x as i32, y as i32);
        if xi >= w as i32 || yi >= h as i32 {
            continue;
        }
        px.push(Pixel(Point::new(xi, yi), lut[(heat * 255.0) as usize]));
    }
}

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight into render — so NaN falls back to `default`
/// instead of poisoning the heat math downstream.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

/// One octave of value noise evaluated along a row. The lattice y
/// band (`yi`, `fy`) is fixed per row and consecutive samples share
/// lattice cells, so the four corner hashes are only recomputed when
/// the sweep crosses a cell boundary — ~6k hashes per frame instead
/// of ~50k, which matters on the Pi Zero's ARM11.
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
/// scroll/drift modular reduction in `render` seamless. The panel
/// only ever spans ~10 cells, so the repeat is invisible.
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
 * Each palette is a handful of (heat, color) stops expanded into a
 * 256-entry LUT per frame (256 lerps — noise next to the per-pixel
 * work). Stop positions weight the low-heat end so most of the flame
 * body lands in the saturated middle colors, with white reserved for
 * the hottest core.
 */

type Stop = (f32, (u8, u8, u8));

const CLASSIC_STOPS: &[Stop] = &[
    (0.00, (0, 0, 0)),
    (0.15, (0x40, 0x00, 0x00)), // dark red
    (0.35, (0xc8, 0x10, 0x00)), // red
    (0.55, (0xff, 0x60, 0x00)), // orange
    (0.78, (0xff, 0xd2, 0x28)), // yellow
    (1.00, (0xff, 0xff, 0xdc)), // white-hot
];

const GAS_STOPS: &[Stop] = &[
    (0.00, (0, 0, 0)),
    (0.20, (0x08, 0x0c, 0x50)), // deep blue
    (0.45, (0x18, 0x40, 0xe0)), // blue
    (0.72, (0x20, 0xc8, 0xff)), // cyan
    (1.00, (0xeb, 0xff, 0xff)), // white
];

const PHOSPHOR_STOPS: &[Stop] = &[
    (0.00, (0, 0, 0)),
    (0.30, (0x08, 0x40, 0x18)), // dark green
    (0.70, (0x5d, 0xff, 0xa9)), // phosphor green
    (1.00, (0xd2, 0xff, 0xe6)), // mint white
];

#[allow(clippy::cast_precision_loss)]
fn build_palette(palette: FirePalette) -> [Rgb888; 256] {
    let stops = match palette {
        FirePalette::Classic => CLASSIC_STOPS,
        FirePalette::Gas => GAS_STOPS,
        FirePalette::Phosphor => PHOSPHOR_STOPS,
    };
    let mut lut = [Rgb888::new(0, 0, 0); 256];
    for (i, slot) in lut.iter_mut().enumerate() {
        let t = i as f32 / 255.0;
        let mut color = stops[stops.len() - 1].1;
        for pair in stops.windows(2) {
            let (t0, c0) = pair[0];
            let (t1, c1) = pair[1];
            if t <= t1 {
                let f = if t1 > t0 { (t - t0) / (t1 - t0) } else { 0.0 };
                color = (lerp8(c0.0, c1.0, f), lerp8(c0.1, c1.1, f), lerp8(c0.2, c1.2, f));
                break;
            }
        }
        *slot = Rgb888::new(color.0, color.1, color.2);
    }
    lut
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
fn lerp8(a: u8, b: u8, f: f32) -> u8 {
    (f32::from(a) + (f32::from(b) - f32::from(a)) * f) as u8
}
