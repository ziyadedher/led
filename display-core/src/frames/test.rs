//! Test patterns. Useful for diagnosing matrix wiring, dead pixels,
//! brightness ramps, and moiré (chromatic aberration on cheap
//! panels). Selectable via `pattern`; renderer is pure pixel math,
//! no font / no animation.

use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    primitives::{PrimitiveStyleBuilder, Rectangle},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub enum TestPattern {
    /// 8 vertical bars: black, R, G, B, yellow, cyan, magenta, white.
    /// White corner pixels mark (0,0), (W-1,0), (0,H-1), (W-1,H-1) for
    /// geometry verification.
    #[default]
    ColorBars,
    /// Horizontal R/G/B gradients (top third, middle, bottom third)
    /// from black to fully saturated. Reveals dead bits in the PWM
    /// chain and uneven channel response.
    Gradient,
    /// 1×1 checkerboard. White squares at every other (x+y) position.
    /// Surfaces row-driver shadows and moiré with the camera grid.
    Checkerboard,
}

#[derive(Clone, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub struct TestScene {
    #[serde(default)]
    pub pattern: TestPattern,
}

#[allow(clippy::cast_possible_wrap)]
pub fn render<D>(frame: &TestScene, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let size = canvas.size();
    let w = size.width as i32;
    let h = size.height as i32;

    match frame.pattern {
        TestPattern::ColorBars => render_color_bars(canvas, w, h)?,
        TestPattern::Gradient => render_gradient(canvas, w, h)?,
        TestPattern::Checkerboard => render_checkerboard(canvas, w, h)?,
    }
    Ok(())
}

#[allow(clippy::cast_sign_loss)]
fn render_color_bars<D>(canvas: &mut D, w: i32, h: i32) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    // 8 bars; the first is black so anyone glancing at the panel
    // immediately sees if the "off" state is leaking.
    const BARS: [Rgb888; 8] = [
        Rgb888::BLACK,
        Rgb888::RED,
        Rgb888::GREEN,
        Rgb888::BLUE,
        Rgb888::YELLOW,
        Rgb888::CYAN,
        Rgb888::MAGENTA,
        Rgb888::WHITE,
    ];
    let bar_w = w / 8;
    for (i, color) in BARS.iter().enumerate() {
        let x = (i as i32) * bar_w;
        let width = if i == BARS.len() - 1 { w - x } else { bar_w };
        Rectangle::new(Point::new(x, 0), Size::new(width as u32, h as u32))
            .into_styled(PrimitiveStyleBuilder::new().fill_color(*color).build())
            .draw(canvas)?;
    }
    // Corner crosshair pixels — overrides the color bar at each corner.
    let corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)];
    for (x, y) in corners {
        Rectangle::new(Point::new(x, y), Size::new(1, 1))
            .into_styled(
                PrimitiveStyleBuilder::new()
                    .fill_color(Rgb888::WHITE)
                    .build(),
            )
            .draw(canvas)?;
    }
    Ok(())
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_sign_loss)]
fn render_gradient<D>(canvas: &mut D, w: i32, h: i32) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    // Top third red, middle green, bottom blue. Each scaled 0..255
    // across x so brightness/PWM steps are visible.
    let band = h / 3;
    for y in 0..h {
        let channel = if y < band {
            0
        } else if y < band * 2 {
            1
        } else {
            2
        };
        for x in 0..w {
            let value = ((x * 255) / (w - 1).max(1)).min(255) as u8;
            let color = match channel {
                0 => Rgb888::new(value, 0, 0),
                1 => Rgb888::new(0, value, 0),
                _ => Rgb888::new(0, 0, value),
            };
            Rectangle::new(Point::new(x, y), Size::new(1, 1))
                .into_styled(PrimitiveStyleBuilder::new().fill_color(color).build())
                .draw(canvas)?;
        }
    }
    Ok(())
}

fn render_checkerboard<D>(canvas: &mut D, w: i32, h: i32) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    for y in 0..h {
        for x in 0..w {
            if (x + y) % 2 == 0 {
                Rectangle::new(Point::new(x, y), Size::new(1, 1))
                    .into_styled(
                        PrimitiveStyleBuilder::new()
                            .fill_color(Rgb888::WHITE)
                            .build(),
                    )
                    .draw(canvas)?;
            }
        }
    }
    Ok(())
}
