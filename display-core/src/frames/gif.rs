//! Animated GIF mode. The dash decodes the gif into a sequence of
//! RGB888 frames + per-frame delays at upload time and stores the
//! whole sequence in `mode_config`; the renderer just steps through
//! the sequence based on accumulated step time.
//!
//! No GIF decoder ships in the driver — that's deliberate. Decoding
//! happens once on the dash and produces an already-resized,
//! disposal-resolved frame stream, which keeps the Pi's runtime
//! cheap and avoids pulling a heavyweight image crate into a
//! release build that already runs at SCHED_FIFO with a tight
//! frame budget.

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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct GifScene {
    pub width: u32,
    pub height: u32,
    pub frames: Vec<GifFrame>,
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

    // The driver vsync ticks `step` once per ~16.67ms. Map the
    // accumulated step time into a frame index using each frame's
    // own delay; pos_ms wraps within the gif's total duration.
    let step_ms: u64 = (step as u64) * 1000 / 60;
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
