//! Minimal pure-Rust userspace driver for the Raspberry Pi 5 RP1 PIO
//! block via `/dev/pio0`.
//!
//! Scope: exactly what's needed to load a PIO program, claim a state
//! machine, route GPIOs to PIO, and stream data into the TX FIFO over
//! DMA. No HUB75 knowledge lives here — that's the driver's RP1 sink.
//!
//! ABI reference: `raspberrypi/linux` `rpi-6.12.y`
//! `include/uapi/misc/rp1_pio_if.h`. 64-bit (aarch64) only.

mod config;
mod ioctl;

use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::path::Path;

pub use config::SmConfig;
pub use ioctl::{PioSmConfig, DIR_TO_SM, RP1_GPIO_FUNC_PIO};

/// Largest single `SM_XFER_DATA` chunk: `data_bytes` is a `u16`, so
/// the cap is the largest multiple of 4 ≤ 65535.
pub const MAX_XFER_BYTES: usize = 65_532;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("open {path}: {source}")]
    Open {
        path: String,
        source: std::io::Error,
    },
    #[error("ioctl {op}: {source}")]
    Ioctl { op: &'static str, source: nix::Error },
    #[error("xfer chunk {0} bytes exceeds max {MAX_XFER_BYTES}")]
    ChunkTooLarge(usize),
    #[error("program is {0} instructions; max is 32")]
    ProgramTooLong(usize),
}

type Result<T> = std::result::Result<T, Error>;

/// An open handle to the RP1 PIO device.
pub struct Pio {
    file: File,
}

