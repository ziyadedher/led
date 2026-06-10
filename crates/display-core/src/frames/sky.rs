//! Celestial faces — moon phase, solar day arc, day/night terminator
//! world map. All pure astronomy math from a caller-injected UTC
//! timestamp (no network, no APIs). Mirrors clock's pattern: config
//! persisted, `now` filled per frame by the driver/dash.
//!
//! Formulas are the standard low-precision set (Meeus-style Julian
//! day, NOAA/Astronomical-Almanac solar position): good to a degree
//! or two over 2000–2100, far below one pixel at 64×64. Everything
//! derives from `SkyTime` alone, so the driver (chrono::Utc) and the
//! dash sim (Date.getUTC*) render the identical frame.

use embedded_graphics::{pixelcolor::Rgb888, prelude::*, Pixel};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub enum SkyFace {
    /// Tonight's moon, correctly phased and oriented.
    #[default]
    Moon,
    /// Sun's arc across today, sunrise→sunset, with golden hours.
    Sun,
    /// World map with the live day/night terminator.
    Terminator,
}

/// UTC wall-clock sample injected by the caller each frame.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct SkyTime {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
}

fn d_color() -> Rgb { Rgb { r: 0xff, g: 0xe0, b: 0xb0 } }
fn d_lat() -> f32 { 0.0 }
fn d_lon() -> f32 { 0.0 }

/// Persisted shape (panels.mode_config) — everything but `now`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SkySceneConfig {
    #[serde(default)]
    pub face: SkyFace,
    /// Observer latitude in degrees. Clamped [-90, 90].
    #[serde(default = "d_lat")]
    pub lat: f32,
    /// Observer longitude in degrees. Clamped [-180, 180].
    #[serde(default = "d_lon")]
    pub lon: f32,
    /// Accent color for the lit body / arc / daylight.
    #[serde(default = "d_color")]
    pub color: Rgb,
}

impl Default for SkySceneConfig {
    fn default() -> Self {
        Self { face: SkyFace::Moon, lat: d_lat(), lon: d_lon(), color: d_color() }
    }
}

impl SkySceneConfig {
    #[must_use]
    pub fn into_frame(self, now: SkyTime) -> SkyScene {
        SkyScene { face: self.face, lat: self.lat, lon: self.lon, color: self.color, now }
    }
}

/// Per-frame render payload — config + injected UTC now.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SkyScene {
    #[serde(default)]
    pub face: SkyFace,
    #[serde(default = "d_lat")]
    pub lat: f32,
    #[serde(default = "d_lon")]
    pub lon: f32,
    #[serde(default = "d_color")]
    pub color: Rgb,
    #[serde(default)]
    pub now: SkyTime,
}

impl Default for SkyScene {
    fn default() -> Self {
        SkySceneConfig::default().into_frame(SkyTime::default())
    }
}

/* ─── astronomy ────────────────────────────────────────────────────
 *
 * Low-precision but well-conditioned formulas, all in f64. Accuracy
 * over 2000–2100: solar declination/EoT within ~0.1°/1 min, moon
 * phase age within a few hours — sub-pixel on a 64×64 panel.
 */

/// Mean synodic month in days.
const SYNODIC_MONTH: f64 = 29.530_588_853;
/// A recent new moon epoch (2000-01-06 18:14 UTC), the standard
/// anchor for the fractional-age method.
const NEW_MOON_JD: f64 = 2_451_550.1;

/// Julian day from a UTC civil date (Fliegel/Van Flandern via the
/// Meeus arithmetic form). Valid for all Gregorian dates 2000–2100
/// (and well beyond).
fn julian_day(t: SkyTime) -> f64 {
    let (mut y, mut m) = (f64::from(t.year), f64::from(t.month));
    if t.month <= 2 {
        y -= 1.0;
        m += 12.0;
    }
    let a = (y / 100.0).floor();
    let b = 2.0 - a + (a / 4.0).floor();
    let day = f64::from(t.day) + (f64::from(t.hour) + f64::from(t.minute) / 60.0) / 24.0;
    (365.25 * (y + 4716.0)).floor() + (30.6001 * (m + 1.0)).floor() + day + b - 1524.5
}

