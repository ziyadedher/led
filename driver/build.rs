//! Embed the build's git sha into the driver binary at compile time.
//! Reported to the dash via `panels.driver_version` so we can flag
//! Pis that are running an older binary than the rest of the fleet.

use std::process::Command;

fn main() {
    let sha = Command::new("git")
        .args(["rev-parse", "--short=10", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);

    let version = if dirty { format!("{sha}-dirty") } else { sha };
    println!("cargo:rustc-env=LED_DRIVER_VERSION={version}");

    // Re-run when HEAD or any tracked file changes so the embedded sha
    // tracks the actual binary content.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
}
