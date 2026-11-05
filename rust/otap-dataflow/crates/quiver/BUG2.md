# Reopening the WAL after a partial purge restarts the surviving rotated files at position 0

## Summary

Quiver keeps a history of rotated WAL files `wal.1`, `wal.2`, ... Each rotated
file's header records the WAL position it starts at, so even after older files
are purged the survivors still know where they sit in the logical WAL stream.
When the writer reopens, `reload_rotated_files` rebuilds each rotated file's end
position by adding up file lengths **starting from 0**, and it never reads the
start position stored in the header. As long as `wal.1` is still present that
happens to be correct, because the stream really does start at 0. But once the
consumer cursor has advanced past `wal.1` and `wal.1` has been purged, the oldest
file left on disk is `wal.2`, which starts at some position P1 > 0. On reopen the
writer places `wal.2` as if it started at 0, so it comes out P1 too low. The
active file takes its start from the end of the last rotated file, so the active
file's start is understated by P1 as well.

No crash is required. A clean shutdown and reopen is enough. After the reopen
every new entry is numbered about P1 behind where it should be, so the next
segment seal persists a cursor below the one already saved and is rejected with
"invalid consumer cursor: safe offset regressed", exactly like the
rotation-crash bug in `BUG.md`. The segment that failed to seal is never handed
to subscribers.

This is an independent root cause from `BUG.md`. `BUG.md` needs a kill in the
middle of a rotation to leave an empty active file; this bug needs only a restart
while rotated files remain after a partial purge. The two can also compound: a
fix for `BUG.md` that recovers the active file's start from the rotated files is
itself wrong unless those rotated files are placed correctly, which is what this
bug breaks.

## More Detailed

1. Before: the history spans `wal.1`, `wal.2`, `wal.3` plus the active `wal`.
   Each rotated header records its own start: `wal.1` at 0, `wal.2` at P1,
   `wal.3` at P2.
2. The consumer cursor advances past the end of `wal.1` and the cursor is
   persisted. Because the cursor now covers all of `wal.1`, `wal.1` is purged.
   `wal.2` and `wal.3` remain and still carry their correct header starts P1 and
   P2.
3. Clean shutdown and reopen. Nothing is lost or truncated; this is an ordinary
   restart with a correct on-disk state.
4. `reload_rotated_files` discovers `wal.2` and `wal.3` and recomputes positions
   by summing data lengths from 0: it assigns `wal.2` an end of about
   `len(wal.2) - header`, ignoring the P1 in its header. Every surviving file is
   now shifted down by P1, the logical size of the purged `wal.1`.
5. `active_wal_position_start()` returns the last rotated file's end, which is now
   P1 too low. The active file's start regresses by P1.
6. The next append is numbered from that understated start, so its WAL position
   lands about P1 below the persisted cursor.
7. The seal for that entry persists a cursor below the saved cursor and is
   rejected with "safe offset regressed". Every later seal fails the same way
   until the stream catches back up past the saved cursor.
8. As in `BUG.md`, subscribers are only notified after the cursor update
   succeeds, so the segments that fail to seal are orphaned and unexported until
   a later restart scans for orphaned files.

## Reproduction

`wal::tests::partial_purge_then_clean_reopen_does_not_regress_cursor` reproduces
this with no crash: it rotates to produce `wal.1`/`wal.2`/`wal.3`, advances the
cursor to purge only `wal.1`, cleanly closes and reopens the writer, then appends
one entry. On current code the entry is numbered 531 bytes too low -- exactly the
logical size of the purged `wal.1` -- and the following `persist_cursor` is
rejected.

The turmoil crash-injection harness (`turmoil_sim`) also reaches this bug. On the
seeds that need both candidate fixes (for example `QUIVER_SIM_SEED=0`), applying
only the `BUG.md` fix (`QUIVER_SIM_FIX_A=1`) leaves a different cursor error,
`safe offset beyond wal tail`; the failure clears only once the rotated files are
placed from their headers (`QUIVER_SIM_FIX_B=1`).

## Candidate fix

In `reload_rotated_files`, take each rotated file's end from the start position
recorded in its header plus its data length, rather than accumulating lengths
from 0. The same correction is what lets the `BUG.md` fix recover the active
file's start from the surviving rotated files.
