//! Static image mode. The dash uploads/pastes an image, downsamples
//! it to fit the panel, and stores raw RGB bytes in mode_config.
//! Renderer just blits the bitmap into the canvas, centered.
//!
//! No animation — for moving images, use the `gif` mode.

use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    Pixel,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ImageScene {
    pub width: u32,
    pub height: u32,
    /// RGB bytes, row-major. Length must be exactly 3 * width * height.
    /// Pure black (0, 0, 0) is rendered as "leave canvas pixel unset"
    /// — this is what we want for transparent margins around centered
    /// images and is the convention the gif decoder also uses.
    pub bitmap: Vec<u8>,
}

impl Default for ImageScene {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            bitmap: Vec::new(),
        }
    }
}

#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_possible_truncation)]
pub fn render<D>(frame: &ImageScene, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    if frame.width == 0 || frame.height == 0 {
        return Ok(());
    }
    let expected = (frame.width as usize) * (frame.height as usize) * 3;
    if frame.bitmap.len() < expected {
        return Ok(());
    }

    let canvas_size = canvas.size();
    let cw = canvas_size.width as i32;
    let ch = canvas_size.height as i32;
    let iw = frame.width as i32;
    let ih = frame.height as i32;
    let ox = (cw - iw) / 2;
    let oy = (ch - ih) / 2;
    let stride = (frame.width as usize) * 3;

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
