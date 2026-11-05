// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

//! Turmoil deterministic-simulation reproduction of the WAL rotation crash bug
//! described in `crates/quiver/BUG.md`.
//!
//! These tests only compile and run under `--cfg quiver_turmoil`. They route all
//! of quiver's filesystem access through turmoil's simulated filesystem (see
//! [`crate::fs_compat`]) so a crash in the middle of a WAL rotation is driven
//! from turmoil's POSIX durability model -- an unsynced write is discarded on
//! crash -- rather than by hand-crafting the post-crash on-disk state the way
//! the non-sim repro test (`rotation_crash_restart_at_zero_does_not_regress_
//! later_cursor` in `wal/tests.rs`) does.
//!
//! The point of this POC is to evaluate whether turmoil could have *found* this
//! bug. The crash point here (right after the rotation rename + parent-dir sync,
//! before the new active header is synced) is the single durability gap in the
//! rotation path; it is exactly the window a crash-point explorer would probe.
//!
//! Run with:
//!
//! ```text
//! CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
//!   cargo test -p otel-arrow-dfe-quiver turmoil
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use tokio::sync::Notify;
use turmoil::Builder;

use crate::fs_compat::{std_fs, sync_dir, tokio_fs};
use crate::record_bundle::{BundleDescriptor, SlotDescriptor, SlotId};
use crate::wal::writer::test_support::{self as writer_test_support, CrashInjection};
use crate::wal::{FlushPolicy, WalConsumerCursor, WalError, WalWriter, WalWriterOptions};

// A fixture bundle local to the sim tests. The rich fixtures in `wal/tests.rs`
// live in a `#[cfg(test)]` module that is not reachable from this file, so we
// re-create the minimal single-slot bundle used by the repro.
mod fixtures;
use fixtures::single_slot_bundle;

const WAL_PATH: &str = "/data/quiver.wal";

fn logs_descriptor() -> BundleDescriptor {
    BundleDescriptor::new(vec![SlotDescriptor::new(SlotId::new(0), "Logs")])
}

fn rotated_path_for(base: &Path, index: usize) -> PathBuf {
    let mut name = base.as_os_str().to_os_string();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

/// Existence check through the simulated filesystem. `std::path::Path::exists`
/// queries the real OS filesystem, which the shim never touches, so we probe
/// via the shim `metadata` instead.
fn sim_exists(path: &Path) -> bool {
    std_fs::metadata(path).is_ok()
}

/// Header size for a WAL file; needed to convert on-disk file length to logical
/// bytes. Mirrors `wal/tests.rs::test_header_size`.
fn header_size() -> u64 {
    crate::wal::header::WalHeader::new([0u8; 16]).encoded_len()
}

/// Sum of logical (post-header) bytes across the active file and every rotated
/// `wal.N`, read through the simulated filesystem.
fn sim_total_logical_bytes(path: &Path) -> u64 {
    let header = header_size();
    let mut total = std_fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0)
        .saturating_sub(header);
    let mut index = 1;
    while let Ok(m) = std_fs::metadata(rotated_path_for(path, index)) {
        total = total.saturating_add(m.len().saturating_sub(header));
        index += 1;
    }
    total
}

/// Outcome communicated from the simulated host back to the test driver.
#[derive(Default)]
struct SimOutcome {
    /// WAL position just past the archived history (P in BUG.md).
    history_end_position: AtomicU64,
    /// Whether `wal.1` was purged after the first post-restart seal.
    purged_wal1: AtomicBool,
    /// Whether the post-purge `persist_cursor` succeeded (the invariant).
    second_seal_ok: AtomicBool,
    /// Whether the first phase actually reached and tripped the rotation crash.
    reached_crash: AtomicBool,
}

/// Phase of the two-run scenario, shared with the host closure so the same host
/// future can play "before crash" and "after restart" roles.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    BeforeCrash,
    AfterRestart,
}

