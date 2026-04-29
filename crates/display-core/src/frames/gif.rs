//! Animated GIF mode. Frames arrive pre-decoded and pre-resized in
//! `mode_config`; the renderer steps through them by accumulated
//! `step` time. Decoding lives on the dash to keep the Pi's render
//! loop allocation-free.

use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    Pixel,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct GifFrame {
    /// RGB888 row-major. Length must be exactly 3 * scene.width * scene.height.
    /// Pure black (0, 0, 0) renders as transparent — matches the convention
    /// used by `image` mode and gives a clean way to encode disposal regions.
    pub bitmap: Vec<u8>,
    /// Frame display duration in milliseconds. Clamped to a 20ms floor at
    /// render time so a malformed gif with delay=0 still advances.
    pub delay_ms: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GifScene {
    pub width: u32,
    pub height: u32,
    pub frames: Vec<GifFrame>,
    /// Playback rate. 1.0 = native gif speed.
    #[serde(default = "default_speed")]
    pub speed: f32,
}

fn default_speed() -> f32 {
    1.0
}

impl Default for GifScene {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            frames: Vec::new(),
            speed: 1.0,
        }
    }
}

#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_possible_truncation)]
pub fn render<D>(scene: &GifScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    if scene.frames.is_empty() || scene.width == 0 || scene.height == 0 {
        return Ok(());
    }

    // The driver vsync ticks `step` once per ~16.67ms. Scale by
    // `speed` so a 2.0 makes time advance twice as fast through the
    // timeline (frames flip at half their native delay), 0.5 doubles
    // each frame's apparent duration. Clamp to a sane range so a
    // bogus 0 or negative value can't stall or break wrap-around.
    let speed = scene.speed.clamp(0.05, 16.0);
    let step_ms: u64 = ((step as f64) * (1000.0 / 60.0) * f64::from(speed)) as u64;
    let total_ms: u64 = scene
        .frames
        .iter()
        .map(|f| f.delay_ms.max(20) as u64)
        .sum::<u64>()
        .max(1);
    let pos_ms = step_ms % total_ms;

    let mut accum: u64 = 0;
    let mut frame_idx = scene.frames.len() - 1;
    for (i, frame) in scene.frames.iter().enumerate() {
        accum += frame.delay_ms.max(20) as u64;
        if pos_ms < accum {
            frame_idx = i;
            break;
        }
    }

    let frame = &scene.frames[frame_idx];
    let expected = (scene.width as usize) * (scene.height as usize) * 3;
    if frame.bitmap.len() < expected {
        return Ok(());
    }

    let canvas_size = canvas.size();
    let cw = canvas_size.width as i32;
    let ch = canvas_size.height as i32;
    let iw = scene.width as i32;
    let ih = scene.height as i32;
    let ox = (cw - iw) / 2;
    let oy = (ch - ih) / 2;
    let stride = (scene.width as usize) * 3;

    canvas.draw_iter((0..ih).flat_map(|y| {
        let bitmap = &frame.bitmap;
        (0..iw).filter_map(move |x| {
            let idx = (y as usize) * stride + (x as usize) * 3;
            let r = bitmap[idx];
            let g = bitmap[idx + 1];
            let b = bitmap[idx + 2];
            if r == 0 && g == 0 && b == 0 {
                return None;
            }
            let cx = ox + x;
            let cy = oy + y;
            if cx < 0 || cy < 0 || cx >= cw || cy >= ch {
                return None;
            }
            Some(Pixel(Point::new(cx, cy), Rgb888::new(r, g, b)))
        })
    }))
}
