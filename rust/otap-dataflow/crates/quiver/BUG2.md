# Reopening the WAL after a partial purge restarts the surviving rotated files at position 0

## Status

Fixed. `reload_rotated_files` now derives each rotated file's end position from
the start recorded in its header. Reproduced through the public API by
`engine::tests::crash_restart_with_surviving_rotated_wal_files_preserves_delivery`
(real filesystem, no simulator), which failed before the fix with
`InvalidConsumerCursor("safe offset beyond wal tail")` from `flush()`. The
internal `wal::tests::partial_purge_then_clean_reopen_does_not_regress_cursor`
also passes.

## Summary

Quiver keeps a history of rotated WAL files `wal.1`, `wal.2`, ... Each rotated
file's header records the WAL position it starts at, so even after older files
are purged the survivors still know where they sit in the logical WAL stream.
When the writer reopens, `reload_rotated_files` rebuilt each rotated file's end
position by adding up file data lengths **starting from 0**; it opened each file
only to read its header size and never read the start position stored in the
header. As long as `wal.1` is still present that happens to be correct, because
the stream really does start at 0. But once the consumer cursor has advanced
past `wal.1` and `wal.1` has been purged, the oldest file left on disk is
`wal.2`, which starts at some position P1 > 0. On reopen the writer places
`wal.2` as if it started at 0, so it comes out P1 too low.

The active file's own header start is read correctly, but it is only used when
no rotated files exist; otherwise `active_wal_position_start()` takes the end
of the last rotated file, so the active file's start is understated by P1 too.

WAL replay is not affected: `MultiFileWalReader` reads every header and assigns
entries their correct positions. The writer, however, now numbers and validates
positions in a frame shifted down by P1, and the two meet when a segment is
finalized and its cursor is checked by `persist_cursor`.

This is an independent root cause from `BUG.md`, and the two compound: the
`BUG.md` fix recovers the active file's start from the rotated files, which is
only correct once those files are placed from their headers.

## When it triggers

Any restart that does not go through a successful `QuiverEngine::shutdown()`
while a rotated file with a non-zero start is still on disk: power loss, a
kill / OOM / panic, or dropping the engine without calling `shutdown()`. No
crash in any particular window is needed, and nothing has to be lost or
truncated -- the on-disk state is correct.

A successful `shutdown()` finalizes the open segment, persists the cursor at
the end of the WAL, and purges every rotated file, so the bug cannot follow a
graceful shutdown. Earlier versions of this report called the trigger a "clean
shutdown"; that was true only of the internal `WalWriter` test, which drops the
writer without going through the engine.

Rotated files with non-zero starts are the normal steady state: the cursor
trails the open segment, so the rotated files holding its entries survive.

## Symptoms (public API)

What the user sees depends on what the next finalized segment contains:

- **Replayed entries:** their cursors use correct positions, which exceed the
  writer's shifted view of the WAL tail by P1. `flush()` (or any finalization)
  fails with `InvalidConsumerCursor("safe offset beyond wal tail")`. The public
  API test exercises this by flushing the replayed tail on its own. If
  finalization is triggered during replay itself, `QuiverEngine::open` could
  fail the same way (not reproduced).
- **Only live entries:** their cursors use the shifted frame, so validation
  passes unless the persisted cursor is within P1 of the end, in which case it
  fails with `"safe offset regressed"`. That is the symptom the internal
  `WalWriter` test shows. If validation passes, the shifted (too low) cursor is
  persisted.

The symptom is timing-dependent: if replayed entries are finalized together
with new live data, the segment's cursor comes from a live append and the bug
can stay hidden. An earlier version of the public API test passed for exactly
this reason.

## More Detailed

1. Before: the history spans `wal.1`, `wal.2`, `wal.3` plus the active `wal`.
   Each rotated header records its own start: `wal.1` at 0, `wal.2` at P1,
   `wal.3` at P2.
2. A segment is finalized and the cursor is persisted past the end of `wal.1`,
   so `wal.1` is purged. `wal.2` and `wal.3` remain and still carry their
   correct header starts P1 and P2.
3. The process stops without a successful `shutdown()` (e.g. power loss).
4. Reopen: `reload_rotated_files` assigns `wal.2` an end of
   `len(wal.2) - header`, ignoring the P1 in its header. Every surviving file,
   and the active file's start, is shifted down by P1.
5. Replay reads the unfinalized entries with correct positions into the open
   segment.
6. Finalizing that segment presents a cursor P1 beyond the writer's view of the
   tail and is rejected with "safe offset beyond wal tail".

## Reproduction

- `engine::tests::crash_restart_with_surviving_rotated_wal_files_preserves_delivery`
  (public API): flush and purge a prefix, ingest more so rotated files survive,
  `std::mem::forget(engine)` as a power loss, reopen, flush the replayed tail.
- `wal::tests::partial_purge_then_clean_reopen_does_not_regress_cursor`
  (internal): rotates to produce `wal.1`/`wal.2`/`wal.3`, persists a cursor that
  purges only `wal.1`, drops and reopens the writer, then appends one entry. On
  the unfixed code the entry is numbered 531 bytes too low -- exactly the
  logical size of the purged `wal.1`.
- The turmoil harness also reaches it (originally classified with the
  now-removed `QUIVER_SIM_FIX_A` / `QUIVER_SIM_FIX_B` toggles, e.g. seed 0).

## Fix

In `reload_rotated_files`, take each rotated file's end from the start position
recorded in its header plus its data length, rather than accumulating lengths
from 0. The now-unused `WalHeader::read_header_size` is test-only.
