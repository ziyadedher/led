//! Pong clock — the panel plays pong against itself and the score is
//! the time (HH vs MM). The losing paddle deliberately misses on a
//! score rollover. Ball/paddle motion is a pure function of step;
//! the time is caller-injected like clock's `now`.
//!
//! Closed-form rally: the ball's x is a triangle wave between the
//! paddle planes (one crossing per `half_steps`), and its y is a
//! reflective fold of a line drawn between hash-derived "unfolded"
//! arrival targets — so every crossing's arrival row is known in
//! O(1) from the crossing index alone. Paddles ease between their
//! own side's consecutive arrival rows, which makes paddle/ball
//! contact at every crossing instant true by construction, no state.
//!
//! The miss: `now.second < 3` marks a fresh minute. Second 0 plays
//! the score (receiving paddle wrong-footed, ball sails past and
//! exits right), second 1 is an empty court, second 2 re-serves by
//! resuming the normal closed-form rally — which also makes the
//! 2 → 3 transition seamless. step and wall-clock aren't phase-
//! locked, so the branch entry at second 0 jumps the ball to a
//! plausible mid-court position and animates smoothly from there.

use embedded_graphics::{
    mono_font::{ascii::FONT_5X8, MonoTextStyleBuilder},
    pixelcolor::Rgb888,
    prelude::*,
    text::Text,
    Pixel,
};
use serde::{Deserialize, Serialize};

use crate::frames::text::Rgb;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub enum PongFormat {
    #[default]
    H24,
    H12,
}

fn d_color() -> Rgb { Rgb { r: 0xe6, g: 0xe6, b: 0xea } }
fn d_speed() -> f32 { 1.0 }

/// Persisted shape (panels.mode_config) — everything but `now`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PongSceneConfig {
    #[serde(default = "d_color")]
    pub color: Rgb,
    /// Rally speed. Clamped [0.25, 4].
    #[serde(default = "d_speed")]
    pub speed: f32,
    #[serde(default)]
    pub format: PongFormat,
}

impl Default for PongSceneConfig {
    fn default() -> Self {
        Self { color: d_color(), speed: d_speed(), format: PongFormat::H24 }
    }
}

/// Caller-injected local wall-clock sample.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct PongTime {
    pub hour: u8,
    pub minute: u8,
    /// Seconds — used to phase the serve/miss animation right after
    /// a score rollover.
    pub second: u8,
}

