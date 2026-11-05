# Turmoil POC: autonomous crash-consistency testing for quiver

This document records a proof-of-concept that evaluates whether
[tokio turmoil](https://github.com/tokio-rs/turmoil) could have found the bug in
[`BUG.md`](./BUG.md) -- a gateway kill in the middle of a WAL rotation that
restarts the WAL stream at position 0 and later rejects segment seals with
`invalid consumer cursor: safe offset regressed`.

The bug was originally found with a proprietary deterministic testing platform.
The question here: with turmoil's simulated filesystem and a general crash
oracle, could we rediscover that defect automatically, without pointing the test
at any specific line of code?

**Answer: yes.** A seeded crash-injection harness drives a full `QuiverEngine`
and crashes the process right before arbitrary filesystem writes. Across 108
seeds, 100% surfaced a fatal crash-consistency violation. 87 reproduced BUG.md
(`safe offset regressed`); 21 surfaced a second, independent candidate bug
(directory-entry durability of the data directory). Nothing in the harness names
the rotation path -- the oracle crashes before generic filesystem operations and
the invariants catch the fallout.

## How to run

The POC is gated behind the custom cfg `quiver_turmoil`, NOT a Cargo feature.
CI and `cargo xtask check` build with `--all-features`, and a feature would
redirect every existing quiver test (which uses real tempdirs) onto the
simulated filesystem. A custom cfg is invisible to `--all-features`, exactly like
`tokio_unstable`.

```bash
# Explore seeds 0..200 (default). Fails on the first fatal violation, printing
# the seed, the broken invariant, the crash log, and a replay command.
CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
  cargo test -p otel-arrow-dfe-quiver turmoil -- --nocapture

# Replay exactly one seed.
QUIVER_SIM_SEED=0 CARGO_TARGET_DIR=target/turmoil RUSTFLAGS="--cfg quiver_turmoil" \
  cargo test -p otel-arrow-dfe-quiver turmoil -- --nocapture
```

Environment knobs: `QUIVER_SIM_SEED`, `QUIVER_SIM_SEED_START`,
`QUIVER_SIM_SEEDS`, `QUIVER_SIM_CRASH_PROB` (default 0.02),
`QUIVER_SIM_INGESTS` (default 60), `QUIVER_SIM_CHECKPOINT`.

Normal builds and tests are unaffected:

```bash
cargo test -p otel-arrow-dfe-quiver        # 452 pass; 1 pre-existing repro fail
cargo check -p otel-arrow-dfe-quiver --all-features   # turmoil not linked
```

## Design

### A single filesystem wrapper with a crash oracle

Every filesystem access in quiver goes through `crate::fs_compat`
([`src/fs_compat.rs`](./src/fs_compat.rs)). On a normal build it re-exports
`std::fs` / `tokio::fs` unchanged (zero behavioral change). Under
`--cfg quiver_turmoil` it provides thin wrappers around turmoil's simulated
filesystem shims. Before any operation that MUTATES on-disk state (write,
`set_len`, `sync_data`/`sync_all`, `sync_dir`, `rename`, `remove_file`,
create/truncate open, `create_dir_all`, `set_permissions`) the wrapper consults
a seeded crash oracle ([`src/fs_compat/sim.rs`](./src/fs_compat/sim.rs)).

The oracle draws from a per-host SplitMix64 RNG and, with probability `p`, "kills"
the process at that instant by panicking with `InjectedCrash`. Because the crash
fires BEFORE the mutation reaches even turmoil's pending state, it faithfully
models a power loss at that point. Read-only operations never crash.

### Crash = panic, restart = crash + bounce on the same Sim

The harness ([`src/turmoil_sim.rs`](./src/turmoil_sim.rs)) runs a `QuiverEngine`
inside a single turmoil host. When the oracle panics:

1. The panic unwinds the host task; `sim.step()` surfaces it.
2. The harness confirms it was an injected crash (not a real bug), then calls
   `sim.crash("quiver")` (discards unsynced writes) and `sim.bounce("quiver")`
   (restarts the host on the SAME in-memory filesystem).
3. The producer retries the interrupted id and the run continues.

Two subtleties the research flagged, both handled:

- **`WalWriter::Drop` fsync is disabled under the cfg.** `sim.crash` cancels the
  host's tasks -- which runs `Drop` -- BEFORE discarding pending writes, so a
  sync there would mask the crash. A real SIGKILL never runs destructors either.
- **The segment writer re-raises `spawn_blocking` panics.** Arrow IPC writes run
  on a blocking thread; tokio would convert a panic there into an ordinary error,
  letting quiver keep running (and delete the partial segment). Under the cfg the
  panic is re-raised with `resume_unwind`, and the blocking thread re-enters both
  the turmoil filesystem context (`FsHandle`) and the crash oracle, since both are
  thread-local.

### Workload and invariants

One producer ingests bundles carrying a unique, increasing id plus a checksum,
retrying the same id until `ingest` returns `Ok` (contiguous commit, like an
upstream with nack/retry). One subscriber claims one bundle at a time, acks it,
and periodically flushes progress. `flush_interval = 0` makes an `Ok` ingest a
durable promise, which is what lets "no loss" be asserted. Segments and the WAL
are kept small so rotation and finalization happen constantly. All tracking state
lives outside the host so it survives crashes.

Fatal invariants (fail the seed):

- **L (export without restart):** at a no-crash checkpoint (stop ingest, `flush`,
  `maintain`, drain), every committed id must have been delivered. No extra
  restart is allowed to make up the difference -- orphaned-but-undelivered data,
  the BUG.md failure mode, violates this.
- **4 (clean operation):** `open` succeeds after each restart; `ingest`, `flush`,
  `maintain` never error except an injected crash or storage-capacity
  backpressure. BUG.md's "safe offset regressed" surfaces here.
- **3 (no phantom/corruption):** every delivered id was attempted and its payload
  checksum matches.
- **Liveness:** a drain terminates within a bounded step budget.

Report-only (logged, do not fail): **1 (ordering)** first delivery strictly
increasing; **5 (durable acks)** a durably-acked id is never redelivered.

## Findings

108 seeds, three crash probabilities (0.02 / 0.05 / 0.10). **Every seed found a
fatal violation.** Runs are deterministic: a given seed reproduces the identical
violation every time.

| Count | Invariant | Detail | Interpretation |
| --- | --- | --- | --- |
| 87 | 4 | `invalid consumer cursor: safe offset regressed` | **BUG.md**, rediscovered |
| 21 | 4 | `progress file I/O error: parent directory not found` | **New candidate:** data-dir entry not made durable |

### Finding 1: BUG.md (the target)

Reproduced on the majority of seeds. Example (seed 0, `crash_prob=0.05`): the
crash log ends with `open(create/truncate) /data/wal/quiver.wal` -- a crash while
recreating the active WAL during rotation. On restart, `WalWriter::open` finds the
active file absent/empty, writes a header starting at position 0, and a later
`persist_cursor` is rejected with "safe offset regressed". This is exactly the
BUG.md mechanism, reached from generic crash injection rather than a hand-placed
hook. The symptom is identical to the existing non-sim repro
(`wal::tests::rotation_crash_restart_at_zero_does_not_regress_later_cursor`).

Replay: `QUIVER_SIM_SEED=0 QUIVER_SIM_CRASH_PROB=0.05 QUIVER_SIM_INGESTS=40`.

### Finding 2: data-directory entry is never made durable (candidate)

On 21 seeds the engine crashes before/while creating `/data/segments` or
`/data/wal` (via `create_dir_all`), and after the restart a subscriber progress
write fails with `parent directory not found`. Root cause: quiver creates
`data_dir` and its subdirectories but never fsyncs the parent so the directory
entries become durable. `WalWriter`'s `sync_parent_dir` syncs `/data/wal` (for the
WAL file's entry), but nothing syncs `/` (for `/data`) or `/data` (for the
`wal`/`segments` subdir entries). On a crash before those entries are durable, the
tree is partially gone and the next write errors.

