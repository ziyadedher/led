//! Setup mode. Shown by the driver while wifi-setup is running its
//! AP + captive portal — gives the user something to do while the
//! Pi waits for credentials. Renders the AP SSID and the portal URL
//! so they can join from a phone without already knowing them.

use embedded_graphics::{
    mono_font::{ascii::FONT_5X8, MonoTextStyleBuilder},
    pixelcolor::Rgb888,
    prelude::*,
    text::Text,
};
use serde::{Deserialize, Serialize};

use crate::text::Rgb;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SetupFrame {
    pub color: Rgb,
    pub ssid: String,
    pub portal_url: String,
}

impl Default for SetupFrame {
    fn default() -> Self {
        Self {
            color: Rgb {
                r: 0xff,
                g: 0xb8,
                b: 0x4d,
            },
            ssid: String::new(),
            portal_url: "10.42.0.1".to_string(),
        }
    }
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
pub fn render<D>(frame: &SetupFrame, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let font = FONT_5X8;
    let canvas_w = canvas.size().width as i32;
    let glyph_w = (font.character_size.width + font.character_spacing) as i32;
    let line_pitch = font.character_size.height as i32 + 1;

    // Lines stack from the top with one row of vertical padding.
    // Layout:
    //   row 1 (y=8):  WIFI SETUP   (header, accent color)
    //   row 3 (y=26): JOIN AP:
    //   row 4 (y=35): <SSID — marquees if it doesn't fit>
    //   row 6 (y=53): GO TO:
    //   row 7 (y=62): <PORTAL URL>
    let style_accent = MonoTextStyleBuilder::new()
        .font(&font)
        .text_color(frame.color.clone().into())
        .build();
    let style_dim = MonoTextStyleBuilder::new()
        .font(&font)
        .text_color(Rgb888::new(0x80, 0x80, 0x80))
        .build();

    // Row 1: WIFI SETUP, centered.
    let header = "WIFI SETUP";
    let header_w = header.len() as i32 * glyph_w;
    Text::new(
        header,
        Point::new((canvas_w - header_w) / 2, line_pitch),
        style_accent,
    )
    .draw(canvas)?;

    // Row 3: JOIN AP: (left-aligned, dim)
    let label_a = "JOIN AP:";
    Text::new(label_a, Point::new(1, line_pitch * 3), style_dim).draw(canvas)?;

    // Row 4: SSID. If wider than the canvas, marquee it with the
    // same offset math the text mode uses.
    draw_scrolling(
        canvas,
        &frame.ssid,
        line_pitch * 4,
        canvas_w,
        glyph_w,
        step,
        style_accent,
    )?;

    // Row 6: GO TO:
    let label_b = "GO TO:";
    Text::new(label_b, Point::new(1, line_pitch * 6), style_dim).draw(canvas)?;

    // Row 7: portal URL — usually short enough to fit, but marquee
    // if not (defensive).
    draw_scrolling(
        canvas,
        &frame.portal_url,
        line_pitch * 7,
        canvas_w,
        glyph_w,
        step,
        style_accent,
    )?;

    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_possible_truncation)]
fn draw_scrolling<D>(
    canvas: &mut D,
    text: &str,
    y: i32,
    canvas_w: i32,
    glyph_w: i32,
    step: usize,
    style: embedded_graphics::mono_font::MonoTextStyle<'_, Rgb888>,
) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888>,
{
    let text_w = text.chars().count() as i32 * glyph_w;
    if text_w <= canvas_w {
        let x = (canvas_w - text_w) / 2;
        Text::new(text, Point::new(x, y), style).draw(canvas)?;
        return Ok(());
    }
    // Marquee: 1px every 4 frames, looping with canvas-width gap.
    let cycle = text_w + canvas_w;
    let raw = ((step as i32) / 4) % cycle;
    let x = if raw < text_w { -raw } else { -raw + cycle };
    Text::new(text, Point::new(x, y), style).draw(canvas)?;
    Ok(())
}
