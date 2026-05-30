//! Frame → PIO command-stream encoder.
//!
//! Pure logic: turns a rendered [`PixelBuffer`] into the tagged 32-bit
//! word stream the [`super::program`] state machine consumes. No
//! hardware, no I/O — so the exact bit-stream is asserted in unit
//! tests below with nothing attached.
//!
//! Each HUB75 signal sits at its native BCM bit position in every
//! sample word; CLK (GPIO17) is driven by the program's side-set and
//! is never set here. The panel is 1/32-scan: row `r` (top half) and
//! `r + height/2` (bottom half) are clocked together while address
//! lines A–E select the row pair.

use std::sync::OnceLock;

use embedded_graphics::prelude::RgbColor;

use crate::color_order::ColorOrder;
use crate::sink::PixelBuffer;

// Adafruit RGB Matrix Bonnet pin map (BCM numbers = bit positions).
const PIN_R1: u32 = 5;
const PIN_G1: u32 = 13;
const PIN_B1: u32 = 6;
const PIN_R2: u32 = 12;
const PIN_G2: u32 = 16;
const PIN_B2: u32 = 23;
const PIN_ADDR: [u32; 5] = [22, 26, 27, 20, 24]; // A B C D E
const PIN_OE: u32 = 4;
const PIN_LAT: u32 = 21;
// CLK = GPIO17 — driven by the PIO side-set, never set in a word.

/// OE is active-LOW on the Bonnet: bit high = output disabled (blank).
const OE_DISABLED: u32 = 1 << PIN_OE;
const LAT_BIT: u32 = 1 << PIN_LAT;

const CMD_DATA: u32 = 1 << 31;

/// Number of bit planes (color depth per channel). Higher = smoother
/// gradients but more data + lower refresh.
pub const BIT_PLANES: u32 = 8;
/// Base OE-on dwell (PIO cycles) for the least-significant plane; each
/// more-significant plane doubles it (binary-coded modulation).
const BASE_DWELL: u32 = 8;
/// LAT latch-pulse width (PIO cycles).
const LATCH_TICKS: u32 = 4;
/// OE-off guard after the dwell, before the next row's address changes.
/// This is the anti-ghosting knob: the panel's output drivers need time
/// to fully switch off, otherwise the bright row bleeds faintly onto the
/// next address row ("the LED below is slightly lit"). Generous here is
/// cheap — it's a fixed cost per row, negligible against the dwell sum.
const BLANK_TICKS: u32 = 24;

/// `data_header(n)` then exactly `n` sample words follow.
fn data_header(n: u32) -> u32 {
    debug_assert!(n >= 1);
    CMD_DATA | (n - 1)
}

/// `delay_header(t)` then one held word; the SM holds it `t` cycles.
fn delay_header(ticks: u32) -> u32 {
    debug_assert!(ticks >= 1);
    // tag 0 (bit 31 clear); count = ticks - 1 (the SM's jmp-y-- loop
    // runs count+1 times).
    (ticks - 1) & 0x7fff_ffff
}

fn addr_word(addr: u32) -> u32 {
    let mut w = 0;
    for (i, &pin) in PIN_ADDR.iter().enumerate() {
        if addr & (1 << i) != 0 {
            w |= 1 << pin;
        }
    }
    w
}

/// 8-bit channel → `BIT_PLANES`-bit gamma-corrected level. Gamma 2.2
/// matches the panel's perceptual response; applied before bit-plane
/// decomposition so dim values keep their relative steps.
fn gamma_lut() -> &'static [u16; 256] {
    static LUT: OnceLock<[u16; 256]> = OnceLock::new();
    LUT.get_or_init(|| {
        let max = f64::from((1u32 << BIT_PLANES) - 1);
        let mut lut = [0u16; 256];
        for i in 0u16..256 {
            let norm = f64::from(i) / 255.0;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let level = (max * norm.powf(2.2)).round() as u16;
            lut[i as usize] = level;
        }
        lut
    })
}

