# Segment file deletions are never made durable

## Status

Fixed. Found with the turmoil simulator only; there is no real-filesystem
reproduction, because it depends on a power loss discarding directory updates
that were never fsynced. The root cause of the observed hang is inferred (see
below), not traced end to end.

## Summary

`SegmentStore::delete_segment` removes a segment file with `remove_file` and
never fsyncs the `segments/` directory. On POSIX, removing a directory entry is
only durable once the directory itself is synced, so after a power loss the
deleted segment files can reappear. This is the same class of gap as `BUG3.md`
(directory entries never synced) and the WAL-purge half of `BUG6.md`, on a
separate code path: completed-segment cleanup in `maintain()` and `ingest()`,
DropOldest force-drops, and max-age expiry all delete without a sync.

Effects:

- Reclaimed segments come back after a crash. Subscribers are offered bundles
  they had already durably acked (see "Related" below) and cleanup has to redo
  the same deletions after every restart.
- On one simulator seed the engine stopped making progress entirely: across
  more than 860 restarts the trace shows the same block of `SEG_DELETE` lines
  for segments 27-46 repeated, and no new segment was ever finalized. The run
  never completes. With the fix the seed passes in seconds.

## More Detailed

1. Subscribers ack all bundles in a range of segments; `maintain()` (or the
   budget cleanup in `ingest()`) deletes the segment files.
2. The deletions sit in the directory's unsynced state.
3. Power is lost. The deletions are discarded; the files exist again.
4. Restart: the segment scan registers the resurrected files, so cleanup has to
   delete them again -- and the cycle repeats if a crash keeps landing before
   anything syncs `segments/`.

Why the hang was a permanent loop rather than just repeated work is not fully
established; the fix removed it and no further investigation was done.

## Reproduction

```text
QUIVER_SIM_SEED=39 QUIVER_SIM_CRASH_PROB=0.10 QUIVER_SIM_INGESTS=150 \
QUIVER_SIM_CHECKPOINT=10 QUIVER_SIM_BUDGET=200000 QUIVER_SIM_DEFER_EVERY=4 \
QUIVER_SIM_MAINTAIN_EVERY=3 QUIVER_SIM_TORN_BLOCK=256 QUIVER_SIM_RANDOM_SYNC=0.3 \
QUIVER_SIM_TRACE=1 \
CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
cargo test -p otel-arrow-dfe-quiver explore_crash_consistency -- --nocapture
```

Before the fix this never finishes and repeats the same `SEG_DELETE` block on
every restart.

## Related: durably acked segments redelivered

When a completed segment's deletion is lost, its file outlives its entry in the
subscriber progress file (completed segments are dropped from progress). On
restart, `SubscriberRegistry::open` skipped segments below the persisted
boundary, and `activate()` then re-added every available segment the subscriber
did not track -- as fully unacked. Bundles that were durably acknowledged were
delivered again. This is duplicate delivery, not loss (quiver is
at-least-once), but it contradicts the persisted progress.

Reproduced through the public API by
`engine::tests::durably_acked_segments_are_not_redelivered_after_restart`
(restores the deleted segment files to model the lost deletions). Fixed in
`subscriber/registry.rs` by tracking such segments as fully resolved instead of
not tracking them; cleanup then removes them.

## Fix

`SegmentStore::sync_segment_dir()` fsyncs the segment directory;
`QuiverEngine::sync_segment_deletions()` calls it after deletions in
`maintain()` and in both budget paths of `ingest()` (completed-segment cleanup
and DropOldest). A failed sync is logged, not returned: a deletion that is not
durable is redone by a later cleanup, so the sync only narrows the window.
