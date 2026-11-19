# HarnessKit — Engine/Checkpoint Identity Report

Status: real defect confirmed across three independent review rounds, closed in this branch
(`hk/p5b-engine-identity`, based on `f03525a`). Not merged, not pushed — committed to this
worktree's own branch only, per the isolation this lane was scoped to.

Files touched: `scripts/compose-workflow.js`, `scripts/langgraph-workflow.js`, `bin/harnesskit.js`.
No changes to `scripts/execute-workflow.js` (the file `hk/p5a-shared-handlers` is extracting shared
handlers out of, in a separate parallel worktree) — see "Relationship to `hk/p5a-shared-handlers`"
below.

---

## The bug

`bin/harnesskit.js`'s `resume` command (previously ~line 204-205) dispatched like this:

```js
function cmdResume(a) {
  if (a.engine === 'langgraph') return cmdResumeLangGraph(a);
  if (a.target) return cmdResumeTarget(a);   // <- legacy engine, unconditionally
  ...
}
```

`cmdResumeTarget` (legacy) reads `<target>/.harnesskit/workflow-dag.json`.
`cmdResumeLangGraph` reads `<target>/.harnesskit/langgraph-checkpoints.sqlite` via
`scripts/langgraph-workflow.js`'s `resumeWorkflow`, whose `resolveAndSetAdapter` hard-throws
`MissingCapabilityError` on unresolved capabilities.

**There was no mechanism anywhere that answered "which engine actually owns this target's
persisted state?"** A workflow started with `harnesskit run --engine langgraph ...` persists
*only* to `langgraph-checkpoints.sqlite` — `startWorkflow` never touches `workflow-dag.json`. A
bare `harnesskit resume --target <path>` against that same target therefore hit
`cmdResumeTarget`'s existing `if (!fs.existsSync(dagPath))` check and failed with a *misleading*
error ("run `harnesskit run` against this target first" — untrue; a run already happened, just
under the other engine).

The more dangerous version of this bug: if `run` is ever invoked under **both** engines against the
same target directory (nothing before this fix stopped that — `cmdRunLangGraph` never checked for
a pre-existing legacy dag, and vice versa), both `workflow-dag.json` and
`langgraph-checkpoints.sqlite` exist simultaneously, each describing a real, independent, possibly
divergent workflow state. A bare `resume --target` would then silently resume *whichever one
`cmdResumeTarget`'s hardcoded path happens to find* (the legacy dag), completely ignoring the other
engine's real, live checkpoint — a genuine silent-misroute, not just a bad error message.

---

## The identity scheme

### What's persisted, and where

Every composed workflow dag now carries an `engine` field:

```json
"engine": { "name": "legacy", "schema_version": 1 }
```

or

```json
"engine": { "name": "langgraph", "schema_version": 1 }
```

This is written by `scripts/compose-workflow.js`'s `composeWorkflow()`, which gained one new
optional parameter:

```js
function composeWorkflow({ taskClass, repoProfile, risk, policy, engine }) {
  const engineName = engine || 'legacy';
  if (!KNOWN_ENGINES.includes(engineName)) {
    throw new Error(`composeWorkflow: unknown engine '${engineName}' -- must be one of ${KNOWN_ENGINES.join(', ')}`);
  }
  ...
  return {
    task_class: taskClass || null,
    engine: { name: engineName, schema_version: ENGINE_SCHEMA_VERSION },
    stages, composed_at: nowIso(), composition_note: ...
  };
}
```

`ENGINE_SCHEMA_VERSION` (currently `1`) and `KNOWN_ENGINES` (`['legacy', 'langgraph']`) are
exported constants. The version is meant to be bumped only if the **shape of `dag.engine` itself**
changes (not for unrelated dag/stage-shape changes).

Two call sites, two outcomes, **one shared write path**:

