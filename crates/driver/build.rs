//! Embed `CARGO_PKG_VERSION` (with `-dirty` suffix on a dirty tree)
//! into the binary so the dash can flag stale deployments.

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
