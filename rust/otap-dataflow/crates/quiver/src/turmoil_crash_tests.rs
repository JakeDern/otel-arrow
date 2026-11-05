// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

//! Deterministic crash reproductions driven by turmoil barriers.
//!
//! Each test runs quiver inside one turmoil host on the simulated filesystem.
//! A `turmoil::barriers::Barrier` with `Reaction::Suspend` parks the host at a
//! named [`CrashPoint`] in production code; the test then calls `Sim::crash`
//! (which discards every filesystem operation that was not yet synced) and
//! `Sim::bounce` (which restarts the host on the same filesystem). No file is
//! edited by hand: the on-disk state after the restart is exactly what a power
//! loss at that line leaves behind.
//!
//! The host closure runs again after the bounce, so it reads a shared run
//! counter to decide whether it is the pre-crash run or the post-restart run.
//! The post-restart run returns `Err` on any failed expectation, which
//! `Sim::step` surfaces as a test failure, and sets a shared flag on success.
//!
//! Run with:
//!
//! ```text
//! CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
//!   cargo test -p otel-arrow-dfe-quiver turmoil_crash_tests -- --nocapture
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use arrow_array::{Int64Array, RecordBatch};
use arrow_schema::{DataType, Field, Schema};
use turmoil::barriers::{Barrier, Reaction, Triggered};

use crate::config::{QuiverConfig, SegmentConfig, WalConfig};
use crate::crash_point::CrashPoint;
use crate::engine::QuiverEngine;
use crate::record_bundle::{BundleDescriptor, PayloadRef, RecordBundle, SlotDescriptor, SlotId};
use crate::segment_store::SegmentReadMode;
use crate::wal::{
    FlushPolicy, WalConsumerCursor, WalError, WalReader, WalWriter, WalWriterOptions,
};
use crate::{DiskBudget, QuiverError};

const HOST: &str = "quiver";
const DATA_DIR: &str = "/data";
/// Upper bound on simulation steps spent waiting for one phase.
const STEP_BUDGET: usize = 10_000;

fn fail(msg: impl Into<String>) -> Box<dyn std::error::Error> {
    msg.into().into()
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// Single-slot bundle whose payload is one row holding `id`.
struct IdBundle {
    descriptor: BundleDescriptor,
    batch: RecordBatch,
}

impl IdBundle {
    fn new(id: u64) -> Self {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false)]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(Int64Array::from(vec![id as i64]))])
            .expect("valid batch");
        Self {
            descriptor: BundleDescriptor::new(vec![SlotDescriptor::new(SlotId::new(0), "Logs")]),
            batch,
        }
    }
}

impl RecordBundle for IdBundle {
    fn descriptor(&self) -> &BundleDescriptor {
        &self.descriptor
    }
    fn ingestion_time(&self) -> SystemTime {
        // Fixed timestamp keeps retention/time paths out of the picture.
        UNIX_EPOCH + Duration::from_secs(1_000)
    }
    fn payload(&self, slot: SlotId) -> Option<PayloadRef<'_>> {
        (slot == SlotId::new(0)).then_some(PayloadRef {
            schema_fingerprint: [0x11; 32],
            batch: &self.batch,
        })
    }
    fn item_count(&self) -> u64 {
        1
    }
}

fn engine_config(wal: WalConfig) -> QuiverConfig {
    QuiverConfig::builder()
        .data_dir(DATA_DIR)
        .wal(wal)
        .segment(SegmentConfig {
            // Never finalize on size or age: only explicit flush() (or the WAL
            // capacity path) seals segments, so each test controls when.
            target_size_bytes: std::num::NonZeroU64::new(64 * 1024 * 1024).expect("nonzero"),
            max_open_duration: Duration::from_secs(86_400),
            ..Default::default()
        })
        .read_mode(SegmentReadMode::Standard)
        .build()
        .expect("config")
}

async fn open_engine(config: &QuiverConfig) -> Result<Arc<QuiverEngine>, QuiverError> {
    QuiverEngine::open(config.clone(), Arc::new(DiskBudget::unlimited())).await
}

// ---------------------------------------------------------------------------
// Simulation driver
// ---------------------------------------------------------------------------

/// Builds a simulation with no network and a long duration budget.
fn build_sim<'a>() -> turmoil::Sim<'a> {
    let mut builder = turmoil::Builder::new();
    let _ = builder.simulation_duration(Duration::from_secs(86_400));
    builder.build()
}

/// Steps `sim` until `cond` holds, failing the test if the host errors or the
/// step budget runs out.
fn step_until(sim: &mut turmoil::Sim<'_>, what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..STEP_BUDGET {
        if cond() {
            return;
        }
        if let Err(e) = sim.step() {
            panic!("host failed while waiting for {what}: {e}");
        }
    }
    panic!("step budget exhausted while waiting for {what}");
}

