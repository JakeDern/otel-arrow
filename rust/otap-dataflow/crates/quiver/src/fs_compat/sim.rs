// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

//! Seeded crash oracle for the turmoil simulation build.
//!
//! Every mutating filesystem operation in quiver consults [`maybe_crash`] before
//! it runs. The oracle draws from a per-host, seeded RNG and may decide to
//! "kill" the process at that instant by panicking with [`InjectedCrash`]. The
//! harness ([`crate::turmoil_sim`]) catches that panic, turns it into a turmoil
//! `Sim::crash` + `Sim::bounce`, and keeps pumping data. Because the crash fires
//! BEFORE the mutation touches even turmoil's pending state, it faithfully models
//! a power loss at that exact point.
//!
//! The oracle state is thread-local so that the segment writer's `spawn_blocking`
//! thread (which also enters the simulated filesystem via
//! `turmoil::fs::FsHandle`) can carry the same crash configuration across the
//! thread boundary with [`capture`] / [`CrashGuard`].

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

/// A filesystem operation class, used both to decide crash eligibility and to
/// record where a crash was injected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FsOp {
    /// Opening a file with `create` and/or `truncate` (changes directory entry
    /// or file length).
    OpenMutating,
    /// A positional or streaming write.
    Write,
    /// `set_len` (truncate/extend).
    SetLen,
    /// `sync_data` on a file handle.
    SyncData,
    /// `sync_all` on a file handle.
    SyncAll,
    /// Directory fsync.
    SyncDir,
    /// `rename`.
    Rename,
    /// `remove_file`.
    RemoveFile,
    /// `create_dir_all`.
    CreateDir,
    /// `set_permissions`.
    SetPermissions,
}

impl FsOp {
    /// Human-readable label for crash logs. (Used by the harness reporter.)
    #[allow(dead_code)]
    pub(crate) fn label(self) -> &'static str {
        match self {
            FsOp::OpenMutating => "open(create/truncate)",
            FsOp::Write => "write",
            FsOp::SetLen => "set_len",
            FsOp::SyncData => "sync_data",
            FsOp::SyncAll => "sync_all",
            FsOp::SyncDir => "sync_dir",
            FsOp::Rename => "rename",
            FsOp::RemoveFile => "remove_file",
            FsOp::CreateDir => "create_dir_all",
            FsOp::SetPermissions => "set_permissions",
        }
    }
}

/// The panic payload used for an injected crash. The harness downcasts
/// `Box<dyn Any>` from a caught panic to confirm it was an intentional crash
/// rather than a genuine bug. The fields are informational (carried for
/// debugging / future reporting).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct InjectedCrash {
    /// Which operation was about to run.
    pub(crate) op: FsOp,
    /// The path the operation targeted.
    pub(crate) path: PathBuf,
    /// Which mutating-op number (1-based) in the current incarnation this was.
    pub(crate) op_index: u64,
}

/// One recorded crash point (for the seed summary on a violation). Fields are
/// read by the harness reporter (a separate compilation unit).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct CrashRecord {
    pub(crate) op: FsOp,
    pub(crate) path: PathBuf,
    pub(crate) op_index: u64,
}

/// Shared, cross-incarnation oracle state. Lives in the harness (outside the
/// turmoil host) and is cloned into each incarnation's thread-local slot.
#[derive(Debug)]
pub(crate) struct OracleShared {
    /// Deterministic RNG state (SplitMix64). Advances on every mutating op.
    rng: Mutex<u64>,
    /// Probability in [0,1] of crashing before any given mutating op.
    crash_prob: f64,
    /// When true, the oracle is disabled (final no-crash phase).
    armed: Mutex<bool>,
    /// Count of mutating ops seen in the current incarnation.
    op_counter: Mutex<u64>,
    /// Whether a crash has already been injected and not yet cleared by a
    /// bounce. Used by the debug assertion that no fs op runs post-crash.
    poisoned: Mutex<bool>,
    /// Log of injected crash points across the whole run.
    crash_log: Mutex<Vec<CrashRecord>>,
}

