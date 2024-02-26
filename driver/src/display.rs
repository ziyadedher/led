use std::sync::Arc;

use anyhow::Context;
use embedded_graphics::{
    mono_font::{ascii, MonoTextStyleBuilder},
    pixelcolor::Rgb888,
    prelude::*,
    text::Text,
};
use rpi_led_panel::{RGBMatrix, RGBMatrixConfig};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::state::State;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RainbowOptions {
    pub is_per_letter: bool,
    pub speed: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum TextEntryColor {
    Rgb(Rgb),
    Rainbow(RainbowOptions),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MarqueeOptions {
    pub speed: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TextEntryOptions {
    pub color: TextEntryColor,
    pub marquee: MarqueeOptions,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TextEntry {
    pub text: String,
    pub options: TextEntryOptions,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct FlashState {
    /// True if and only if the display is currently flashing.
    pub is_active: bool,
    /// Number of steps to flash on for before turning off.
    pub on_steps: usize,
    /// Total number of steps a flash cycle lasts.
    pub total_steps: usize,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Panel {
    /// Number of lines to scroll the display by. In practice, this is the index of the first entry that will be
    /// displayed.
    pub scroll: i32,
    /// True if and only if the display has all effects paused (e.g. marquee and rainbow).
    pub is_paused: bool,
    pub flash: FlashState,
}

#[allow(clippy::too_many_lines)]
#[allow(clippy::cast_possible_truncation)]
#[allow(clippy::cast_possible_wrap)]
#[allow(clippy::cast_sign_loss)]
#[allow(clippy::cast_lossless)]
#[allow(clippy::cast_precision_loss)]
#[tracing::instrument]
pub async fn drive(config: RGBMatrixConfig, state: Arc<RwLock<State>>) -> anyhow::Result<()> {
    log::info!("Initializing display...");
    let (mut matrix, canvas) = RGBMatrix::new(config, 0).context("Matrix initialization failed")?;

    let font = ascii::FONT_5X8;

    let mut step: usize = 0;
    loop {
        log::debug!("Starting display loop iteration...");
        let state = state.read().await;
        let mut canvas = canvas.clone();

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
                (i as i32 + 1 - state.panel.scroll) * (font.character_size.height as i32 + 1) - 1;

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

        // We have `!state.is_paused` here even though time (step) doesn't move forward when paused since we might
        // end up in a situation where we are at a "step duration boundary" and we don't want the display to, when
        // paused, end up in a pure white state.
        if state.panel.flash.is_active && !state.panel.is_paused {
            let flash_progress = step % state.panel.flash.total_steps;
            let flash_on = flash_progress < state.panel.flash.on_steps;
            if flash_on {
                canvas.fill(255, 255, 255);
            }
        }

        if !state.panel.is_paused {
            step += 1;
        }

        matrix.update_on_vsync(canvas);
    }
}