/// Moon age as a fraction of the synodic month: 0 = new, 0.5 = full.
fn moon_phase_frac(jd: f64) -> f64 {
    ((jd - NEW_MOON_JD) / SYNODIC_MONTH).rem_euclid(1.0)
}

/// Solar declination (radians) + equation of time (minutes) from the
/// Astronomical Almanac low-precision sun: mean longitude/anomaly →
/// ecliptic longitude → declination + right ascension; EoT is the
/// mean-vs-apparent longitude gap expressed in clock minutes.
fn solar_coords(jd: f64) -> (f64, f64) {
    let n = jd - 2_451_545.0; // days since J2000.0
    let l = (280.460 + 0.985_647_4 * n).rem_euclid(360.0); // mean longitude
    let g = (357.528 + 0.985_600_3 * n).rem_euclid(360.0).to_radians(); // mean anomaly
    let lambda = (l + 1.915 * g.sin() + 0.020 * (2.0 * g).sin()).to_radians();
    let eps = (23.439 - 0.000_000_4 * n).to_radians(); // obliquity
    let decl = (eps.sin() * lambda.sin()).asin();
    let alpha = (eps.cos() * lambda.sin()).atan2(lambda.cos()).to_degrees();
    let eot_min = 4.0 * wrap180(l - alpha);
    (decl, eot_min)
}

/// Subsolar longitude in degrees: where the sun is at zenith. Noon
/// apparent solar time at Greenwich shifts by the equation of time.
fn subsolar_lon(utc_hours: f64, eot_min: f64) -> f64 {
    wrap180(-15.0 * (utc_hours + eot_min / 60.0 - 12.0))
}

/// Sun elevation (degrees) at an observer, from the subsolar point
/// via the great-circle angle: sin(el) = sin φ sin δ + cos φ cos δ cos Δλ.
fn sun_elevation_deg(lat_deg: f64, lon_deg: f64, decl: f64, subsolar_lon_deg: f64) -> f64 {
    let phi = lat_deg.to_radians();
    let dl = (lon_deg - subsolar_lon_deg).to_radians();
    (phi.sin() * decl.sin() + phi.cos() * decl.cos() * dl.cos())
        .clamp(-1.0, 1.0)
        .asin()
        .to_degrees()
}

fn wrap180(x: f64) -> f64 {
    (x + 180.0).rem_euclid(360.0) - 180.0
}

/* ─── shared pixel plumbing ───────────────────────────────────── */

type Px = Vec<Pixel<Rgb888>>;

/// Linear-ish RGB accumulator in f32; clamps on conversion out.
#[derive(Clone, Copy)]
struct C(f32, f32, f32);

impl C {
    fn from_rgb(c: Rgb) -> Self {
        C(f32::from(c.r), f32::from(c.g), f32::from(c.b))
    }
    fn scale(self, f: f32) -> Self {
        C(self.0 * f, self.1 * f, self.2 * f)
    }
    fn add(self, o: C) -> Self {
        C(self.0 + o.0, self.1 + o.1, self.2 + o.2)
    }
    fn lerp(self, o: C, t: f32) -> Self {
        let t = t.clamp(0.0, 1.0);
        C(
            self.0 + (o.0 - self.0) * t,
            self.1 + (o.1 - self.1) * t,
            self.2 + (o.2 - self.2) * t,
        )
    }
    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_sign_loss)]
    fn rgb888(self) -> Rgb888 {
        Rgb888::new(
            self.0.clamp(0.0, 255.0) as u8,
            self.1.clamp(0.0, 255.0) as u8,
            self.2.clamp(0.0, 255.0) as u8,
        )
    }
}