impl PongSceneConfig {
    #[must_use]
    pub fn into_frame(self, now: PongTime) -> PongScene {
        PongScene { color: self.color, speed: self.speed, format: self.format, now }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PongScene {
    #[serde(default = "d_color")]
    pub color: Rgb,
    #[serde(default = "d_speed")]
    pub speed: f32,
    #[serde(default)]
    pub format: PongFormat,
    #[serde(default)]
    pub now: PongTime,
}

impl Default for PongScene {
    fn default() -> Self {
        PongSceneConfig::default().into_frame(PongTime::default())
    }
}

// Driver renders ~60 steps/s (see fire.rs RISE notes).
const STEPS_PER_SEC: f64 = 60.0;
// One paddle-to-paddle crossing at speed 1.0 — the base rally tempo.
const BASE_CROSSING_SECS: f64 = 3.5;
const PADDLE_H: i32 = 7;
// Unfolded y targets span 3× the court so consecutive arrivals can
// be up to ~3 folds apart — the ball banks 0–3 times per crossing.
const Y_UNFOLD: f64 = 3.0;
// How far (px) the wrong-footed paddle parks from the passing ball.
const DODGE: f64 = 9.0;

// Per-stream hash seeds — arbitrary odd constants (fire.rs style).
const SEED_ARRIVE: u32 = 0x9d2c_5681;
const SEED_JITTER: u32 = 0x5f35_6495;
const SEED_MISS: u32 = 0x1f12_3bb5;

/// Court geometry derived from the canvas size. All ball y values
/// are ball-top rows; the ball is 2×2 and paddles are 1×`PADDLE_H`.
struct Court {
    h: i32,
    /// Center-line column.
    cx: i32,
    /// Ball-top x at left/right paddle contact.
    bx_min: f64,
    bx_max: f64,
    /// Ball-top y travel band (below the score digits).
    by_min: f64,
    by_max: f64,
    /// Paddle-top clamp band.
    pt_min: f64,
    pt_max: f64,
    /// Paddle columns.
    lp_x: i32,
    rp_x: i32,
}

impl Court {
    fn new(w: i32, h: i32) -> Self {
        Self {
            h,
            cx: w / 2 - 1,
            bx_min: 2.0,
            bx_max: f64::from(w - 4),
            by_min: 10.0,
            by_max: f64::from(h - 3),
            pt_min: 8.0,
            pt_max: f64::from(h - PADDLE_H),
            lp_x: 1,
            rp_x: w - 2,
        }
    }

    fn span(&self) -> f64 {
        self.by_max - self.by_min
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Left,
    Right,
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_precision_loss)]
pub fn render<D>(scene: &PongScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let (w, h) = (size.width as i32, size.height as i32);
    if w < 24 || h < 24 {
        // Too small for a court; the dispatcher already cleared.
        return Ok(());
    }
    let court = Court::new(w, h);

    let speed = f64::from(finite_clamp(scene.speed, 0.25, 4.0, d_speed()));
    let half_steps = BASE_CROSSING_SECS * STEPS_PER_SEC / speed;
    // f64 keeps sub-crossing resolution ~u·2⁻⁵² — smooth far past
    // step 2^24 (where a raw f32 clock would quantize and freeze).
    let u = step as f64 / half_steps;

    let mut px: Vec<Pixel<Rgb888>> = Vec::with_capacity(128);

    // Court furniture: dashed center line at 25%, score at 60%.
    let line = scale_color(scene.color, 0.25);
    for y in 0..court.h {
        if y % 4 < 2 {
            px.push(Pixel(Point::new(court.cx, y), line));
        }
    }

    // Rollover script. Seconds 0/1 branch; second 2 already rallies
    // (the re-serve), making the hand-off back to honest play seamless.
    let hour_rollover = scene.now.minute == 0;
    match scene.now.second {
        0 => draw_miss(&mut px, scene, step, u, &court, hour_rollover),
        1 => {
            // Empty court: the ball is out, paddles regroup.
            draw_paddle(&mut px, &court, Side::Left, paddle_top(u, Side::Left, &court), scene.color);
            draw_paddle(&mut px, &court, Side::Right, paddle_top(u, Side::Right, &court), scene.color);
        }
        _ => draw_rally(&mut px, scene, u, &court),
    }

    canvas.draw_iter(px)?;
    draw_score(scene, &court, canvas)
}

/// Honest play: closed-form ball + both paddles easing between their
/// own arrival rows.
fn draw_rally(px: &mut Vec<Pixel<Rgb888>>, scene: &PongScene, u: f64, court: &Court) {
    let r = u.floor();
    let frac = u - r;
    #[allow(clippy::cast_possible_truncation)]
    let ri = r as i64;

    // x: triangle wave between paddle planes; even crossings launch
    // from the left plane, odd from the right.
    let bx = if ri.rem_euclid(2) == 0 {
        court.bx_min + frac * (court.bx_max - court.bx_min)
    } else {
        court.bx_max - frac * (court.bx_max - court.bx_min)
    };
    // y: fold of the line between this crossing's and the next
    // crossing's unfolded targets — banks off the rails en route and
    // lands exactly on `arrive_top(r+1)`.
    let by = court.by_min
        + tri_fold(lerp(arrive_unfolded(ri, court), arrive_unfolded(ri + 1, court), frac), court.span());

    draw_ball(px, court, bx, by, scene.color);
    draw_paddle(px, court, Side::Left, paddle_top(u, Side::Left, court), scene.color);
    draw_paddle(px, court, Side::Right, paddle_top(u, Side::Right, court), scene.color);
}

/// Second 0 of the minute: the receiving side (right for a minute
/// change; both when the hour rolls) parks off the ball's row and
/// the ball sails out the right edge. Sub-second motion rides
/// `step % 60`; its phase vs the wall second is arbitrary, so the
/// exit burst finishes fast (≲0.5 s) and any mid-second wrap usually
/// lands while the ball is already off-screen.
fn draw_miss(
    px: &mut Vec<Pixel<Rgb888>>,
    scene: &PongScene,
    step: usize,
    u: f64,
    court: &Court,
    hour_rollover: bool,
) {
    let span = court.span();
    let mid = (court.by_min + court.by_max) * 0.5;
    // The missed row is pinned per (hour, minute) so it holds still
    // for the whole second.
    let hm = u32::from(scene.now.hour) * 64 + u32::from(scene.now.minute);
    let by = court.by_min + (0.15 + 0.7 * unit(hash2(hm, 0, SEED_MISS))) * span;

    #[allow(clippy::cast_precision_loss)]
    let qs = (step % 60) as f64 / 60.0;
    let e = (qs * 2.2).min(1.0);
    let bx = f64::from(court.cx) + e * (f64::from(court.rp_x) + 3.0 - f64::from(court.cx));
    draw_ball(px, court, bx, by, scene.color);

    // Wrong-footed: dodge away from the ball's row, toward open court.
    let dodge_top = |ball_top: f64| {
        let dir = if ball_top + 1.0 < mid { 1.0 } else { -1.0 };
        (ball_top - 2.0 + dir * DODGE).clamp(court.pt_min, court.pt_max)
    };
    let left_top = if hour_rollover { dodge_top(by) } else { paddle_top(u, Side::Left, court) };
    draw_paddle(px, court, Side::Left, left_top, scene.color);
    draw_paddle(px, court, Side::Right, dodge_top(by), scene.color);
}

/// Unfolded y target for crossing `r` — hash-derived, in
/// [0, `Y_UNFOLD`·span). `tri_fold` of this is the arrival ball-top.
fn arrive_unfolded(r: i64, court: &Court) -> f64 {
    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_sign_loss)]
    let (lo, hi) = (r as u32, (r >> 32) as u32);
    unit(hash2(lo, hi, SEED_ARRIVE)) * Y_UNFOLD * court.span()
}