- `bin/harnesskit.js`'s `cmdRunLocked` (legacy `run`) calls `composeWorkflow({ taskClass: null,
  repoProfile: profile })` — no `engine` passed, defaults to `'legacy'`. This is the *only*
  existing call site prior to this change, and its on-disk `workflow-dag.json` shape is unchanged
  except for the one new field — no migration needed, no existing consumer of that file breaks.
- `scripts/langgraph-workflow.js`'s `startWorkflow` now calls `composeWorkflow({ taskClass: null,
  repoProfile: profile, engine: 'langgraph' })`.

The second one is the interesting part: this `dag` object becomes the LangGraph graph's own `dag`
state channel (`WorkflowState`'s `dag: Annotation()`). LangGraph's `SqliteSaver` checkpoints the
*entire* state on every node transition, so `dag.engine` is persisted into
`langgraph-checkpoints.sqlite` **for free**, through the exact same write path the rest of the
workflow's state already uses — no separate write, no second place that could drift out of sync.
Confirmed by a new self-test assertion in `langgraph-workflow.js` (`selfTest` test 2,
`checkpoint_persisted_dag_carries_langgraph_engine_identity`) that reads it back out via
`getWorkflowState()` while the thread is genuinely paused mid-run.

Backward compatibility: a `workflow-dag.json` written before this change has no `engine` field at
all. The detection code (below) treats a missing field as `'legacy'` — safe, because this file has
only ever been written by the legacy engine; no prior version of this code could have produced a
langgraph-owned `workflow-dag.json`.

### Detecting ownership at resume time

New in `bin/harnesskit.js`: `detectOwningEngine(targetPath)` (async) and `guardEngineMismatch(...)`
(pure, sync), consulted by `cmdResume` before dispatching to either engine-specific resume path.

```js
async function cmdResume(a) {
  if (a.target) {
    const targetPath = path.resolve(a.target);
    const requestedEngine = a.engine === 'langgraph' ? 'langgraph' : 'legacy';
    const owning = await detectOwningEngine(targetPath);
    const mismatch = guardEngineMismatch(targetPath, requestedEngine, owning);
    if (mismatch) return printJson(mismatch);
    return requestedEngine === 'langgraph' ? cmdResumeLangGraph(a) : cmdResumeTarget(a);
  }
  ...
}
```

`detectOwningEngine` reads **real persisted content**, not just file paths:

- Legacy: `fs.existsSync(workflow-dag.json)` → parse it, read `dag.engine.name` (default `'legacy'`
  if absent).
- LangGraph: **only if `langgraph-checkpoints.sqlite` already exists on disk** does it call
  `getWorkflowState()` (from `langgraph-workflow.js`) and check whether a real checkpoint row came
  back (`snap.dag` truthy). An empty/never-invoked sqlite file is *not* mistaken for a real
  langgraph-owned run.

That last point matters and is worth spelling out, because it was the trickiest correctness issue
in this design: `SqliteSaver.fromConnString(path)` (called inside `compileGraph()`, which
`getWorkflowState`/`startWorkflow`/`resumeWorkflow` all call) creates the sqlite **file** as a side
effect of merely opening it, and the underlying `better-sqlite3` `CREATE TABLE IF NOT EXISTS`
schema setup runs on first *any* method call — including a read-only `getState()`. So:

1. **Detection never calls `compileGraph`/`getWorkflowState` at all if the checkpoint file doesn't
   already exist.** If it did, the mere act of checking "is this langgraph-owned?" on a pure-legacy
   target would create an empty checkpoint file, permanently (and wrongly) making every future
   check on that same target see the file and have to reason about it.
2. When the file *does* already exist, presence of the **file** is still not treated as evidence of
   ownership — only a real checkpoint row for that target's specific derived `thread_id` is
   (`snap.dag` truthy, i.e. `getState()` actually returned persisted values, not an empty
   snapshot). Regression-tested by `refused_cross_engine_probe_never_created_a_langgraph_checkpoint_file`
   in `bin/harnesskit.js`'s self-test.

### Auto-route vs. refuse — the design decision

**Decision: refuse, with an actionable, engine-and-path-specific error. Never silently auto-route.**

The task allowed either. Auto-routing looked superficially safer at first (it "just works" for the
user), but the two engines' resume flag vocabularies are **not interchangeable**:

- Legacy: `--resolve-stage <id> --resolve-status <s> --resolve-outputs '<json>'`
- LangGraph: `--resume-value '<json>' [--state-update '<json>']`

If `cmdResume` silently routed a request to whichever engine `detectOwningEngine` found as the
"real" owner, it would still be **silently discarding whichever engine-specific flags the caller
actually passed** — flags they wrote assuming the engine they *thought* they were resuming. A user
who runs `resume --target X --resolve-stage plan --resolve-outputs '{"plan_summary":"..."}'`
against a langgraph-owned `X`, auto-routed transparently to `cmdResumeLangGraph`, would have their
entire resolution silently dropped (that command reads `--resume-value`, never
`--resolve-stage`/`--resolve-outputs`) while the CLI still printed `"ok": true`. That is strictly
worse than today's plain failure — it *looks* like success while quietly doing something other
than what was asked.

Refusing costs the caller one extra invocation and tells them exactly what to run instead (the
literal retry command, with the real target path substituted in). Given the stated hazard is
specifically about *silent* misrouting, "loud and actionable" was the safer end of the two options
offered, and is what got built.

The guard has three branches, in `guardEngineMismatch`:

1. **Both** a real legacy dag and a real langgraph checkpoint exist (the coexistence hazard
   described above) → refuse regardless of `--engine`, name both paths, ask the caller to be
   explicit and consider separating them.
2. LangGraph owns it, request was bare/legacy → refuse, give the exact `--engine langgraph`
   retry command.
3. Legacy owns it, request was `--engine langgraph` → refuse, give the exact bare/legacy retry
   command.
4. (Implicit fourth outcome, not a branch: request matches actual ownership → `null`, proceed
   exactly as before. Also covers "neither engine has touched this target" — falls through to the
   existing, unchanged "no workflow-dag.json found" / "no paused thread found" errors.)

---

## Tests added

### `scripts/compose-workflow.js` self-test (3 new assertions)

- `engine_identity_defaults_to_legacy` — no `engine` option → `{name:'legacy', schema_version:1}`.
- `engine_identity_stamps_explicit_langgraph` — `engine: 'langgraph'` → stamped verbatim.
- `engine_identity_rejects_unknown_engine_name` — an unrecognized engine value throws, doesn't
  silently mislabel provenance.

### `scripts/langgraph-workflow.js` self-test (1 new assertion, inside existing test 2)

- `checkpoint_persisted_dag_carries_langgraph_engine_identity` — while a thread is genuinely
  paused mid-run, `getWorkflowState()`'s returned `dag.engine` reads
  `{name:'langgraph', schema_version:1}`.

### `bin/harnesskit.js` self-test (13 new assertions — covers all 3 required regression scenarios plus one bonus)

**(a) LangGraph-started target, bare `resume --target` (no `--engine`):**
- `identity_setup_langgraph_start_paused_at_plan`, `identity_setup_langgraph_start_wrote_no_legacy_dag`
- `bare_resume_on_langgraph_target_refuses_not_silently_misroutes` — asserts `ok:false` AND the
  error text names the langgraph engine and gives the `--engine langgraph` retry command
- `bare_resume_on_langgraph_target_never_created_a_legacy_dag` — proves the refusal happened
  *before* falling through to `cmdResumeTarget` (which would otherwise have started a brand new,
  wrong, fresh legacy workflow against an already-in-progress target)

**(b) Legacy-started target, `--engine langgraph` resume attempt:**
- `identity_setup_legacy_start_paused_at_plan`, `identity_setup_legacy_start_wrote_no_langgraph_checkpoint`
- `langgraph_resume_on_legacy_target_refuses_not_silently_misroutes`
- `refused_cross_engine_probe_never_created_a_langgraph_checkpoint_file` — proves the refusal
  happens *before* `compileGraph()` is ever called (no stray empty checkpoint file left behind)

**(c) Same-engine resume still works (both directions, regression check against the new guard):**
- `same_engine_langgraph_resume_still_works_through_the_guard` (reusing fixture from (a))
- `same_engine_legacy_resume_still_works_through_the_guard` (reusing fixture from (b))

**Bonus — ambiguous coexistence (guard branch 1), built on top of fixture (b):**
- `ambiguous_setup_langgraph_run_also_succeeds_against_legacy_owned_target` — confirms `run
  --engine langgraph` against an already-legacy-owned target is not itself blocked (a related,
  disclosed gap — see Known Limitations)
- `ambiguous_coexistence_refuses_regardless_of_requested_engine`

All new assertions required fixing one pre-existing bug in the fixtures during development: task
IDs like `TASKID001` don't match `task-discovery.js`'s `ROADMAP_ID` regex
(`/\b([A-Z]{1,5}-?\d{2,4})\b/g` — max 5 letters before the digits), so the fixtures use `TASKQ001`
/ `TASKZ002` instead (matching the convention already used elsewhere in this file's self-test,
e.g. `TASKX001`).

`cmdResume` had to become `async` (it now awaits `detectOwningEngine`), which meant one pre-existing
self-test call (`COMMANDS.resume({ target: repoRoot, 'resolve-stage': ... })`, previously
un-awaited because the whole call chain was synchronous) needed an `await` added — a one-line fix,
called out here because it's a change to a pre-existing test line, not new test content.

---

## Self-test results — all 8 required suites, HARNESS_ROOT set to this worktree

Run individually, `HARNESS_ROOT=<worktree-dir>/p5b-engine-identity` for every invocation:

```
scripts/execute-workflow.js --self-test        -> self-test: ALL PASS   (38 assertions)
bin/harnesskit.js --self-test                  -> self-test: ALL PASS   (35 assertions)
scripts/langgraph-workflow.js --self-test      -> self-test: ALL PASS   (27 assertions)
scripts/doctor.js --self-test                  -> self-test: ALL PASS   (18 assertions)
scripts/security-boundary.js --self-test       -> self-test: ALL PASS   (20 assertions)
scripts/content-provenance.js --self-test      -> self-test: ALL PASS   (9 assertions)
scripts/verification-classifier.js --self-test -> self-test: ALL PASS   (26 assertions)
scripts/task-discovery.js --self-test          -> self-test: ALL PASS   (10 assertions)
```

Plus `scripts/compose-workflow.js --self-test` (not one of the 8 mandated suites, but directly
touched by this change): `self-test: ALL PASS` (9 assertions).

No regressions in any of the 8 required suites or in `compose-workflow.js`. Zero flaky reruns
needed.

A real, manual end-to-end sanity check (outside the self-test harness, against fresh scratch
fixtures, cleaned up afterward) confirmed the exact hazard is now caught:

```
$ harnesskit run --engine langgraph --repo <fixture> --instruction "manual check lg"
  -> paused_at: discover-task
