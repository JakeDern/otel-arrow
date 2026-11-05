# A crash loses segments that were cleaned up before the subscriber durably consumed them

## Summary

Quiver finalizes an open segment to a segment file, persists the WAL consumer
cursor past that segment's WAL entries, and then purges the rotated WAL files the
cursor has passed. Once that happens the segment file is the *only* durable copy
of those bundles. Segment cleanup decides a segment can be deleted from the
in-memory subscriber ack state, but a subscriber's acks only become durable when
its progress file is flushed (at a checkpoint). In between, a subscriber can ack
all the bundles in a segment in memory, the cleanup path can delete the segment
file, and the WAL backing it has already been purged. If the process is then
killed before the subscriber's progress flush reaches disk, the restart finds no
segment file and no WAL entries for those bundles: the acks were rolled back but
the data was already gone. The bundles are committed (ingest returned Ok) yet are
never delivered to the subscriber, on this run or any future restart.

The simulator reproduces this deterministically. With the known WAL fixes
enabled (so this is not a cursor-regression symptom):

```text
CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
QUIVER_SIM_FIX_A=1 QUIVER_SIM_FIX_B=1 QUIVER_SIM_PRECREATE_DATADIR=1 \
QUIVER_SIM_SEED=5 QUIVER_SIM_CRASH_PROB=0.05 QUIVER_SIM_INGESTS=40 \
QUIVER_SIM_CHECKPOINT=15 \
cargo test -p otel-arrow-dfe-quiver explore_crash_consistency -- --nocapture
```

This fails invariant L with `committed_max=Some(39) but 4 committed ids never
delivered: [0, 1, 2, 3]`. `QUIVER_SIM_REOPEN_PROBE=1` confirms the loss survives
three extra clean restarts ("genuine loss"), and `QUIVER_SIM_TRACE=1` shows
segment 0 (the segment holding ids 0..=3) is written once
(`FLUSH_DONE seg=0 cursor_seq=4`) and then deleted (`SEG_DELETE
.../0000000000000000.qseg`) with no WAL sequence regression anywhere in the run.

## More Detailed

1. Ingest ids 0..=3. Each is appended to the WAL (durable) and accumulated into
   the open segment. When the segment reaches its size target it is finalized:
   the file `0000000000000000.qseg` is written and fsynced, the WAL cursor is
   persisted past those entries, and the rotated WAL file that held them is
   purged. The segment file is now the only durable copy.
2. The subscriber claims and acks ids 0..=3. These acks update in-memory state
   only; the subscriber progress file is not written until the next checkpoint.
3. Segment cleanup runs (triggered by budget pressure, ingest, or maintain) and
   sees that every bundle in segment 0 is acked in memory, so it deletes
   `0000000000000000.qseg`. Both durable copies of ids 0..=3 are now gone while
   the ack that justified the delete is still only in memory.
4. The process is killed before the subscriber progress flush is durable.
5. Restart: the segment scan finds no file for segment 0, WAL replay starts after
   the purged entries, and the subscriber's restored progress does not record
   acks for ids 0..=3 (that flush never happened). There is nothing left to
   deliver them from.
6. The final no-crash drain delivers 4..=39 but never 0..=3. Invariant L fails,
   and the loss is permanent across any number of restarts.

## Candidate fixes

- Do not delete a segment file until every subscriber that still needs it has a
  **durable** acknowledgement (flushed progress), not merely an in-memory ack.
  Equivalently, gate `cleanup_completed_segments` on the persisted progress
  floor rather than live state.
- Alternatively, keep the WAL entries for a segment until the segment's bundles
  are durably acked, so a lost segment can always be replayed.
