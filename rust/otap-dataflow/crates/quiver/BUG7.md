# A segment deleted by ingest cleanup before progress is flushed wedges the subscriber after a restart

## Status

Fixed. Reproduced through the public API with
`engine::tests::segment_deleted_by_ingest_cleanup_before_progress_flush_does_not_wedge_subscriber`
(real filesystem, no simulator).

## Summary

When disk usage is over the budget's soft cap, `QuiverEngine::ingest()` calls
`cleanup_completed_segments()` to reclaim space. That deletes every segment file
whose bundles all subscribers have acked **in memory**, without first writing
subscriber progress to disk. ARCHITECTURE.md requires the opposite order
("before deleting a segment, all subscriber progress files must be flushed");
`maintain()` follows it, the ingest path does not.

If the process dies after the delete but before the next `maintain()` /
`flush_progress()`, the on-disk progress file still lists that segment as
incomplete. On restart `SubscriberRegistry::open` restores the stale entry,
`next_pending()` hands out a bundle from it, and reading the bundle fails with
`SegmentNotFound`. The subscriber never gets past it: every
`poll_next_bundle` / `next_bundle` call returns "segment N not found", on this
run and every later restart.

No data is lost -- the missing bundles were already acked -- but the
subscriber can no longer consume anything, so everything ingested afterwards
stays undelivered. This needs no special filesystem behavior, only a power
loss or kill in an ordinary window.

## More Detailed

1. A subscriber partially acks segment S and progress is flushed, so the
   progress file records S as incomplete.
2. The subscriber acks the rest of S. Acks only update in-memory state.
3. Disk usage crosses the soft cap. The next `ingest()` runs
   `cleanup_completed_segments()`, sees S complete in memory, and deletes
   `S.qseg`. No progress flush happens.
4. The process is killed before any `maintain()`.
5. Restart: the segment scan does not find S, but the progress file still
   lists S with unacked bundles, and the registry restores that entry as-is.
6. `register_subscriber` / `activate_subscriber` succeed. The first
   `poll_next_bundle` picks a bundle in S and fails with
   `SubscriberError::SegmentNotFound`. Every later poll picks the same bundle
   and fails the same way.

## Reproduction

- `engine::tests::segment_deleted_by_ingest_cleanup_before_progress_flush_does_not_wedge_subscriber`
  drives exactly the steps above with a tight `DiskBudget` and
  `std::mem::forget(engine)` as the power loss. Before the fix it failed with
  `SegmentNotFound { segment_seq: 0 }`.
- The turmoil harness reaches it with a bounded budget, e.g.
  `QUIVER_SIM_BUDGET=200000 QUIVER_SIM_SEED=1 QUIVER_SIM_CRASH_PROB=0.10
  QUIVER_SIM_INGESTS=150 QUIVER_SIM_CHECKPOINT=10`, which failed with
  `INVARIANT4_NEXT_BUNDLE: segment 43 not found`. Ten seeds of the
  "all_hi" sweep hit it; enabling the budget alone was sufficient.

## Fix

When loading progress, entries that reference a segment whose file no longer
exists are treated as complete and skipped, with a warning
(`subscriber/registry.rs`). A missing segment cannot be delivered from, and it
can only be missing because it was completed and deleted (or expired, which
already force-completes it).

Flushing progress before the cleanup in `ingest()` would restore the documented
ordering but adds progress-file I/O to the ingest path. It would also not be
sufficient on its own: a crash between a delete and the next flush leaves the
same state, so the load-time reconciliation is needed regardless.
