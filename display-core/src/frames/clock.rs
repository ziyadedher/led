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

/// Persisted shape — what the dash writes into `panels.mode_config`
/// for clock-mode panels. Mirrors `ClockModeConfig` in dash/types.ts.
/// Driver constructs a `ClockFrame` per render by adding `now`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct ClockConfig {
    #[serde(default)]
    pub format: ClockFormat,
    #[serde(default)]
    pub show_seconds: bool,
    #[serde(default)]
    pub show_meridiem: bool,
    /// IANA timezone (e.g. "America/Los_Angeles"). Empty/None means
    /// use the Pi's system local time (which we never explicitly
    /// configure, so it's UTC unless raspbian's tzdata default
    /// applies).
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default = "default_clock_color")]
    pub color: Rgb,
}

impl Default for ClockConfig {
    fn default() -> Self {
        Self {
            format: ClockFormat::H24,
            show_seconds: false,
            show_meridiem: false,
            timezone: None,
            color: default_clock_color(),
        }
    }
}

impl ClockConfig {
    /// Combine the persisted config with a freshly-sampled time into
    /// a render-ready `ClockFrame`.
    #[must_use]
    pub fn into_frame(self, now: ClockTime) -> ClockFrame {
        ClockFrame {
            format: self.format,
            show_seconds: self.show_seconds,
            show_meridiem: self.show_meridiem,
            color: self.color,
            now,
        }
    }
}

fn default_clock_color() -> Rgb {
    Rgb {
        r: 0xff,
        g: 0x8a,
        b: 0x2c,
    }
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
    #[serde(default = "default_clock_color")]
    pub color: Rgb,
    /// Current time. Caller fills this each frame; deserializing a
    /// stored `mode_config` (which never includes a clock value) lands
    /// the default 00:00:00 here, then the driver overwrites it
    /// before render.
    #[serde(default)]
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
            color: default_clock_color(),
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