fn push(px: &mut Px, x: i32, y: i32, w: i32, h: i32, c: C) {
    if x >= 0 && x < w && y >= 0 && y < h {
        px.push(Pixel(Point::new(x, y), c.rgb888()));
    }
}

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight into render — so NaN falls back to `default`
/// instead of poisoning every elevation/phase computation downstream.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

/// Integer hash → u32. Same xorshift-multiply mixer family as fire's
/// — the faces' only source of "random" placement (stars, maria), so
/// they're identical every render and across driver/WASM.
fn hash(x: u32, seed: u32) -> u32 {
    let mut v = x.wrapping_mul(0x9e37_79b9) ^ seed;
    v ^= v >> 15;
    v = v.wrapping_mul(0x2c1b_3c6d);
    v ^= v >> 12;
    v = v.wrapping_mul(0x2972_5913);
    v ^= v >> 15;
    v
}

#[allow(clippy::cast_precision_loss)]
fn hash01(x: u32, seed: u32) -> f32 {
    (hash(x, seed) >> 8) as f32 * (1.0 / 16_777_216.0)
}

fn smooth01(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// `step·rate` folded onto one turn in f64 *before* narrowing to f32
/// — a raw `step as f32` clock loses sub-step increments past 2^24
/// steps (~3 days at 60/s) and the shimmer would quantize, then
/// freeze. f64 holds any realistic step exactly.
#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_possible_truncation)]
fn step_phase(step: usize, rate: f64) -> f32 {
    ((step as f64 * rate).rem_euclid(core::f64::consts::TAU)) as f32
}

const SEED_STARS: u32 = 0x51a7_f00d;
const SEED_MARIA: u32 = 0x300d_cafe;

pub fn render<D>(scene: &SkyScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width, size.height);
    if w == 0 || h == 0 {
        return Ok(());
    }
    #[allow(clippy::cast_possible_wrap)]
    let (w, h) = (w as i32, h as i32);

    let lat = f64::from(finite_clamp(scene.lat, -90.0, 90.0, 0.0));
    let lon = f64::from(finite_clamp(scene.lon, -180.0, 180.0, 0.0));
    let base = C::from_rgb(scene.color);
    let jd = julian_day(scene.now);
    let utc_hours = f64::from(scene.now.hour) + f64::from(scene.now.minute) / 60.0;

    let mut px: Px = Vec::with_capacity((w * h) as usize);
    match scene.face {
        SkyFace::Moon => face_moon(&mut px, w, h, base, jd, lat, step),
        SkyFace::Sun => face_sun(&mut px, w, h, base, jd, utc_hours, lat, lon),
        SkyFace::Terminator => {
            face_terminator(&mut px, w, h, base, jd, utc_hours, lat, lon, step);
        }
    }
    canvas.draw_iter(px)
}

/* ─── face 1: moon ─────────────────────────────────────────────────
 *
 * Big centered disc with the classic phase rendering: per row the
 * disc spans ±half(y), and the terminator is the ellipse x = half(y)
 * · cos(2π·age). Waxing lights the right limb for northern
 * observers; the whole face mirrors for cfg.lat < 0 (southern sky).
 */

