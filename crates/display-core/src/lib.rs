//! Hardware-agnostic LED-matrix render core.
//!
//! Whatever ends up on the panel comes from [`render`]. The Pi driver
//! and the in-browser simulator both call into here — same code, same
//! pixels, modulo the underlying [`DrawTarget`].
//!
//! Architecture: each render mode (text, clock, image, …) lives in
//! its own module and exposes its own per-mode frame type. The
//! top-level [`Scene`] tags which mode to dispatch to and carries
//! mode-independent panel state (flash, pause).

use std::sync::Arc;

use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    primitives::{PrimitiveStyleBuilder, Rectangle},
    Pixel,
};
use serde::{Deserialize, Serialize};

pub mod frames;

pub use frames::{boot, clock, gif, image, life, setup, shapes, test, text};
pub use frames::text::{
    MarqueeOptions, RainbowOptions, Rgb, TextEntry, TextEntryColor, TextEntryOptions,
};

#[derive(PartialEq, Eq, Clone, Debug, Default, Deserialize, Serialize)]
pub struct FlashState {
    pub is_active: bool,
    pub on_steps: usize,
    pub total_steps: usize,
}

/// Mode-independent panel state. Flash + pause behave the same no
/// matter which mode is active — overlay applied after the per-mode
/// renderer runs. `is_off` short-circuits the dispatch entirely
/// (panel renders fully black) without disturbing the configured
/// mode — flipping back gives you the same scene you left.
/// `brightness` is a final 0.0–1.0 multiplier applied to every pixel.
// Not `Eq`: `brightness` is an f32.
#[derive(PartialEq, Clone, Debug, Deserialize, Serialize)]
pub struct PanelState {
    pub is_paused: bool,
    pub is_off: bool,
    pub flash: FlashState,
    /// Final brightness multiplier in [0, 1] applied to every pixel
    /// before output. 1.0 = full. Missing in older persisted scenes,
    /// so it defaults to full rather than black.
    #[serde(default = "full_brightness")]
    pub brightness: f32,
}

fn full_brightness() -> f32 {
    1.0
}

impl Default for PanelState {
    fn default() -> Self {
        Self {
            is_paused: false,
            is_off: false,
            flash: FlashState::default(),
            brightness: 1.0,
        }
    }
}

/// Tagged union over render modes. Externally-tagged so JSON looks
/// like `{ "Text": {...} }` — easy for the dash to construct
/// directly.
///
/// Image/Gif payloads are `Arc`-wrapped so the driver's per-frame
/// scene rebuild is an atomic-increment instead of a 720KB Vec
/// memcpy on cache hits. The wire format is unchanged — serde
/// transparently (de)serializes `Arc<T>` as `T`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum Mode {
    Text(text::TextScene),
    Clock(clock::ClockScene),
    Life(life::LifeScene),
    Image(Arc<image::ImageScene>),
    Gif(Arc<gif::GifScene>),
    Shapes(shapes::ShapesScene),
    Test(test::TestScene),
    Boot(boot::BootScene),
    Setup(setup::SetupScene),
}

impl Default for Mode {
    fn default() -> Self {
        Self::Text(text::TextScene::default())
    }
}

/// One frame of input — what to render plus how the panel as a whole
/// is configured (paused, flashing).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Scene {
    pub mode: Mode,
    pub panel: PanelState,
}

/// Render one frame onto `canvas`. `step` is a monotonically
/// increasing tick counter that drives any animation. The Pi driver
/// calls this once per vsync; the WASM simulator calls it once per
/// requestAnimationFrame.
pub fn render<D>(frame: &Scene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    canvas.clear(Rgb888::BLACK)?;

    if frame.panel.is_off {
        // Skip mode dispatch + flash overlay. The black canvas is the
        // entire output.
        return Ok(());
    }

    let brightness = frame.panel.brightness.clamp(0.0, 1.0);
    if brightness >= 0.999 {
        dispatch(frame, step, canvas)
    } else {
        // Render through a wrapper that scales every drawn pixel.
        // embedded-graphics' fill_*/clear default impls all route
        // through draw_iter, so this catches every mode + the flash
        // overlay without each renderer knowing about brightness.
        let mut dimmed = BrightnessTarget {
            inner: canvas,
            scale: brightness,
        };
        dispatch(frame, step, &mut dimmed)
    }
}

fn dispatch<D>(frame: &Scene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    match &frame.mode {
        Mode::Text(t) => text::render(t, step, canvas)?,
        Mode::Clock(c) => clock::render(c, canvas)?,
        Mode::Life(l) => life::render(l, canvas)?,
        Mode::Image(i) => image::render(i.as_ref(), canvas)?,
        Mode::Gif(g) => gif::render(g.as_ref(), step, canvas)?,
        Mode::Shapes(s) => shapes::render(s, step, canvas)?,
        Mode::Test(t) => test::render(t, canvas)?,
        Mode::Boot(b) => boot::render(b, step, canvas)?,
        Mode::Setup(s) => setup::render(s, step, canvas)?,
    }
    apply_flash(canvas, &frame.panel, step)?;
    Ok(())
}

/// `DrawTarget` wrapper that scales every pixel's color by `scale`
/// before forwarding to the real canvas. Used to apply the panel's
/// global brightness as a final multiply.
struct BrightnessTarget<'a, D> {
    inner: &'a mut D,
    scale: f32,
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
impl<D> DrawTarget for BrightnessTarget<'_, D>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    type Color = Rgb888;
    type Error = D::Error;

    fn draw_iter<I>(&mut self, pixels: I) -> Result<(), Self::Error>
    where
        I: IntoIterator<Item = Pixel<Rgb888>>,
    {
        let s = self.scale;
        let scale = |c: u8| (f32::from(c) * s) as u8;
        self.inner.draw_iter(
            pixels
                .into_iter()
                .map(|Pixel(p, c)| Pixel(p, Rgb888::new(scale(c.r()), scale(c.g()), scale(c.b())))),
        )
    }
}

impl<D> OriginDimensions for BrightnessTarget<'_, D>
where
    D: OriginDimensions,
{
    fn size(&self) -> Size {
        self.inner.size()
    }
}

fn apply_flash<D>(canvas: &mut D, panel: &PanelState, step: usize) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    if !panel.flash.is_active || panel.is_paused || panel.flash.total_steps == 0 {
        return Ok(());
    }
    let progress = step % panel.flash.total_steps;
    if progress >= panel.flash.on_steps {
        return Ok(());
    }
    let style = PrimitiveStyleBuilder::new()
        .fill_color(Rgb888::WHITE)
        .build();
    Rectangle::new(Point::zero(), canvas.size())
        .into_styled(style)
        .draw(canvas)?;
    Ok(())
}
