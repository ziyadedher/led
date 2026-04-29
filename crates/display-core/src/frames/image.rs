//! Static image mode. The dash uploads/pastes an image, downsamples
//! it to fit the panel, and stores RGBA bytes in mode_config.
//! Renderer blits the opaque (alpha != 0) pixels into the canvas,
//! centered. Animated input → gif mode.

use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    Pixel,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ImageScene {
    pub width: u32,
    pub height: u32,
    /// RGBA bytes, row-major. Length must be exactly `4 * width * height`.
    /// Alpha is treated as binary on the LED panel: `0` = leave the
    /// canvas pixel unset, anything else = render at full intensity
    /// (the matrix has no notion of partial transparency).
    pub bitmap: Vec<u8>,
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
    let expected = (frame.width as usize) * (frame.height as usize) * 4;
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
    let stride = (frame.width as usize) * 4;

    canvas.draw_iter((0..ih).flat_map(|y| {
        let bitmap = &frame.bitmap;
        (0..iw).filter_map(move |x| {
            let idx = (y as usize) * stride + (x as usize) * 4;
            let a = bitmap[idx + 3];
            if a == 0 {
                return None;
            }
            let cx = ox + x;
            let cy = oy + y;
            if cx < 0 || cy < 0 || cx >= cw || cy >= ch {
                return None;
            }
            Some(Pixel(
                Point::new(cx, cy),
                Rgb888::new(bitmap[idx], bitmap[idx + 1], bitmap[idx + 2]),
            ))
        })
    }))
}
