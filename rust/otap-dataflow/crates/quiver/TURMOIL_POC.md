# Turmoil POC: reproducing the WAL rotation-crash bug

This document records a proof-of-concept that evaluates whether
[tokio turmoil](https://github.com/tokio-rs/turmoil) could have found the bug in
[`BUG.md`](./BUG.md) -- a gateway kill in the middle of a WAL rotation that
restarts the WAL stream at position 0 and later rejects every segment seal with
`invalid consumer cursor: safe offset regressed`.

The bug was originally found and reproduced with a proprietary deterministic
testing platform. The question here is: with turmoil's simulated filesystem,
could we reproduce the same defect from the durability model alone, and what
would it take to push the same technique up to the durable buffer processor and
a full DFE instance?

Short answer: **yes for quiver**. The POC reproduces the exact BUG.md symptom
inside a turmoil simulation, driving the crash from turmoil's POSIX durability
model rather than by hand-crafting the post-crash on-disk state. A seeded
exploration variant surfaces the same regression, which is the "could a crash
explorer have found it" evidence. Lifting this to the durable buffer processor
and the full DFE is progressively more involved; the blockers are catalogued
below.

## How to run

The POC is gated behind the custom cfg `quiver_turmoil`, NOT a Cargo feature.
This is deliberate: CI and `cargo xtask check` build with `--all-features`, and
a feature would redirect every existing quiver test (which uses real tempdirs)
onto the simulated filesystem. A custom cfg is invisible to `--all-features`,
exactly like `tokio_unstable`.

```bash
CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
  cargo test -p otel-arrow-dfe-quiver turmoil
```

Expected result while the bug is present:

```text
test wal::turmoil_tests::rotation_crash_reproduces_cursor_regression_under_turmoil ... ok
test wal::turmoil_tests::rotation_crash_exploration_finds_cursor_regression_under_turmoil ... ok
test wal::turmoil_tests::rotation_crash_fixed_cursor_does_not_regress_under_turmoil ... ignored
```

The two `ok` tests pass by observing the defect (green means "turmoil reproduced
the bug"). The `#[ignore]`d test is the post-fix regression guard: it asserts the
correct invariant and will pass once the bug is fixed. Run it with `--ignored`
to check fix status.

Normal builds and tests are unaffected:

```bash
cargo test -p otel-arrow-dfe-quiver        # 452 pass, 1 pre-existing repro fail
cargo check -p otel-arrow-dfe-quiver --all-features   # turmoil not linked
```

## What the POC contains

Three tests in
[`src/wal/turmoil_tests.rs`](./src/wal/turmoil_tests.rs), all built on one shared
`run_scenario(seed)` helper that drives a `WalWriter` inside a turmoil `Sim`:

1. `rotation_crash_reproduces_cursor_regression_under_turmoil` -- the
   deterministic reproduction. One simulated host runs the WAL writer through a
   two-phase scenario (fill + crash, then restart + seal). The crash is a real
   `Sim::crash`, and the test observes that the post-purge `persist_cursor` is
   rejected with "safe offset regressed", exactly as BUG.md describes.
2. `rotation_crash_exploration_finds_cursor_regression_under_turmoil` -- the same
   workload across eight RNG seeds, collecting the seeds whose cursor regresses.
   This is the "a seeded crash explorer would have found it" evidence.
3. `rotation_crash_fixed_cursor_does_not_regress_under_turmoil` -- the post-fix
   regression guard, `#[ignore]`d while the bug is present.

### How the crash is driven

The crash point is the single durability gap in the rotation path
(`WalCoordinator::rotate_active_file` in
[`src/wal/writer.rs`](./src/wal/writer.rs)):

1. `rename(wal -> wal.N)`
2. `sync_parent_dir(parent)` -- makes the rename durable
3. (crash window) -- `reopen_wal_file` writes the new active header, **unsynced**

turmoil models POSIX durability explicitly: writes stay pending until a file or
directory sync, and a crash discards everything still pending. So `Sim::crash` at
step 3 deterministically keeps the synced rename (`wal.N` survives) and discards
the unsynced new header (`wal` is gone). On restart `WalWriter::open` finds an
absent active file, recreates it empty, and writes a header that starts at
position 0 -- the root cause from BUG.md. No hand-crafted empty file is needed;
the bad state falls out of what the code actually makes durable.

The existing non-sim repro
(`wal::tests::rotation_crash_restart_at_zero_does_not_regress_later_cursor`) fails
with the identical error (`Err(InvalidConsumerCursor("safe offset regressed"))`),
confirming the two reproductions are equivalent.

## Changes required in quiver

The simulation is switched entirely by the `quiver_turmoil` cfg. The production
code path is unchanged on a normal build.

- [`Cargo.toml`](./Cargo.toml): `turmoil` as a `cfg(quiver_turmoil)` dependency
  (features `unstable-fs`, `unstable-barriers`). Not linked under
  `--all-features`.
- Workspace `Cargo.toml`: `quiver_turmoil` added to the `check-cfg` list so the
  `unexpected_cfgs` lint stays happy.
- [`src/fs_compat.rs`](./src/fs_compat.rs) (new): a filesystem facade. On a normal
  build it re-exports `std::fs` / `tokio::fs` unchanged; under `--cfg
  quiver_turmoil` it re-exports turmoil's shims. It also provides `sync_dir` and
  `path_exists` helpers (see below).
- WAL modules (`writer.rs`, `reader.rs`, `cursor_sidecar.rs`, `header.rs`):
  filesystem calls on the durability-critical path now go through the facade.
  `WalHeader::{write_to,read_from,read_from_sync}` were made generic over the
  I/O traits so the same code accepts either the real or the shim `File`.

Two cfg-gated behavior tweaks in `writer.rs`, both faithful to a real crash:

- `WalWriter::flush_now_sync` (called from `Drop`) is a no-op under
  `quiver_turmoil`. `Sim::crash` cancels the host's tasks -- which runs `Drop` --
  BEFORE it discards pending writes, so a sync here would make the pending header
  durable and mask the bug. A real SIGKILL never runs destructors either.
- `WalWriter::open` fsyncs the just-written header of a brand-new WAL under
  `quiver_turmoil`. See the next section for why this is needed, and why it is a
  reasonable thing to do in production too.

## What turmoil-fs taught us (model differences)

Two places where quiver relied on real-kernel behavior that turmoil models more
strictly. Neither is the reported bug, but both are worth noting because they are
exactly the kind of latent assumption a simulated filesystem exposes.

1. **Read-after-write visibility across handles without fsync.**
   `WalWriter::open` writes the header, then `detect_next_sequence` opens a
   *separate* read handle to scan the file. On Linux both handles share the page
   cache, so the fresh handle sees the just-written (unsynced) header. turmoil
   makes an unsynced write visible only to the writing handle, so the scan read
   an empty file, reported "no entries", and the first entry overwrote the header
   at offset 0. The POC fixes this by fsyncing the new header at open (gated by
   the cfg). This is a benign change in production -- a new WAL's header arguably
   should be durable before use -- but it is left cfg-gated to keep the POC's
   production footprint minimal.
2. **`std::path::Path::exists` bypasses the filesystem facade.**
   `Path::exists` queries the real OS filesystem, which the shim never touches,
   so it always returned `false` in the simulation. Three call sites
   (`scan_file_for_entries`, the sidecar check in `persist_cursor`, and the
   active-file check in replay) now go through `fs_compat::path_exists`.

The takeaway: wiring turmoil-fs into an existing storage engine is not purely
mechanical. It surfaces every place the code assumes shared-page-cache semantics
or calls `std::path`/`std::fs` directly, which is itself valuable review signal.

## turmoil version note

The public `turmoil` 0.7.2 on crates.io differs from the `main` branch. On
`main`, `turmoil-fs` is a standalone crate with a public `Fs::builder()` you can
drive outside a `Sim`. In 0.7.2 the filesystem lives inside `turmoil` under the
`unstable-fs` feature and is driven only through a `Sim` (configure via
`Builder::fs().sync_probability(..)`, crash via `Sim::crash`, restart via
`Sim::bounce`). This POC targets 0.7.2, so the "Tier 0 standalone-Fs" idea from
planning collapsed into the `Sim`-host form, which is also closer to how a real
deployment would be simulated.

## Extending to the durable buffer processor

The durable buffer processor (`core-nodes`, feature `durable-buffer`) wraps
`QuiverEngine`. The `quiver_turmoil` cfg is global, so it already reaches quiver
through the processor without any feature plumbing. The remaining work:

- **Engine-level fs rerouting.** The POC only rerouted the WAL path. A
  processor-level test exercises the full engine: `engine.rs` (segment finalize,
  cursor load), `segment/writer.rs`, `segment/reader.rs`, `segment_store.rs`, and
  `subscriber/progress.rs`. All of these call `std::fs` / `tokio::fs` directly and
  would need to go through `fs_compat`. Estimated ~100 call sites across ~6
  files; mechanical but not trivial, plus more `Path::exists`-style audits.
- **`spawn_blocking` + Arrow IPC in the segment writer.** turmoil's filesystem is
  thread-local; a `spawn_blocking` closure runs on a different thread where the
  `Fs` is not entered, so any shim call panics. Under the cfg the segment write
  would need to run inline (or re-enter the host's `Fs` on the worker thread).
- **mmap segment reads.** You cannot mmap a simulated file. Under the cfg the
  read mode must be forced to the standard (non-mmap) path.
- **`TestRuntime` cannot nest in a turmoil host.**
  `engine::testing::processor::TestRuntime` builds its own current-thread runtime
  and calls `block_on`. A turmoil host future already runs on turmoil's runtime,
  so `block_on` inside it will panic. A processor test would need a `TestRuntime`
  variant that drives the processor on the *existing* runtime and `LocalSet`
  instead of creating its own.

Estimate: roughly 1-2 days to reroute the engine filesystem surface and add a
nest-friendly `TestRuntime`, after which the existing processor-level repro
(`crash_mid_wal_rotation_does_not_lose_acked_data_after_purge`) could be expressed
as a turmoil crash instead of hand-renamed/truncated files.

## Extending to a full DFE instance

Substantially larger, and probably not worth it for crash-consistency alone:

- The controller spawns per-core OS threads with core pinning and a separate
  runtime per core, plus admin/telemetry threads. turmoil runs all hosts on one
  thread with its own runtime; the DFE runtime layer would need a simulation mode
  that forgoes real threads and pinning.
- Receivers/exporters use `tokio::net`. A whole-DFE simulation would need
  `turmoil-net` (or `turmoil`'s built-in simulated network) wired into the
  transport layer in addition to the filesystem.
- turmoil does not simulate `SystemTime`; code that reads wall-clock time
  (ingestion timestamps, file times) would need a clock seam.
- Signals and process lifecycle (the actual "gateway kill") are outside turmoil's
  model; the kill would be modeled as `Sim::crash` on the simulated host.

For a whole-process kill like the one that found this bug, a process-level
deterministic platform (which snapshots and kills the real process and real
filesystem) is a better fit than turmoil. turmoil's strength is component- and
subsystem-level crash-consistency, where it is cheap, fully deterministic, and
replayable -- as this quiver POC shows.

## Conclusion

turmoil-fs reproduces the BUG.md defect at the quiver layer with modest,
cfg-gated changes, and a seeded search surfaces it without a hand-built scenario.
That answers the core question: a turmoil-based crash-consistency test of quiver
could have found this bug. Pushing the technique to the durable buffer processor
is a bounded engineering task (engine fs rerouting + a nest-friendly test
runtime). A full-DFE simulation is a much larger investment and overlaps with
what a process-level platform already does well.