#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_possible_truncation)]
fn face_moon(px: &mut Px, w: i32, h: i32, base: C, jd: f64, lat: f64, step: usize) {
    let cx = (w as f32 - 1.0) / 2.0;
    let cy = (h as f32 - 1.0) / 2.0;
    let r = (w.min(h) as f32) * 0.36; // ≈23px → 46px disc at 64×64

    // Thin starfield around the disc. Fixed hash positions; a gentle
    // per-star twinkle rides `step` but the static frame reads fine.
    for i in 0..20u32 {
        let sx = (hash01(i, SEED_STARS) * w as f32) as i32;
        let sy = (hash01(i, SEED_STARS ^ 0xbeef) * h as f32) as i32;
        let dx = sx as f32 - cx;
        let dy = sy as f32 - cy;
        if dx * dx + dy * dy <= (r + 2.0) * (r + 2.0) {
            continue; // never inside (or kissing) the disc
        }
        let b = 0.10 + 0.20 * hash01(i, SEED_STARS ^ 0x77);
        let phase = hash01(i, SEED_STARS ^ 0x3f) * core::f32::consts::TAU;
        let tw = 0.85 + 0.15 * (step_phase(step, 0.05) + phase).sin();
        push(px, sx, sy, w, h, C(190.0, 200.0, 220.0).scale(b * tw));
    }

    let frac = moon_phase_frac(jd);
    let waxing = frac < 0.5;
    #[allow(clippy::cast_possible_truncation)]
    let cos_t = (core::f64::consts::TAU * frac).cos() as f32;
    let flip = lat < 0.0; // southern observers see the moon mirrored

    // Fixed maria (darker basalt patches) in disc-local coordinates,
    // so they mirror together with the phase for southern observers.
    let mut maria = [(0.0f32, 0.0f32, 0.0f32); 6];
    for (k, m) in maria.iter_mut().enumerate() {
        let k = k as u32;
        let ang = hash01(k, SEED_MARIA) * core::f32::consts::TAU;
        let rad = r * (0.15 + 0.55 * hash01(k, SEED_MARIA ^ 0x11));
        let br = r * (0.10 + 0.13 * hash01(k, SEED_MARIA ^ 0x22));
        *m = (ang.cos() * rad, ang.sin() * rad, br);
    }

    for yi in 0..h {
        let dy = yi as f32 - cy;
        if dy.abs() > r + 0.5 {
            continue;
        }
        let half = (r * r - dy * dy).max(0.0).sqrt();
        let x0 = (cx - half - 1.0).floor() as i32;
        let x1 = (cx + half + 1.0).ceil() as i32;
        for xi in x0..=x1 {
            let dx = xi as f32 - cx;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist > r + 0.5 {
                continue;
            }
            // Soft limb: fade the outermost ~1px ring.
            let edge = (r + 0.5 - dist).clamp(0.0, 1.0);

            // Phase-mirrored x: orientation flips south of the equator.
            let dxo = if flip { -dx } else { dx };
            // Signed distance (px) past the terminator into the lit side.
            let s = if waxing { dxo - half * cos_t } else { -dxo - half * cos_t };
            let lit = smooth01(s / 1.5 + 0.5);

            // Limb darkening on the lit hemisphere.
            let rho2 = (dist * dist) / (r * r);
            let ld = 0.55 + 0.45 * (1.0 - rho2).max(0.0).sqrt();

            // Maria darken the lit surface (invisible on the dark side).
            let mut mf = 1.0;
            for &(mx, my, br) in &maria {
                let ddx = dxo - mx;
                let ddy = dy - my;
                let d = (ddx * ddx + ddy * ddy).sqrt();
                if d < br {
                    mf *= 0.62 + 0.38 * smooth01(d / br);
                }
            }

            let lit_c = base.scale(ld * mf);
            let dark_c = base.scale(0.045);
            push(px, xi, yi, w, h, dark_c.lerp(lit_c, lit).scale(edge));
        }
    }
}

/* ─── face 2: sun ──────────────────────────────────────────────────
 *
 * Today's solar arc at the observer's coordinates. The x-axis is
 * local apparent solar time (midnight at the edges, solar noon dead
 * center), so the arc is symmetric and the "now" disc slides along
 * it through the day. Sky gradient keys off the current elevation.
 */