/// Encode one full frame into `out` (cleared first). `out` is the word
/// stream to DMA into the SM TX FIFO.
pub fn encode_frame(buf: &PixelBuffer, order: ColorOrder, out: &mut Vec<u32>) {
    out.clear();
    let width = buf.width();
    let scan_rows = buf.height() / 2;
    let lut = gamma_lut();

    // Pre-gamma both half-panel rows once per (row, column) below; the
    // permutation maps logical RGB to the panel's wired channel order.
    let level = |c: embedded_graphics::pixelcolor::Rgb888| -> (u16, u16, u16) {
        let (r, g, b) = order.permute(c.r(), c.g(), c.b());
        (lut[r as usize], lut[g as usize], lut[b as usize])
    };

    // Pipelined to avoid row-transition ghosting: the address lines
    // always match the row currently in the output latches. We clock
    // row N's data while the address still points at the previously
    // latched row, then latch, THEN advance the address, then
    // illuminate. So there's never a window where the address selects
    // one row while the latches hold a different (bright) row — that
    // mismatch is what bleeds a faint copy onto the next row.
    //
    // `prev` is the row whose data is in the latches right now. Seeded
    // to the last scan row so the first iteration is consistent; any
    // startup transient is a single sub-frame and invisible.
    let mut prev = scan_rows - 1;

    // MSB plane first (p = 0) so the longest dwell leads each row.
    for plane in 0..BIT_PLANES {
        let bit = BIT_PLANES - 1 - plane; // plane 0 → MSB
        let dwell = BASE_DWELL << (BIT_PLANES - 1 - plane);
        for addr in 0..scan_rows {
            let prev_abits = addr_word(prev);
            let abits = addr_word(addr);

            // Clock row `addr`'s data in. OE blanked; address still
            // selects `prev` (matching the latched data) so any leakage
            // during the long shift can only re-light `prev`, not bleed
            // onto a neighbour.
            out.push(data_header(width));
            for x in 0..width {
                let (tr, tg, tb) = level(buf.pixel(x, addr));
                let (br, bg, bb) = level(buf.pixel(x, addr + scan_rows));
                let mut w = OE_DISABLED | prev_abits;
                if tr & (1 << bit) != 0 {
                    w |= 1 << PIN_R1;
                }
                if tg & (1 << bit) != 0 {
                    w |= 1 << PIN_G1;
                }
                if tb & (1 << bit) != 0 {
                    w |= 1 << PIN_B1;
                }
                if br & (1 << bit) != 0 {
                    w |= 1 << PIN_R2;
                }
                if bg & (1 << bit) != 0 {
                    w |= 1 << PIN_G2;
                }
                if bb & (1 << bit) != 0 {
                    w |= 1 << PIN_B2;
                }
                out.push(w);
            }

            // Latch the shifted row into the output latches (still
            // blanked, address still `prev`).
            out.push(delay_header(LATCH_TICKS));
            out.push(OE_DISABLED | prev_abits | LAT_BIT);

            // Advance the address to the row we just latched, while
            // still blanked, and let it settle.
            out.push(delay_header(BLANK_TICKS));
            out.push(OE_DISABLED | abits);

            // Illuminate for this plane's weighted dwell (OE active-low
            // = 0; LAT low; address now matches the latched data).
            out.push(delay_header(dwell));
            out.push(abits);

            prev = addr;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use embedded_graphics::{pixelcolor::Rgb888, prelude::*};

    const RGB_MASK: u32 = (1 << PIN_R1)
        | (1 << PIN_G1)
        | (1 << PIN_B1)
        | (1 << PIN_R2)
        | (1 << PIN_G2)
        | (1 << PIN_B2);
    const CLK_BIT: u32 = 1 << 17;

    fn solid(color: Rgb888) -> PixelBuffer {
        let mut b = PixelBuffer::new(64, 64);
        b.clear(color).unwrap();
        b
    }

    /// Walk the stream the way the PIO does and collect the GPIO output
    /// words (sample words + held delay words). Command headers encode
    /// counts in the low bits and are NOT pin words, so they're skipped.
    fn gpio_words(stream: &[u32]) -> Vec<u32> {
        let mut words = Vec::new();
        let mut i = 0;
        while i < stream.len() {
            let hdr = stream[i];
            i += 1;
            if hdr & CMD_DATA != 0 {
                let n = (hdr & 0x7fff_ffff) + 1;
                for _ in 0..n {
                    words.push(stream[i]);
                    i += 1;
                }
            } else {
                // delay: exactly one held word follows
                words.push(stream[i]);
                i += 1;
            }
        }
        words
    }

    #[test]
    fn all_black_lights_no_rgb_bits() {
        let mut out = Vec::new();
        encode_frame(&solid(Rgb888::BLACK), ColorOrder::Rgb, &mut out);
        assert!(!out.is_empty());
        // No GPIO word asserts an RGB channel, and CLK is never set in
        // the stream (it's the program's side-set).
        for w in gpio_words(&out) {
            assert_eq!(w & RGB_MASK, 0, "black frame lit an RGB pin");
            assert_eq!(w & CLK_BIT, 0, "encoder must never set CLK (GPIO17)");
        }
    }

    #[test]
    fn clk_never_set_in_any_gpio_word() {
        let mut out = Vec::new();
        encode_frame(&solid(Rgb888::WHITE), ColorOrder::Rgb, &mut out);
        for w in gpio_words(&out) {
            assert_eq!(w & CLK_BIT, 0, "CLK must be driven only by side-set");
        }
    }

    #[test]
    fn white_top_left_sets_top_rgb_on_msb_plane() {
        let mut out = Vec::new();
        encode_frame(&solid(Rgb888::WHITE), ColorOrder::Rgb, &mut out);
        // First word is the MSB-plane, row-0 data header for 64 samples.
        assert_eq!(out[0], data_header(64));
        // First sample (column 0) of the MSB plane: white → top + bottom
        // RGB all lit (gamma of 255 = max, MSB set).
        let w = out[1];
        assert_ne!(w & (1 << PIN_R1), 0);
        assert_ne!(w & (1 << PIN_G1), 0);
        assert_ne!(w & (1 << PIN_B1), 0);
        assert_ne!(w & (1 << PIN_R2), 0);
        // OE blanked while clocking.
        assert_ne!(w & OE_DISABLED, 0);
    }

    /// Decode the row address (A–E) carried in a GPIO word.
    fn decode_addr(word: u32) -> u32 {
        // PIN_ADDR = [A,B,C,D,E] at bits [22,26,27,20,24]
        let pins = [22, 26, 27, 20, 24];
        let mut a = 0;
        for (i, p) in pins.iter().enumerate() {
            if word & (1 << p) != 0 {
                a |= 1 << i;
            }
        }
        a
    }

    #[test]
    fn dwell_doubles_per_more_significant_plane() {
        let mut out = Vec::new();
        encode_frame(&solid(Rgb888::WHITE), ColorOrder::Rgb, &mut out);
        // Each row block is, in order:
        //   [data_hdr][64 samples][lat_hdr][lat_word][blank_hdr][addr_word][dwell_hdr][on_word]
        let row_block = 64 + 1 + 2 + 2 + 2; // = 71 words
        let dwell_hdr_offset = 1 + 64 + 2 + 2; // past data, samples, latch, blank
        let plane0_dwell = out[dwell_hdr_offset] + 1;
        let plane1_dwell = out[row_block * 32 + dwell_hdr_offset] + 1;
        // plane 0 is MSB → exactly double plane 1.
        assert_eq!(plane0_dwell, plane1_dwell * 2);
    }

    #[test]
    fn address_is_pipelined_to_avoid_ghosting() {
        // The anti-ghosting invariant: while clocking a row's data in,
        // the address must still select the row currently in the latches
        // (the one displayed by the PREVIOUS block's dwell), never the
        // row being shifted. So block i's dwell address == block i+1's
        // sample-clock address.
        let mut out = Vec::new();
        encode_frame(&solid(Rgb888::WHITE), ColorOrder::Rgb, &mut out);
        let row_block = 64 + 1 + 2 + 2 + 2;
        let sample_offset = 1; // first sample word
        let dwell_word_offset = 1 + 64 + 2 + 2 + 1; // the OE-on word
        for i in 0..5 {
            let dwell_addr = decode_addr(out[i * row_block + dwell_word_offset]);
            let next_clock_addr = decode_addr(out[(i + 1) * row_block + sample_offset]);
            assert_eq!(
                dwell_addr, next_clock_addr,
                "block {i} displays row {dwell_addr} but block {} clocks against row {next_clock_addr}",
                i + 1
            );
            // And within a block, the clock-in address differs from the
            // row being displayed (it's the previous row).
            let this_clock_addr = decode_addr(out[i * row_block + sample_offset]);
            assert_ne!(this_clock_addr, dwell_addr);
        }
    }

    #[test]
    fn color_order_permutes_channels() {
        // A pure-red logical pixel under BGR wiring drives the B channel.
        let mut rgb = Vec::new();
        encode_frame(&solid(Rgb888::new(255, 0, 0)), ColorOrder::Rgb, &mut rgb);
        let mut bgr = Vec::new();
        encode_frame(&solid(Rgb888::new(255, 0, 0)), ColorOrder::Bgr, &mut bgr);
        // RGB: R1 lit, B1 dark. BGR: B1 lit, R1 dark.
        assert_ne!(rgb[1] & (1 << PIN_R1), 0);
        assert_eq!(rgb[1] & (1 << PIN_B1), 0);
        assert_eq!(bgr[1] & (1 << PIN_R1), 0);
        assert_ne!(bgr[1] & (1 << PIN_B1), 0);
    }
}
