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
use crate::subscriber::SubscriberId;
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

/// Claims and acks every available bundle, returning the delivered ids.
fn drain_ids(engine: &Arc<QuiverEngine>, sub: &SubscriberId) -> Result<Vec<u64>, String> {
    let mut ids = Vec::new();
    while let Some(handle) = engine.poll_next_bundle(sub).map_err(|e| e.to_string())? {
        let batch = handle
            .data()
            .payload(SlotId::new(0))
            .ok_or("bundle missing slot 0")?;
        let col = batch
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .ok_or("id column not Int64")?;
        ids.push(col.value(0) as u64);
        handle.ack();
    }
    Ok(ids)
}

/// Opens the engine and (re)registers + activates the subscriber.
async fn open_with_subscriber(
    config: &QuiverConfig,
    sub: &SubscriberId,
) -> Result<Arc<QuiverEngine>, Box<dyn std::error::Error>> {
    let engine = open_engine(config).await?;
    // Re-registration after a restart is rejected when progress was loaded
    // from disk; the subscriber already exists in that case.
    let _ = engine.register_subscriber(sub.clone());
    engine.activate_subscriber(sub)?;
    Ok(engine)
}

/// Scenario: Using only the public engine API, bundles are ingested (never
/// flushed) until the WAL's first size-triggered rotation, and the process is
/// killed by a turmoil crash in the middle of that rotation -- after the active
/// WAL was renamed to `wal.1` and the rename synced, but before the fresh active
/// WAL and its header exist. The engine is reopened (replaying the history in
/// `wal.1`), one more bundle is ingested and `flush()`ed (which advances the
/// WAL cursor past `wal.1` and purges it), then another bundle is ingested and
/// `flush()`ed. Finally the subscriber drains everything.
/// Guarantees: both post-restart `flush()` calls succeed, every bundle whose
/// `ingest` returned Ok is delivered exactly once, and the bundle whose ingest
/// was interrupted by the crash is delivered at most once. Regressing this
/// (BUG.md) means the restart writes a fresh active WAL header starting at
/// position 0; once `wal.1` is purged, new entries are numbered behind the
/// persisted cursor, so the second `flush()` fails with "invalid consumer
/// cursor: safe offset regressed" and its segment is never delivered.
#[test]
fn rotation_crash_does_not_reject_later_flush() {
    let config = engine_config(WalConfig {
        // Every Ok ingest is fsynced, so it must survive the crash.
        flush_interval: Duration::ZERO,
        // Large enough that many bundles accumulate before the first rotation
        // (wal.1 spans a wide WAL range) and the two post-restart ingests do
        // not rotate again, which would rewrite the active header.
        rotation_target_bytes: std::num::NonZeroU64::new(8 * 1024).expect("nonzero"),
        max_size_bytes: std::num::NonZeroU64::new(4 * 1024 * 1024).expect("nonzero"),
        max_rotated_files: 16,
    });

    let mut sim = build_sim();
    let run = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicBool::new(false));
    // Ids whose ingest returned Ok before the crash.
    let committed = Arc::new(AtomicU64::new(0));

    let host_run = run.clone();
    let host_done = done.clone();
    let host_committed = committed.clone();
    sim.host(HOST, move || {
        let run = host_run.load(Ordering::SeqCst);
        let done = host_done.clone();
        let committed = host_committed.clone();
        let config = config.clone();
        async move {
            let sub = SubscriberId::new("rotation-crash").expect("sub id");
            let engine = open_with_subscriber(&config, &sub).await?;

            if run == 0 {
                // Parks at WalRotationRenamed inside the ingest that triggers
                // the first rotation.
                for id in 0..10_000u64 {
                    engine.ingest(&IdBundle::new(id)).await?;
                    committed.store(id + 1, Ordering::SeqCst);
                }
                return Err(fail("WAL rotation never triggered"));
            }

            let before_crash = committed.load(Ordering::SeqCst);
            let m0 = 1_000_000u64;
            let m1 = 1_000_001u64;

            // Seals the replayed history plus m0, moving the WAL cursor past
            // the end of wal.1, which purges it.
            engine.ingest(&IdBundle::new(m0)).await?;
            engine
                .flush()
                .await
                .map_err(|e| fail(format!("first flush after restart failed: {e}")))?;

            // With wal.1 gone, m1 must still be numbered past the cursor.
            engine.ingest(&IdBundle::new(m1)).await?;
            engine
                .flush()
                .await
                .map_err(|e| fail(format!("second flush after restart failed: {e}")))?;

            let mut delivered = drain_ids(&engine, &sub).map_err(fail)?;
            delivered.sort_unstable();
            // The ingest that triggered the rotation crashed before returning,
            // but its entry was already fsynced to the WAL (append happens
            // before rotation), so replay may legitimately deliver it too.
            let in_flight = before_crash;
            let mut expected: Vec<u64> = (0..before_crash).collect();
            if delivered.contains(&in_flight) {
                expected.push(in_flight);
            }
            expected.extend([m0, m1]);
            if delivered != expected {
                return Err(fail(format!(
                    "every committed id must be delivered exactly once \
                     (in-flight id {in_flight} at most once): \
                     expected {expected:?}, got {delivered:?}"
                )));
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
    assert!(
        committed.load(Ordering::SeqCst) > 1,
        "wal.1 must hold a multi-entry history"
    );
    crash_and_restart(&mut sim, parked, &run);
    step_until(&mut sim, "post-restart run", || done.load(Ordering::SeqCst));
}

// ---------------------------------------------------------------------------
// BUG6: purged rotated WAL files that reappear after a crash wedge ingest
// ---------------------------------------------------------------------------

fn wal_path() -> PathBuf {
    PathBuf::from(DATA_DIR).join("wal").join("quiver.wal")
}

fn rotated(path: &Path, id: u64) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{id}"));
    PathBuf::from(name)
}

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
