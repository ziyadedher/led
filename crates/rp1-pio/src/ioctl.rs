//! Raw `/dev/pio0` ioctl ABI.
//!
//! Mirrors `include/uapi/misc/rp1_pio_if.h` from `raspberrypi/linux`
//! `rpi-6.12.y`. Magic = 102 (`'f'`). The driver rejects any call
//! whose `_IOC_SIZE` doesn't equal the native struct size, so every
//! struct here carries a compile-time size assertion against the
//! kernel's layout. 64-bit (aarch64) only: `*mut c_void` is 8 bytes.

use std::os::fd::RawFd;

use nix::ioctl_write_ptr;

pub const PIO_IOC_MAGIC: u8 = 102;

/// `(uint16_t)~0` — let the driver place the program anywhere. We load
/// at origin 0 instead (absolute jump targets), so this is reference
/// documentation of the ABI sentinel rather than a value we pass.
#[allow(dead_code)]
pub const ORIGIN_ANY: u16 = 0xFFFF;
pub const RP1_GPIO_FUNC_PIO: u16 = 7;
pub const INSTRUCTION_COUNT: usize = 32;

/// Transfer direction for `SM_XFER_DATA` / `SM_CONFIG_XFER`.
pub const DIR_TO_SM: u16 = 0;
#[allow(dead_code)]
pub const DIR_FROM_SM: u16 = 1;

/// SM PIO config registers (RP2040-identical bit layout). Build the
/// words via [`crate::config::SmConfig`].
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PioSmConfig {
    pub clkdiv: u32,
    pub execctrl: u32,
    pub shiftctrl: u32,
    pub pinctrl: u32,
}
const _: () = assert!(core::mem::size_of::<PioSmConfig>() == 16);

#[repr(C)]
pub struct AddProgramArgs {
    pub num_instrs: u16,
    pub origin: u16,
    pub instrs: [u16; INSTRUCTION_COUNT],
}
const _: () = assert!(core::mem::size_of::<AddProgramArgs>() == 68);

#[repr(C)]
pub struct SmClaimArgs {
    pub mask: u16,
}
const _: () = assert!(core::mem::size_of::<SmClaimArgs>() == 2);

#[repr(C)]
pub struct SmInitArgs {
    pub sm: u16,
    pub initial_pc: u16,
    pub config: PioSmConfig,
}
const _: () = assert!(core::mem::size_of::<SmInitArgs>() == 20);

#[repr(C)]
pub struct SmSetEnabledArgs {
    pub mask: u16,
    pub enable: u8,
    pub rsvd: u8,
}
const _: () = assert!(core::mem::size_of::<SmSetEnabledArgs>() == 4);

#[repr(C)]
pub struct SmClearFifosArgs {
    pub sm: u16,
}
const _: () = assert!(core::mem::size_of::<SmClearFifosArgs>() == 2);

#[repr(C)]
pub struct SmConfigXferArgs {
    pub sm: u16,
    pub dir: u16,
    pub buf_size: u16,
    pub buf_count: u16,
}
const _: () = assert!(core::mem::size_of::<SmConfigXferArgs>() == 8);

/// `data` is a userptr; the kernel copies it into DMA bounce buffers.
/// On aarch64 the pointer is 8-byte aligned, so there are 2 bytes of
/// implicit padding after `data_bytes` — `#[repr(C)]` inserts it; do
/// not hand-pack. Total size 16.
#[repr(C)]
pub struct SmXferDataArgs {
    pub sm: u16,
    pub dir: u16,
    pub data_bytes: u16,
    pub data: *mut core::ffi::c_void,
}
const _: () = assert!(core::mem::size_of::<SmXferDataArgs>() == 16);

#[repr(C)]
pub struct SmSetPindirsArgs {
    pub sm: u16,
    pub rsvd: u16,
    pub dirs: u32,
    pub mask: u32,
}
const _: () = assert!(core::mem::size_of::<SmSetPindirsArgs>() == 12);

#[repr(C)]
pub struct GpioInitArgs {
    pub gpio: u16,
}
const _: () = assert!(core::mem::size_of::<GpioInitArgs>() == 2);

#[repr(C)]
pub struct GpioSetFunctionArgs {
    pub gpio: u16,
    pub func: u16,
}
const _: () = assert!(core::mem::size_of::<GpioSetFunctionArgs>() == 4);

#[repr(C)]
pub struct GpioSetArgs {
    pub gpio: u16,
    pub value: u16,
}
const _: () = assert!(core::mem::size_of::<GpioSetArgs>() == 4);

// `_IOW(102, nr, T)` wrappers. nix computes the request as
// `request_code_write!(MAGIC, nr, size_of::<T>())`, matching the
// kernel's `_IOC_SIZE` check given the size asserts above.
ioctl_write_ptr!(add_program, PIO_IOC_MAGIC, 11, AddProgramArgs);
ioctl_write_ptr!(sm_claim, PIO_IOC_MAGIC, 20, SmClaimArgs);
ioctl_write_ptr!(sm_unclaim, PIO_IOC_MAGIC, 21, SmClaimArgs);
ioctl_write_ptr!(sm_init, PIO_IOC_MAGIC, 30, SmInitArgs);
ioctl_write_ptr!(sm_clear_fifos, PIO_IOC_MAGIC, 33, SmClearFifosArgs);
ioctl_write_ptr!(sm_set_enabled, PIO_IOC_MAGIC, 37, SmSetEnabledArgs);
ioctl_write_ptr!(sm_set_pindirs, PIO_IOC_MAGIC, 36, SmSetPindirsArgs);
ioctl_write_ptr!(sm_drain_tx, PIO_IOC_MAGIC, 45, SmClearFifosArgs);
ioctl_write_ptr!(sm_config_xfer, PIO_IOC_MAGIC, 0, SmConfigXferArgs);
ioctl_write_ptr!(sm_xfer_data, PIO_IOC_MAGIC, 1, SmXferDataArgs);
ioctl_write_ptr!(gpio_init, PIO_IOC_MAGIC, 50, GpioInitArgs);
ioctl_write_ptr!(gpio_set_function, PIO_IOC_MAGIC, 51, GpioSetFunctionArgs);
ioctl_write_ptr!(gpio_set_drive_strength, PIO_IOC_MAGIC, 57, GpioSetArgs);

/// Sanity: the request encoding matches the kernel's `_IOW(102, …)`.
/// `request_code_write!` is what the macros above expand to; this
/// pins the dir(=1)/magic/size/nr packing so a nix-version change
/// can't silently shift it.
#[cfg(test)]
mod tests {
    use super::*;
    use nix::request_code_write;

    #[test]
    fn request_codes_match_kernel_iow() {
        // _IOW(102, 1, SmXferDataArgs{size 16}) on asm-generic:
        // (1<<30) | (16<<16) | (102<<8) | 1
        let expected =
            (1u32 << 30) | ((16u32) << 16) | ((PIO_IOC_MAGIC as u32) << 8) | 1;
        let got = request_code_write!(PIO_IOC_MAGIC, 1, core::mem::size_of::<SmXferDataArgs>()) as u32;
        assert_eq!(got, expected);
    }
}

// Re-exported so the wrappers are reachable; `RawFd` keeps signatures
// honest at call sites.
pub type Fd = RawFd;