/// Arrival ball-top row for crossing `r`.
fn arrive_top(r: i64, court: &Court) -> f64 {
    court.by_min + tri_fold(arrive_unfolded(r, court), court.span())
}

/// Paddle-top at rally parameter `u`. Each side is struck on
/// alternating crossings (left = even, right = odd); between two of
/// its own hits the paddle eases — with a short reaction lag and a
/// hash jitter that vanishes at the endpoints — from the row it just
/// defended to the row the ball will arrive on. Contact at every
/// crossing instant is therefore exact by construction.
fn paddle_top(u: f64, side: Side, court: &Court) -> f64 {
    let base = match side {
        Side::Left => u / 2.0,
        Side::Right => (u - 1.0) / 2.0,
    };
    let k = base.floor();
    let s = base - k;
    #[allow(clippy::cast_possible_truncation)]
    let r_from = match side {
        Side::Left => 2 * (k as i64),
        Side::Right => 2 * (k as i64) + 1,
    };

    let from = arrive_top(r_from, court) - 2.0;
    let to = arrive_top(r_from + 2, court) - 2.0;
    // Reaction lag: hold the old row briefly, then ease over.
    let g = smoothstep(((s - 0.12) / 0.88).clamp(0.0, 1.0));
    // Mid-leg wander, zero at both hit instants.
    let win = 4.0 * s * (1.0 - s);
    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_sign_loss)]
    let j = (unit(hash2(r_from as u32, (r_from >> 32) as u32, SEED_JITTER)) - 0.5) * 4.0;

    (from + (to - from) * g + j * win).clamp(court.pt_min, court.pt_max)
}

/* ─── drawing ──────────────────────────────────────────────────── */

#[allow(clippy::cast_possible_truncation)]
fn draw_ball(px: &mut Vec<Pixel<Rgb888>>, court: &Court, bx: f64, by: f64, color: Rgb) {
    let (x0, y0) = (bx.round() as i32, by.round() as i32);
    let c: Rgb888 = color.into();
    for dy in 0..2 {
        for dx in 0..2 {
            let (x, y) = (x0 + dx, y0 + dy);
            // Clip: the miss exit deliberately runs off the right
            // edge of the panel (rp_x + 2 == panel width).
            if x >= 0 && x < court.rp_x + 2 && y >= 0 && y < court.h {
                px.push(Pixel(Point::new(x, y), c));
            }
        }
    }
}

