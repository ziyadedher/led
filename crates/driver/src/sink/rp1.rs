//! Raspberry Pi 5 (RP1) HUB75 backend.
//!
//! On the Pi 5 the GPIO lives behind the RP1 south-bridge over PCIe;
//! the decade-old BCM-register-mmap approach (`rpi-led-panel`) does
//! not apply. Instead we drive HUB75 from an RP1 PIO state machine:
//! the CPU packs each frame into a bit-plane command stream and DMAs
//! it into the PIO FIFO; the state machine clocks the pixel bits out
//! with hardware-deterministic timing.
//!
//! Structure (filled in as the implementation lands):
//!   - `crates/rp1-pio`        — generic `/dev/pio0` userspace wrapper
//!   - this module             — the HUB75 encoder + `MatrixSink` impl
//!
//! The frame → command-stream encoder is factored behind a trait so
//! the exact bit-stream can be asserted in unit tests with no hardware
//! attached (see `encoder` once implemented).

use crate::color_order::ColorOrder;
use crate::sink::{MatrixSink, PixelBuffer};

/// HUB75-on-RP1 output sink for the Pi 5.
pub struct Rp1PioSink {
    width: u32,
    height: u32,
    #[allow(dead_code)] // wired into the encoder once implemented
    color_order: ColorOrder,
}

impl Rp1PioSink {
    /// Construct the RP1 PIO backend for a `width × height` panel.
    ///
    /// Not yet implemented: returns an error so a misrouted Pi 5
    /// deploy fails loudly with an actionable message rather than
    /// silently rendering nothing.
    pub fn new(width: u32, height: u32, color_order: ColorOrder) -> anyhow::Result<Self> {
        let _ = Self {
            width,
            height,
            color_order,
        };
        anyhow::bail!(
            "RP1 PIO backend (Raspberry Pi 5) is not yet implemented — \
             tracking native /dev/pio0 HUB75 support"
        )
    }
}

impl MatrixSink for Rp1PioSink {
    fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn present(&mut self, _buffer: &PixelBuffer) -> anyhow::Result<()> {
        unreachable!("Rp1PioSink cannot be constructed yet")
    }
}
