//! Boot mode. Shown by the driver while it's initializing — before
//! the first state pull from Supabase has resolved a panel id. Just
//! a "BOOT" wordmark with three pulsing dots so the user sees that
//! the matrix is alive even when there's nothing on the wire yet.

use embedded_graphics::{
    mono_font::{ascii::FONT_5X8, MonoTextStyleBuilder},
    pixelcolor::Rgb888,
    prelude::*,
    primitives::{PrimitiveStyleBuilder, Rectangle},
    text::Text,
};
use serde::{Deserialize, Serialize};

use crate::text::Rgb;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BootScene {
    pub color: Rgb,
}

impl Default for BootScene {
    fn default() -> Self {
        Self {
            color: Rgb {
                r: 0xff,
                g: 0x8a,
                b: 0x2c,
            },
        }
    }
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
pub fn render<D>(frame: &BootScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let font = FONT_5X8;
    let canvas_size = canvas.size();
    let cw = canvas_size.width as i32;
    let ch = canvas_size.height as i32;

    // "BOOT" wordmark, centered. 4 chars × 6px pitch = 24px.
    let text = "BOOT";
    let glyph_w = (font.character_size.width + font.character_spacing) as i32;
    let text_w = text.len() as i32 * glyph_w;
    let text_x = (cw - text_w) / 2;
    let text_y = ch / 2 - 2;

    let style = MonoTextStyleBuilder::new()
        .font(&font)
        .text_color(frame.color.into())
        .build();
    Text::new(text, Point::new(text_x, text_y), style).draw(canvas)?;

    // Three pulsing dots beneath. Each dot brightens in sequence —
    // (step / 8) % 3 decides which one is "now" lit; the others fade.
    let dot_y = text_y + 6;
    let dot_pitch = 6;
    let dots_w = 3 * dot_pitch;
    let dots_x = (cw - dots_w) / 2 + 1;
    let active = (step / 8) % 3;

    for (i, dot) in (0..3).enumerate() {
        let intensity = if i == active { 1.0 } else { 0.18 };
        let r = (frame.color.r as f32 * intensity) as u8;
        let g = (frame.color.g as f32 * intensity) as u8;
        let b = (frame.color.b as f32 * intensity) as u8;
        let style = PrimitiveStyleBuilder::new()
            .fill_color(Rgb888::new(r, g, b))
            .build();
        Rectangle::new(
            Point::new(dots_x + dot * dot_pitch, dot_y),
            Size::new(2, 2),
        )
        .into_styled(style)
        .draw(canvas)?;
    }

    Ok(())
}
