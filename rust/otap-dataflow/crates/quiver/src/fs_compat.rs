//! Filesystem facade used by quiver so the same production code can run against
//! either the real operating-system filesystem or turmoil's deterministic
//! simulated filesystem.
//!
//! # Why this exists
//!
//! Quiver's durability correctness depends on the exact ordering of writes,
//! `fsync`, directory `fsync`, and `rename`. On a real kernel those orderings
//! are nondeterministic (page-cache writeback, `fsync` timing), which makes
//! crash-consistency bugs extremely hard to reproduce. `BUG.md` describes one
//! such bug: a crash in the middle of a WAL rotation leaves an empty active
//! `wal` whose header is later rewritten starting at position 0.
//!
//! [`turmoil`](https://github.com/tokio-rs/turmoil) ships a simulated
//! filesystem (`turmoil-fs`, exposed through the `unstable-fs` feature) that
//! models POSIX durability explicitly: writes land in a per-host pending state,
//! `sync_all`/`sync_dir` promote them to durable, and a simulated crash discards
//! everything still pending. By routing quiver's filesystem calls through this
//! module we can drive those crashes deterministically from a test.
//!
//! # How it is wired
//!
//! This facade is switched entirely by the `quiver_turmoil` cfg, NOT by a Cargo
//! feature. That is deliberate: CI and `cargo xtask check` build the workspace
//! with `--all-features`, and a feature would silently redirect every existing
//! quiver test (which use real tempdirs) onto the simulated filesystem. A custom
//! cfg is invisible to `--all-features`, exactly like `tokio_unstable`.
//!
//! To build/run the simulation POC:
//!
//! ```text
//! CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
//!   cargo test -p otel-arrow-dfe-quiver turmoil
//! ```
//!
//! # What callers use
//!
//! Instead of `use tokio::fs::{File, OpenOptions}` and `std::fs::*`, modules on
//! the durability-critical path import from here:
//!
//! ```ignore
//! use crate::fs_compat::tokio_fs::{self, File, OpenOptions};
//! use crate::fs_compat::std_fs;
//! use crate::fs_compat::sync_dir;
//! ```
//!
//! On a normal build every symbol resolves to the corresponding `std`/`tokio`
//! item, so there is zero behavioral change. Under `--cfg quiver_turmoil` the
//! same symbols resolve to turmoil's shims.

// -------------------------------------------------------------------------
// Production build: thin re-exports of the real std / tokio filesystem APIs.
// -------------------------------------------------------------------------
#[cfg(not(quiver_turmoil))]
mod imp {
    /// Async filesystem namespace (mirrors `tokio::fs`).
    pub(crate) mod tokio_fs {
        pub(crate) use tokio::fs::{File, OpenOptions, create_dir_all, remove_file, rename};
    }

    /// Synchronous filesystem namespace (mirrors `std::fs`).
    pub(crate) mod std_fs {
        // `metadata`/`set_permissions` are only used on some platforms (the
        // non-unix read-only purge path), so allow unused here.
        #[allow(unused_imports)]
        pub(crate) use std::fs::{File, Permissions, metadata, read_dir, set_permissions};
    }

    /// Fsync a directory so that a rename/create of one of its entries is
    /// durable.
    ///
    /// On real POSIX systems directories cannot be opened as regular files on
    /// all platforms, but `tokio::fs::File::open` on a directory works on Unix
    /// and `sync_all` performs the directory fsync. Non-Unix platforms are a
    /// no-op, matching the behavior quiver already relied on.
    pub(crate) async fn sync_dir(path: &std::path::Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            let dir = tokio::fs::File::open(path).await?;
            dir.sync_all().await?;
        }
        #[cfg(not(unix))]
        let _ = path;
        Ok(())
    }

    /// Whether `path` points at an existing entity.
    ///
    /// Mirrors `std::path::Path::exists`.
    pub(crate) fn path_exists(path: &std::path::Path) -> bool {
        path.exists()
    }
}

// -------------------------------------------------------------------------
// Simulation build: route through turmoil's simulated filesystem shims.
// -------------------------------------------------------------------------
#[cfg(quiver_turmoil)]
mod imp {
    /// Async filesystem namespace (turmoil's `tokio::fs` shim).
    pub(crate) mod tokio_fs {
        pub(crate) use turmoil::fs::shim::tokio::fs::{
            File, OpenOptions, create_dir_all, remove_file, rename,
        };
    }

    /// Synchronous filesystem namespace (turmoil's `std::fs` shim).
    pub(crate) mod std_fs {
        // `metadata`/`set_permissions` are only used on some platforms (the
        // non-unix read-only purge path), so allow unused here.
        #[allow(unused_imports)]
        pub(crate) use turmoil::fs::shim::std::fs::{
            File, Permissions, metadata, read_dir, set_permissions,
        };
    }

    /// Fsync a directory via turmoil's explicit `sync_dir`.
    ///
    /// turmoil models directory entries separately from file data; a freshly
    /// created file is "orphaned" (and removed on crash) until its parent's
    /// directory entry is synced. turmoil cannot open a directory as a `File`,
    /// so it exposes a dedicated `sync_dir` free function for this.
    pub(crate) async fn sync_dir(path: &std::path::Path) -> std::io::Result<()> {
        turmoil::fs::shim::std::fs::sync_dir(path).map_err(std::io::Error::other)
    }

    /// Whether `path` points at an existing entity in the simulated filesystem.
    ///
    /// `std::path::Path::exists` queries the real OS filesystem, which the shim
    /// never touches, so route existence checks through the shim metadata.
    pub(crate) fn path_exists(path: &std::path::Path) -> bool {
        turmoil::fs::shim::std::fs::metadata(path).is_ok()
    }
}

pub(crate) use imp::{path_exists, std_fs, sync_dir, tokio_fs};
