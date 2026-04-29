//! Text-sign mode. Renders an ordered list of text entries, each with
//! its own color (solid or rainbow) and optional marquee scroll.
//! Lines are stacked top-to-bottom in `panel.scroll`-shifted positions
//! so the panel can scroll through more entries than fit at once.

use embedded_graphics::{
    mono_font::{ascii::FONT_5X8, MonoTextStyle, MonoTextStyleBuilder},
    pixelcolor::Rgb888,
    prelude::*,
    text::Text,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl From<Rgb> for Rgb888 {
    fn from(rgb: Rgb) -> Self {
        Rgb888::new(rgb.r, rgb.g, rgb.b)
    }
}

#[derive(PartialEq, Eq, Clone, Debug, Deserialize, Serialize)]
pub struct RainbowOptions {
    pub is_per_letter: bool,
    pub speed: u32,
}

#[derive(PartialEq, Eq, Clone, Debug, Deserialize, Serialize)]
pub enum TextEntryColor {
    Rgb(Rgb),
    Rainbow(RainbowOptions),
}

#[derive(PartialEq, Eq, Clone, Debug, Deserialize, Serialize)]
pub struct MarqueeOptions {
    pub speed: u32,
}

#[derive(PartialEq, Eq, Clone, Debug, Deserialize, Serialize)]
pub struct TextEntryOptions {
    pub color: TextEntryColor,
    pub marquee: MarqueeOptions,
}

#[derive(PartialEq, Eq, Clone, Debug, Deserialize, Serialize)]
pub struct TextEntry {
    pub text: String,
    pub options: TextEntryOptions,
}

/// Per-frame text-mode payload.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct TextScene {
    pub entries: Vec<TextEntry>,
    /// Index of the first entry rendered at the top of the panel.
    /// Subsequent entries are stacked below; entries before this
    /// index are not drawn (they've scrolled off the top).
    #[serde(default)]
    pub scroll: i32,
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_sign_loss)]
#[allow(clippy::cast_lossless)]
#[allow(clippy::cast_precision_loss)]
pub fn render<D>(frame: &TextScene, step: usize, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let font = FONT_5X8;
    let canvas_w = canvas.size().width as i32;

    for (i, entry) in frame.entries.iter().enumerate() {
        let marquee_offset = compute_marquee_offset(entry, step, canvas_w, &font);
        let line_offset =
            (i as i32 + 1 - frame.scroll) * (font.character_size.height as i32 + 1) - 1;

        match &entry.options.color {
            TextEntryColor::Rgb(rgb) => {
                draw_text(
                    canvas,
                    &entry.text,
                    Point::new(marquee_offset, line_offset),
                    style(&font, rgb.clone().into()),
                )?;
            }
            TextEntryColor::Rainbow(RainbowOptions {
                is_per_letter: true,
                speed,
            }) => {
                for (j, c) in entry.text.chars().enumerate() {
                    let char_offset = j as i32
                        * (font.character_size.width as i32 + font.character_spacing as i32);
                    let progress = (((255 * 3) as f64
                        * (j as f64 / entry.text.chars().count().max(1) as f64))
                        as usize
                        + ((step * *speed as usize / 10) % (255 * 3)))
                        % (255 * 3);
                    let s = c.to_string();
                    draw_text(
                        canvas,
                        &s,
                        Point::new(marquee_offset + char_offset, line_offset),
                        style(&font, rainbow_color(progress)),
                    )?;
                }
            }
            TextEntryColor::Rainbow(RainbowOptions {
                is_per_letter: false,
                speed,
            }) => {
                let progress = (step * *speed as usize / 10) % (255 * 3);
                draw_text(
                    canvas,
                    &entry.text,
                    Point::new(marquee_offset, line_offset),
                    style(&font, rainbow_color(progress)),
                )?;
            }
        }
    }

    Ok(())
}

fn style<'a>(
    font: &'a embedded_graphics::mono_font::MonoFont<'a>,
    color: Rgb888,
) -> MonoTextStyle<'a, Rgb888> {
    MonoTextStyleBuilder::new()
        .font(font)
        .text_color(color)
        .build()
}

fn draw_text<D>(
    canvas: &mut D,
    text: &str,
    point: Point,
    style: MonoTextStyle<'_, Rgb888>,
) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888>,
{
    Text::new(text, point, style).draw(canvas)?;
    Ok(())
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
fn compute_marquee_offset(
    entry: &TextEntry,
    step: usize,
    canvas_w: i32,
    font: &embedded_graphics::mono_font::MonoFont<'_>,
) -> i32 {
    if entry.options.marquee.speed == 0 {
        return 0;
    }
    let text_size: i32 = entry.text.chars().count() as i32
        * (font.character_size.width + font.character_spacing) as i32;
    let raw =
        (step as i32 * entry.options.marquee.speed as i32 / 10) % (text_size + canvas_w).max(1);
    if raw < text_size {
        -raw
    } else {
        -raw + canvas_w + text_size
    }
}

#[allow(clippy::cast_possible_truncation)]
fn rainbow_color(progress: usize) -> Rgb888 {
    if progress < 255 {
        Rgb888::new((255 - progress) as u8, progress as u8, 0)
    } else if progress < 255 * 2 {
        Rgb888::new(0, (255 - (progress - 255)) as u8, (progress - 255) as u8)
    } else {
        Rgb888::new(
            (progress - 255 * 2) as u8,
            0,
            (255 - (progress - 255 * 2)) as u8,
        )
    }
}
