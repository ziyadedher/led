//! The HUB75 PIO program.
//!
//! Assembled at build time with `pio-proc` from the same source as
//! Adafruit's `protomatter.pio` (which hzeller vendored verbatim).
//! The state machine reads a command-tagged 32-bit word stream:
//!
//!   - `out x, 1`  pulls the tag bit (MSB of the word, OUT shifts LEFT)
//!   - `out y, 31` pulls the 31-bit count/delay
//!   - tag 1 → clock out N sample words (CLK high via side-set per word)
//!   - tag 0 → hold one word for N cycles (CLK low) — the bit-plane dwell
//!
//! CLK is the single side-set pin; every other HUB75 signal lives in
//! the 32-bit word at its native BCM bit position (see `encoder`).

/// `out pins` writes GPIO 0..27 (every HUB75 signal except CLK).
pub const OUT_BASE: u8 = 0;
pub const OUT_COUNT: u8 = 28;
/// Side-set width including the opt-enable bit (`.side_set 1 opt`).
pub const SIDESET_COUNT: u8 = 2;
/// Program wrap bounds (absolute offsets; loaded at origin 0).
pub const WRAP_TARGET: u8 = 0;
pub const WRAP_SOURCE: u8 = 4;
/// Initial program counter.
pub const INITIAL_PC: u16 = 0;

/// The assembled instruction words (≤ 32) to upload via `add_program`.
pub fn instructions() -> Vec<u16> {
    let asm = pio_proc::pio_asm!(
        ".side_set 1 opt",
        ".wrap_target",
        "top:",
        "    out x, 1",
        "    out y, 31",
        "    jmp !x, do_delay",
        "data_loop:",
        "    out pins, 32",
        "    jmp y--, data_loop side 1",
        ".wrap",
        "do_delay:",
        "    out pins, 32",
        "delay_loop:",
        "    jmp y--, delay_loop",
        "    jmp top",
    );
    asm.program.code.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden opcodes from the shipping Adafruit/hzeller `protomatter`
    /// program (decoded from the vendored `.pio.h`). If `pio-proc`
    /// ever assembles these differently, this fails loudly rather than
    /// silently driving the panel wrong.
    #[test]
    fn matches_reference_protomatter_opcodes() {
        let expected: [u16; 8] = [
            0x6021, // out x, 1
            0x605f, // out y, 31
            0x0025, // jmp !x, do_delay(5)
            0x6000, // out pins, 32   (data_loop)
            0x1883, // jmp y--, data_loop(3) side 1
            0x6000, // out pins, 32   (do_delay)
            0x0086, // jmp y--, delay_loop(6)
            0x0000, // jmp top(0)
        ];
        assert_eq!(instructions().as_slice(), &expected);
    }

    #[test]
    fn wrap_bounds_are_known() {
        assert_eq!((WRAP_TARGET, WRAP_SOURCE), (0, 4));
    }
}