/// Steps `sim` until the host parks at `barrier`, then returns the handle that
/// keeps it parked.
fn step_until_parked(
    sim: &mut turmoil::Sim<'_>,
    barrier: &mut Barrier<CrashPoint>,
) -> Triggered<CrashPoint> {
    for _ in 0..STEP_BUDGET {
        // The source side sends on an unbounded channel before awaiting the
        // release, so a parked host is visible as a ready message here.
        if let Some(triggered) = poll_barrier(barrier) {
            return triggered;
        }
        if let Err(e) = sim.step() {
            panic!("host failed before reaching the crash point: {e}");
        }
    }
    panic!("step budget exhausted before the host reached the crash point");
}

/// Non-blocking check for a barrier trigger.
fn poll_barrier(barrier: &mut Barrier<CrashPoint>) -> Option<Triggered<CrashPoint>> {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    let mut fut = std::pin::pin!(barrier.wait());
    match fut.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(Some(t)) => Some(t),
        Poll::Ready(None) => panic!("barrier channel closed"),
        Poll::Pending => None,
    }
}

/// Crashes the host while it is parked at a crash point, discarding every
/// unsynced filesystem operation, then restarts it on the same filesystem.
fn crash_and_restart(sim: &mut turmoil::Sim<'_>, parked: Triggered<CrashPoint>, run: &AtomicU64) {
    // Advance the run counter first so the restarted host takes the
    // post-restart path.
    let _ = run.fetch_add(1, Ordering::SeqCst);
    sim.crash(HOST);
    // The parked task was cancelled by the crash; releasing it is a no-op.
    drop(parked);
    sim.bounce(HOST);
}

// ---------------------------------------------------------------------------
// BUG.md: a crash in the middle of WAL rotation restarts the WAL at 0
// ---------------------------------------------------------------------------

fn wal_path() -> PathBuf {
    PathBuf::from(DATA_DIR).join("wal").join("quiver.wal")
}

fn rotated(path: &Path, id: u64) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{id}"));
    PathBuf::from(name)
}

/// WAL position just past the last entry of rotated file `path`, computed from
/// its header start and data length.
fn rotated_end(path: &Path) -> Result<u64, Box<dyn std::error::Error>> {
    Ok(WalReader::open(path)?.wal_position_end()?)
}

/// Scenario: A `WalWriter` accumulates several entries in its active file and
/// the process is killed by a turmoil crash in the middle of the size-triggered
/// rotation -- after `wal` was renamed to `wal.1` and the rename synced, but
/// before the fresh active `wal` and its header exist. After the restart one
/// entry is appended and its cursor persisted (which purges `wal.1`), then a
/// second entry is appended and its cursor persisted.
/// Guarantees: the first post-restart entry continues at the end of `wal.1`,
/// and after `wal.1` is purged the next entry is still numbered past the
/// persisted cursor, so `persist_cursor` is not rejected with "safe offset
/// regressed". Regressing this means a missing active file after a
/// mid-rotation crash restarts the WAL stream at position 0 (BUG.md), so every
/// later segment seal is rejected and its segment is never exported.
#[test]
fn wal_rotation_crash_does_not_restart_wal_at_zero() {
    let mut sim = build_sim();
    let run = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicBool::new(false));

    let host_run = run.clone();
    let host_done = done.clone();
    sim.host(HOST, move || {
        let run = host_run.load(Ordering::SeqCst);
        let done = host_done.clone();
        async move {
            let path = wal_path();
            if run == 0 {
                // A moderate rotation target lets many entries accumulate, so
                // wal.1 spans a wide WAL range [0, P).
                let options = WalWriterOptions::new(path, [0xD5; 16], FlushPolicy::Immediate)
                    .with_rotation_target(8 * 1024)
                    .with_max_rotated_files(10);
                let mut writer = WalWriter::open(options).await?;
                for id in 0..10_000 {
                    // Parks at WalRotationRenamed once a rotation starts.
                    let _ = writer.append_bundle(&IdBundle::new(id)).await?;
                }
                return Err(fail("rotation never triggered"));
            }

            // Post-restart: the crash left wal.1 and no durable active file.
            if crate::fs_compat::path_exists(&path) {
                let len = crate::fs_compat::tokio_fs::metadata(&path).await?.len();
                if len != 0 {
                    return Err(fail(format!(
                        "expected missing/empty active wal after crash, found {len} bytes"
                    )));
                }
            }
            let history_end = rotated_end(&rotated(&path, 1))?;
            if history_end == 0 {
                return Err(fail("wal.1 should hold the pre-crash history"));
            }

            // Large rotation target so no further rotation rewrites the header.
            let options = WalWriterOptions::new(path, [0xD5; 16], FlushPolicy::Immediate)
                .with_rotation_target(1024 * 1024)
                .with_max_rotated_files(10);
            let mut writer = WalWriter::open(options).await?;

            let first = writer.append_bundle(&IdBundle::new(1_000_000)).await?;
            if first.position != history_end {
                return Err(fail(format!(
                    "first post-restart entry at {} but wal.1 ends at {history_end}",
                    first.position
                )));
            }
            writer
                .persist_cursor(&WalConsumerCursor::from_offset(&first))
                .await?;
            if writer.purge_count() != 1 {
                return Err(fail("wal.1 should be purged once the cursor passes it"));
            }

            let second = writer.append_bundle(&IdBundle::new(1_000_001)).await?;
            match writer
                .persist_cursor(&WalConsumerCursor::from_offset(&second))
                .await
            {
                Ok(()) => {}
                Err(e @ WalError::InvalidConsumerCursor(_)) => {
                    return Err(fail(format!(
                        "persist_cursor after purge rejected: {e} (cursor {} vs persisted {})",
                        second.next_offset, first.next_offset
                    )));
                }
                Err(e) => return Err(e.into()),
            }

            done.store(true, Ordering::SeqCst);
            std::future::pending::<()>().await;
            Ok(())
        }
    });

    let mut barrier = Barrier::build(Reaction::Suspend, |p: &CrashPoint| {
        *p == CrashPoint::WalRotationRenamed
    });
    let parked = step_until_parked(&mut sim, &mut barrier);
    drop(barrier);
    crash_and_restart(&mut sim, parked, &run);
    step_until(&mut sim, "post-restart run", || done.load(Ordering::SeqCst));
}

