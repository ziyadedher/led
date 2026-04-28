//! WASM glue around `display-core`. Browser side calls
//! [`Renderer::tick`] each rAF; the JS side reads RGBA bytes out of
//! [`Renderer::buffer`] and paints them to a 64×64 ImageData.

use display_core::{Scene, render};
use embedded_graphics::{
    pixelcolor::Rgb888, prelude::*, draw_target::DrawTarget, geometry::Size,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct Renderer {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    scene: Scene,
    step: usize,
}

#[wasm_bindgen]
impl Renderer {
    /// Create a renderer for a `width × height` matrix. Sized to match
    /// the panel (default 64×64).
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32) -> Renderer {
        Renderer {
            width,
            height,
            pixels: vec![0; (width * height * 4) as usize],
            scene: Scene::default(),
            step: 0,
        }
    }

    /// Replace the renderable state (entries + panel scroll/pause/flash).
    /// Pass a JSON string; we parse here so the JS shape is whatever
    /// `serde` accepts on `Scene`.
    #[wasm_bindgen(js_name = setSceneJson)]
    pub fn set_scene_json(&mut self, json: &str) -> Result<(), JsError> {
        self.scene =
            serde_json::from_str(json).map_err(|e| JsError::new(&format!("frame parse: {e}")))?;
        Ok(())
    }

    /// Render the current frame at the current step into the pixel
    /// buffer, advance step (unless paused), and return the RGBA bytes.
    /// JS wraps the result as a Uint8ClampedArray and feeds it to
    /// ImageData. wasm-bindgen copies the bytes once on return — for
    /// 64×64×4 = 16KiB at rAF that's negligible.
    pub fn tick(&mut self) -> Result<Vec<u8>, JsError> {
        let mut target = PixelBuffer {
            width: self.width,
            height: self.height,
            pixels: &mut self.pixels,
        };
        render(&self.scene, self.step, &mut target).map_err(|_| JsError::new("render error"))?;
        if !self.scene.panel.is_paused {
            self.step = self.step.wrapping_add(1);
        }
        Ok(self.pixels.clone())
    }

    /// Reset the step counter so animations restart deterministically.
    pub fn reset(&mut self) {
        self.step = 0;
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }
}

struct PixelBuffer<'a> {
    width: u32,
    height: u32,
    pixels: &'a mut [u8],
}

impl DrawTarget for PixelBuffer<'_> {
    type Color = Rgb888;
    type Error = core::convert::Infallible;

    fn draw_iter<I>(&mut self, pixels: I) -> Result<(), Self::Error>
    where
        I: IntoIterator<Item = embedded_graphics::Pixel<Self::Color>>,
    {
        let w = self.width as i32;
        let h = self.height as i32;
        for embedded_graphics::Pixel(pt, color) in pixels {
            if pt.x < 0 || pt.y < 0 || pt.x >= w || pt.y >= h {
                continue;
            }
            let idx = ((pt.y as u32 * self.width + pt.x as u32) * 4) as usize;
            self.pixels[idx] = color.r();
            self.pixels[idx + 1] = color.g();
            self.pixels[idx + 2] = color.b();
            self.pixels[idx + 3] = 255;
        }
        Ok(())
    }
}

impl embedded_graphics::geometry::OriginDimensions for PixelBuffer<'_> {
    fn size(&self) -> Size {
        Size::new(self.width, self.height)
    }
}
