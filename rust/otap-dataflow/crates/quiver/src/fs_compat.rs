//! Filesystem facade used by quiver so the same production code can run against
//! either the real operating-system filesystem or turmoil's deterministic
//! simulated filesystem with crash injection.
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
//! everything still pending.
//!
//! # The single wrapper
//!
//! EVERY filesystem access in quiver goes through this module. On a normal build
//! the symbols re-export the real `std::fs` / `tokio::fs` items unchanged, so
//! there is zero behavioral change. Under `--cfg quiver_turmoil` the same
//! symbols resolve to thin wrappers around turmoil's shims that, before each
//! operation which MUTATES the on-disk state (write, set_len, sync, rename,
//! remove, create/truncate open, create_dir, set_permissions), consult a seeded
//! crash oracle (see [`sim`]). The oracle may decide to "kill" the process right
//! before the mutation by panicking with [`sim::InjectedCrash`]; the harness
//! then turns that into a turmoil `Sim::crash` + `Sim::bounce` and continues
//! pumping data. Because the crash fires BEFORE the mutation, the mutation never
//! reaches even the pending state, which is exactly a power loss at that
//! instant.
//!
//! # How it is wired
//!
//! Switched entirely by the `quiver_turmoil` cfg, NOT a Cargo feature: CI and
//! `cargo xtask check` build with `--all-features`, and a feature would silently
//! redirect every existing quiver test (which use real tempdirs) onto the
//! simulated filesystem. A custom cfg is invisible to `--all-features`, exactly
//! like `tokio_unstable`.
//!
//! Run the simulation harness with:
//!
//! ```text
//! CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
//!   cargo test -p otel-arrow-dfe-quiver turmoil
//! ```

// -------------------------------------------------------------------------
// Production build: thin re-exports of the real std / tokio filesystem APIs.
// -------------------------------------------------------------------------
#[cfg(not(quiver_turmoil))]
mod imp {
    /// Async filesystem namespace (mirrors `tokio::fs`).
    pub(crate) mod tokio_fs {
        #[allow(unused_imports)]
        pub(crate) use tokio::fs::{
            File, OpenOptions, create_dir_all, metadata, read, remove_file, rename, set_permissions,
        };
    }

    /// Synchronous filesystem namespace (mirrors `std::fs`).
    pub(crate) mod std_fs {
        // Some items are only used on certain platforms (the non-unix read-only
        // purge path) or by specific call sites, so allow unused here.
        #[allow(unused_imports)]
        pub(crate) use std::fs::{
            File, OpenOptions, Permissions, create_dir_all, metadata, read_dir, remove_file,
            set_permissions,
        };
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
// Simulation build: route through turmoil's simulated filesystem shims, with a
// seeded crash oracle in front of every mutating operation.
// -------------------------------------------------------------------------
#[cfg(quiver_turmoil)]
pub(crate) mod sim;

#[cfg(quiver_turmoil)]
mod imp {
    pub(crate) mod std_fs;
    pub(crate) mod tokio_fs;

    /// Fsync a directory via turmoil's explicit `sync_dir`.
    ///
    /// turmoil models directory entries separately from file data; a freshly
    /// created file is "orphaned" (and removed on crash) until its parent's
    /// directory entry is synced. turmoil cannot open a directory as a `File`,
    /// so it exposes a dedicated `sync_dir` free function for this. This is a
    /// durability-affecting op, so the crash oracle runs first.
    pub(crate) async fn sync_dir(path: &std::path::Path) -> std::io::Result<()> {
        crate::fs_compat::sim::maybe_crash(crate::fs_compat::sim::FsOp::SyncDir, path);
        turmoil::fs::shim::std::fs::sync_dir(path).map_err(std::io::Error::other)
    }

    /// Whether `path` points at an existing entity in the simulated filesystem.
    ///
    /// `std::path::Path::exists` queries the real OS filesystem, which the shim
    /// never touches, so route existence checks through the shim metadata. This
    /// is a pure read, so it never crashes.
    pub(crate) fn path_exists(path: &std::path::Path) -> bool {
        turmoil::fs::shim::std::fs::metadata(path).is_ok()
    }
}

pub(crate) use imp::{path_exists, std_fs, sync_dir, tokio_fs};

/// Creates `path` (and any missing ancestors) and makes the new directory
/// entries durable.
///
/// `create_dir_all` alone only guarantees the directories exist in the page
/// cache: on POSIX a newly created directory entry survives a power loss only
/// once its parent directory has been fsynced. Without this, a crash shortly
/// after `open` can drop the directory (and everything later written into it,
/// even fsynced files).
///
/// Every ancestor and then `path` itself are synced, top-down, so a parent's
/// entry is durable before its child's. Syncing an ancestor that quiver did not
/// create is harmless; failures above `path` are ignored because a pre-existing
/// ancestor may not be readable, in which case it was not created by us and
/// its entry is already durable.
pub(crate) async fn create_dir_all_durable(path: &std::path::Path) -> std::io::Result<()> {
    tokio_fs::create_dir_all(path).await?;
    let mut ancestors: Vec<&std::path::Path> = path
        .ancestors()
        .skip(1)
        .filter(|dir| !dir.as_os_str().is_empty())
        .collect();
    ancestors.reverse();
    for dir in ancestors {
        let _ = sync_dir(dir).await;
    }
    sync_dir(path).await
}