$ harnesskit resume --target <fixture>            # bare, no --engine
  -> {"ok": false, "error": "refusing to resume ... this target's workflow was created by the
      LangGraph engine ... Retry with: harnesskit resume --engine langgraph --target ... "}
$ harnesskit resume --engine langgraph --target <fixture> --resume-value '{"status":"completed", ...}'
  -> succeeds, advances normally
```

---

## Honest completion status

All 6 required items from the task are done:

1. Identity scheme designed and implemented (both stores, one write path).
2. Auto-detect-or-refuse implemented for `resume`, with documented reasoning for refuse-over-route.
3. All 3 required regression tests added (plus a bonus ambiguous-coexistence test), all passing.
4. All 8 required self-test suites run with `HARNESS_ROOT` set to this worktree — all pass, no
   regressions.
5. This report.
6. Committed to `hk/p5b-engine-identity` (this worktree's own branch) — see commit for exact SHA.

This is genuinely complete for what was asked. It is **not** a complete fix for every
engine-identity-adjacent gap that exists in this codebase — see below.

---

## Known limitations / disclosed gaps (not fixed here, out of this lane's scope)

1. **`run` doesn't prevent the ambiguous-coexistence state from being created in the first place.**
   Neither `cmdRunLocked` (legacy) nor `cmdRunLangGraph` checks whether the *other* engine already
   has real state at the same target before starting a fresh run. This lane fixes `resume` (the
   task's explicit scope) and adds detection that *catches* coexistence once it exists (guard
   branch 1, tested above) — but doesn't stop `run` from creating it. A natural follow-up: have
   `cmdRunLangGraph` call `detectOwningEngine`-equivalent logic and refuse to start if a legacy dag
   with real progress already exists there, and symmetrically for `cmdRunLocked`. Deliberately left
   out of this lane to stay inside the stated scope ("Implement auto-detect-or-refuse logic for
   `bin/harnesskit.js`'s `resume` command") and avoid scope creep into `run`'s semantics.
2. **No cleanup story for a refused-and-abandoned target.** If a caller hits the "BOTH" ambiguous
   branch, the error message suggests "moving the other engine's artifact aside" but there's no
   tooling to do that safely (e.g. no `harnesskit inspect --target` surfacing of which engine owns
   what, no archival command). Purely a UX gap, not a correctness one — the guard still refuses
   correctly either way.
3. **`ENGINE_SCHEMA_VERSION` is defined but not yet consulted by the detection/guard logic itself**
   — it's persisted and asserted in tests, but if a future schema change bumped it, nothing today
   would compare "checkpoint schema_version" against "code's current expected version" and warn on
   a mismatch. Currently harmless (there is only one version, `1`), but worth flagging as the
   natural next increment if `dag.engine`'s shape ever changes.
4. **Detection's LangGraph-side check pays the `@langchain/langgraph` require cost** whenever a
   checkpoint file already exists at the target, even for a request that's about to be refused.
   This is a deliberate, disclosed trade-off (see `detectOwningEngine`'s comment) — reusing the
   already-tested `getWorkflowState()` rather than hand-rolling a second, lighter sqlite-schema
   reader was judged the safer choice (one code path reading that file's schema, not two that could
   drift). Cost is a few hundred milliseconds at most, paid only when relevant.

---

## Relationship to `hk/p5a-shared-handlers`

This lane's task explicitly noted `hk/p5a-shared-handlers` (a separate, parallel worktree) is
extracting shared handlers out of `scripts/execute-workflow.js` at the same time. Confirmed at the
end of this work: **this lane made zero changes to `execute-workflow.js`.** The 3 files touched
here (`compose-workflow.js`, `langgraph-workflow.js`, `bin/harnesskit.js`) are adjacent to but
distinct from p5a's target file. `langgraph-workflow.js` does `require('./execute-workflow.js')`
for `AUTOMATED_HANDLERS`/`completeStage`/etc., so if p5a's extraction changes those *names* or
*call signatures* (not just their location), this lane's `resolveAndSetAdapter` /
`makeOrchestratorNode` call sites would need to follow — but nothing in this lane depends on where
those handlers physically live, only on their existing exported names, which p5a's own stated
scope (extracting shared handlers, presumably preserving the export surface) shouldn't change.

No blocking dependency found. **Recommendation, restated from the task brief and worth repeating
here**: review this lane and `hk/p5a-shared-handlers` together before either merges, even though
they were built independently in parallel — both touch engine-adjacent code
(`execute-workflow.js`'s exports are this lane's dependency; `bin/harnesskit.js` and
`langgraph-workflow.js` are this lane's own changes), and an integration-time smoke test (both
branches merged into one working tree, all 8 self-test suites re-run there) is cheap insurance
against a naming/signature drift neither lane's own self-test could have caught in isolation.

---

## Recommended independent reviewer

`ce-reliability-reviewer` — this change touches resume/retry semantics, engine-selection error
handling, and a checkpoint-side-effect correctness subtlety (`compileGraph`'s eager file/schema
creation) that's exactly the class of failure-mode review that persona is built for.