#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
#[allow(clippy::too_many_arguments)]
#[allow(clippy::similar_names)]
fn face_sun(px: &mut Px, w: i32, h: i32, base: C, jd: f64, utc_hours: f64, lat: f64, lon: f64) {
    let (decl, eot_min) = solar_coords(jd);
    // Local apparent solar hour: 12.0 = sun due south/north (transit).
    let solar_now = (utc_hours + lon / 15.0 + eot_min / 60.0).rem_euclid(24.0);
    let elev_at = |solar_h: f64| -> f64 {
        let ha = (15.0 * (solar_h - 12.0)).to_radians();
        let phi = lat.to_radians();
        (phi.sin() * decl.sin() + phi.cos() * decl.cos() * ha.cos())
            .clamp(-1.0, 1.0)
            .asin()
            .to_degrees()
    };
    let el_now = elev_at(solar_now) as f32;

    let hy = (h * 44) / 64; // horizon row (44 at 64×64)
    let hyf = hy as f32;
    // Day factor: night below -6° (civil twilight), full day above +10°.
    let dfac = smooth01((el_now + 6.0) / 16.0);
    // Golden hour: peaks near the horizon, fades out by el ∈ [-6, 10].
    let gold = (1.0 - (el_now - 2.0).abs() / 8.0).clamp(0.0, 1.0);

    let night_top = C(2.0, 3.0, 10.0);
    let night_bot = C(6.0, 9.0, 22.0);
    let day_top = C(20.0, 45.0, 90.0).lerp(base, 0.20);
    let day_bot = C(70.0, 110.0, 160.0).lerp(base, 0.35);
    let warm = C(200.0, 90.0, 18.0);

    // Background color per row (sky gradient above the horizon line,
    // ground below). Kept as a table so the overlays — arc, ticks,
    // halo, under-horizon glow — can ADD onto it: replacing pixels
    // would punch dark holes into a dusk-bright sky.
    let bg_row = |y: i32| -> C {
        if y < hy {
            let t = y as f32 / hyf;
            let night = night_top.lerp(night_bot, t);
            let day = day_top.lerp(day_bot, t);
            // Golden-hour band hugs the horizon (t² weighting).
            night.lerp(day, dfac).add(warm.scale(0.45 * gold * t * t))
        } else {
            let depth = (y - hy) as f32 / (h - hy).max(1) as f32;
            let g = C(4.0, 5.0, 4.0)
                .lerp(C(16.0, 18.0, 12.0), dfac)
                .scale(1.0 - 0.35 * depth);
            if y == hy {
                // The horizon line itself: a slightly brighter seam.
                g.scale(1.8).add(warm.scale(0.12 * gold))
            } else {
                g
            }
        }
    };
    let bg: Vec<C> = (0..h).map(bg_row).collect();
    for y in 0..h {
        for x in 0..w {
            push(px, x, y, w, h, bg[y as usize]);
        }
    }

    // Sunrise/sunset tick marks (skip during polar day/night).
    let cos_h0 = -lat.to_radians().tan() * decl.tan();
    if cos_h0.abs() <= 1.0 {
        let h0 = cos_h0.acos().to_degrees() / 15.0; // half day length, hours
        for sh in [12.0 - h0, 12.0 + h0] {
            let x = ((sh / 24.0) * f64::from(w)) as i32;
            for y in [hy - 1, hy] {
                push(px, x, y, w, h, bg[y.clamp(0, h - 1) as usize].add(base.scale(0.45)));
            }
        }
    }

    // The day's arc: elevation sampled per column, drawn faint gold
    // where the sun is above the horizon.
    let y_of = |el: f32| hyf - (el / 90.0) * (hyf - 4.0);
    for x in 0..w {
        let sh = (f64::from(x) + 0.5) / f64::from(w) * 24.0;
        let el = elev_at(sh) as f32;
        if el <= 0.0 {
            continue;
        }
        let y = (y_of(el) as i32).clamp(0, h - 1);
        let glow = base.scale(0.14 + 0.18 * el / 90.0);
        push(px, x, y, w, h, bg[y as usize].add(glow));
    }

    // The sun NOW.
    let x_now = ((solar_now / 24.0) * f64::from(w)) as i32;
    if el_now > 0.0 {
        let y_now = y_of(el_now);
        let rr = 2.4f32;
        let lo = -(rr.ceil() as i32) - 2;
        let hi = rr.ceil() as i32 + 2;
        for dy in lo..=hi {
            for dx in lo..=hi {
                let d = ((dx * dx + dy * dy) as f32).sqrt();
                let (x, y) = (x_now + dx, (y_now as i32) + dy);
                if y < 0 || y >= h {
                    continue;
                }
                if d <= rr {
                    // Core: base color pushed toward white at center.
                    let c = base.lerp(C(255.0, 255.0, 240.0), 0.6 * (1.0 - d / rr));
                    push(px, x, y, w, h, c);
                } else if d <= rr + 2.0 && y < hy {
                    // Halo over the sky only — keep the horizon crisp.
                    let f = 1.0 - (d - rr) / 2.0;
                    push(px, x, y, w, h, bg[y as usize].add(base.scale(0.30 * f * f)));
                }
            }
        }
    } else {
        // Below the horizon: a dim glow seeping under the horizon
        // line, fading out entirely by el = -12°.
        let fade = (1.0 + el_now / 12.0).clamp(0.0, 1.0);
        for dx in -4i32..=4 {
            for dy in 0i32..=2 {
                let y = hy + 1 + dy;
                if y >= h {
                    continue;
                }
                let f = (1.0 - dx.abs() as f32 / 5.0) * (1.0 - dy as f32 / 3.0);
                push(px, x_now + dx, y, w, h, bg[y as usize].add(base.scale(0.30 * fade * f)));
            }
        }
    }
}

