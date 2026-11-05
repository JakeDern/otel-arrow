# Repeated crashes during segment finalization can wedge ingest at "WAL at capacity" forever

## Summary

Quiver bounds the WAL size. When an append would exceed the cap, the engine
finalizes the current open segment to advance the WAL consumer cursor, purge
rotated files, and free space, then retries the append (see
`append_to_wal_with_capacity_handling`). Freeing WAL space therefore depends
on a segment finalization succeeding. Under a high crash rate, finalization keeps
getting killed before it can persist the cursor and purge, so the cursor never
advances, no WAL space is reclaimed, and the WAL stays full. Every subsequent
ingest fails with `wal at capacity: wal size cap exceeded; advance cursor to
reclaim space`, which is not an injected crash and not a normal
`StorageAtCapacity` backpressure error. The producer, which retries the same id,
can no longer make progress: the engine is wedged until it happens to get a
crash-free window long enough to finalize a segment.

The simulator reproduces this deterministically:

```text
CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
QUIVER_SIM_FIX_A=1 QUIVER_SIM_FIX_B=1 QUIVER_SIM_PRECREATE_DATADIR=1 \
QUIVER_SIM_SEED=0 QUIVER_SIM_CRASH_PROB=0.20 QUIVER_SIM_INGESTS=200 \
QUIVER_SIM_CHECKPOINT=5 \
cargo test -p otel-arrow-dfe-quiver explore_crash_consistency -- --nocapture
```

This fails with `INVARIANT4_INGEST: wal error: wal at capacity: wal size cap
exceeded; advance cursor to reclaim space`. It also appears at crash_prob 0.10
with 200 ingests. It does not appear at low crash probabilities, which is
consistent with a reclamation path that only stalls when finalization is
repeatedly interrupted.

## More Detailed

1. The WAL fills to its cap as ids are ingested.
2. The next append hits the cap. The engine calls `finalize_segment_impl` to
   write the open segment, persist the cursor past its entries, and purge rotated
   WAL files, which is the only way to reclaim WAL space.
3. A crash kills the process during that finalization (segment write, cursor
   sidecar write, or purge) before the cursor advances. Nothing is reclaimed.
4. Restart: WAL replay rebuilds the same full WAL state. The WAL is still at the
   cap. The next ingest again triggers finalization, which is again likely to be
   killed at this crash rate.
5. The loop repeats. Because the WAL never drains, ingest keeps returning
   `wal at capacity`. The engine does not treat this as a hard error and the
   producer retries the same id, so the system is live-locked until a long enough
   crash-free interval lets one finalization complete.

Whether this is a true bug or an expected degraded mode depends on the intended
contract. Two things make it look like a defect rather than clean backpressure:
the error surfaced to the caller is a raw WAL error (not the
`StorageAtCapacity` backpressure variant callers are told to handle), and there
is no forward-progress guarantee: the only reclamation path is itself the thing
that keeps being interrupted, so there is no smaller unit of work that can make
partial progress.

## Candidate fixes

- Give WAL-space reclamation a crash-resilient, incremental path that does not
  require a full segment finalization to complete in one shot (for example,
  persist the cursor advance independently of the segment write once the segment
  bytes are durable, so a later restart can purge even if registration was
  interrupted).
- At minimum, surface the "WAL full, cannot reclaim" condition as the documented
  backpressure error (`StorageAtCapacity`) so callers apply the intended
  backpressure instead of seeing a raw WAL capacity error, and consider sizing
  guidance so the WAL cap cannot be reached before a segment can be finalized.