// ---------------------------------------------------------------------------
// BUG6: purged rotated WAL files that reappear after a crash wedge ingest
// ---------------------------------------------------------------------------

/// Number of rotated WAL files currently present.
fn rotated_wal_count() -> usize {
    let path = wal_path();
    (1..=1000u64)
        .filter(|id| crate::fs_compat::path_exists(&rotated(&path, *id)))
        .count()
}

/// Scenario: The engine ingests into a WAL with a small size cap until an
/// append hits the cap, so the engine seals a segment, persists the WAL cursor
/// past every rotated file, and removes them. A turmoil crash lands after the
/// removals but before the WAL directory is fsynced, so every purged rotated
/// file is back on disk after the restart, although the persisted cursor
/// already covers them all. The engine is reopened and keeps ingesting.
/// Guarantees: `ingest` keeps succeeding after the restart. Rotated files the
/// persisted cursor already covers hold no unconsumed data and must not count
/// against the WAL cap. Regressing this wedges the engine permanently (BUG6):
/// replay leaves the open segment empty, every append fails with
/// `WalAtCapacity`, and the capacity path's finalize is a no-op that never
/// persists a cursor or purges anything.
#[test]
fn wal_purge_crash_does_not_wedge_ingest_at_capacity() {
    let cap = 8 * 1024u64;
    let config = engine_config(WalConfig {
        flush_interval: Duration::ZERO,
        rotation_target_bytes: std::num::NonZeroU64::new(1024).expect("nonzero"),
        max_size_bytes: std::num::NonZeroU64::new(cap).expect("nonzero"),
        max_rotated_files: 100,
    });

    let mut sim = build_sim();
    let run = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicBool::new(false));
    let rotated_before_crash = Arc::new(AtomicU64::new(0));

    let host_run = run.clone();
    let host_done = done.clone();
    let host_rotated = rotated_before_crash.clone();
    sim.host(HOST, move || {
        let run = host_run.load(Ordering::SeqCst);
        let done = host_done.clone();
        let rotated_before_crash = host_rotated.clone();
        let config = config.clone();
        async move {
            if run == 0 {
                let engine = open_engine(&config).await?;
                // Ingest until the WAL hits its cap. The engine handles that
                // itself: it seals the open segment, persists the cursor past
                // every rotated file, and removes them -- the first and only
                // purge of this run, so no earlier WAL directory fsync has made
                // other removals durable. It parks at WalPurgeUnsynced there.
                for id in 0..10_000u64 {
                    rotated_before_crash.store(rotated_wal_count() as u64, Ordering::SeqCst);
                    engine.ingest(&IdBundle::new(id)).await?;
                }
                return Err(fail("WAL never reached its cap"));
            }

            // Post-restart: the unsynced removals were discarded. Check before
            // opening the engine, which may legitimately purge covered files.
            let resurrected = rotated_wal_count() as u64;
            let expected = rotated_before_crash.load(Ordering::SeqCst);
            if resurrected != expected {
                return Err(fail(format!(
                    "expected all {expected} purged rotated files to reappear, found {resurrected}"
                )));
            }
            let engine = open_engine(&config).await?;
            for id in 0..8 {
                engine
                    .ingest(&IdBundle::new(1_000_000 + id))
                    .await
                    .map_err(|e| fail(format!("ingest after restart failed: {e}")))?;
            }
            done.store(true, Ordering::SeqCst);
            std::future::pending::<()>().await;
            Ok(())
        }
    });

    let mut barrier = Barrier::build(Reaction::Suspend, |p: &CrashPoint| {
        *p == CrashPoint::WalPurgeUnsynced
    });
    let parked = step_until_parked(&mut sim, &mut barrier);
    drop(barrier);
    assert!(
        rotated_before_crash.load(Ordering::SeqCst) > 1,
        "the purge must cover several rotated files"
    );
    crash_and_restart(&mut sim, parked, &run);
    step_until(&mut sim, "post-restart run", || done.load(Ordering::SeqCst));
}
