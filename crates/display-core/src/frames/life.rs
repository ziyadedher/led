//! Conway's Game of Life. Pure ambient — no entries, just a seed
//! and a tick rate. Reseeds when the simulation goes extinct or
//! settles into a still life / period-2 oscillator.
//!
//! State (the live cells) is part of `LifeScene` and stored on the
//! caller side. Driver/sim hold a `Lattice` and call `step` between
//! frames; `render` paints whatever cells are alive in the lattice.

use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    primitives::{PrimitiveStyleBuilder, Rectangle},
};
use serde::{Deserialize, Serialize};

use crate::text::Rgb;

/// 64×64 cell lattice as a flat row-major bitset (one byte per cell
/// for cache simplicity — 4KiB total, fine for the Pi).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lattice {
    pub width: u8,
    pub height: u8,
    pub cells: Vec<u8>,
}

impl Lattice {
    #[must_use]
    pub fn new(width: u8, height: u8) -> Self {
        Self {
            width,
            height,
            cells: vec![0; width as usize * height as usize],
        }
    }

    #[must_use]
    pub fn alive(&self, x: i32, y: i32) -> bool {
        let w = i32::from(self.width);
        let h = i32::from(self.height);
        if x < 0 || y < 0 || x >= w || y >= h {
            return false;
        }
        self.cells[(y as usize) * (self.width as usize) + (x as usize)] != 0
    }

    pub fn set(&mut self, x: i32, y: i32, alive: bool) {
        let w = i32::from(self.width);
        let h = i32::from(self.height);
        if x < 0 || y < 0 || x >= w || y >= h {
            return;
        }
        self.cells[(y as usize) * (self.width as usize) + (x as usize)] = u8::from(alive);
    }

    /// Live-cell count.
    #[must_use]
    pub fn population(&self) -> u32 {
        self.cells.iter().map(|c| u32::from(*c)).sum()
    }

    /// Advance one Conway tick. Returns the new lattice; doesn't
    /// mutate self (so callers can detect cycles by comparing).
    #[must_use]
    pub fn step(&self) -> Lattice {
        let w = self.width as usize;
        let h = self.height as usize;
        let mut next = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut n: u8 = 0;
                for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        if self.alive(x as i32 + dx, y as i32 + dy) {
                            n += 1;
                        }
                    }
                }
                let alive = self.alive(x as i32, y as i32);
                let next_alive = matches!((alive, n), (true, 2 | 3) | (false, 3));
                next[y * w + x] = u8::from(next_alive);
            }
        }
        Lattice {
            width: self.width,
            height: self.height,
            cells: next,
        }
    }
}

fn default_life_color() -> Rgb {
    Rgb {
        r: 0x5d,
        g: 0xff,
        b: 0xa9,
    }
}

/// Default lattice tick interval in render frames (~60 FPS render
/// loop, so 8 → ~7.5 generations/sec).
pub const DEFAULT_STEP_INTERVAL_FRAMES: u32 = 8;

fn default_step_interval_frames() -> u32 {
    DEFAULT_STEP_INTERVAL_FRAMES
}

/// Persisted shape — what the dash writes into `panels.mode_config`
/// for life-mode panels. Mirrors `LifeSceneConfig` in dash/types.ts.
/// Driver merges this with its local lattice each frame.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LifeSceneConfig {
    #[serde(default = "default_life_color")]
    pub color: Rgb,
    /// Render frames between lattice ticks. Higher = slower
    /// generations. Clamped to >= 1 by the renderer.
    #[serde(default = "default_step_interval_frames")]
    pub step_interval_frames: u32,
}

impl Default for LifeSceneConfig {
    fn default() -> Self {
        Self {
            color: default_life_color(),
            step_interval_frames: DEFAULT_STEP_INTERVAL_FRAMES,
        }
    }
}

impl LifeSceneConfig {
    /// Build a render-ready frame from this config + the caller's
    /// current lattice snapshot.
    #[must_use]
    pub fn into_frame(self, lattice: &Lattice) -> LifeScene {
        LifeScene {
            color: self.color,
            lattice_width: lattice.width,
            lattice_height: lattice.height,
            cells: lattice.cells.clone(),
        }
    }
}

/// Per-frame life-mode payload. The lattice is JSON-serialized so
/// the WASM simulator and driver share state shape; in practice the
/// driver evolves it locally and the dash never sees per-cell state.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LifeScene {
    /// Live-cell color.
    pub color: Rgb,
    /// Current lattice (caller advances between frames).
    pub lattice_width: u8,
    pub lattice_height: u8,
    pub cells: Vec<u8>,
}

impl Default for LifeScene {
    fn default() -> Self {
        Self {
            color: default_life_color(),
            lattice_width: 64,
            lattice_height: 64,
            cells: vec![0; 64 * 64],
        }
    }
}

impl From<&Lattice> for LifeScene {
    fn from(l: &Lattice) -> Self {
        Self {
            color: default_life_color(),
            lattice_width: l.width,
            lattice_height: l.height,
            cells: l.cells.clone(),
        }
    }
}

#[allow(clippy::cast_possible_wrap)]
pub fn render<D>(frame: &LifeScene, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let style = PrimitiveStyleBuilder::new()
        .fill_color(frame.color.clone().into())
        .build();
    for y in 0..frame.lattice_height {
        for x in 0..frame.lattice_width {
            let idx = usize::from(y) * usize::from(frame.lattice_width) + usize::from(x);
            if frame.cells.get(idx).copied().unwrap_or(0) == 0 {
                continue;
            }
            Rectangle::new(Point::new(i32::from(x), i32::from(y)), Size::new(1, 1))
                .into_styled(style)
                .draw(canvas)?;
        }
    }
    Ok(())
}
