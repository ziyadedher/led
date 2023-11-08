use std::sync::{Arc, Mutex};

use anyhow::Context;
use embedded_graphics::{
    mono_font::{ascii, MonoTextStyleBuilder},
    pixelcolor::Rgb888,
    prelude::*,
    text::Text,
};
use rpi_led_panel::{RGBMatrix, RGBMatrixConfig};

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
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

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct RainbowOptions {
    pub is_per_letter: bool,
    pub speed: u32,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub enum TextEntryColor {
    Rgb(Rgb),
    Rainbow(RainbowOptions),
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct MarqueeOptions {
    pub speed: u32,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct TextEntryOptions {
    pub color: TextEntryColor,
    pub marquee: MarqueeOptions,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct TextEntry {
    pub text: String,
    pub options: TextEntryOptions,
}

#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
pub struct State {
    pub entries: Vec<TextEntry>,
    /// The number of lines to scroll the display by. In practice, this is the index of the first entry that will be displayed.
    pub scroll: i32,
    pub is_paused: bool,
}

pub async fn drive_display(state: Arc<Mutex<State>>) -> anyhow::Result<()> {
    let config: RGBMatrixConfig = argh::from_env();

    let (mut matrix, mut canvas) =
        RGBMatrix::new(config, 0).context("Matrix initialization failed")?;

    let font = ascii::FONT_5X8;

    let mut step: usize = 0;
    for _ in 0.. {
        // We clone the state here so we can get rid of the lock as soon as possible.
        let state = state.lock().unwrap().clone();

        canvas.clear(Rgb888::BLACK)?;

        for (i, entry) in state.entries.iter().enumerate() {
            let marquee_offset = if entry.options.marquee.speed > 0 {
                let text_size: i32 = entry.text.len() as i32
                    * (font.character_size.width + font.character_spacing) as i32;
                let marquee_offset = (step as i32 * entry.options.marquee.speed as i32 / 10)
                    % (text_size + canvas.width() as i32);
                if marquee_offset < text_size {
                    -marquee_offset
                } else {
                    -marquee_offset + canvas.width() as i32 + text_size
                }
            } else {
                0
            };

            let line_offset =
                (i as i32 + 1 - state.scroll) * (font.character_size.height as i32 + 1) - 1;

            match entry.options.color {
                TextEntryColor::Rgb(ref rgb) => {
                    let text = Text::new(
                        &entry.text,
                        Point::new(marquee_offset, line_offset),
                        MonoTextStyleBuilder::new()
                            .font(&font)
                            .text_color(rgb.clone().into())
                            .build(),
                    );
                    text.draw(canvas.as_mut())?;
                }
                TextEntryColor::Rainbow(RainbowOptions {
                    is_per_letter: true,
                    speed,
                }) => {
                    for (j, c) in entry.text.chars().enumerate() {
                        let char = c.to_string();
                        let char_offset = j as i32
                            * (font.character_size.width as i32 + font.character_spacing as i32);
                        let rgb_progress =
                            (((255 * 3) as f64 * (j as f64 / entry.text.len() as f64)) as usize
                                + ((step * speed as usize / 10) % (255 * 3)))
                                % (255 * 3);
                        let rgb = if rgb_progress < 255 {
                            Rgb888::new((255 - rgb_progress) as u8, rgb_progress as u8, 0)
                        } else if rgb_progress < 255 * 2 {
                            Rgb888::new(
                                0,
                                (255 - (rgb_progress - 255)) as u8,
                                (rgb_progress - 255) as u8,
                            )
                        } else {
                            Rgb888::new(
                                (rgb_progress - 255 * 2) as u8,
                                0,
                                (255 - (rgb_progress - 255 * 2)) as u8,
                            )
                        };

                        let text = Text::new(
                            &char,
                            Point::new(marquee_offset + char_offset, line_offset),
                            MonoTextStyleBuilder::new()
                                .font(&font)
                                .text_color(rgb)
                                .build(),
                        );
                        text.draw(canvas.as_mut())?;
                    }
                }
                TextEntryColor::Rainbow(RainbowOptions {
                    is_per_letter: false,
                    speed,
                }) => {
                    let rgb_progress = (step * speed as usize / 10) % (255 * 3);
                    let rgb = if rgb_progress < 255 {
                        Rgb888::new((255 - rgb_progress) as u8, rgb_progress as u8, 0)
                    } else if rgb_progress < 255 * 2 {
                        Rgb888::new(
                            0,
                            (255 - (rgb_progress - 255)) as u8,
                            (rgb_progress - 255) as u8,
                        )
                    } else {
                        Rgb888::new(
                            (rgb_progress - 255 * 2) as u8,
                            0,
                            (255 - (rgb_progress - 255 * 2)) as u8,
                        )
                    };

                    let text = Text::new(
                        &entry.text,
                        Point::new(marquee_offset, line_offset),
                        MonoTextStyleBuilder::new()
                            .font(&font)
                            .text_color(rgb)
                            .build(),
                    );
                    text.draw(canvas.as_mut())?;
                }
            }
        }

        canvas = matrix.update_on_vsync(canvas);

        if !state.is_paused {
            step += 1;
        }
    }

    Ok(())
}