/// Drives the rotation-crash scenario inside a turmoil simulation for one seed.
///
/// Returns the collected [`SimOutcome`]. The caller asserts the invariant.
fn run_scenario(seed: u64) -> Arc<SimOutcome> {
    // sync_probability(0.0): writes become durable ONLY on explicit
    // sync_all/sync_data/sync_dir. This isolates the bug to quiver's own
    // durability decisions -- the rotation rename is synced, the new active
    // header is not, so the crash deterministically discards exactly that
    // header write.
    let mut builder = Builder::new();
    let _ = builder.rng_seed(seed);
    let _ = builder.fs().sync_probability(0.0);
    let mut sim = builder.build();

    let outcome = Arc::new(SimOutcome::default());
    let phase = Arc::new(std::sync::atomic::AtomicU8::new(Phase::BeforeCrash as u8));
    let notify = Arc::new(Notify::new());

    let host_outcome = outcome.clone();
    let host_phase = phase.clone();
    let host_notify = notify.clone();

    sim.host("quiver", move || {
        let outcome = host_outcome.clone();
        let phase = host_phase.clone();
        let notify = host_notify.clone();
        async move {
            let descriptor = logs_descriptor();
            let hash = [0xD5u8; 16];
            let wal_path = PathBuf::from(WAL_PATH);
            let current = if phase.load(Ordering::SeqCst) == Phase::BeforeCrash as u8 {
                Phase::BeforeCrash
            } else {
                Phase::AfterRestart
            };

            match current {
                Phase::BeforeCrash => {
                    tokio_fs::create_dir_all("/data").await?;
                    sync_dir(Path::new("/data")).await?;

                    let opts =
                        WalWriterOptions::new(wal_path.clone(), hash, FlushPolicy::Immediate)
                            .with_rotation_target(8 * 1024)
                            .with_max_rotated_files(10);
                    let mut writer = WalWriter::open(opts)
                        .await
                        .expect("open writer before crash");

                    // Fire the crash hook after the rotation rename + parent-dir
                    // sync but before the new active header is written/synced.
                    writer_test_support::inject_crash(CrashInjection::AfterRotationRename);

                    let mut crashed = false;
                    for i in 0..1000 {
                        let value = (i as i64).wrapping_mul(seed as i64 + 1);
                        let b =
                            single_slot_bundle(&descriptor, 0x10u8.wrapping_add(i as u8), value);
                        match writer.append_bundle(&b).await {
                            Ok(_) => {}
                            Err(WalError::InjectedCrash(_)) => {
                                crashed = true;
                                break;
                            }
                            Err(other) => panic!("unexpected append error: {other:?}"),
                        }
                    }
                    outcome.reached_crash.store(crashed, Ordering::SeqCst);
                    assert!(
                        sim_exists(&rotated_path_for(&wal_path, 1)),
                        "wal.1 should exist after the mid-rotation crash"
                    );
                    outcome
                        .history_end_position
                        .store(sim_total_logical_bytes(&wal_path), Ordering::SeqCst);

                    // Make sure Drop does not run its sync (it is a no-op under
                    // quiver_turmoil anyway) and leave the writer to be dropped
                    // by the forthcoming crash.
                    writer.test_force_crash();
                }
                Phase::AfterRestart => {
                    let history_end = outcome.history_end_position.load(Ordering::SeqCst);

                    // Large rotation target so no further rotation masks the bug.
                    let opts =
                        WalWriterOptions::new(wal_path.clone(), hash, FlushPolicy::Immediate)
                            .with_rotation_target(1024 * 1024)
                            .with_max_rotated_files(10);
                    let mut writer = WalWriter::open(opts)
                        .await
                        .expect("reopen writer after crash");

                    // First post-restart entry: while wal.1 is present its
                    // position comes from the rotated file's end and is correct.
                    let off_seg = writer
                        .append_bundle(&single_slot_bundle(&descriptor, 0xAA, 7))
                        .await
                        .expect("append after restart");
                    assert_eq!(
                        off_seg.position, history_end,
                        "first post-restart entry must continue from the archived history end"
                    );

                    // Seal: persist cursor past the entry, which purges wal.1.
                    writer
                        .persist_cursor(&WalConsumerCursor {
                            safe_offset: off_seg.next_offset,
                            safe_sequence: off_seg.sequence,
                        })
                        .await
                        .expect("persist first post-restart segment");
                    outcome
                        .purged_wal1
                        .store(writer.purge_count() == 1, Ordering::SeqCst);

                    // wal.1 is gone. With the bug the active header reads 0, so
                    // this entry is numbered near 0 -- behind the persisted
                    // cursor -- and the seal is rejected with "safe offset
                    // regressed".
                    let off_next = writer
                        .append_bundle(&single_slot_bundle(&descriptor, 0xBB, 9))
                        .await
                        .expect("append after purge");
                    let result = writer
                        .persist_cursor(&WalConsumerCursor {
                            safe_offset: off_next.next_offset,
                            safe_sequence: off_next.sequence,
                        })
                        .await;
                    outcome
                        .second_seal_ok
                        .store(result.is_ok(), Ordering::SeqCst);
                }
            }

            notify.notify_one();
            std::future::pending::<()>().await;
            Ok(())
        }
    });

    // Phase 1: run until the host signals it reached the crash point.
    let n = notify.clone();
    sim.client("drive-before", async move {
        n.notified().await;
        Ok(())
    });
    sim.run().expect("phase 1 run");

    // The kill: discards pending (unsynced) writes. The unsynced new active
    // header disappears; the synced rename to wal.1 survives.
    sim.crash("quiver");
    phase.store(Phase::AfterRestart as u8, Ordering::SeqCst);
    sim.bounce("quiver");

    // Phase 2: run the restart and seals.
    let n = notify.clone();
    sim.client("drive-after", async move {
        n.notified().await;
        Ok(())
    });
    sim.run().expect("phase 2 run");

    outcome
}

