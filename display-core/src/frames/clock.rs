//! Clock mode. Renders the current time, centered on the panel.
//!
//! Time is supplied by the caller every frame so the renderer stays
//! pure (no system-clock access from inside display-core). The Pi
//! driver passes `chrono::Local::now()`; the WASM simulator passes
//! `new Date()`.

use embedded_graphics::{
    mono_font::{ascii::FONT_5X8, MonoTextStyleBuilder},
    pixelcolor::Rgb888,
    prelude::*,
    text::Text,
};
use serde::{Deserialize, Serialize};

use crate::text::Rgb;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub enum ClockFormat {
    #[default]
    H24,
    H12,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Deserialize, Serialize)]
pub struct ClockTime {
    pub hour: u8,   // 0..23
    pub minute: u8, // 0..59
    pub second: u8, // 0..59
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct ClockFrame {
    /// 12h or 24h.
    #[serde(default)]
    pub format: ClockFormat,
    /// Render `HH:MM:SS` instead of `HH:MM`.
    #[serde(default)]
    pub show_seconds: bool,
    /// Render color.
    pub color: Rgb,
    /// Current time. Caller fills this each frame.
    pub now: ClockTime,
    /// Optional 12h marker shown after the time. Not rendered when
    /// `format` is H24.
    #[serde(default)]
    pub show_meridiem: bool,
}

impl Default for ClockFrame {
    fn default() -> Self {
        Self {
            format: ClockFormat::H24,
            show_seconds: false,
            color: Rgb {
                r: 0xff,
                g: 0x8a,
                b: 0x2c,
            },
            now: ClockTime::default(),
            show_meridiem: false,
        }
    }
}

#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
pub fn render<D>(frame: &ClockFrame, canvas: &mut D) -> Result<(), D::Error>
where
    D: DrawTarget<Color = Rgb888> + OriginDimensions,
{
    let font = FONT_5X8;
    let canvas_size = canvas.size();
    let canvas_w = canvas_size.width as i32;
    let canvas_h = canvas_size.height as i32;

    let text = format_time(frame);
    let chars = text.chars().count() as i32;
    let glyph_w = (font.character_size.width + font.character_spacing) as i32;
    let glyph_h = font.character_size.height as i32;
    let text_w = chars * glyph_w;

    let x = (canvas_w - text_w) / 2;
    // embedded_graphics Text positions at the baseline (Alphabetic by
    // default), which sits at glyph_h - 1. Center vertically with that.
    let y = (canvas_h + glyph_h) / 2 - 1;

    let style = MonoTextStyleBuilder::new()
        .font(&font)
        .text_color(frame.color.clone().into())
        .build();
    Text::new(&text, Point::new(x, y), style).draw(canvas)?;
    Ok(())
}

fn format_time(frame: &ClockFrame) -> String {
    let (h, m, s) = (frame.now.hour, frame.now.minute, frame.now.second);
    match frame.format {
        ClockFormat::H24 => {
            if frame.show_seconds {
                format!("{h:02}:{m:02}:{s:02}")
            } else {
                format!("{h:02}:{m:02}")
            }
        }
        ClockFormat::H12 => {
            let (display_h, am) = match h {
                0 => (12, true),
                1..=11 => (h, true),
                12 => (12, false),
                _ => (h - 12, false),
            };
            let suffix = if frame.show_meridiem {
                if am {
                    "A"
                } else {
                    "P"
                }
            } else {
                ""
            };
            if frame.show_seconds {
                format!("{display_h}:{m:02}:{s:02}{suffix}")
            } else {
                format!("{display_h}:{m:02}{suffix}")
            }
        }
    }
}
