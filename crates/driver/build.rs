//! Embed the package version into the driver binary at compile time.
//! Reported to the dash via `panels.driver_version` so we can flag
//! Pis that are running an older release than the rest of the fleet.
//!
//! `CARGO_PKG_VERSION` (the value in `Cargo.toml`) is the source of
//! truth — bump it on releases and the dash's classifyVersions can do
//! a proper semver compare. A `-dirty` suffix is appended when the
//! working tree had uncommitted changes at build time, so a Pi
//! running a hand-rolled binary is visually distinct even if its
//! Cargo.toml version is current.

use std::process::Command;

fn main() {
    let pkg_version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());

    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);

    let version = if dirty {
        format!("{pkg_version}-dirty")
    } else {
        pkg_version
    };
    println!("cargo:rustc-env=LED_DRIVER_VERSION={version}");

    // Re-run when HEAD or any tracked file changes so the dirty flag
    // tracks the actual binary content. (The version comes from
    // Cargo.toml so its mtime suffices for that side.)
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs/heads");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
}
