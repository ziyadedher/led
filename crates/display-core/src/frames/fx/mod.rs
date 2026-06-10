//! Demoscene effect pack — ten classic 2D effects behind one mode
//! with a shared (effect, palette, speed) config. Effects live in
//! `classic` (raster-era) and `flow` (field/fractal era); all are
//! pure functions of (scene, step).

pub mod classic;
pub mod flow;

use embedded_graphics::{pixelcolor::Rgb888, prelude::*};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub enum FxEffect {
    #[default]
    Tunnel,
    Rotozoom,
    Twister,
    Copper,
    Moire,
    Kefrens,
    Julia,
    Chladni,
    Aurora,
    BlackHole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub enum FxPalette {
    #[default]
    Ember,
    Phosphor,
    Aurora,
    Rainbow,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FxScene {
    #[serde(default)]
    pub effect: FxEffect,
    #[serde(default)]
    pub palette: FxPalette,
    /// Animation rate. Clamped [0.05, 8].
    #[serde(default = "d_speed")]
    pub speed: f32,
}

fn d_speed() -> f32 { 1.0 }

impl Default for FxScene {
    fn default() -> Self {
        Self { effect: FxEffect::Tunnel, palette: FxPalette::Ember, speed: d_speed() }
    }
}

/// 256-entry RGB lookup for an FxPalette, built from gradient stops.
/// Cheap enough to rebuild per frame (256 integer lerps).
#[must_use]
pub(crate) fn palette_lut(p: FxPalette) -> [[u8; 3]; 256] {
    const fn stop(pos: u8, c: [u8; 3]) -> (u8, [u8; 3]) {
        (pos, c)
    }
    let stops: &[(u8, [u8; 3])] = match p {
        FxPalette::Ember => &[
            stop(0, [0, 0, 0]),
            stop(96, [150, 22, 2]),
            stop(192, [255, 138, 44]),
            stop(255, [255, 220, 180]),
        ],
        FxPalette::Phosphor => &[
            stop(0, [0, 0, 0]),
            stop(96, [10, 130, 55]),
            stop(192, [93, 255, 169]),
            stop(255, [226, 255, 240]),
        ],
        FxPalette::Aurora => &[
            stop(0, [2, 3, 14]),
            stop(80, [8, 28, 96]),
            stop(160, [18, 180, 170]),
            stop(255, [140, 92, 230]),
        ],
        FxPalette::Rainbow => &[
            stop(0, [255, 0, 0]),
            stop(43, [255, 255, 0]),
            stop(85, [0, 255, 0]),
            stop(128, [0, 255, 255]),
            stop(170, [0, 0, 255]),
            stop(213, [255, 0, 255]),
            stop(255, [255, 0, 0]),
        ],
    };
    let mut lut = [[0u8; 3]; 256];
    let mut si = 0;
    for (i, slot) in lut.iter_mut().enumerate() {
        #[allow(clippy::cast_possible_truncation)]
        let i = i as u16;
        while si + 1 < stops.len() && u16::from(stops[si + 1].0) < i {
            si += 1;
        }
        let (p0, c0) = stops[si];
        let (p1, c1) = stops[(si + 1).min(stops.len() - 1)];
        let span = u16::from(p1).saturating_sub(u16::from(p0)).max(1);
        let t = i.saturating_sub(u16::from(p0)).min(span);
        let mut c = [0u8; 3];
        for ch in 0..3 {
            let a = u16::from(c0[ch]);
            let b = u16::from(c1[ch]);
            c[ch] = (a + (b.saturating_sub(a) * t / span))
                .saturating_sub(if b < a { (a - b) * t / span } else { 0 })
                .min(255) as u8;
        }
        *slot = c;
    }
    lut
}

pub fn render<D>(scene: &FxScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    match scene.effect {
        FxEffect::Rotozoom => classic::rotozoom(scene, step, canvas),
        FxEffect::Twister => classic::twister(scene, step, canvas),
        FxEffect::Copper => classic::copper(scene, step, canvas),
        FxEffect::Moire => classic::moire(scene, step, canvas),
        FxEffect::Kefrens => classic::kefrens(scene, step, canvas),
        FxEffect::Tunnel => flow::tunnel(scene, step, canvas),
        FxEffect::Julia => flow::julia(scene, step, canvas),
        FxEffect::Chladni => flow::chladni(scene, step, canvas),
        FxEffect::Aurora => flow::aurora(scene, step, canvas),
        FxEffect::BlackHole => flow::black_hole(scene, step, canvas),
    }
}
