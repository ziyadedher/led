//! WASM glue around `display-core`. Browser side calls
//! [`Renderer::tick`] each rAF; tick returns RGBA bytes the JS side
//! paints onto a 64×64 ImageData.

use display_core::{render_with_sims, Scene, SimHost};
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
    /// Fractional scene steps accumulated from wall time. The scene
    /// `step` unit is a nominal 60/s (mirroring the driver's
    /// StepClock); deriving it from the rAF timestamp instead of
    /// counting callbacks keeps animation speed identical on 60Hz and
    /// 144Hz displays — and identical to the physical panel.
    step_acc: f64,
    last_ms: Option<f64>,
    /// Persistent state for simulation modes — the SAME display-core
    /// code the Pi driver runs, so the preview needs no TS reimpl.
    sims: SimHost,
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
            step_acc: 0.0,
            last_ms: None,
            sims: SimHost::default(),
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

    /// Render the current frame into the pixel buffer and return the
    /// RGBA bytes. `now_ms` is the caller's monotonic clock — pass the
    /// requestAnimationFrame timestamp (or `performance.now()`); steps
    /// advance from elapsed time unless the panel is paused/off, so
    /// animations resume exactly where they froze. JS wraps the result
    /// as a Uint8ClampedArray and feeds it to ImageData; wasm-bindgen
    /// copies the bytes once on return — 16KiB at rAF is negligible.
    #[allow(clippy::cast_possible_truncation)]
    #[allow(clippy::cast_sign_loss)]
    pub fn tick(&mut self, now_ms: f64) -> Result<Vec<u8>, JsError> {
        // Clamp gaps (hidden tab, debugger) so resuming doesn't
        // fast-forward the scene; mirrors the driver's StepClock.
        let dt = match self.last_ms {
            Some(last) => (now_ms - last).clamp(0.0, 250.0),
            None => 0.0,
        };
        self.last_ms = Some(now_ms);
        if !self.scene.panel.is_paused && !self.scene.panel.is_off {
            self.step_acc += dt * (60.0 / 1000.0);
        }
        let step = self.step_acc as usize;

        let mut target = PixelBuffer {
            width: self.width,
            height: self.height,
            pixels: &mut self.pixels,
        };
        render_with_sims(&self.scene, step, &mut self.sims, &mut target)
            .map_err(|_| JsError::new("render error"))?;
        Ok(self.pixels.clone())
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
