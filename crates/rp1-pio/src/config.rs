//! PIO state-machine config word builder.
//!
//! The RP1 PIO SM config registers have the same bit layout as the
//! RP2040/RP2350 PIO (the kernel just forwards these words to the SM).
//! This mirrors the relevant pico-SDK `sm_config_*` setters, emitting
//! the four `clkdiv/execctrl/shiftctrl/pinctrl` words consumed by the
//! `SM_INIT` ioctl.

use crate::ioctl::PioSmConfig;

// execctrl
const EXECCTRL_WRAP_BOTTOM_LSB: u32 = 7;
const EXECCTRL_WRAP_TOP_LSB: u32 = 12;
const EXECCTRL_SIDE_PINDIR: u32 = 1 << 29;
const EXECCTRL_SIDE_EN: u32 = 1 << 30;
// shiftctrl
const SHIFTCTRL_AUTOPULL: u32 = 1 << 17;
const SHIFTCTRL_OUT_SHIFTDIR: u32 = 1 << 19;
const SHIFTCTRL_PULL_THRESH_LSB: u32 = 25;
const SHIFTCTRL_FJOIN_TX: u32 = 1 << 30;
// pinctrl
const PINCTRL_OUT_BASE_LSB: u32 = 0;
const PINCTRL_SIDESET_BASE_LSB: u32 = 10;
const PINCTRL_OUT_COUNT_LSB: u32 = 20;
const PINCTRL_SIDESET_COUNT_LSB: u32 = 29;

/// Builder for a single state machine's PIO config.
#[derive(Clone, Copy, Debug, Default)]
pub struct SmConfig {
    clkdiv: u32,
    execctrl: u32,
    shiftctrl: u32,
    pinctrl: u32,
}

impl SmConfig {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Integer + fractional clock divider. `clkdiv = int<<16 | frac<<8`.
    /// `int` of 0 means 65536 in hardware; pass a real divider ≥ 1.
    #[must_use]
    pub fn clkdiv_int_frac(mut self, int: u16, frac: u8) -> Self {
        self.clkdiv = (u32::from(int) << 16) | (u32::from(frac) << 8);
        self
    }

    /// `out pins` base GPIO + count (1..=32; 32 encoded as 0 in the
    /// 6-bit field, but we never need 32 here).
    #[must_use]
    pub fn out_pins(mut self, base: u8, count: u8) -> Self {
        self.pinctrl &= !(0x1f << PINCTRL_OUT_BASE_LSB);
        self.pinctrl &= !(0x3f << PINCTRL_OUT_COUNT_LSB);
        self.pinctrl |= (u32::from(base) & 0x1f) << PINCTRL_OUT_BASE_LSB;
        self.pinctrl |= (u32::from(count) & 0x3f) << PINCTRL_OUT_COUNT_LSB;
        self
    }

    /// Side-set: `count` *includes* the opt-enable bit when `optional`
    /// (so `.side_set 1 opt` → count = 2). `base` is the first side-set
    /// GPIO. `pindirs` side-sets pin directions rather than levels.
    #[must_use]
    pub fn sideset(mut self, base: u8, count: u8, optional: bool, pindirs: bool) -> Self {
        self.pinctrl &= !(0x7 << PINCTRL_SIDESET_COUNT_LSB);
        self.pinctrl &= !(0x1f << PINCTRL_SIDESET_BASE_LSB);
        self.pinctrl |= (u32::from(count) & 0x7) << PINCTRL_SIDESET_COUNT_LSB;
        self.pinctrl |= (u32::from(base) & 0x1f) << PINCTRL_SIDESET_BASE_LSB;
        if optional {
            self.execctrl |= EXECCTRL_SIDE_EN;
        } else {
            self.execctrl &= !EXECCTRL_SIDE_EN;
        }
        if pindirs {
            self.execctrl |= EXECCTRL_SIDE_PINDIR;
        } else {
            self.execctrl &= !EXECCTRL_SIDE_PINDIR;
        }
        self
    }