/* ─── face 3: terminator ───────────────────────────────────────────
 *
 * 64×32 equirectangular Earth (rows (h-32)/2 .. +32). Day/night per
 * pixel from the sun's elevation there (great-circle angle to the
 * subsolar point), with a soft twilight seam where it crosses zero.
 */

/// Hand-derived 64×32 land mask, '#' = land. Equirectangular:
/// x = (lon+180)/5.625, y = (90-lat)/5.625. Americas left, Africa /
/// Europe center, Asia/Australia right, Antarctica along the bottom.
#[rustfmt::skip]
const EARTH_ART: [&str; MAP_H] = [
    "................................................................",
    "............######...#######....................................",
    "........####.######.#########....##..............##.............",
    "##.#################.#######.......########################.####",
    "..#################....####.##...##############################.",
    "...###########.####............#.##############################.",
    "........#####..####...........#############################.#...",
    "..........##########...........###########################......",
    "..........##########..........###.######.#################......",
    "..........#########...........##.....####################.......",
    "...........#######...........##########################.........",
    "...........#####.##..........#############.###########..........",
    "............####.##..........#############..####.####.#.........",
    ".............####............#############..###..######.........",
    "..............########........###########.....#...#####.........",
    "..............##########.......##########.......############....",
    "..............#############.....#########........##.#.######....",
    "..............############......#########.........####...##.....",
    "..............###########........#######.#...........######.....",
    "..............##########.........#######.#.........#########....",
    "..............########...........######.#..........#########....",
    "...............######.............####..............#######.....",
    "...............#####..............##....................###...##",
    "...............####......................................#....##",
    "................###..........................................##.",
    "................##..............................................",
    "................................................................",
    "....................##..................#.......#......#........",
    "............#############..################..################...",
    "........#######################################################.",
    "....############################################################",
    "################################################################",
];

const MAP_W: usize = 64;
const MAP_H: usize = 32;

/// 64 bits per row, bit x = column x. Built at compile time from the
/// ASCII art above (a wrong-length row is a compile error).
static EARTH: [u64; MAP_H] = build_earth();

const fn build_earth() -> [u64; MAP_H] {
    let mut rows = [0u64; MAP_H];
    let mut y = 0;
    while y < MAP_H {
        let line = EARTH_ART[y].as_bytes();
        assert!(line.len() == MAP_W, "earth map row must be exactly 64 chars");
        let mut x = 0;
        while x < MAP_W {
            if line[x] == b'#' {
                rows[y] |= 1 << x;
            }
            x += 1;
        }
        y += 1;
    }
    rows
}

