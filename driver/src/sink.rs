//! Output abstraction for the render loop.
//!
//! The display loop renders into an in-memory [`PixelBuffer`] and hands
//! it to a [`MatrixSink`] for presentation. Two implementations exist:
//!
//! * [`RpiMatrixSink`] — the real hardware backend, gated on the `rpi`
//!   cargo feature so the workspace builds on hosts without the Pi
//!   crate dependency tree.
//! * [`TerminalMatrixSink`] — ANSI 24-bit half-block renderer for
//!   `just dev`. One terminal row covers two panel rows via the `▀`
//!   glyph (foreground = top pixel, background = bottom pixel).
//!
//! Picking happens at runtime in `main.rs` based on `--terminal` and
//! the `rpi` feature.

use std::convert::Infallible;
use std::fmt::Write as _;
use std::io::{self, Write};
use std::time::{Duration, Instant};

use embedded_graphics::{
    pixelcolor::Rgb888,
    prelude::*,
    Pixel,
};
use embedded_graphics::prelude::RgbColor;

/// Row-major pixel grid that the render core paints into. Cheap to
/// allocate, implements `DrawTarget<Color = Rgb888>` so the existing
/// `display_core::render` call site doesn't change.
#[derive(Clone)]
pub struct PixelBuffer {
    width: u32,
    height: u32,
    pixels: Vec<Rgb888>,
}

impl PixelBuffer {
    #[must_use]
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![Rgb888::BLACK; (width * height) as usize],
        }
    }

    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }

    #[must_use]
    pub fn pixel(&self, x: u32, y: u32) -> Rgb888 {
        self.pixels[(y * self.width + x) as usize]
    }
}

impl DrawTarget for PixelBuffer {
    type Color = Rgb888;
    type Error = Infallible;

    fn draw_iter<I>(&mut self, pixels: I) -> Result<(), Self::Error>
    where
        I: IntoIterator<Item = Pixel<Self::Color>>,
    {
        for Pixel(point, color) in pixels {
            if point.x < 0 || point.y < 0 {
                continue;
            }
            let (x, y) = (point.x as u32, point.y as u32);
            if x >= self.width || y >= self.height {
                continue;
            }
            self.pixels[(y * self.width + x) as usize] = color;
        }
        Ok(())
    }

    fn clear(&mut self, color: Self::Color) -> Result<(), Self::Error> {
        self.pixels.fill(color);
        Ok(())
    }
}

impl OriginDimensions for PixelBuffer {
    fn size(&self) -> Size {
        Size::new(self.width, self.height)
    }
}

/// Where rendered frames go. Implementations decide what "present"
/// means: vsync flip on the Pi, ANSI repaint in the terminal, …
pub trait MatrixSink: Send {
    fn dimensions(&self) -> (u32, u32);
    fn present(&mut self, buffer: &PixelBuffer) -> anyhow::Result<()>;
}

#[cfg(feature = "rpi")]
mod rpi {
    use super::{MatrixSink, PixelBuffer};
    use anyhow::Context;
    use embedded_graphics::prelude::RgbColor;
    use rpi_led_panel::{Canvas, RGBMatrix, RGBMatrixConfig};
    use tokio::task::block_in_place;

    pub struct RpiMatrixSink {
        matrix: RGBMatrix,
        canvas: Option<Box<Canvas>>,
    }

    impl RpiMatrixSink {
        pub fn new(config: RGBMatrixConfig) -> anyhow::Result<Self> {
            let (matrix, canvas) =
                RGBMatrix::new(config, 0).context("Matrix initialization failed")?;
            Ok(Self {
                matrix,
                canvas: Some(canvas),
            })
        }
    }

    impl MatrixSink for RpiMatrixSink {
        fn dimensions(&self) -> (u32, u32) {
            let canvas = self.canvas.as_ref().expect("canvas absent between frames");
            (canvas.width() as u32, canvas.height() as u32)
        }

        fn present(&mut self, buffer: &PixelBuffer) -> anyhow::Result<()> {
            let mut canvas = self
                .canvas
                .take()
                .expect("canvas absent between frames");
            let w = buffer.width();
            let h = buffer.height();
            for y in 0..h {
                for x in 0..w {
                    let p = buffer.pixel(x, y);
                    canvas.set_pixel(x as usize, y as usize, p.r(), p.g(), p.b());
                }
            }
            let next = block_in_place(|| self.matrix.update_on_vsync(canvas));
            self.canvas = Some(next);
            Ok(())
        }
    }
}

#[cfg(feature = "rpi")]
pub use rpi::RpiMatrixSink;

/// ANSI half-block renderer for `just dev`. Each terminal row prints
/// the `▀` glyph for two vertical panel pixels — foreground for the
/// top, background for the bottom. We re-home the cursor each frame
/// rather than clearing the screen to avoid flicker.
pub struct TerminalMatrixSink {
    width: u32,
    height: u32,
    target_period: Duration,
    last_present: Instant,
    initialized: bool,
    out: io::BufWriter<io::Stdout>,
}

impl TerminalMatrixSink {
    pub fn new(width: u32, height: u32, target_fps: f32) -> Self {
        Self {
            width,
            height,
            target_period: Duration::from_secs_f32(1.0 / target_fps.max(1.0)),
            last_present: Instant::now() - Duration::from_secs(1),
            initialized: false,
            out: io::BufWriter::new(io::stdout()),
        }
    }
}

impl Drop for TerminalMatrixSink {
    fn drop(&mut self) {
        // Best effort: re-show cursor and reset color on shutdown so
        // the user's terminal isn't left in a weird state.
        let _ = self.out.write_all(b"\x1b[0m\x1b[?25h\n");
        let _ = self.out.flush();
    }
}

impl MatrixSink for TerminalMatrixSink {
    fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn present(&mut self, buffer: &PixelBuffer) -> anyhow::Result<()> {
        let elapsed = self.last_present.elapsed();
        if elapsed < self.target_period {
            std::thread::sleep(self.target_period - elapsed);
        }
        self.last_present = Instant::now();

        // ~64 cols * 32 rows * ~30 bytes/cell escapes is ~60KB; one
        // string + one write keeps the terminal flicker-free.
        let mut s = String::with_capacity((self.width * self.height) as usize * 16);
        if !self.initialized {
            // Clear screen, home, hide cursor.
            s.push_str("\x1b[2J\x1b[H\x1b[?25l");
            self.initialized = true;
        } else {
            // Re-home — overwrite the previous frame in place.
            s.push_str("\x1b[H");
        }

        let h = buffer.height();
        let w = buffer.width();
        let mut y = 0;
        while y < h {
            for x in 0..w {
                let top = buffer.pixel(x, y);
                let bot = if y + 1 < h {
                    buffer.pixel(x, y + 1)
                } else {
                    Rgb888::BLACK
                };
                // \x1b[38;2;R;G;Bm = fg truecolor, \x1b[48;… = bg.
                let _ = write!(
                    s,
                    "\x1b[38;2;{};{};{};48;2;{};{};{}m\u{2580}",
                    top.r(),
                    top.g(),
                    top.b(),
                    bot.r(),
                    bot.g(),
                    bot.b(),
                );
            }
            // EOL: reset attrs so a stray newline doesn't bleed colour
            // into the next line, then \r\n.
            s.push_str("\x1b[0m\r\n");
            y += 2;
        }
        self.out.write_all(s.as_bytes())?;
        self.out.flush()?;
        Ok(())
    }
}
