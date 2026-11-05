# WAL replay after a crash leaves a committed entry in a gap between the persisted cursor and a lost in-flight segment

## Status

**Not reproduced after the durability fixes; mechanism below is unsupported.**
Kept for the record.

- The described seed passes once `BUG3.md` and `BUG8.md` are fixed.
- The analysis below conflates producer ids with WAL sequence numbers. In this
  run WAL sequences had reset after an early crash and several were reused, so
  nothing ties id 136 to a "boundary entry".
- A segment file is fsynced (and its directory synced) before the cursor is
  persisted, so a persisted cursor can only go backwards if durable state was
  lost or the cursor was clamped because WAL data vanished. The observed
  `cursor_seq` regression therefore points at the missing-directory-sync class
  (`BUG3.md`, `BUG8.md`), not at replay boundary logic. This was not confirmed
  by a trace.
- The command below references `QUIVER_SIM_FIX_A` / `QUIVER_SIM_FIX_B` /
  `QUIVER_SIM_PRECREATE_DATADIR`, which no longer exist or are unnecessary.

## Summary

When a segment is being finalized and the process is killed, the in-flight
segment file is discarded (its write never became durable) and, because the WAL
cursor is only persisted *after* the segment file is durable, the restart replays
the WAL from the last persisted cursor and rebuilds the open segment. This is
supposed to be lossless. But the simulator finds seeds where exactly one
committed id goes missing even though every id was committed and no segment the
subscriber needs was deleted. The signature is a WAL **sequence regression** at
restart: a segment finalized after recovery persists a cursor whose safe sequence
is *lower* than one a pre-crash segment already persisted. The pre-crash segment
that advanced the cursor was lost in the crash, and replay restarts from the
lower persisted cursor, but a single entry at the boundary is covered by neither
the lost segment nor the replayed segment. That entry is committed in the WAL yet
never lands in any surviving segment, so it is never delivered.

The simulator reproduces this deterministically. With the known WAL fixes enabled
(so this is not the BUG/BUG2 cursor-regression-to-error symptom, which those
fixes address):

```text
CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
QUIVER_SIM_FIX_A=1 QUIVER_SIM_FIX_B=1 QUIVER_SIM_PRECREATE_DATADIR=1 \
QUIVER_SIM_SEED=0 QUIVER_SIM_CRASH_PROB=0.05 QUIVER_SIM_INGESTS=200 \
QUIVER_SIM_CHECKPOINT=50 \
cargo test -p otel-arrow-dfe-quiver explore_crash_consistency -- --nocapture
```

This fails invariant L with `committed_max=Some(199) but 1 committed ids never
delivered: [136]`. `QUIVER_SIM_REOPEN_PROBE=1` confirms the loss survives three
extra clean restarts ("genuine loss"). `QUIVER_SIM_TRACE=1` shows the diagnostic
`FLUSH_DONE` cursor sequence running forward and then jumping backward exactly
once (`seg=45 cursor_seq=126` followed by `seg=46 cursor_seq=118`): the post-crash
replay re-flushes an overlapping range, and the single boundary entry is dropped.

## More Detailed

1. During the pump, segments are finalized back to back. A segment (call it the
   "lost" segment) is written and its cursor persisted, advancing the WAL safe
   sequence to S. The rotated WAL covering part of that range is purged.
2. A crash kills the process while the *next* segment is still in flight. That
   next segment file is discarded. Crucially, the cursor the engine replays from
   is the last one that was durably persisted, which reflects the lost segment's
   boundary only partially after recovery reconstructs the rotated-file layout.
3. Restart: WAL replay rebuilds the open segment from the persisted cursor. The
   first segment it finalizes after recovery persists a cursor whose safe
   sequence (118) is below the pre-crash value (126). The ranges overlap on one
   side and leave a one-entry hole on the other.
4. The committed WAL entry for id 136 sits in that hole: it was past the
   persisted replay cursor (so replay skips it) but was only ever materialized in
   the lost pre-crash segment (so no surviving segment contains it).
5. Every other id is delivered; id 136 is never delivered on this run or after
   any number of clean restarts. Invariant L fails.

This differs from BUG4: here no segment the subscriber needs is deleted, and the
distinguishing marker is the WAL sequence regression at restart. BUG4 shows no
sequence regression and loses a whole early segment to cleanup.

## Candidate fixes

- Make the replay cursor and the rebuilt open-segment boundary exactly agree
  after recovery so that reconstructed rotated-file end positions cannot place
  the replay start above a WAL entry that was not durably captured in a segment.
- Persist the segment's covered WAL range atomically with (or before) the cursor
  advance, and on restart reconcile persisted segment ranges against the WAL so
  no committed entry can fall between "already consumed" and "available to
  replay".