fn is_land(x: usize, y: usize) -> bool {
    EARTH[y] >> x & 1 == 1
}

#[allow(clippy::cast_precision_loss)]
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::too_many_arguments)]
fn face_terminator(
    px: &mut Px,
    w: i32,
    h: i32,
    base: C,
    jd: f64,
    utc_hours: f64,
    lat: f64,
    lon: f64,
    step: usize,
) {
    let (decl, eot_min) = solar_coords(jd);
    let ss_lon = subsolar_lon(utc_hours, eot_min);
    let ss_lat = decl.to_degrees();

    #[allow(clippy::cast_possible_wrap)]
    let top = (h - MAP_H as i32) / 2; // rows 16..48 at 64×64

    // Sparse dim stars in the bands above and below the map.
    for i in 0..14u32 {
        let sx = (hash01(i, SEED_STARS ^ 0xa5a5) * w as f32) as i32;
        let band = hash(i, SEED_STARS ^ 0x5a5a) & 1;
        let off = (hash01(i, SEED_STARS ^ 0xc3) * (top as f32 - 1.0)) as i32;
        let sy = if band == 0 { off } else { top + MAP_H as i32 + off };
        let b = 0.08 + 0.16 * hash01(i, SEED_STARS ^ 0x99);
        push(px, sx, sy, w, h, C(170.0, 180.0, 205.0).scale(b));
    }

    let day_sea = C(34.0, 50.0, 66.0);
    let night_sea = C(2.0, 3.0, 6.0);
    let day_land = base.scale(0.85);
    let night_land = base.scale(0.08);
    let twilight = C(150.0, 55.0, 10.0);

    for my in 0..MAP_H {
        let lat_p = 90.0 - (my as f64 + 0.5) * 5.625;
        for mx in 0..MAP_W {
            let lon_p = (mx as f64 + 0.5) * 5.625 - 180.0;
            let el = sun_elevation_deg(lat_p, lon_p, decl, ss_lon) as f32;
            // Day/night blend across el ∈ [-6°, +6°] ≈ 1–2px at this
            // scale — the soft terminator seam.
            let d = smooth01((el + 6.0) / 12.0);
            let land = is_land(mx, my);
            let mut c = if land {
                night_land.lerp(day_land, d)
            } else {
                night_sea.lerp(day_sea, d)
            };
            // Warm twilight tint, strongest right on the line.
            let tw = (1.0 - el.abs() / 7.0).clamp(0.0, 1.0);
            c = c.add(twilight.scale(tw * tw * if land { 0.45 } else { 0.20 }));
            #[allow(clippy::cast_possible_wrap)]
            push(px, mx as i32, top + my as i32, w, h, c);
        }
    }

    // Subsolar point: tiny bright sun dot (with a faint cross halo).
    let sx = ((ss_lon + 180.0) / 5.625) as i32;
    let sy = top + ((90.0 - ss_lat) / 5.625) as i32;
    for (dx, dy, f) in [(0, 0, 1.0f32), (1, 0, 0.3), (-1, 0, 0.3), (0, 1, 0.3), (0, -1, 0.3)] {
        push(px, sx + dx, sy + dy, w, h, C(255.0, 235.0, 170.0).scale(f));
    }

    // Observer marker: slow pulse via `step` — the face's only motion.
    let ox = ((lon + 180.0) / 5.625) as i32;
    let oy = top + ((90.0 - lat) / 5.625) as i32;
    let pulse = 0.35 + 0.65 * (0.5 + 0.5 * step_phase(step, 0.06).sin());
    push(px, ox, oy, w, h, base.lerp(C(255.0, 255.0, 255.0), 0.6).scale(pulse));
}
