# Raspberry Pi 5 (RP1) HUB75 backend — design + reference

## Why this exists

Every Pi from the original Pi 1 through the Pi 4 exposed GPIO as a
memory-mapped BCM SoC peripheral; a tight CPU loop (or DMA) writing
those registers drives HUB75. `rpi-led-panel` (the Rust port of
hzeller's C++ library) does exactly that, and it's what the Pi Zero W
fleet runs.

The **Pi 5 moved all I/O — including GPIO — onto a separate companion
chip, RP1**, attached over PCIe. The old BCM register addresses don't
exist. `rpi-led-panel` 0.5.1 fails at model detection
(`Failed to automatically determine Raspberry Pi model`) and never
even reaches GPIO.

The correct way to drive HUB75 on the Pi 5 is the **RP1 PIO block**: a
Pico-style programmable I/O state machine. The CPU packs each frame
into a bit-plane command stream and DMAs it into the PIO FIFO; the
state machine clocks the pixel bits out with hardware-deterministic
timing and near-zero CPU. This is *better* than the Pi 4 approach
(less CPU, tighter timing), not a workaround.

We implement this **natively in Rust** — no C/C++/FFI — so the build
stays a single pure-Rust cross-compile and the binary is small. The
PIO program is assembled with `pio-rs`; the `/dev/pio0` device is
driven by our own minimal ioctl wrapper (`crates/rp1-pio`).

## Architecture

```
crates/rp1-pio          generic /dev/pio0 userspace wrapper (no HUB75 knowledge)
crates/driver/src/
  model.rs              runtime Pi-model detection → pick backend
  color_order.rs        backend-neutral RGB channel order
  sink.rs               MatrixSink trait + TerminalMatrixSink + BCM sink (rpi-led-panel)
  sink/rp1.rs           HUB75 encoder + Rp1PioSink (the new backend)
```

`build_sink` (in `main.rs`) detects the board at startup: Pi 5 → RP1
PIO sink (`rpi5` feature), everything else → BCM sink (`rpi` feature).
The aarch64 image builds both features so one binary covers Pi 3/4/5;
the armv6 Pi Zero W image builds only `rpi`.

---

## Reference A — `/dev/pio0` ioctl ABI

Source: `raspberrypi/linux` `rpi-6.12.y` —
`include/uapi/misc/rp1_pio_if.h` (authoritative), `drivers/misc/rp1-pio.c`,
`include/linux/pio_rp1.h`; reference consumer `raspberrypi/utils` `piolib/`.

- **Magic** `PIO_IOC_MAGIC = 102` (`'f'`). Every request is
  `_IOC(dir, 102, nr, sizeof(struct))`. The driver rejects the call
  with `-EINVAL` unless `_IOC_SIZE(req) == sizeof(native struct)` —
  **struct sizes must match exactly** (static-assert them).
- **64-bit only.** Build aarch64; `void *` in structs is 8 bytes.
  Ignore the driver's 32-bit compat structs.
- **No `CAP_*`** — access gated by `/dev/pio0` file perms (root or a
  `gpio`-group udev rule).
- Handlers that return `> 0` copy that many bytes back (OUT params:
  `SM_GET`, `SM_FIFO_STATE`).

Key request numbers (nr), all dir=`_IOW` unless noted:

| nr | name | struct | note |
|----|------|--------|------|
| 0  | SM_CONFIG_XFER | config_xfer_args | set up DMA bounce buffers |
| 1  | SM_XFER_DATA | xfer_data_args | **bulk DMA data path** (hot loop) |
| 10/11 | CAN_ADD/ADD_PROGRAM | add_program_args | mailbox; `origin=0xFFFF`=auto |
| 20/21/22 | SM_CLAIM/UNCLAIM/IS_CLAIMED | sm_claim_args | `mask=1<<sm` |
| 30 | SM_INIT | sm_init_args | mailbox; loads config+pc |
| 31 | SM_SET_CONFIG | sm_set_config_args | |
| 37 | SM_SET_ENABLED | sm_set_enabled_args | mailbox |
| 41 | SM_PUT | sm_put_args | **per-word mailbox — too slow for pixels** |
| 50 | GPIO_INIT | gpio_init_args | |
| 51 | GPIO_SET_FUNCTION | gpio_set_function_args | `fn=7` = PIO |
| 57 | GPIO_SET_DRIVE_STRENGTH | gpio_set_args | pad drive |

**Data path:** `SM_PUT` (nr 41) is a per-word firmware mailbox
round-trip — never use it for pixel data. `SM_XFER_DATA` (nr 1) copies
a userptr into pre-allocated DMA-coherent bounce buffers and runs HW
DMA into the TX FIFO synchronously (blocks until drained). `data_bytes`
is `u16` → cap chunks at 65532 (largest mult of 4 ≤ 65535), or use
`SM_XFER_DATA32` (nr 2). Run the xfer on a dedicated thread for a
double-buffered pipeline (as Adafruit Piomatter does).

**Config registers** (build the `clkdiv/execctrl/shiftctrl/pinctrl`
words yourself; identical bit layout to RP2040 PIO SM regs):
- `clkdiv = (div_int << 16) | (div_frac << 8)`
- `shiftctrl`: AUTOPULL @17, OUT_SHIFTDIR @19, PULL_THRESH @25 (5b),
  FJOIN_TX @30
- `pinctrl`: OUT_BASE @0 (5b), SIDESET_BASE @10 (5b), OUT_COUNT @20
  (6b), SIDESET_COUNT @29 (3b)
- `execctrl`: WRAP_BOTTOM @7, WRAP_TOP @12, SIDE_EN @30

Limits: 32 instructions max, 4 SMs, 28 PIO GPIOs (0–27), FIFO depth 8
(with FJOIN). `RP1_GPIO_FUNC_PIO = 7`, `RP1_PIO_ORIGIN_ANY = 0xFFFF`,
`dir`: 0 = TO_SM (TX), 1 = FROM_SM.

**Call sequence:** open → ADD_PROGRAM(auto) → SM_CLAIM → per-pin
GPIO_INIT + GPIO_SET_FUNCTION(7) (+ drive strength) → SM_INIT(pc,
config) → SM_CONFIG_XFER (buf_size=65532, buf_count=3, TO_SM) →
SM_SET_ENABLED → loop SM_XFER_DATA. Teardown: SM_SET_ENABLED(0) →
SM_UNCLAIM → close.

(Full `#[repr(C)]` struct definitions live in `crates/rp1-pio`.)

---

## Reference B — HUB75 PIO program + encoder

Source: Adafruit `Adafruit_Blinka_Raspberry_Pi5_Piomatter`
(`src/protomatter.pio`, `src/include/piomatter/{piomatter,render,pins}.h`);
hzeller `rpi-rgb-led-matrix` `lib/rp1/rp1_pio_backend.cc` (byte-identical
vendored program). For the Adafruit RGB Matrix Bonnet, OE is active-LOW
(`oe_active = 0`).

### PIO program (~10 instructions)

```
.side_set 1 opt              ; 1 side-set bit -> CLK (GPIO17)
.wrap_target
top:
    out x, 1                 ; tag bit (MSB of the 32-bit word)
    out y, 31                ; 31-bit count/delay into Y
    jmp !x, do_delay         ; tag 0 = delay, tag 1 = data
data_loop:
    out pins, 32             ; present GPIO word, CLK low
    jmp y--, data_loop side 1 ; CLK high while shifting; Y = sample count
.wrap
do_delay:
    out pins, 32             ; present hold word
delay_loop:
    jmp y--, delay_loop      ; spin Y cycles, CLK low
    jmp top
```

SM config: **OUT shift LEFT** (the `.pio` "shift right" comment is
stale — trust the code), autopull on, threshold 32. Side-set 1 opt →
CLK base GPIO17. `out` base GPIO0, count 28. FJOIN_TX. Target 27 MHz
PIO clock = 13.5 MHz pixel clock (2 PIO cycles/pixel); `div =
clk_sys / 27e6 / gpio_slowdown`.

### Pin layout — the key constraint (and why it's easy)

`out pins, 28` writes GPIO 0–27, and **each signal sits at its native
BCM bit position** in a full 32-bit word the CPU pre-bakes. No
consecutive-pin remapping. Only CLK is side-set (not in the word).
Bonnet bit positions:

```
R1=5  G1=13 B1=6  R2=12 G2=16 B2=23     (PIN_RGB)
A=22  B=26  C=27  D=20  E=24            (PIN_ADDR, 1/32 scan uses A–E)
OE=4  LAT=21                            CLK=17 (side-set)
```

Encoder builds `word |= 1 << bcm_pin` for each active signal. All used
pins are ≤ 27, so they fit a single `out pins`.

### Word-stream / command encoding

Each 32-bit FIFO word: **bit 31 = tag**. `command_data = 1<<31`,
`command_delay = 0`.
- **Data run:** header `command_data | (N-1)` then exactly `N` GPIO
  sample words; PIO clocks one CLK rising edge per word.
- **Delay:** header `command_delay | (ticks-1)` then **one** GPIO word
  held for `ticks` cycles (CLK low). Used for the OE-on dwell
  (∝ 2^bitplane) and setup gaps. `ticks = max(t/CLOCKS_PER_DELAY -
  DELAY_OVERHEAD, 1)` with `CLOCKS_PER_DELAY=1, DELAY_OVERHEAD=5`.

### Frame sequencing (64×64, 1/32 scan)

CPU builds the whole stream; PIO only clocks samples + counts delays.
Per row-pair `addr` 0..31, per bitplane (MSB→LSB, BCM weights
2^(n-1)..1): clock 64 sample words (R1G1B1 top + R2G2B2 bottom, both
half-panels, carrying the **previous** address bits — pipelined), then
an OE-on dwell delay ∝ bitplane weight × brightness, then OE-blank,
then a LAT pulse word, then advance address. Brightness lives in the
dwell length.

### Color depth / gamma

Framebuffer → RGB10 via a gamma LUT (`max(i, round(1023·(i/255)^2.2))`)
**before** bitplane decomposition. Up to 10 bitplanes; plane `i`
extracts RGB10 bit `9-i` with dwell `2^(n-i-1)` (true BCM). Optional
temporal dithering spreads the lowest planes across frames.

---

## Test harness plan

1. **Encoder unit tests (no hardware).** The frame→command-stream
   encoder is pure logic behind a trait; a `RecordingEncoder` captures
   the exact word stream. Assert: all-black → zero RGB bits + only
   delay words; single white pixel → R1|G1|B1 set on the MSB plane,
   one CLK, address 0; BCM dwell sums to `base·2^i`. This catches the
   whole shift/position bug class with no panel.
2. **On-Pi, no panel.** `just bench-rp1` runs the real `/dev/pio0`
   path against a loopback that hex-dumps the stream; assert <5% CPU
   for 60 s in PIO mode.
3. **Bit-level capture (load-bearing).** Logic analyzer ≥50 MS/s on
   CLK/OE/LAT/A–E/R1G1B1/R2G2B2. The HUB75 clock is 13–27 MHz, so the
   cheap 24 MS/s FX2 clones are too slow — need a Saleae Logic 8 /
   DSLogic. Acceptance: 13–28 MHz clock, ≥100 Hz refresh, no <8 ns
   clock glitches.

## Open risks

- `data_bytes` u16 cap (65532/chunk) — chunk large frames.
- `SM_XFER_DATA` blocks — needs a dedicated xfer thread for
  double-buffering.
- NixOS phase 2: `rp1-pio.ko` is out-of-tree in `raspberrypi/linux`,
  not mainline — pin the Pi kernel fork or wait for upstream.
- Verified present on led-alpha: `/dev/pio0`, `rp1_pio.ko`, firmware
  2025/08/28 (past the PIO floor).