    /// Program wrap: after executing `wrap_top`, jump to `wrap_bottom`.
    /// Both are absolute instruction offsets (the program is loaded at
    /// origin 0).
    #[must_use]
    pub fn wrap(mut self, wrap_bottom: u8, wrap_top: u8) -> Self {
        self.execctrl &= !(0x1f << EXECCTRL_WRAP_BOTTOM_LSB);
        self.execctrl &= !(0x1f << EXECCTRL_WRAP_TOP_LSB);
        self.execctrl |= (u32::from(wrap_bottom) & 0x1f) << EXECCTRL_WRAP_BOTTOM_LSB;
        self.execctrl |= (u32::from(wrap_top) & 0x1f) << EXECCTRL_WRAP_TOP_LSB;
        self
    }

    /// OUT shift config. `shift_right=false` → shift left. `threshold`
    /// of 32 is encoded as 0 in the 5-bit field.
    #[must_use]
    pub fn out_shift(mut self, shift_right: bool, autopull: bool, threshold: u8) -> Self {
        if shift_right {
            self.shiftctrl |= SHIFTCTRL_OUT_SHIFTDIR;
        } else {
            self.shiftctrl &= !SHIFTCTRL_OUT_SHIFTDIR;
        }
        if autopull {
            self.shiftctrl |= SHIFTCTRL_AUTOPULL;
        } else {
            self.shiftctrl &= !SHIFTCTRL_AUTOPULL;
        }
        self.shiftctrl &= !(0x1f << SHIFTCTRL_PULL_THRESH_LSB);
        self.shiftctrl |= (u32::from(threshold) & 0x1f) << SHIFTCTRL_PULL_THRESH_LSB;
        self
    }

    /// Join both FIFOs into a single 8-deep TX FIFO.
    #[must_use]
    pub fn fifo_join_tx(mut self) -> Self {
        self.shiftctrl |= SHIFTCTRL_FJOIN_TX;
        self
    }

    #[must_use]
    pub fn build(self) -> PioSmConfig {
        PioSmConfig {
            clkdiv: self.clkdiv,
            execctrl: self.execctrl,
            shiftctrl: self.shiftctrl,
            pinctrl: self.pinctrl,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clkdiv_packs_int_and_frac() {
        let c = SmConfig::new().clkdiv_int_frac(7, 104).build();
        assert_eq!(c.clkdiv, (7 << 16) | (104 << 8));
    }

    #[test]
    fn out_pins_sets_base_and_count() {
        let c = SmConfig::new().out_pins(0, 28).build();
        // base 0 at bits 0..4, count 28 at bits 20..25
        assert_eq!(c.pinctrl, 28 << 20);
    }

    #[test]
    fn sideset_one_opt_sets_count2_and_side_en() {
        let c = SmConfig::new().sideset(17, 2, true, false).build();
        assert_eq!((c.pinctrl >> PINCTRL_SIDESET_COUNT_LSB) & 0x7, 2);
        assert_eq!((c.pinctrl >> PINCTRL_SIDESET_BASE_LSB) & 0x1f, 17);
        assert_ne!(c.execctrl & EXECCTRL_SIDE_EN, 0);
        assert_eq!(c.execctrl & EXECCTRL_SIDE_PINDIR, 0);
    }

    #[test]
    fn out_shift_left_autopull_threshold32() {
        let c = SmConfig::new().out_shift(false, true, 32).build();
        assert_eq!(c.shiftctrl & SHIFTCTRL_OUT_SHIFTDIR, 0); // left
        assert_ne!(c.shiftctrl & SHIFTCTRL_AUTOPULL, 0);
        assert_eq!((c.shiftctrl >> SHIFTCTRL_PULL_THRESH_LSB) & 0x1f, 0); // 32 -> 0
    }

    #[test]
    fn wrap_bottom_top() {
        let c = SmConfig::new().wrap(0, 4).build();
        assert_eq!((c.execctrl >> EXECCTRL_WRAP_BOTTOM_LSB) & 0x1f, 0);
        assert_eq!((c.execctrl >> EXECCTRL_WRAP_TOP_LSB) & 0x1f, 4);
    }
}
