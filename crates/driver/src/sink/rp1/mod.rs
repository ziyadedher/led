//! Raspberry Pi 5 (RP1) HUB75 backend.
//!
//! Drives the panel from an RP1 PIO state machine: each frame is packed
//! into a bit-plane command stream ([`encoder`]) and DMA'd into the PIO
//! TX FIFO; the [`program`] state machine clocks the pixels out with
//! hardware-deterministic timing. See `docs/rpi5-rp1-pio-backend.md`.

mod encoder;
mod program;

use rp1_pio::{Pio, SmConfig, DIR_TO_SM, RP1_GPIO_FUNC_PIO};

use crate::color_order::ColorOrder;
use crate::sink::{MatrixSink, PixelBuffer};

const PIO_DEVICE: &str = "/dev/pio0";
const SM: u8 = 0;
const CLK_GPIO: u8 = 17;

/// Every GPIO routed to PIO: the 13 signals carried in the data word
/// plus CLK (side-set). All are set to output before the SM runs.
const PIO_GPIOS: [u8; 14] = [
    5, 13, 6, 12, 16, 23, // R1 G1 B1 R2 G2 B2
    22, 26, 27, 20, 24, // A B C D E
    4, 21, // OE LAT
    CLK_GPIO, // CLK (side-set)
];

// Clock divider. The RP1 PIO core clock is assumed 200 MHz; /10 gives a
// 20 MHz PIO clock = 10 MHz pixel clock (2 PIO cycles/pixel). Chosen
// conservatively for first light — bit-plane dwell + refresh scale with
// this, so it's the first knob to tune against the panel.
const CLKDIV_INT: u16 = 10;
const CLKDIV_FRAC: u8 = 0;

/// DMA bounce buffers for the data path. `MAX_XFER_BYTES` (65532) fits
/// a u16 by construction.
#[allow(clippy::cast_possible_truncation)]
const XFER_BUF_SIZE: u16 = rp1_pio::MAX_XFER_BYTES as u16;
const XFER_BUF_COUNT: u16 = 3;

/// HUB75-on-RP1 output sink for the Pi 5.
pub struct Rp1PioSink {
    pio: Pio,
    width: u32,
    height: u32,
    color_order: ColorOrder,
    /// Reused frame word-stream buffer (avoids a per-frame alloc).
    words: Vec<u32>,
}

impl Rp1PioSink {
    /// Bring up the PIO state machine for a `width × height` panel.
    pub fn new(width: u32, height: u32, color_order: ColorOrder) -> anyhow::Result<Self> {
        let pio = Pio::open(PIO_DEVICE)?;

        pio.add_program(&program::instructions())?;
        pio.claim_sm(SM)?;

        // Route each signal to PIO and set it as an output.
        let mut pin_mask: u32 = 0;
        for &gpio in &PIO_GPIOS {
            pio.gpio_init(gpio)?;
            pio.gpio_set_function(gpio, RP1_GPIO_FUNC_PIO)?;
            pin_mask |= 1 << gpio;
        }

        let config = SmConfig::new()
            .clkdiv_int_frac(CLKDIV_INT, CLKDIV_FRAC)
            .out_pins(program::OUT_BASE, program::OUT_COUNT)
            .sideset(CLK_GPIO, program::SIDESET_COUNT, true, false)
            .wrap(program::WRAP_TARGET, program::WRAP_SOURCE)
            .out_shift(false, true, 32) // shift left, autopull, threshold 32
            .fifo_join_tx()
            .build();
        pio.sm_init(SM, program::INITIAL_PC, &config)?;
        pio.set_pindirs(SM, pin_mask, pin_mask)?; // all outputs

        pio.config_xfer(SM, DIR_TO_SM, XFER_BUF_SIZE, XFER_BUF_COUNT)?;
        pio.set_enabled(SM, true)?;

        Ok(Self {
            pio,
            width,
            height,
            color_order,
            words: Vec::new(),
        })
    }
}

impl MatrixSink for Rp1PioSink {
    fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn present(&mut self, buffer: &PixelBuffer) -> anyhow::Result<()> {
        encoder::encode_frame(buffer, self.color_order, &mut self.words);
        // Blocks until the whole frame DMAs through the FIFO — this is
        // also the render-loop's pacing for the RP1 path.
        self.pio.xfer_all(SM, DIR_TO_SM, &self.words)?;
        Ok(())
    }
}
