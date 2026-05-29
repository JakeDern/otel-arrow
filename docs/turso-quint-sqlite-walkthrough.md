# How Turso used Quint to find SQLite bugs: a code-level walkthrough

A detailed reconstruction of the trace-generation / replay pipeline behind the
Turso blog post
[*How we used Quint to find over 10 bugs in SQLite while hardening Turso*](https://turso.tech/blog/how-we-used-quint-to-find-over-10-bugs-in-sqlite),
based on reading the actual model and tooling code.

---

## 0. TL;DR

The work was done by Turso community member **Pavan Nambi**. The technique is
**model-based testing of SQLite's documented C API**, not whole-system
verification:

1. Pick one documented C-API contract (e.g. "`sqlite3_deserialize()` returns
   `SQLITE_BUSY` if a read transaction is open").
2. Write a tiny Quint state machine that encodes that contract, plus invariants
   that assert the documented behavior.
3. Run a bounded model checker (`quint verify`, backed by Apalache/SMT). Either
   the invariants hold, or the checker spits out a **counterexample trace** in
   ITF (Informal Trace Format) JSON.
4. Feed that trace to a Python codegen tool that emits a **standalone C repro
   harness** exercising the real SQLite C API in exactly that sequence.
5. Compile the harness against a **pinned SQLite amalgamation** and run it
   (optionally under ASan/UBSan). If real SQLite diverges from the model's
   documented expectation — or crashes — you've found a bug (or a model bug).

> "Traces are just a sequence of states, not SQL statements. Those traces can
> then be translated into whatever you want to allow execution against the
> system." — the blog post

**The crash that anchors the whole story:** `sqlite3_deserialize()` called while
a read transaction is active. Docs say it must return `SQLITE_BUSY`; real SQLite
**segfaulted / read invalid memory**. Reported and fixed upstream
([SQLite forum thread](https://sqlite.org/forum/forumpost/39134ba029), fixed in
SQLite trunk commit `1fc7341ad2331b31ba5edc0160554ce4a1bef35e`).

### Where the code actually lives — important

There are **three distinct artifacts**, and it is easy to conflate them:

| Artifact | Repo / path | What it is |
|---|---|---|
| **The Quint C-API models + trace tooling** (the subject of the blog) | [`pavan-nambi/sqlite-c-api-quint`](https://github.com/pavan-nambi/sqlite-c-api-quint) (personal, **archived**) | The models, codegen, and replay harness described here |
| A separate TLA+ transaction model | [`tursodatabase/turso` → `tlaplus/sqlite-tx/`](https://github.com/tursodatabase/turso/tree/main/tlaplus/sqlite-tx) | An unrelated TLA+ spec of Turso's MVCC transactions; *not* the C-API/Quint work |
| Turso's normal fuzz CI | `tursodatabase/turso` `run-fuzz-tests` workflow | The CI job you linked is Turso's own SQL fuzzer, separate from the Quint pipeline |

The blog is hosted on Turso's site and the work hardens Turso, but the
bug-finding machinery itself is in the standalone, now-archived repo. Its
author's own README is refreshingly blunt:

> "became too stupid to extend - archiving, 'd rather start from scratch"
> "i severely underestimated how much time this takes it's absolutely nuts."

Everything below references files in
[`pavan-nambi/sqlite-c-api-quint`](https://github.com/pavan-nambi/sqlite-c-api-quint)
at commit `44b7735` (branch `main`).

---

## 1. The pipeline at a glance

```
                    ┌─────────────────────────────────────────────────────┐
                    │  Quint model of one C-API contract (*.qnt)           │
                    │  state machine + documented-behavior invariants      │
                    └───────────────────────┬─────────────────────────────┘
                                            │  quint verify (Apalache/SMT,
                                            │  bounded: --max-steps=4..8)
                          ┌─────────────────┴───────────────────┐
                          │                                      │
                   invariants hold                    invariant VIOLATED
                          │                                      │
                          │                              counterexample =
                          │                              violation.itf.json
                          │                                      │
                          │                                      ▼
                          │                    ┌─────────────────────────────────┐
                          │                    │ trace_codegen.py                │
                          │                    │  validate ITF trace shape, then │
                          │                    │  emit canonical C repro harness │
                          │                    └────────────────┬────────────────┘
                          │                                     │
                          ▼                                     ▼
            ┌───────────────────────────┐    ┌──────────────────────────────────────┐
            │ generate_trace_fixtures.py │    │ cc -I $SQLITE_SOURCE_DIR sqlite3.c     │
            │ canonical ITF traces for   │    │    harness.c   (optionally +ASan/UBSan)│
            │ every supported scenario   │    │ run → prints "case"/"diverge" lines    │
            │ (regression / conformance) │    └──────────────────┬─────────────────────┘
            └─────────────┬──────────────┘                       │
                          └───────────────────┬──────────────────┘
                                              ▼
                              ┌───────────────────────────────┐
                              │ *_conformance_check.py         │
                              │ fail if any "diverge" line, or │
                              │ if any required case is missing│
                              └───────────────────────────────┘
```

The single entry point that wires all of this together is
[`quint/run.sh`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/run.sh),
which has three subcommands: `model`, `trace-repro`, and `trace-conformance`.

There are **two flows** sharing the same machinery:

- **Discovery flow** (how bugs are found): write a model → `quint verify` →
  counterexample ITF → `run.sh trace-repro violation.itf.json` → compile & run →
  observe crash/divergence.
- **Conformance/regression flow** (how findings are locked in): hand-curated
  canonical ITF traces for every known-good scenario are regenerated and replayed
  on every run via `run.sh trace-conformance <family>`, failing CI if upstream
  SQLite ever diverges from the modeled contract.

---

## 2. How the C API is modeled in Quint

Quint is an executable specification language built on the same theory as TLA+
(Temporal Logic of Actions), with a friendlier syntax and a real type checker.
The key modeling decision here is **abstraction**: the models do **not** simulate
SQLite. They are small state machines whose states are *facts about an API
interaction*, and whose invariants encode *what the documentation promises*.

Three model families exist, one `.qnt` file each:

| File | C-API surface modeled | Step bound |
|---|---|---|
| [`serde_api.qnt`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/serde_api.qnt) | `sqlite3_serialize` / `sqlite3_deserialize` (+ flags `FREEONCLOSE`, `READONLY`, `RESIZEABLE`) | `--max-steps=4` |
| [`lifecycle_api.qnt`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/lifecycle_api.qnt) | `sqlite3_close` / `close_v2` / `finalize` / `prepare_v2`/`v3` / `backup_*` | `--max-steps=8` |
| [`stmt_api.qnt`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/stmt_api.qnt) | `sqlite3_bind*` / `reset` / `clear_bindings` / `column_*` / `data_count` | `--max-steps=7` |

### 2.1 Anatomy of a model — the serde example

Take [`serde_api.qnt`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/serde_api.qnt),
the file that found the headline crash. Its structure is the template for all three.

**(a) A scenario enum.** Each distinct documented behavior is a named scenario
(`serde_api.qnt:5-16`):

```quint
val ReadTxnBusy: Scenario = "deserialize_read_txn_busy"
val BackupBusy:  Scenario = "deserialize_backup_busy"
val NullSchemaMain: Scenario = "deserialize_null_schema_main"
val TempSchemaError: Scenario = "deserialize_temp_schema_error"
val ReadonlyReadWrite: Scenario = "deserialize_readonly_read_write"
val ResizeableGrowth: Scenario = "deserialize_resizeable_growth"
// ...12 in total
```

**(b) A flat state record** of boolean facts plus the observed return code
(`serde_api.qnt:27-41`):

```quint
type ModelState = {
  scenario: Scenario,
  readTxn: bool,          // is a read txn open on the target?
  backupSource: bool,     // is the target a live backup source?
  deserialized: bool,     // did the image get installed?
  readonlyRead: bool,
  readonlyWriteRejected: bool,
  resizeableGrew: bool,
  // ...
  rc: ReturnCode,         // last observed SQLite return code, or NO_CALL
  divergence: bool,
}
```

**(c) `init` picks a scenario nondeterministically** (`serde_api.qnt:141-146`).
This is what lets one model cover all 12 documented cases at once — the model
checker explores every scenario:

```quint
action initDoc = {
  nondet scenario = Scenarios.oneOf()
  state' = fresh(scenario)
}
```

**(d) Actions are the API calls.** Each guarded action corresponds to a step a
caller could take. `startReadTxn` opens a read txn; `deserialize` performs the
call and records the *documented* expected return code via `expectedDocRc`
(`serde_api.qnt:124-198`):

```quint
def expectedDocRc(current: ModelState): ReturnCode =
  if (current.scenario == ReadTxnBusy and current.readTxn)      { SQLITE_BUSY }
  else if (current.scenario == BackupBusy and current.backupSource) { SQLITE_BUSY }
  else if (current.scenario == TempSchemaError)    { SQLITE_ERROR }
  else if (current.scenario == NegativeSizeArmor)  { SQLITE_MISUSE }
  else { SQLITE_OK }

action deserialize = all {
  state.rc == NO_CALL,
  state' = withResult(state, expectedDocRc(state),
                      expectedDocRc(state) == SQLITE_OK, /* freeOnClose */ ...),
}
```

**(e) `step` is the disjunction of all actions** plus a `stutter`
(`serde_api.qnt:317-328`) — the model checker may take any enabled action at
each step.

**(f) Invariants encode the documentation as logic.** These are the actual
oracle. For the deserialize-during-read-txn contract (`serde_api.qnt:333-349`):

```quint
val docBusyConflictsReturnBusy =
  ( state.rc != NO_CALL and
    ( (state.scenario == ReadTxnBusy and state.readTxn)
      or (state.scenario == BackupBusy and state.backupSource) ) )
  implies state.rc == SQLITE_BUSY

val docBusyConflictsDoNotInstall =
  ( state.rc == SQLITE_BUSY and (...conflict...) )
  implies not(state.deserialized)
```

Other invariants in the file assert: successful deserialize installs the image
(`successfulDeserializeInstalls`), schema errors do not install
(`schemaErrorsDoNotInstall`), readonly rejects writes
(`readonlyWriteRequiresReadonlyDeserialize`), resizeable growth, WAL-image
`CANTOPEN`, `FREEONCLOSE` failure semantics, and bounded non-resizeable growth.

### 2.2 The "staged" lifecycle/stmt models

[`lifecycle_api.qnt`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/lifecycle_api.qnt)
is much larger (1231 lines, ~45 actions) because object lifecycles are ordered.
It adds an integer `stage` field to the state and models multi-step protocols —
e.g. *prepare a statement → `sqlite3_close` returns `SQLITE_BUSY` → step/finalize
the statement → `sqlite3_close` now returns `SQLITE_OK`*. It also models
`backup_step(0)` (no progress), `backup_step(-1)` (copy all), and transient
`BUSY/LOCKED` retry paths. The invariants checked are listed in
[`run.sh:53-65`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/run.sh#L53).

Notably, this is also where the model encodes the `prepare_v2`/`prepare_v3`
**equivalence** contract (zero-flag `v3` must behave identically to `v2`), which
the C harness later checks field-by-field.

---

## 3. How traces are generated

There are two trace sources, both producing the same **ITF** JSON shape that the
codegen consumes.

### 3.1 Counterexamples from the model checker (discovery)

`run.sh model serde` runs (`run.sh:95-124`):

```sh
quint typecheck serde_api.qnt
quint verify serde_api.qnt \
  --init=initDoc --step=step \
  --server-endpoint localhost:$PORT \
  --invariants noDocDivergence docBusyConflictsReturnBusy ... \
  --max-steps=4
```

`quint verify` uses the **Apalache** backend (symbolic, SMT-based bounded model
checking). When an invariant fails, Apalache emits the violating state sequence
as `violation.itf.json` under `_apalache-out/server/<run-id>/`. That file is the
trace. Because the state is just a handful of booleans and a small step bound,
this search is tiny and fast (see §6).

ITF ("Informal Trace Format") is Apalache/Quint's standard JSON trace encoding:
a top-level `states` array, each element wrapping a `state` object. The codegen's
`load_states` (`trace_codegen.py:65-79`) expects exactly that.

### 3.2 Canonical hand-authored traces (conformance / regression)

For ongoing conformance the repo also ships **canonical ITF traces** for every
supported scenario, written out by
[`generate_trace_fixtures.py`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/generate_trace_fixtures.py).
The state sequences themselves are declared as data in
[`trace_scenarios.py`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/trace_scenarios.py).
For instance the read-txn-busy trace (`trace_scenarios.py:219-223`) is literally:

```python
"deserialize_read_txn_busy": [
    {},                                          # stage 0: fresh
    {"readTxn": True},                           # open read txn
    {"readTxn": True, "rc": "SQLITE_BUSY"},      # deserialize -> BUSY, not installed
],
```

`wrap_states` (`trace_scenarios.py:465-466`) merges each partial state over the
family default (`SERDE_DEFAULT`, `trace_scenarios.py:175-188`) and wraps it into
the `{"states": [{"state": ...}]}` ITF envelope. So the same codegen path serves
both real counterexamples and curated regression traces.

---

## 4. How a trace becomes a C program

This is the heart of the system:
[`trace_codegen.py`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/trace_codegen.py)
(1926 lines). It is deliberately **not** a general-purpose trace interpreter. As
its own docstring says (`trace_codegen.py:9-14`):

> "Supported ITF trace shape -> standalone C repro harness for that canonical
> scenario on upstream SQLite. This is not arbitrary semantic trace replay."

### 4.1 Step 1 — identify the scenario and validate the trace shape

`infer_trace_model` (`trace_codegen.py:229-250`) reads the `scenario` field from
the first state, checks every state agrees on it, routes to the family
(`scenario_family`), and then runs **heavy validation** before emitting anything.
The validation is itself an oracle layer:

- **Independent expected-behavior oracles.** `trace_oracles.py` re-declares, in a
  separate table, the expected return code, the expected ordered list of
  transition "steps", and the expected terminal facts for every scenario
  (`trace_oracles.py:188-198`, `:338-356`, `:142-186`). The codegen recomputes
  the steps actually implied by the trace
  (`infer_serde_transition_steps`, `trace_scenarios.py:476-498`) and asserts they
  match the oracle (`validate_expected_steps`, `trace_codegen.py:119-127`). This
  catches model drift: if the model and the independent oracle disagree, codegen
  fails loudly rather than emitting a misleading repro.
- **Stage monotonicity** for staged families: stages must start at 0, never
  regress, and never skip (`validate_staged_trace`, `trace_codegen.py:82-116`).
- **Terminal-fact equality**: the last state must exactly equal the expected
  terminal facts, with no extra keys (`validate_terminal_facts`,
  `trace_codegen.py:130-144`).
- For serde, it also asserts the **observed** deserialize rc in the trace equals
  the oracle's expected rc (`infer_serde_model`, `trace_codegen.py:147-176`).

### 4.2 Step 2 — emit a canonical C harness for that scenario

Each scenario maps to a hand-written C function baked into a template. `emit_c`
(`trace_codegen.py:1749-1760`) dispatches by family to `emit_c_serde` /
`emit_c_lifecycle` / `emit_c_stmt`. The generated `main()` simply `strcmp`s the
scenario string and calls the right `run_*` function.

The "translation" is therefore **scenario-templated, not opcode-by-opcode**: the
trace's role is to (a) select which canonical harness to emit and (b) be
cross-checked against the oracle so the harness provably matches the modeled
sequence. The actual C is purpose-written per contract.

The read-txn-busy harness it emits (`trace_codegen.py:438-467`) is exactly the
repro for the crash:

```c
static int run_deserialize_read_txn_busy(const char *case_name, const char *event_name) {
  sqlite3 *src = 0, *target = 0;
  unsigned char *data = 0;
  sqlite3_int64 size = 0;
  int count = 0, rc;

  emit_case(case_name);
  if (make_small_source(&src) != 0) return 1;       // CREATE t1; INSERT 1,2,3
  if (make_small_source(&target) != 0) return 1;
  if (serialize_copy(src, &data, &size) != 0) return 1;   // sqlite3_serialize

  if (exec_ok(target, "BEGIN") != 0) return 1;            // open a read txn
  if (query_count(target, &count) != 0) return 1;
  if (count != 3) return fail_msg(case_name, "read transaction query mismatch");
  if (sqlite3_txn_state(target, "main") != SQLITE_TXN_READ)
    return fail_msg(case_name, "target is not in SQLITE_TXN_READ state");

  rc = sqlite3_deserialize(target, "main", data, size, size,   // <-- the call under test
      SQLITE_DESERIALIZE_FREEONCLOSE);
  if (rc != SQLITE_BUSY) {                                 // docs say SQLITE_BUSY
    emit_diverge(case_name, rc);                           // ...real SQLite crashed here
  }
  ...
}
```

Every harness reports results on stdout in a tiny machine-readable protocol:

- `case <case-name>` — emitted when a case starts (`emit_case`).
- `diverge <case-name> <event> api=... expected=... observed=...` — emitted when
  the real return code / behavior differs from the documented expectation
  (`check_rc`, `emit_diverge`, `trace_codegen.py:293-324`).

Crucially, a **crash** never gets to print `diverge` — the process dies — which
is exactly why crashes are the most valuable signal (see §5).

### 4.3 What the harnesses actually exercise

The harnesses are real, careful C-API usage, not toys. A few examples:

- **serde** builds in-memory source/target DBs, uses `sqlite3_serialize` /
  `sqlite3_malloc64` / `memcpy` to construct images, and probes `READONLY`,
  `RESIZEABLE`, attached-schema, temp/missing schema, and bounded-growth
  (`SQLITE_FULL`) behavior (`trace_codegen.py:501-656`).
- **lifecycle** compares `sqlite3_prepare_v2` vs `sqlite3_prepare_v3(...,0,...)`
  field by field — rc, tail pointer offset, column count, step rc, first value,
  finalize rc, and `errmsg` string — across six SQL inputs including
  `nbyte` truncation and embedded-NUL cases (`PrepareObservation` /
  `compare_observations`, `trace_codegen.py:886-972`). It also exercises
  `backup_step(0/-1)`, partial backups, and transient-conflict retry against a
  multi-page source (`make_large_source` builds a 200-row blob table via a
  recursive CTE, `trace_codegen.py:820-827`).
- **stmt** checks `reset` retains bindings, `clear_bindings` nulls them,
  bind-after-step returns `SQLITE_MISUSE`, `data_count` transitions across
  ROW/DONE, and `column_blob` of a zero-length blob returns `NULL`
  (`trace_codegen.py:1526-1705`).

### 4.4 The optional Tcl path

With `--emit-tcl`, the tool also writes a SQLite **testfixture**-style Tcl
scaffold (`emit_tcl_*`, `trace_codegen.py:1763-1892`). These are explicitly
labeled scaffolds; the C harness is "the authoritative rc-level conformance
path." This matters because Tcl wrappers don't surface every C return code.

---

## 5. How divergence / bugs are detected against real SQLite

### 5.1 Compile against a pinned amalgamation

`run.sh trace-repro <itf>` → `run_trace_repro_core` (`run.sh:140-194`) generates
the `.c`, then compiles it together with the real SQLite amalgamation:

```sh
cc -std=c11 -O0 -g \
   -I "$SQLITE_SOURCE_DIR" \
   "$SQLITE_SOURCE_DIR/sqlite3.c" \
   "$src" -o "$out" -lpthread -ldl -lm
"$out"        # run it
```

The SQLite version is **pinned and verified**. `require_sqlite_source`
(`scripts/common.sh:42-78`) refuses to run unless `$SQLITE_SOURCE_DIR` contains
`sqlite3.c`/`sqlite3.h`/`manifest.uuid` whose version, version number,
source-id, and manifest UUID all match
[`spec/upstream.toml`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/spec/upstream.toml)
(at this commit, **SQLite 3.54.0**, manifest
`78193b60...44916b`). This guarantees a divergence is attributable to a known
exact build.

### 5.2 The sanitized lane — how crashes surface as bugs

With `--sanitize` (`run.sh:168-184`) the same harness is rebuilt with
**ASan + UBSan**, no-recover, frame pointers:

```sh
cc -std=c11 -g -O1 \
   -fsanitize=address,undefined \
   -fno-omit-frame-pointer -fno-sanitize-recover=all \
   -I "$SQLITE_SOURCE_DIR" "$SQLITE_SOURCE_DIR/sqlite3.c" "$src" -o "$out" ...
ASAN_OPTIONS=detect_leaks=0 "$out"
```

This is the lane that turns a counterexample into a concrete, reportable bug:

- The deserialize-during-read-txn case **segfaulted on macOS** and produced
  `SQLITE_CORRUPT` + Valgrind invalid-read reports on Linux — i.e. the process
  died or read freed/garbage memory instead of returning `SQLITE_BUSY`.
- The 128-byte `sqlite3_mutex` alignment bug surfaced as
  `UndefinedBehaviorSanitizer: undefined-behavior sqlite3.c:30828:32` (misaligned
  address) under UBSan.

This is why the blog stresses that crashes are the most useful outcome:

> "Crashes have one big advantage: it is easy to know that this is not an issue
> with the model, since crashing is almost never the right behavior."

A model bug can produce a false `diverge`, but it cannot make a *correct* SQLite
build segfault. So crashes are self-validating evidence.

### 5.3 The conformance gate

`run.sh trace-conformance <family>` (`run.sh:233-300`) is the regression harness:

1. `generate_trace_fixtures.py` writes every canonical `*.itf.json` for the family.
2. Each is run through `trace-repro`, appending `case`/`diverge` lines to a log.
3. `rg '^(case|diverge) ' "$out_log" | python3 <checker>` filters the protocol
   lines and pipes them to the family's checker.

The serde checker
([`c_quint_conformance_check.py`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/c_quint_conformance_check.py))
fails if **any** `diverge` line appears *or* if any of the 9 required cases is
missing from the output (`REQUIRED_CASES`, `:9-19`; `check`, `:64-72`). The
lifecycle and stmt families have their own checkers. So once a contract is
modeled and confirmed, any future upstream SQLite that breaks it fails the gate.

### 5.4 The model-ledger that ties it together

[`formal_models.toml`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/formal_models.toml)
is a machine-readable ledger binding each requirement/scenario ID to the exact
Quint module, `init`/`step`, and invariant names that mechanize it, e.g.:

```toml
[[formal_model]]
id = "serde-doc-null-schema-deserialize-installs"
tool = "quint_apalache"
model_path = "quint/serde_api.qnt"
invariants = ["successfulDeserializeInstalls"]
requirement_ids = ["SQLITE-CAPI-DESERIALIZE-NULL-SCHEMA-MAIN"]
scenario_ids = ["SERDE-DESERIALIZE-NULL-SCHEMA-MAIN"]
```

It explicitly disclaims source-level conformance — it asserts *abstract-model*
obligations and exists so "model drift is caught by the checkers."

---

## 6. How fast is generation and replay?

**Neither the blog nor the repo publishes throughput numbers**, and the author's
candid note ("severely underestimated how much time this takes") is about
*human* modeling effort, not machine runtime. But the design lets us characterize
performance precisely from the code:

**Model checking (trace generation) is cheap and bounded by construction:**

- The state is a flat record of a dozen booleans + one small enum; the search
  depth is tiny: `--max-steps=4` (serde), `7` (stmt), `8` (lifecycle)
  (`run.sh:66`, `:90`, `:121`).
- Apalache reduces each bounded check to an SMT query. With this little state and
  these depths, each `quint verify` invocation is effectively interactive
  (sub-second to a few seconds per invariant on a laptop). This is the whole
  point of modeling *one contract at a time* with minimal state — it keeps the
  search space trivially small.

**Replay cost is dominated by compiling SQLite, not by running traces:**

- Each scenario recompiles the entire **SQLite amalgamation** (`sqlite3.c`, on
  the order of ~250k lines) from scratch — at `-O0 -g` in the normal lane, or
  `-O1` with ASan/UBSan instrumentation in the sanitized lane (`run.sh:174-191`).
  That compile (seconds per scenario) dwarfs everything else.
- The generated harness itself does a handful of in-`:memory:` SQLite operations
  and exits in **milliseconds**. Trace execution is essentially free.
- `trace_codegen.py` is pure string templating with no heavy work — code
  generation is sub-millisecond.

So the realistic profile is: **generation ≈ seconds (SMT), per-scenario replay ≈
dominated by an amalgamation compile (seconds), trace execution ≈ milliseconds.**
There is no published aggregate "N traces/sec" figure because the harness is
correctness-oriented (a fixed, small set of curated/derived canonical traces
replayed deterministically), not a high-throughput fuzzer.

> Contrast with the GitHub Actions `run-fuzz-tests` job you linked
> ([PR #6474](https://github.com/tursodatabase/turso/pull/6474)): that is Turso's
> *own* SQL fuzzer in the main repo (the PR was a routine SQLite 3.53 bump +
> `fpdigits` pin), a separate harness from this Quint pipeline. I found no direct
> evidence that that specific CI run produced the deserialize crash; the
> deserialize crash is documented as coming from the Quint model →
> counterexample → C-repro flow described above.

---

## 7. The bugs (from the blog + forum thread)

Twelve bugs were reported; representative ones:

| Bug | Surface | How the pipeline caught it |
|---|---|---|
| `sqlite3_deserialize()` crash during active read transaction | `serde_api.qnt` `docBusyConflictsReturnBusy` | Docs say `SQLITE_BUSY`; real SQLite segfaulted / read invalid memory. Fixed upstream (`1fc7341a...`). |
| `sqlite3_db_readonly()` wrong after `-readonly` deserialize | readonly invariant | Returned 0 where 1 expected after `SQLITE_DESERIALIZE_READONLY`. |
| `sqlite3_mutex` 128-byte alignment UB | sanitized replay | UBSan: misaligned address at `sqlite3.c:30828`. |
| EXISTS→join optimization LIMIT/OFFSET errors | (query optimizer) | reported upstream |
| Nested EXISTS→join correlation loss | (query optimizer) | reported upstream |
| `ALTER ... ADD ... CHECK` crash with internal tables | (DDL) | reported upstream |
| xfer optimization BLOB type-check bypass | (optimizer) | reported upstream |

All were reported and fixed upstream in SQLite. The deserialize crash is
documented in the SQLite forum thread
[forumpost/39134ba029](https://sqlite.org/forum/forumpost/39134ba029)
(reporter: Pavan Nambi, ~April 27, 2026).

---

## 8. Why this approach works (the conceptual takeaways)

1. **Documentation is the oracle.** The hard problem in differential testing is
   knowing the right answer. Here, the Quint invariants *are* a formalization of
   SQLite's own published C-API contracts, so any divergence is either a real bug
   or a model bug — and crashes can only be real bugs.
2. **Abstraction keeps model checking trivial.** By modeling *one contract* with
   a flat boolean state and a 4–8 step bound, the SMT search stays tiny, so
   counterexamples come back instantly.
3. **Traces are a portable interchange format.** A counterexample is just a state
   sequence (ITF JSON). The same trace can drive a C harness today and (per the
   README's original intent) be replayed against Turso later to confirm Turso
   matches SQLite — "if it passes against sqlite, it's correct obviously."
4. **The codegen is intentionally narrow.** Rather than a general semantic
   interpreter for arbitrary traces, it pairs each modeled scenario with a
   hand-audited C harness and uses independent oracle tables to *prove the
   harness matches the trace*. This trades generality for trustworthy,
   reviewable repros.
5. **Pinning + sanitizers make findings reproducible and credible.** Exact
   version verification plus an ASan/UBSan lane turn "the model disagreed" into a
   concrete, upstream-reportable crash on a named build.

---

## Appendix: file map of `pavan-nambi/sqlite-c-api-quint`

| File | Role |
|---|---|
| [`quint/serde_api.qnt`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/serde_api.qnt) | serialize/deserialize state machine + invariants (found the crash) |
| [`quint/lifecycle_api.qnt`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/lifecycle_api.qnt) | close/finalize/prepare/backup state machine (1231 lines) |
| [`quint/stmt_api.qnt`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/stmt_api.qnt) | bind/reset/clear + column/data_count state machine |
| [`quint/run.sh`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/run.sh) | entry point: `model` / `trace-repro` / `trace-conformance` |
| [`quint/trace_codegen.py`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/trace_codegen.py) | ITF trace → validated canonical C repro (+ optional Tcl) |
| [`quint/trace_scenarios.py`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/trace_scenarios.py) | scenario metadata + canonical ITF state sequences + step inference |
| [`quint/trace_oracles.py`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/trace_oracles.py) | independent expected rc / steps / terminal-fact tables |
| [`quint/generate_trace_fixtures.py`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/generate_trace_fixtures.py) | writes canonical `*.itf.json` per scenario |
| [`quint/c_quint_conformance_check.py`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/c_quint_conformance_check.py) | serde `case`/`diverge` gate |
| [`quint/lifecycle_trace_conformance_check.py`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/lifecycle_trace_conformance_check.py) / [`stmt_...`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/stmt_trace_conformance_check.py) | per-family gates |
| [`quint/formal_models.toml`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/quint/formal_models.toml) | requirement ↔ model/invariant ledger |
| [`scripts/common.sh`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/scripts/common.sh) | pinned-SQLite verification + compile helpers |
| [`spec/upstream.toml`](https://github.com/pavan-nambi/sqlite-c-api-quint/blob/main/spec/upstream.toml) | pinned SQLite version/manifest (3.54.0) |

### Sources
- [Turso blog: How we used Quint to find over 10 bugs in SQLite](https://turso.tech/blog/how-we-used-quint-to-find-over-10-bugs-in-sqlite)
- [pavan-nambi/sqlite-c-api-quint (archived)](https://github.com/pavan-nambi/sqlite-c-api-quint)
- [SQLite forum: formal verification thread / deserialize crash](https://sqlite.org/forum/forumpost/39134ba029)
- [tursodatabase/turso PR #6474 (the linked CI run's PR)](https://github.com/tursodatabase/turso/pull/6474)
- [Quint language](https://quint-lang.org/)