Severity caveat: in a typical durable-buffer deployment the data directory is a
pre-existing, durably-mounted volume, so quiver not fsyncing its own creation is
arguably acceptable. But quiver does create these directories itself and treats
a successful `open` as ready-to-persist, so this is a real gap worth a decision:
either fsync the directory tree at creation, or document that `data_dir` must be
pre-created and durable.

Replay: `QUIVER_SIM_SEED=1 QUIVER_SIM_CRASH_PROB=0.05 QUIVER_SIM_INGESTS=40`.

## What wiring turmoil-fs into quiver required

All changes are cfg-gated; the normal build is byte-for-byte unchanged in
behavior.

- `Cargo.toml`: `turmoil` as a `cfg(quiver_turmoil)` dependency (features
  `unstable-fs`, `unstable-barriers`). Not linked under `--all-features`.
- Workspace `Cargo.toml`: `quiver_turmoil` added to `check-cfg`.
- `src/fs_compat.rs` + `src/fs_compat/{sim,imp/tokio_fs,imp/std_fs}.rs`: the
  facade, crash oracle, and wrapped `File`/`OpenOptions` types.
- Every durability-path filesystem call in `engine.rs`, `segment/writer.rs`,
  `segment/reader.rs`, `segment_store.rs`, `subscriber/progress.rs`,
  `subscriber/registry.rs`, and `wal/*` now goes through the facade. `Path::exists`
  is routed through `fs_compat::path_exists` because `std::path::Path::exists`
  queries the real filesystem the shim never touches.
- Two cfg-gated behavior tweaks, both faithful to a real crash: `WalWriter`'s
  Drop fsync is a no-op, and the segment writer re-raises blocking-task panics and
  re-enters the simulated filesystem on the worker thread.
- One benign cfg-gated correctness tweak surfaced by the stricter model:
  `WalWriter::open` fsyncs a brand-new WAL's header before the recovery scan
  re-reads it. On Linux the page cache makes the unsynced header visible across
  handles; turmoil enforces per-handle visibility, so without the fsync the scan
  saw an empty file. Under the sim the permissions probe and read-only enforcement
  are also skipped (the shim does not enforce modes), and segment reads use the
  standard (non-mmap) path.

## Extending to the durable buffer processor and full DFE

Unchanged from the earlier analysis; the harness now exercises the whole engine,
so the processor is the natural next step:

- **Durable buffer processor** (feature `durable-buffer`): the `quiver_turmoil`
  cfg already reaches quiver through the processor. The remaining work is a
  `TestRuntime` variant that nests inside a turmoil host (the current one builds
  its own runtime and `block_on`s, which cannot nest), after which the processor's
  own crash scenario could be driven by the oracle instead of hand-renamed files.
  Estimated ~1-2 days.
- **Full DFE:** substantially larger -- a simulation runtime mode (no per-core
  threads/pinning), `turmoil-net` for receivers/exporters, and a clock seam for
  `SystemTime`. For a whole-process kill, a process-level deterministic platform
  remains the better fit; turmoil's strength is component/subsystem
  crash-consistency, which this quiver harness demonstrates cheaply and
  deterministically.

## Conclusion

A general, seeded crash-injection harness over quiver's filesystem rediscovers
BUG.md automatically -- no hand-placed crash point -- and also surfaced a second
durability gap. This answers the evaluation question directly: a turmoil-based
crash-consistency harness could have found this bug, and is a cheap, deterministic,
replayable way to keep finding this class of bug.