/// Scenario: Using turmoil's simulated filesystem, a WAL rotation renames `wal`
/// to `wal.1` and makes that rename durable (parent-dir sync), but the process
/// is crashed (`Sim::crash`) before the freshly created active `wal` header is
/// ever synced. On restart the active `wal` is empty, one segment seal purges
/// `wal.1`, then another entry is appended and its cursor persisted.
/// Guarantees: this test DEMONSTRATES the BUG.md defect through turmoil alone --
/// it passes while the bug is present by observing that the post-purge
/// `persist_cursor` is rejected with "safe offset regressed", driven purely from
/// turmoil's durability model (the unsynced new-header write is discarded on
/// crash) rather than by hand-building the post-crash on-disk state. When the
/// underlying bug is fixed this test will start failing, at which point it should
/// be replaced by (or inverted to match)
/// `rotation_crash_fixed_cursor_does_not_regress_under_turmoil`.
#[test]
fn rotation_crash_reproduces_cursor_regression_under_turmoil() {
    let outcome = run_scenario(1);

    assert!(
        outcome.reached_crash.load(Ordering::SeqCst),
        "the rotation crash point should have been reached"
    );
    assert!(
        outcome.history_end_position.load(Ordering::SeqCst) > 0,
        "wal.1 must hold the archived history"
    );
    assert!(
        outcome.purged_wal1.load(Ordering::SeqCst),
        "wal.1 should be purged once the cursor passes it"
    );
    assert!(
        !outcome.second_seal_ok.load(Ordering::SeqCst),
        "POC expectation: with the bug present, persist_cursor after purge is \
         rejected with 'safe offset regressed'. If this assertion fails the bug \
         may be fixed -- flip this test to the fixed-behavior guard."
    );
}

/// Scenario: Seeded exploration. The same rotation-crash workload runs against
/// the simulated filesystem across many RNG seeds; each seed crashes at the one
/// durability gap in the rotation path (after rename + dir-sync, before the new
/// header sync) -- the crash point a randomized crash explorer would select.
/// Guarantees: DEMONSTRATES that a turmoil-based exploration surfaces the bug --
/// it passes while the bug is present by collecting the seeds whose post-purge
/// `persist_cursor` regresses and asserting at least one did. This is the "could
/// turmoil have found it" evidence: the defect is reachable from a seeded crash
/// search, not just a hand-crafted scenario.
#[test]
fn rotation_crash_exploration_finds_cursor_regression_under_turmoil() {
    let mut regressing_seeds = Vec::new();
    for seed in 0..8u64 {
        let outcome = run_scenario(seed);
        assert!(
            outcome.reached_crash.load(Ordering::SeqCst),
            "seed {seed}: rotation crash should trigger"
        );
        if !outcome.second_seal_ok.load(Ordering::SeqCst) {
            regressing_seeds.push(seed);
        }
    }

    assert!(
        !regressing_seeds.is_empty(),
        "expected turmoil exploration to surface the cursor-regression bug, but no seed did; \
         regressing seeds = {regressing_seeds:?}"
    );
}

/// Scenario: Identical to `rotation_crash_reproduces_cursor_regression_under_
/// turmoil`, but asserts the CORRECT post-fix invariant.
/// Guarantees: after `wal.1` is purged the writer still numbers new entries at
/// or beyond the already-persisted cursor, so `persist_cursor` succeeds. This is
/// the regression guard that should pass once the rotation bug is fixed; it is
/// `#[ignore]`d while the bug is present so the POC suite stays green. Run it
/// explicitly with `--ignored` to check fix status.
#[test]
#[ignore = "fails until the WAL rotation-restart-at-zero bug is fixed; see BUG.md"]
fn rotation_crash_fixed_cursor_does_not_regress_under_turmoil() {
    let outcome = run_scenario(1);
    assert!(
        outcome.second_seal_ok.load(Ordering::SeqCst),
        "persist_cursor after purge must not regress with 'safe offset regressed'"
    );
}