#[allow(clippy::cast_possible_truncation)]
fn draw_paddle(px: &mut Vec<Pixel<Rgb888>>, court: &Court, side: Side, top: f64, color: Rgb) {
    let x = match side {
        Side::Left => court.lp_x,
        Side::Right => court.rp_x,
    };
    let top = top.round() as i32;
    let c: Rgb888 = color.into();
    for dy in 0..PADDLE_H {
        let y = top + dy;
        if y >= 0 && y < court.h {
            px.push(Pixel(Point::new(x, y), c));
        }
    }
}

/// Score row: hours top-left of the line, minutes top-right, in the
/// same FONT_5X8 glyphs clock.rs uses, at 60% of cfg.color. H12
/// drops the hour's leading zero and lights a tiny pm dot in the
/// center gap.
#[allow(clippy::cast_possible_wrap)]
fn draw_score<D>(scene: &PongScene, court: &Court, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let (h, m) = (scene.now.hour, scene.now.minute);
    let (hour_text, pm) = match scene.format {
        PongFormat::H24 => (format!("{h:02}"), false),
        PongFormat::H12 => {
            let display_h = match h {
                0 => 12,
                1..=12 => h,
                _ => h - 12,
            };
            (format!("{display_h}"), h >= 12)
        }
    };
    let minute_text = format!("{m:02}");

    let dim = scale_color(scene.color, 0.60);
    let style = MonoTextStyleBuilder::new().font(&FONT_5X8).text_color(dim).build();

    let glyph_w = (FONT_5X8.character_size.width + FONT_5X8.character_spacing) as i32;
    let hour_w = hour_text.chars().count() as i32 * glyph_w - 1;
    // 3-px gap on each side of the center line; FONT_5X8's baseline
    // sits at row 7, so the score occupies rows 0..=7 above the
    // ball's travel band (by_min = 10).
    Text::new(&hour_text, Point::new(court.cx - 3 - hour_w, 7), style).draw(canvas)?;
    Text::new(&minute_text, Point::new(court.cx + 4, 7), style).draw(canvas)?;

    if pm {
        // Tiny pm marker tucked into the center gap at the baseline.
        canvas.draw_iter([Pixel(Point::new(court.cx - 2, 6), dim)])?;
    }
    Ok(())
}

/* ─── numerics (fire.rs conventions) ───────────────────────────── */

/// `f32::clamp` propagates NaN, and the driver feeds raw persisted
/// configs straight into render — NaN falls back to `default`.
fn finite_clamp(v: f32, lo: f32, hi: f32, default: f32) -> f32 {
    if v.is_nan() {
        default
    } else {
        v.clamp(lo, hi)
    }
}

/// 2-D integer hash → u32. Same mixer family as fire.rs — the
/// scene's only source of variation, bit-identical on ARM and WASM.
fn hash2(x: u32, y: u32, seed: u32) -> u32 {
    let mut v = x.wrapping_mul(0x9e37_79b9) ^ y.wrapping_mul(0x85eb_ca6b) ^ seed;
    v ^= v >> 15;
    v = v.wrapping_mul(0x2c1b_3c6d);
    v ^= v >> 12;
    v = v.wrapping_mul(0x2972_5913);
    v ^= v >> 15;
    v
}

/// Hash → [0, 1).
fn unit(h: u32) -> f64 {
    f64::from(h >> 8) * (1.0 / 16_777_216.0)
}

