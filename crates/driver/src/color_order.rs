//! Backend-neutral LED channel order.
//!
//! Different panel / bonnet revisions wire the R/G/B channels in
//! different physical orders; this is the per-Pi knob that fixes
//! "everything renders with red and blue swapped". The render core
//! always produces logical RGB; the active sink permutes to the
//! panel's wiring at the output boundary.
//!
//! Kept independent of any backend crate so it parses + tests without
//! the Pi feature set. Each backend maps it to its own representation
//! (`rpi-led-panel`'s `LedSequence`, or a channel permutation in the
//! RP1 PIO encoder).

use std::str::FromStr;

/// Physical ordering of the three colour channels on the panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ColorOrder {
    #[default]
    Rgb,
    Rbg,
    Grb,
    Gbr,
    Brg,
    Bgr,
}

impl ColorOrder {
    /// Permute a logical `(r, g, b)` triple into the channel order the
    /// panel hardware expects. Generic over the channel type so it
    /// works for `u8` samples and for bit-position indices alike.
    #[must_use]
    pub fn permute<T>(self, r: T, g: T, b: T) -> (T, T, T) {
        match self {
            ColorOrder::Rgb => (r, g, b),
            ColorOrder::Rbg => (r, b, g),
            ColorOrder::Grb => (g, r, b),
            ColorOrder::Gbr => (g, b, r),
            ColorOrder::Brg => (b, r, g),
            ColorOrder::Bgr => (b, g, r),
        }
    }
}

impl FromStr for ColorOrder {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_uppercase().as_str() {
            "" | "RGB" => Ok(ColorOrder::Rgb),
            "RBG" => Ok(ColorOrder::Rbg),
            "GRB" => Ok(ColorOrder::Grb),
            "GBR" => Ok(ColorOrder::Gbr),
            "BRG" => Ok(ColorOrder::Brg),
            "BGR" => Ok(ColorOrder::Bgr),
            other => Err(format!(
                "color_order = {other:?}; expected one of RGB / RBG / GRB / GBR / BRG / BGR"
            )),
        }
    }
}

/// Parse the optional config string, defaulting to `Rgb` when unset.
pub fn from_config(value: Option<&str>) -> Result<ColorOrder, String> {
    match value {
        None => Ok(ColorOrder::Rgb),
        Some(s) => s.parse(),
    }
}

#[cfg(feature = "rpi")]
impl From<ColorOrder> for rpi_led_panel::LedSequence {
    fn from(order: ColorOrder) -> Self {
        use rpi_led_panel::LedSequence;
        match order {
            ColorOrder::Rgb => LedSequence::Rgb,
            ColorOrder::Rbg => LedSequence::Rbg,
            ColorOrder::Grb => LedSequence::Grb,
            ColorOrder::Gbr => LedSequence::Gbr,
            ColorOrder::Brg => LedSequence::Brg,
            ColorOrder::Bgr => LedSequence::Bgr,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_case_insensitively_with_default() {
        assert_eq!(from_config(None).unwrap(), ColorOrder::Rgb);
        assert_eq!(from_config(Some("")).unwrap(), ColorOrder::Rgb);
        assert_eq!(from_config(Some("bgr")).unwrap(), ColorOrder::Bgr);
        assert_eq!(from_config(Some(" GbR ")).unwrap(), ColorOrder::Gbr);
        assert!(from_config(Some("xyz")).is_err());
    }

    #[test]
    fn permute_reorders_channels() {
        assert_eq!(ColorOrder::Rgb.permute(1, 2, 3), (1, 2, 3));
        assert_eq!(ColorOrder::Bgr.permute(1, 2, 3), (3, 2, 1));
        assert_eq!(ColorOrder::Grb.permute(1, 2, 3), (2, 1, 3));
    }
}