impl Pio {
    /// Open `/dev/pio0` (or another `/dev/pioN`).
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let p = path.as_ref();
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(p)
            .map_err(|source| Error::Open {
                path: p.display().to_string(),
                source,
            })?;
        Ok(Self { file })
    }

    fn fd(&self) -> ioctl::Fd {
        self.file.as_raw_fd()
    }

    /// Load a PIO program at origin 0 (jump targets are absolute, so
    /// the program must sit at a known base — we always use 0). The
    /// program is ≤ 32 instructions.
    pub fn add_program(&self, instrs: &[u16]) -> Result<()> {
        if instrs.len() > ioctl::INSTRUCTION_COUNT {
            return Err(Error::ProgramTooLong(instrs.len()));
        }
        let mut args = ioctl::AddProgramArgs {
            num_instrs: instrs.len() as u16,
            origin: 0,
            instrs: [0; ioctl::INSTRUCTION_COUNT],
        };
        args.instrs[..instrs.len()].copy_from_slice(instrs);
        // SAFETY: args outlives the call; struct size is asserted to
        // match the kernel's `_IOC_SIZE`.
        unsafe { ioctl::add_program(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "add_program", source })?;
        Ok(())
    }

    pub fn claim_sm(&self, sm: u8) -> Result<()> {
        let args = ioctl::SmClaimArgs { mask: 1 << sm };
        unsafe { ioctl::sm_claim(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "sm_claim", source })?;
        Ok(())
    }

    pub fn gpio_init(&self, gpio: u8) -> Result<()> {
        let args = ioctl::GpioInitArgs { gpio: u16::from(gpio) };
        unsafe { ioctl::gpio_init(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "gpio_init", source })?;
        Ok(())
    }

    pub fn gpio_set_function(&self, gpio: u8, func: u16) -> Result<()> {
        let args = ioctl::GpioSetFunctionArgs { gpio: u16::from(gpio), func };
        unsafe { ioctl::gpio_set_function(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "gpio_set_function", source })?;
        Ok(())
    }

    /// Pad drive strength (RP1 levels 0..=3 → ~2/4/8/12 mA).
    pub fn gpio_set_drive_strength(&self, gpio: u8, level: u16) -> Result<()> {
        let args = ioctl::GpioSetArgs { gpio: u16::from(gpio), value: level };
        unsafe { ioctl::gpio_set_drive_strength(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "gpio_set_drive_strength", source })?;
        Ok(())
    }

    /// Reset + configure a state machine and set its initial PC.
    pub fn sm_init(&self, sm: u8, initial_pc: u16, config: &PioSmConfig) -> Result<()> {
        let args = ioctl::SmInitArgs {
            sm: u16::from(sm),
            initial_pc,
            config: *config,
        };
        unsafe { ioctl::sm_init(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "sm_init", source })?;
        Ok(())
    }

    /// Allocate the DMA bounce buffers used by [`Self::xfer`].
    pub fn config_xfer(&self, sm: u8, dir: u16, buf_size: u16, buf_count: u16) -> Result<()> {
        let args = ioctl::SmConfigXferArgs {
            sm: u16::from(sm),
            dir,
            buf_size,
            buf_count,
        };
        unsafe { ioctl::sm_config_xfer(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "config_xfer", source })?;
        Ok(())
    }

    /// Set pin directions for the SM (1 = output). `mask` selects which
    /// GPIOs to touch. PIO pins default to input, so output signals
    /// must be set here before enabling the SM.
    pub fn set_pindirs(&self, sm: u8, dirs: u32, mask: u32) -> Result<()> {
        let args = ioctl::SmSetPindirsArgs {
            sm: u16::from(sm),
            rsvd: 0,
            dirs,
            mask,
        };
        unsafe { ioctl::sm_set_pindirs(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "sm_set_pindirs", source })?;
        Ok(())
    }

    pub fn set_enabled(&self, sm: u8, enable: bool) -> Result<()> {
        let args = ioctl::SmSetEnabledArgs {
            mask: 1 << sm,
            enable: u8::from(enable),
            rsvd: 0,
        };
        unsafe { ioctl::sm_set_enabled(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "sm_set_enabled", source })?;
        Ok(())
    }

    pub fn clear_fifos(&self, sm: u8) -> Result<()> {
        let args = ioctl::SmClearFifosArgs { sm: u16::from(sm) };
        unsafe { ioctl::sm_clear_fifos(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "clear_fifos", source })?;
        Ok(())
    }

    /// DMA a single ≤[`MAX_XFER_BYTES`] chunk into the SM's TX FIFO.
    /// Blocks until the transfer drains. `data` length must be a
    /// multiple of 4 (whole 32-bit words).
    pub fn xfer(&self, sm: u8, dir: u16, data: &[u8]) -> Result<()> {
        if data.len() > MAX_XFER_BYTES {
            return Err(Error::ChunkTooLarge(data.len()));
        }
        let args = ioctl::SmXferDataArgs {
            sm: u16::from(sm),
            dir,
            data_bytes: data.len() as u16,
            // TO_SM is read-only on the kernel side; the cast-away of
            // const is sound because the kernel copies *from* this buf.
            data: data.as_ptr() as *mut core::ffi::c_void,
        };
        unsafe { ioctl::sm_xfer_data(self.fd(), &args) }
            .map_err(|source| Error::Ioctl { op: "xfer_data", source })?;
        Ok(())
    }

    /// DMA an arbitrarily large word buffer, chunked to the FIFO cap.
    pub fn xfer_all(&self, sm: u8, dir: u16, words: &[u32]) -> Result<()> {
        // Reinterpret as bytes (little-endian; the SM consumes raw
        // 32-bit words and we run on LE aarch64).
        let bytes: &[u8] = bytemuck_cast(words);
        for chunk in bytes.chunks(MAX_XFER_BYTES) {
            self.xfer(sm, dir, chunk)?;
        }
        Ok(())
    }
}

/// `&[u32]` → `&[u8]` without a dependency. Safe: `u32` has no padding
/// and any bit pattern is a valid `u8`; alignment of the result (1) is
/// weaker than the source.
fn bytemuck_cast(words: &[u32]) -> &[u8] {
    // SAFETY: see doc comment.
    unsafe { core::slice::from_raw_parts(words.as_ptr().cast::<u8>(), words.len() * 4) }
}