/// Reflective fold of `v` into [0, span] — the rail bounce.
fn tri_fold(v: f64, span: f64) -> f64 {
    let m = v.rem_euclid(2.0 * span);
    if m > span {
        2.0 * span - m
    } else {
        m
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

fn smoothstep(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
fn scale_color(c: Rgb, f: f32) -> Rgb888 {
    let s = |v: u8| (f32::from(v) * f) as u8;
    Rgb888::new(s(c.r), s(c.g), s(c.b))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal 64×64 capture target for asserting on emitted pixels.
    struct Buf {
        px: Vec<Option<Rgb888>>,
    }

    impl Buf {
        fn new() -> Self {
            Self { px: vec![None; 64 * 64] }
        }

        fn get(&self, x: i32, y: i32) -> Option<Rgb888> {
            self.px[(y * 64 + x) as usize]
        }
    }

    impl OriginDimensions for Buf {
        fn size(&self) -> Size {
            Size::new(64, 64)
        }
    }

    impl DrawTarget for Buf {
        type Color = Rgb888;
        type Error = core::convert::Infallible;

        fn draw_iter<I>(&mut self, pixels: I) -> Result<(), Self::Error>
        where
            I: IntoIterator<Item = Pixel<Rgb888>>,
        {
            for Pixel(p, c) in pixels {
                if (0..64).contains(&p.x) && (0..64).contains(&p.y) {
                    self.px[(p.y * 64 + p.x) as usize] = Some(c);
                }
            }
            Ok(())
        }
    }

    fn scene(second: u8) -> PongScene {
        PongSceneConfig::default().into_frame(PongTime { hour: 21, minute: 7, second })
    }

    fn bright(c: Rgb888) -> bool {
        c == Rgb888::new(0xe6, 0xe6, 0xea)
    }

    /// Full-brightness pixels strictly between the paddle columns —
    /// i.e. the ball (digits and line render dimmer).
    fn ball_pixels(buf: &Buf) -> Vec<(i32, i32)> {
        let mut out = Vec::new();
        for y in 0..64 {
            for x in 2..62 {
                if buf.get(x, y).is_some_and(bright) {
                    out.push((x, y));
                }
            }
        }
        out
    }

    #[test]
    fn deterministic() {
        let (mut a, mut b) = (Buf::new(), Buf::new());
        render(&scene(30), 123_456, &mut a).unwrap();
        render(&scene(30), 123_456, &mut b).unwrap();
        assert_eq!(a.px, b.px);
    }

    #[test]
    fn rally_has_ball_in_court() {
        for step in [0_usize, 100, 5000, (1 << 25) + 17] {
            let mut buf = Buf::new();
            render(&scene(30), step, &mut buf).unwrap();
            let ball = ball_pixels(&buf);
            assert_eq!(ball.len(), 4, "2x2 ball expected at step {step}");
            for (_, y) in ball {
                assert!(y >= 10, "ball must stay below the score row");
            }
        }
    }

    #[test]
    fn ball_meets_left_paddle_at_even_crossings() {
        // speed=1.0 → half_steps = 210; u = 2 exactly at step 420.
        let mut buf = Buf::new();
        render(&scene(30), 420, &mut buf).unwrap();
        let ball = ball_pixels(&buf);
        assert!(ball.iter().all(|&(x, _)| x == 2 || x == 3), "ball at left plane: {ball:?}");
        // Paddle column 1 must cover every ball row.
        for &(_, y) in &ball {
            assert!(buf.get(1, y).is_some_and(bright), "paddle misses ball row {y}");
        }
    }

    #[test]
    fn minute_rollover_blanks_then_reserves() {
        // Second 1: ball is out — no full-brightness pixels mid-court.
        let mut buf = Buf::new();
        render(&scene(1), 999, &mut buf).unwrap();
        assert!(ball_pixels(&buf).is_empty(), "no ball during the post-miss blank");
        // Second 2 re-serves identically to the honest rally branch.
        let (mut s2, mut s30) = (Buf::new(), Buf::new());
        render(&scene(2), 999, &mut s2).unwrap();
        render(&scene(30), 999, &mut s30).unwrap();
        assert_eq!(s2.px, s30.px, "second 2 must already rally (seamless hand-off)");
    }

    #[test]
    fn miss_second_dodges_receiving_paddle() {
        // Early in the exit burst the ball is still on-court and the
        // right paddle must not cover its rows.
        let mut buf = Buf::new();
        render(&scene(0), 6, &mut buf).unwrap(); // step%60 small → ball mid-court
        let ball = ball_pixels(&buf);
        assert_eq!(ball.len(), 4, "ball visible at exit start");
        for &(_, y) in &ball {
            assert!(
                !buf.get(62, y).is_some_and(bright),
                "right paddle must be wrong-footed off row {y}"
            );
        }
    }

    #[test]
    fn nan_speed_falls_back() {
        let mut cfg = scene(30);
        cfg.speed = f32::NAN;
        let mut buf = Buf::new();
        render(&cfg, 777, &mut buf).unwrap();
        assert_eq!(ball_pixels(&buf).len(), 4);
    }
}
