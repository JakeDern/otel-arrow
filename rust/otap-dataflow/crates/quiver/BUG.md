# A gateway kill in the middle of a WAL rotation restarts the WAL stream at position 0, and every later buffer flush fails with "safe offset regressed"

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
offset regressed". The segment files are written but never handed to the subscriber, the cursor
never moves, the WAL is never purged, and the disk budget fills. After that the gateway refuses
every batch with "storage at capacity" while it stays up and reports ready.
