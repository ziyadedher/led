//! Per-thread realtime scheduling primitives.
//!
//! HUB75 panels need a tight bit-bang loop with microsecond-level
//! jitter tolerance. The natural fit is `SCHED_FIFO`, but applying it
//! to the whole driver process — e.g. via systemd's
//! `CPUSchedulingPolicy=fifo` — also promotes the tokio runtime
//! workers, `OTel` batch exporter, reqwest pool, and tracing-appender
//! threads. Tokio workers in particular spin on their task queues and
//! don't yield cleanly under FIFO; on a single-core Pi Zero W they
//! starve PID 1 systemd long enough to miss the BCM2835 hardware
//! watchdog (1-min timeout) and the kernel reboots before
//! multi-user.target. See `project_pi_realtime_scheduling.md`.
//!
//! The fix is per-thread: only the matrix render thread sets
//! `SCHED_FIFO` on itself; everyone else stays ``SCHED_OTHER``. The
//! render thread also `mlockall`s its memory so a page fault during
//! a DMA-driven row update can't introduce a stall.
//!
//! All functions soft-fail with a returned error rather than
//! panicking — dev boxes / qemu / containers without `CAP_SYS_NICE`
//! or `RLIMIT_RTPRIO` should still run, just at `SCHED_OTHER` (and
//! probably with visible flicker).

use std::io;

/// Promote the calling thread to `SCHED_FIFO` at the given priority.
///
/// `priority` must be in 1..=99 per `sched(7)`. We default to 50
/// elsewhere in the driver — high enough to preempt `SCHED_OTHER`
/// reliably, low enough that any genuinely critical kernel RT thread
/// (PRIO 99) still wins.
///
/// Requires `CAP_SYS_NICE` (or being root) AND `RLIMIT_RTPRIO >=
/// priority`. The systemd unit sets `LimitRTPRIO=` accordingly; on
/// Linux returns `EPERM` otherwise. Non-Linux targets are a no-op
/// (this matters for the terminal sink in `just dev` on macOS).
#[cfg(target_os = "linux")]
pub fn promote_current_thread_to_fifo(priority: i32) -> io::Result<()> {
    let param = libc::sched_param {
        sched_priority: priority,
    };
    // tid = 0 means "calling thread" in `sched_setscheduler(2)`.
    let rc = unsafe { libc::sched_setscheduler(0, libc::SCHED_FIFO, &raw const param) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "linux"))]
pub fn promote_current_thread_to_fifo(_priority: i32) -> io::Result<()> {
    Ok(())
}

/// Lock the process's current and future memory so the render thread
/// never page-faults mid-frame. Affects the whole process (mlock
/// isn't per-thread), but the only memory we'd otherwise risk paging
/// is the rendering hot path and its scratch buffers — which is
/// exactly what we want resident.
///
/// Requires `RLIMIT_MEMLOCK >= memory-resident-set-size`. The
/// systemd unit sets `LimitMEMLOCK=infinity`; on Linux returns
/// `ENOMEM` otherwise. Non-Linux targets are a no-op.
#[cfg(target_os = "linux")]
pub fn lock_all_memory() -> io::Result<()> {
    let rc = unsafe { libc::mlockall(libc::MCL_CURRENT | libc::MCL_FUTURE) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "linux"))]
pub fn lock_all_memory() -> io::Result<()> {
    Ok(())
}