// The harness (a separate compilation unit) drives these; lib-only analysis
// cannot see those uses.
#[allow(dead_code)]
impl OracleShared {
    /// Create a fresh oracle for one seed.
    pub(crate) fn new(seed: u64, crash_prob: f64) -> Arc<Self> {
        Arc::new(Self {
            // Mix the seed so seed 0 is not a degenerate all-zero stream.
            rng: Mutex::new(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1)),
            crash_prob,
            armed: Mutex::new(true),
            op_counter: Mutex::new(0),
            poisoned: Mutex::new(false),
            crash_log: Mutex::new(Vec::new()),
        })
    }

    /// Disarm the oracle (final no-crash phase). Operations still count but never
    /// crash.
    pub(crate) fn disarm(&self) {
        *self.armed.lock() = false;
    }

    /// Re-arm after a disarm (not normally needed; present for completeness).
    #[allow(dead_code)]
    pub(crate) fn arm(&self) {
        *self.armed.lock() = true;
    }

    /// Clear the per-incarnation counters/poison after a `Sim::bounce`.
    pub(crate) fn begin_incarnation(&self) {
        *self.op_counter.lock() = 0;
        *self.poisoned.lock() = false;
    }

    /// Whether a crash was injected in the current incarnation and not cleared.
    pub(crate) fn is_poisoned(&self) -> bool {
        *self.poisoned.lock()
    }

    /// Snapshot of the crash log for reporting.
    pub(crate) fn crash_log(&self) -> Vec<CrashRecord> {
        self.crash_log.lock().clone()
    }

    /// Next SplitMix64 value.
    fn next_u64(&self) -> u64 {
        let mut state = self.rng.lock();
        *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Draw a uniform f64 in [0,1).
    fn next_f64(&self) -> f64 {
        // 53-bit mantissa for a uniform double.
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Decide whether to crash before a mutating op. On a crash, record it and
    /// mark poisoned; the caller panics.
    fn decide(&self, op: FsOp, path: &Path) -> Option<InjectedCrash> {
        let op_index = {
            let mut c = self.op_counter.lock();
            *c += 1;
            *c
        };
        if !*self.armed.lock() {
            // Still advance the RNG so disarmed runs stay on the same stream as
            // armed ones up to the disarm point. We only skip the crash.
            let _ = self.next_f64();
            return None;
        }
        let draw = self.next_f64();
        if draw < self.crash_prob {
            *self.poisoned.lock() = true;
            let record = CrashRecord {
                op,
                path: path.to_path_buf(),
                op_index,
            };
            self.crash_log.lock().push(record);
            Some(InjectedCrash {
                op,
                path: path.to_path_buf(),
                op_index,
            })
        } else {
            None
        }
    }
}

thread_local! {
    /// The oracle active on the current thread, if any. Installed on the host
    /// thread by the harness and on `spawn_blocking` threads via [`CrashGuard`].
    static ORACLE: RefCell<Option<Arc<OracleShared>>> = const { RefCell::new(None) };
}

/// Install `oracle` as the current thread's oracle, returning a guard that
/// removes it on drop. The harness installs this on the host thread for each
/// incarnation.
pub(crate) fn install(oracle: Arc<OracleShared>) -> CrashGuard {
    ORACLE.with(|slot| {
        *slot.borrow_mut() = Some(oracle);
    });
    CrashGuard { _private: () }
}

/// Capture the current thread's oracle so it can be re-installed on another
/// thread (e.g. a `spawn_blocking` worker). Returns `None` if no oracle is
/// installed (normal non-sim execution path should never hit this under cfg).
pub(crate) fn capture() -> Option<Arc<OracleShared>> {
    ORACLE.with(|slot| slot.borrow().clone())
}

/// Guard that removes the thread-local oracle when dropped.
#[must_use = "the crash oracle is only active while this guard is held"]
pub(crate) struct CrashGuard {
    _private: (),
}

impl Drop for CrashGuard {
    fn drop(&mut self) {
        ORACLE.with(|slot| {
            *slot.borrow_mut() = None;
        });
    }
}

/// Consult the crash oracle before a mutating filesystem operation.
///
/// If the oracle decides to crash, this panics with an [`InjectedCrash`] payload
/// (via `panic_any`) and never returns. Otherwise it returns normally and the
/// caller proceeds with the operation.
///
/// If no oracle is installed on this thread (which should not happen for mutating
/// ops under the harness), this is a no-op, so direct unit-test use of the shim
/// without the harness still works.
#[track_caller]
pub(crate) fn maybe_crash(op: FsOp, path: &Path) {
    let oracle = ORACLE.with(|slot| slot.borrow().clone());
    let Some(oracle) = oracle else {
        return;
    };
    // Debug assertion: once poisoned, no further fs op should execute until the
    // harness bounces. Catches harness/bug assumptions (e.g. a Drop that writes
    // after the crash point, or a surviving task).
    debug_assert!(
        !oracle.is_poisoned(),
        "filesystem op {:?} on {} ran after an injected crash and before bounce",
        op,
        path.display()
    );
    if let Some(crash) = oracle.decide(op, path) {
        std::panic::panic_any(crash);
    }
}
