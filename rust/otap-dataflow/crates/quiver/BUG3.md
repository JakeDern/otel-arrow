# The data directory's own entry is never made durable, so a crash can strand it

## Status

Fixed, and broader than originally described below.

- Not only `data_dir`: `segments/` and `wal/` were never synced after creation
  either.
- The active WAL file's own directory entry was never synced -- not when it was
  first created at open, and not when rotation recreated it -- until the first
  rotation or cursor save happened to sync `wal/`. Appends to it could be
  fsynced and acknowledged and still disappear with the file. This is the real
  cause behind `BUG4.md`.
- The fix: `fs_compat::create_dir_all_durable` creates the directory and syncs
  every ancestor and then the directory itself, top-down (a parent's entry is
  durable before its child's); the engine uses it for `segments/` and the WAL
  writer for `wal/`. New active WAL files are now `sync_all`ed and their parent
  directory synced, both at open and in `reopen_wal_file` during rotation.

Corrections to the text below:

- The cursor sidecar lives in `data_dir/wal`, so persisting it syncs `wal/`, not
  `data_dir`. Only progress files sync `data_dir`.
- The "child exists, parent missing" state is only reachable in turmoil (its
  `sync_dir(X)` also makes X's own creation durable, unlike POSIX `fsync(X)`).
  The real-filesystem impact is the lost-entry problem above, which matters on
  filesystems or mount options without journal ordering of directory updates.
- `QUIVER_SIM_PRECREATE_DATADIR` is no longer needed; with the fix the
  "parent directory not found" failures do not occur.

## Summary

Quiver creates its data directory tree with `create_dir_all` (`data_dir`, then
`data_dir/segments`, and later `data_dir/wal`), and it fsyncs directories only as
the *parent of a file it just wrote*: `sync_parent_dir` syncs `data_dir/wal` when
the WAL file is renamed, and `data_dir` when the cursor sidecar or a subscriber
progress file is renamed. Nothing ever fsyncs the directory that contains
`data_dir` itself (the mount root). So `data_dir`'s own directory entry is never
explicitly made durable; quiver relies on the containing filesystem already being
durable, which on a real mounted volume it is.

Under a strict crash model this is observable. If the process crashes after
`data_dir/wal` and `data_dir/segments` have been made durable (as the parents of
files quiver wrote) but before anything made `data_dir` itself durable, a
power-loss model that drops not-yet-durable directory entries removes `data_dir`
while keeping its children. That is an inconsistent tree -- a child directory
whose parent is gone. On restart quiver calls `create_dir_all(data_dir/segments)`,
but if the child still appears to exist the call does not recreate the missing
parent, and the next write into `data_dir` (a subscriber progress file) fails with
"parent directory not found".

Severity is low and the trigger is environment-dependent. In a normal deployment
`data_dir` is a pre-existing, durably-mounted volume, so its entry is already
durable and this cannot happen. The finding is really that quiver treats a
successful `open` as ready-to-persist without having made its own directory tree
durable. The clean fix is either to fsync the directory tree (including the mount
root) at creation, or to document that `data_dir` must be pre-created and durable.

## Important caveat: this was surfaced by a simulated filesystem

This bug was found with the turmoil crash-injection harness (`turmoil_sim`), whose
simulated filesystem (`turmoil-fs`) enforces POSIX directory-entry durability much
more strictly than a typical Linux mount. Two turmoil behaviors combine with the
quiver observation above to produce the failure:

1. turmoil's crash discards directory entries that were created but never synced
   into a directory's durable entry set. Because quiver syncs `data_dir`'s children
   (as file parents) but never `data_dir` itself, a crash can leave the children
   durable and `data_dir` removed.
2. turmoil's `create_dir_all` walks ancestors from the target up and stops at the
   first existing component. Given the inconsistent child-without-parent tree, it
   sees the child already exists and never recreates the missing parent, so the
   tree is never repaired.

Behavior 2 in particular is a turmoil-fs modeling artifact: a real `create_dir_all`
could not encounter a child directory whose parent is absent. So the concrete
"parent directory not found" failure, as observed, is partly an artifact of the
simulator. The underlying quiver observation -- `data_dir`'s own entry is never
explicitly synced -- is real, but whether it can bite in production depends
entirely on the deployment's storage being durably mounted.

## More Detailed

1. Engine open: `create_dir_all(data_dir/segments)` creates `data_dir` and
   `data_dir/segments`; WAL open creates `data_dir/wal`. All three are created but
   none is yet durable.
2. Normal operation syncs directories only as file parents:
   `sync_parent_dir(data_dir/wal/quiver.wal)` syncs `data_dir/wal`;
   `sync_parent_dir` for the cursor sidecar and progress files syncs `data_dir`.
   These flush the children's and `data_dir`'s entries into the durable set -- but
   the entry for `data_dir` in its own parent (the mount root) is never synced,
   because quiver never fsyncs the root.
3. A crash lands in a window where `data_dir/wal` and `data_dir/segments` are
   durable but `data_dir` itself is not yet in the root's durable entry set.
4. The crash model removes `data_dir` (its entry was never made durable) but keeps
   `data_dir/wal` and `data_dir/segments` (theirs were). The tree is now
   inconsistent: children exist, parent does not.
5. Restart: `create_dir_all(data_dir/segments)` sees `data_dir/segments` already
   present and stops, so it never recreates the missing `data_dir`.
6. The engine opens, but the first attempt to write a subscriber progress file
   into `data_dir` fails with "parent directory not found", surfacing as a
   `maintain`/progress I/O error.

## Reproduction and confirmation

Across the turmoil sweep this appears as
`INVARIANT4_MAINTAIN[_DRAIN]: progress file I/O error at /data/...tmp: parent
directory not found` (for example `QUIVER_SIM_SEED=1 QUIVER_SIM_CRASH_PROB=0.05
QUIVER_SIM_INGESTS=40`).

Two investigation toggles in the harness confirm the mechanism (simulation build
only, default off):

- `QUIVER_SIM_DEBUG_DIRS=1` prints the existence of `/data`, `/data/wal`,
  `/data/segments` at each incarnation. On a failing seed it shows the impossible
  state `/data=false` while `/data/wal=true` and `/data/segments=true`, and shows
  that `create_dir_all` during the next open does not restore `/data`.
- `QUIVER_SIM_PRECREATE_DATADIR=1` makes `/data` durable up front (by creating it
  and syncing the root). With this on, the "parent directory not found" failures
  disappear entirely; the affected seeds instead surface the genuine WAL cursor
  bugs (see `BUG.md` and `BUG2.md`). This isolates the cause to `/data` never being
  explicitly synced.

## Candidate fix

If quiver is to own the durability of its directory tree, fsync each directory
after creating it, including the directory that contains `data_dir` (the mount
root), so `data_dir`'s own entry is durable before the engine reports `open`
success. Otherwise, document that `data_dir` must be a pre-existing,
durably-mounted directory, since the current code assumes the containing
filesystem is already durable.
