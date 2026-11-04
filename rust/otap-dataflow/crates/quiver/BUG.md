# A gateway kill in the middle of a WAL rotation restarts the WAL stream at position 0

## Summary

Quiver rotates its write-ahead log (WAL) in two steps: it renames the active file `wal` to `wal.N`,
then creates a new, empty `wal` and writes a header into it that says "this file starts at WAL
position P", where P is where `wal.N` ends. If the process is killed between those two steps, the
restart finds `wal.N` plus an empty `wal`. `WalWriter::open` treats any empty active file as a
brand-new WAL and writes a header that starts at position **0**.

For a short while nothing goes wrong, because while `wal.N` is still on disk the writer takes the
active file's start from `wal.N`. Replay works and the first segment flush succeeds. That flush moves
the consumer cursor past `wal.N`, so `wal.N` is purged. From then on the writer takes the active
file's start from the header, which is 0. Every new entry gets a WAL position far behind the
persisted cursor, so every later segment flush is rejected with "invalid consumer cursor: safe
offset regressed".

## More Detailed

1. Before the crash: wal holds the history, covering WAL positions [0, P). Rotation renames it to wal.N, which is already complete because it is the old file under a new name. The new wal and its header never reach the disk.
2. Restart: WalWriter::open finds wal missing or empty and writes a header saying "starts at 0". The cursor sidecar holds whatever was last saved. In the test that is P, because run 1 flushed everything.
3. Replay: replay reads wal.N from the cursor onward and puts any entries past the cursor into the open segment. In the test there are none.
4. Live ingest (m-0): wal.N is still present, so the writer numbers m-0 from wal.N's end. That gives position P, which is correct.
5. First seal succeeds: the cursor moves to just past m-0, which is at least P, and is saved. Because the cursor has now passed wal.N's end, wal.N is purged.
6. Next ingest (m-1): with no rotated file left, the writer uses the header value of 0. m-1 is numbered from about 0 instead of about P.
7. Second seal fails: its cursor is about 0, which is below the saved cursor of about P, so the cursor update  is rejected with "safe offset regressed". Every later seal fails the same way until we catch up to P.
8. We only notify subscribers after the cursor update succeeds so any new segments we attempt to seal are orphaned and unexported until a restart does a scan for orphaned files.
9. If we write enough data to catch back up to offset `P` then we will be able to seal new segments again
