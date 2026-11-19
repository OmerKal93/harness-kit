# HarnessKit → LangGraph.js: Phase 5 Implementation Report

Status: real vertical slice, built and tested against the actual repo tree, additive. The legacy
hand-rolled engine (`scripts/execute-workflow.js`, `bin/harnesskit.js`'s default `run`/`resume`) is
untouched and remains the default; nothing here removes or breaks it. Not committed (per the task's
instruction) — this is a snapshot of uncommitted working-tree changes at the time of writing.

Starting point: `docs/plans/LANGGRAPH_ARCHITECTURE_DESIGN.md` (design + research only, no code). This
report is the follow-up build, done directly in `<repo-root>`.

---

## 1. What was built

- **`package.json`**: added `@langchain/langgraph@^1.4.7` and
  `@langchain/langgraph-checkpoint-sqlite@^1.0.3` as real dependencies. `npm install` run for real,
  inside this repo's own dependency tree (not an isolated scratch project) — clean, 0 vulnerabilities,
  same `better-sqlite3` "install script skipped by allow-scripts, prebuilt binary still loads" pattern
  the design doc found in its scratch test, re-confirmed here:
  ```
  $ node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); console.log(db.prepare('SELECT 1 as x').get());"
  { x: 1 }
  ```
  The real shipped `.d.ts` files (`StateGraph`, `CompiledStateGraph.updateState`/`getState`,
  `interrupt`, `Command`, `SqliteSaver`) were read directly from `node_modules/` before writing any
  code, not assumed from the design doc.

- **`scripts/langgraph-workflow.js`** (new): a real `StateGraph` with 10 nodes, one per existing
  stage (`inspect-repository`, `discover-task`, `classify-task`, `challenge-task`, `plan`, `execute`,
  `deterministic-verify`, `independent-review`, `prepare-commit`, `final-report`), connected by a
  strictly linear `addEdge` chain — confirmed linear by re-reading `compose-workflow.js`'s
  `STAGE_TEMPLATE`/`defaultDependencies()` and `execute-workflow.js`'s `topologicalOrder()` (real
  Kahn's-algorithm code, but never fed anything but this same linear chain). Every automated node
  calls the real handler from `AUTOMATED_HANDLERS` (imported from `execute-workflow.js`, not
  reimplemented) and writes results back through the real `completeStage()` (same file) — so
  security-boundary scanning, the verification-classifier 7-state policy, and the
  `validateReviewIndependence` gate all apply because it is literally the same code running, not a
  parallel reimplementation.

- **Checkpointing**: one SQLite file per target repo, at `<target>/.harnesskit/langgraph-checkpoints.sqlite`
  — matching the existing convention (`<target>/.harnesskit/` already holds `workflow-dag.json`,
  `task-discovery.json`, etc.) and deliberately sidestepping the design doc's disclosed, unverified
  concurrent-writer-safety question by never sharing one checkpoint file across targets.
  `thread_id` = sha256 of the resolved absolute target path (design doc's own proposed convention).

- **Pause/resume mapping**: `task-discovery.js`'s genuine `NEEDS_USER` confidence-tie is mapped onto a
  real `interrupt()` call inside `discoverTaskNode` (and, following the same pattern, inside
  `challengeTaskNode` for its structurally similar tie/staleness re-check). The three orchestrator
  stages (`plan`, `execute`, `independent-review`) each call `interrupt()` and resume via
  `Command({resume})`, applying the resumed value through the real `completeStage()`.

- **CLI wiring** (`bin/harnesskit.js`): additive `--engine langgraph` flag on the existing `run` and
  `resume` verbs — not a new verb, matching this project's "six verbs" convention.
  ```
  harnesskit run --engine langgraph --repo <url-or-path> --instruction "<text>"
  harnesskit resume --engine langgraph --target <path> --resume-value '<json>' [--commit-message "<msg>"] [--state-update '<json>']
  ```
  `main()` was made `async` (and awaits the dispatched command) to support this — a no-op change for
  every legacy (synchronous) command; `selfTest()` was likewise made `async` to add new, real
  assertions for the langgraph path. The legacy engine's own behavior was re-verified unaffected (see
  §4, `legacy_engine_unaffected_by_langgraph_addition`).

---

## 2. Real proof: cross-process interrupt/resume, end to end, with a real commit

Not the design doc's 2-process toy example — a real, repository-changing workflow, driven through
**five genuinely separate `node` process invocations** (each a fresh OS process, spawned via
`execFileSync`, sharing zero in-memory state — only the SQLite checkpoint file on disk carries state
across them), against a real, disposable, git-initialized fixture repo:

1. **Process A**: `node bin/harnesskit.js run --engine langgraph --repo <fixture> --instruction "..."`
   → runs `inspect-repository` → `discover-task` → `classify-task` → `challenge-task` for real, hits
   the `plan` orchestrator stage's `interrupt()`, and **exits completely** (`paused_at: "plan"`).
2. **Process B**: `... resume --engine langgraph --target <fixture> --resume-value '{"status":"completed","outputs":{"plan_summary":"e2e plan"}}'`
   → reloads the checkpoint from the SQLite file (no memory from process A), resumes `plan`, advances
   to `execute`'s interrupt (`paused_at: "execute"`).
3. **Process C**: resolves `execute`, supplying `--state-update` to inject a known-good `repo.test`
   command (see §5 finding below on why this seam — `Command({resume, update})` — was needed) →
   `deterministic-verify` runs the **real** command (`node -e "process.exit(0)"`, a real subprocess,
   real exit code 0, classified `VERIFIED_PASS` by the real `verification-classifier.js`), then
   reaches `independent-review`'s interrupt (`paused_at: "independent-review"`).
4. **Process D**: resolves `independent-review` with `reviewer_adapter_id: "codex-cli"` (genuinely
   different from `execute`'s `claude-code`) and `--commit-message`. Because `prepare-commit` and
   `final-report` are automated nodes with no interrupt of their own, this **single process** runs
   all the way through a **real `git add -A` + `git commit`** (`handlePrepareCommit`, unmodified) and
   `final-report`, to completion (`interrupted: false`).
5. **Process E** (re-resume after completion): confirms `resumeWorkflow()` **refuses**
   (`ok: false, "no paused/resumable LangGraph thread found"`) rather than silently re-running
   anything — no duplicated commit, no re-executed stage.

Real git verification after the run: exactly **one** new commit landed
(`d8435e1 feat: e2e proof commit via langgraph engine`), and its SHA matches the fixture's real
`HEAD` — no stage's side effect (especially the git commit) was duplicated across any of the five
process boundaries.

Real self-test output (from `node scripts/langgraph-workflow.js --self-test`, this session):
```
PASS  self-test:process_a_pauses_at_plan_then_exits  ({"ok":true,"paused_at":"plan"})
PASS  self-test:process_b_resumes_plan_lands_at_execute  ("execute")
PASS  self-test:reaches_independent_review_across_processes  ("independent-review")
PASS  self-test:genuinely_different_reviewer_accepted_across_processes  ({"stage_id":"independent-review","status":"completed","selected_adapter":"codex-cli","outputs":{"reviewer_adapter_id":"codex-cli","verdict":"PASS"}})
PASS  self-test:run_completes_with_no_further_interrupt  ({"interrupted":false,"paused_at":null})
PASS  self-test:prepare_commit_completed_with_a_real_sha  ({"stage_id":"prepare-commit","status":"completed","selected_adapter":"claude-code","outputs":{"commit_sha":"d8435e121cfdfe68e09bbed8daf16e70a5c61b5c","message":"feat: e2e proof commit via langgraph engine","pushed":false}})
PASS  self-test:final_report_completed  (...)
PASS  self-test:exactly_one_new_commit_no_duplicate_side_effect  (["d8435e1 feat: e2e proof commit via langgraph engine"])
PASS  self-test:commit_sha_matches_real_head  (d8435e121cfdfe68e09bbed8daf16e70a5c61b5c)
PASS  self-test:resume_after_completion_refuses_not_silently_reruns  ({"ok":false,"error":"no paused/resumable LangGraph thread found for ... -- did 'run --engine langgraph' start one?", ...})
self-test: ALL PASS
```

**A genuine, unplanned proof of the security gate along the way**: the first time this repo's own
tests ever drove a workflow all the way to `prepare-commit`, `git add -A` staged the fixture's own
`.harnesskit/task-discovery.json` artifact — whose real numeric confidence field
(`0.6000000000000001`) pattern-matched `security-boundary.js`'s credit-card regex, and
`handlePrepareCommit`'s real `scanBeforeCommit` **genuinely blocked the commit** on the first attempt.
This is not a bug introduced by this migration — it is a real, previously-unexercised interaction in
the *existing* handler (no prior self-test in this repo had ever reached a real `prepare-commit` with
`.harnesskit/` artifacts staged). The fix applied was the correct one and not a scanner weakening: the
fixture's own `.gitignore` now excludes `.harnesskit/`, exactly the practice any real target repo
should already follow (mirroring HarnessKit's own `.gitignore` excluding `runs/`). The gate itself was
not touched, loosened, or bypassed.

---

## 3. Independent-review gate: proven to survive the LangGraph path

Recent adversarial review of the hand-rolled engine (Findings 1/2) hardened `validateReviewIndependence`
against a same-adapter reviewer and a fabricated/never-registered reviewer id. Because this module
calls the exact same `completeStage()` function (imported, not reimplemented), those fixes apply
automatically — proven, not assumed, by a dedicated self-test:

```
PASS  self-test:same_adapter_reviewer_rejected_through_langgraph_path  ({"stage_id":"independent-review","status":"rejected_not_independent","selected_adapter":"codex-cli","outputs":{"reviewer_adapter_id":"claude-code","verdict":"PASS","independence_check_failed":"reviewer_adapter_id 'claude-code' matches the producer adapter 'claude-code' -- not independent"}})
PASS  self-test:rejected_review_never_reaches_a_real_commit  ({"stage_id":"prepare-commit","status":"blocked", ...})
```

A reviewer declared identical to the producer is rejected (`rejected_not_independent`), and that
rejection is never satisfied by `prepare-commit`'s gate — same behavior as the legacy engine's own
self-test #6d, reached this time entirely through the LangGraph graph.

---

## 4. Real interrupt/resume proof (in-process) and CLI wiring proof

In-process round trip against a genuine `discover-task` confidence tie (same fixture shape as
`bin/harnesskit.js`'s own existing self-test — `AGENTS.md` with two equally-weighted "active task"
mentions, both scoring confidence `0.60`, neither clearing ahead of the other):

```
PASS  self-test:inprocess_run_pauses_at_discover_task_tie  ({"interrupted":true,"paused_at":"discover-task"})
PASS  self-test:inprocess_interrupt_payload_carries_real_candidates  (... candidate_tasks: [TASKA100 @0.60, TASKB200 @0.60] ...)
PASS  self-test:getWorkflowState_reports_paused_before_resume  (["discover-task"])
PASS  self-test:inprocess_resume_advances_past_discover_task  ({"interrupted":true,"paused_at":"plan"})
```

CLI-level proof (`bin/harnesskit.js --self-test`), confirming `--engine langgraph` is real, reachable
surface — not a library sitting unused — and that it does not disturb the legacy default path:

```
PASS  self-test:cli_engine_langgraph_run_reaches_plan  ({"ok":true,"engine":"langgraph","paused_at":"plan"})
PASS  self-test:cli_engine_langgraph_resume_advances_past_plan  ("execute")
PASS  self-test:legacy_engine_unaffected_by_langgraph_addition  ("plan")
```

---

## 5. The disclosed risk, resolved: `updateState(asNode)` vs. today's `--resolve-stage <any-id>`

The design doc named one real, unresolved question: today's
`harnesskit resume --target --resolve-stage <any-id> --resolve-outputs '<json>'` can patch *any*
named stage's status/outputs regardless of where execution actually paused, while LangGraph's lower-
level analog, `CompiledStateGraph.updateState(config, values, asNode)`, was confirmed to exist but was
never actually exercised. This session exercised it for real, with three separate experiments (kept
in scratch, not part of this repo).

**Finding: `updateState(asNode)` is real, but strictly MORE dangerous than the legacy flag when used
to target a node other than the one a thread is genuinely paused at — it silently skips the real
paused node's execution entirely, with no re-check.**

Experiment 1 (does `updateState` let you jump ahead, skipping intervening nodes?): a 4-node linear
graph (`a→b→c→d`) was run to completion, its full checkpoint history inspected, then
`updateState(checkpointAfterA, {trace:['FORCED-d']}, 'd')` was called from the checkpoint recorded
right after `a` ran (before `b`/`c` ever executed). Result: `getState().next` became `[]` (fully
done), and continuing the graph produced `{"trace":["a","FORCED-d"]}` — nodes `b` and `c` **never
ran, not even once**. `updateState(asNode)` sets `next` to the named node's static-graph successors,
with no verification that the nodes actually between the checkpoint's real position and the forced
node ever executed.

Experiment 2 (is `Command({resume})` similarly dangerous if misused?): calling
`Command({resume:'x'})` against a checkpoint with **no pending interrupt** does **not** throw and
does **not** skip anything — it is a harmless no-op passthrough that just continues real execution
from wherever `next` actually points, running every subsequent node for real. This confirms
`interrupt()`/`Command({resume})` alone is safe and narrow: it can only ever continue truthfully from
where the graph genuinely is.

Experiment 3 (the case most directly analogous to today's flag): a graph genuinely interrupted at
node `b` (real `interrupt()` call, `getState().next === ['b']`) was resumed via
`updateState(currentConfig, {trace:['FORCED-c']}, 'c')` — targeting `'c'`, **not** the node (`'b'`)
execution was actually paused at. Result: `next` became `[]`, the final trace showed `c` as forced,
and node `b`'s body **never logged its resume** — the genuinely-interrupted node was silently
bypassed, never actually resolved.

**Conclusion, stated honestly rather than forced into a fake equivalence**: LangGraph's real resume
model is *narrower* in the safe case (interrupt/resume can only ever continue truthfully from the
actual current position) but the lower-level escape hatch (`updateState(asNode)`) that would be
needed to replicate the legacy flag's "any named stage" generality is *more dangerous* than the
legacy flag, not equivalent to it — it can silently skip real, unexecuted predecessor work with no
safety check, which the legacy engine's `topologicalOrder()` loop structure incidentally prevents
(an out-of-order `completeStage()` call there still gets re-visited and re-paused at any genuinely
incomplete predecessor on the next `executeWorkflow()` pass).

**Design decision made as a result**: `scripts/langgraph-workflow.js`'s `resumeWorkflow()` only ever
exposes the safe, narrow path — resuming exactly the node a thread is actually interrupted at, via
`Command({resume, update})`. It refuses outright (`ok:false`) if there is no pending interrupt at all
(see the "resume after completion" self-test). **No `--resolve-stage <arbitrary>` equivalent is wired
into the `--engine langgraph` CLI surface**, and `updateState(asNode)` is not called anywhere in this
module. This is a deliberate, disclosed narrowing of the legacy flag's nominal scope — not a fake
equivalence, and, per the empirical evidence above, arguably a *safer* engine on this specific point
than the flag it's replacing.

One genuinely useful, safe seam this work did add: `Command({resume, update})` lets a resume call
also merge extra fields into graph state (verified real — `state.extra` was visible to a downstream
node after `Command({resume, update:{extra:'hello-from-update'}})`). This is how `--commit-message`
and `--state-update` reach the automated, non-interrupting `prepare-commit` node in this module —
there is no other seam to inject ctx fields mid-run, since only the currently-interrupted node
receives `resume` directly.

---

## 6. What was NOT migrated / proven (honest list)

- **`missing_capability` mid-run halting.** The legacy engine treats an unresolved capability as a
  soft pause (`status: 'missing_capability'`, `paused_at` reported, resumable in principle once a
  real adapter exists). This module's `resolveAndSetAdapter()` throws a `MissingCapabilityError`
  instead — a hard graph-run failure, not an inspectable pause. This is a deliberate simplification,
  not an oversight (documented in code comments), and was never exercised as a genuine failure mode in
  this session's proofs because every stage's required capability resolved against the real,
  registered adapters in `config/adapter-registry.json` (`claude-code`, `codex-cli`) throughout. If a
  real target repo hits a true `missing_capability` case through this engine, it currently crashes
  the process rather than reporting a clean, resumable pause the way the legacy CLI does.
- **`deterministic-verify` auto-retry via `retryPolicy`.** `NodePolicyOptions.retryPolicy` is real
  (confirmed in the shipped `.d.ts`) but was not exercised in this session — `deterministicVerifyNode`
  uses its own `interrupt()`-based retry loop (re-running the real handler with a merged override)
  instead, which is closer to today's actual `--verification-override` CLI usage than LangGraph's
  generic retry primitive would have been.
- **`updateState(config, values, asNode)` and `bulkUpdateState`** are not used anywhere in the shipped
  module (see §5) — confirmed real via direct experiments, deliberately not wired into the CLI.
- **Checkpoint-history-as-audit-trail** (`checkpointer.list(config)`, replacing "cat
  task-discovery.json" as an audit view) — not built. The design doc named this as a possible future
  replacement for the current `task-discovery.json` side-file audit trail; this session's `taskDiscovery`
  channel in graph state gives an equivalent value inside a single checkpoint snapshot, but no tooling
  was built to walk full checkpoint history for audit purposes.
- **Concurrent-writer safety** of the SQLite checkpoint file was sidestepped, not resolved, by using
  one file per target repo (matching today's `.harnesskit/`-per-target isolation) rather than one
  shared file — the design doc's disclosed UNVERIFIED concern about `better-sqlite3`'s behavior under
  truly concurrent writers from multiple simultaneous processes against the *same* file was not
  re-tested, because this module's convention never creates that scenario in the first place.
- **A real, latent Windows bug surfaced (not fixed, out of scope)**: `inspect-repo.js`'s package.json
  detection always yields an `npm run <script>`-shaped command, and the legacy
  `handleDeterministicVerify`'s `execFileSync(cmd, args, ...)` genuinely fails with `spawnSync npm
  ENOENT` on this Windows machine when invoking a bare `npm`-prefixed command without `shell: true`
  (confirmed with a direct reproduction, separate from any LangGraph code). This is a pre-existing gap
  in the already-tested legacy engine (no existing self-test in this repo happens to exercise a
  package.json-detected verify command), surfaced only because this session's self-tests are the first
  to drive a repo-profile-detected command through a real workflow run. Not fixed here — flagged for a
  separate, focused fix.
- **`guard-triggers` eval suite (`node scripts/run-evals.js`)** shows 20/28 passing both before and
  after this work (confirmed via `git stash`/`git stash pop` A-B comparison) — a pre-existing gap,
  unrelated to and unaffected by this migration.

---

## 7. Full self-test run (this session, after all changes)

All 9 self-test suites in the repo, run with `HARNESS_ROOT=<repo-root>`:

| Suite | Result |
|---|---|
| `scripts/execute-workflow.js --self-test` | ALL PASS (32 assertions) |
| `scripts/task-discovery.js --self-test` | ALL PASS (10 assertions) |
| `scripts/compose-workflow.js --self-test` | ALL PASS (6 assertions) |
| `scripts/doctor.js --self-test` | ALL PASS (16 assertions) |
| `scripts/security-boundary.js --self-test` | ALL PASS (14 assertions) |
| `scripts/content-provenance.js --self-test` | ALL PASS (9 assertions) |
| `scripts/verification-classifier.js --self-test` | ALL PASS (22 assertions) |
| `bin/harnesskit.js --self-test` | ALL PASS (18 assertions, incl. 3 new `--engine langgraph` ones) |
| `scripts/langgraph-workflow.js --self-test` (new) | ALL PASS (22 assertions) |

No pre-existing self-test regressed. The `guard-triggers` eval-suite gap (§6) is confirmed
pre-existing via A/B comparison, not introduced by this work.

---

## Summary

- **Real interrupt/resume works end-to-end**, across genuinely separate OS processes, through a real
  repository-changing workflow (a real `git commit` landed exactly once, no duplicated side effects).
- **The security-boundary / verification-classifier / independent-review gates all still apply**
  through the LangGraph path, because the same handler and `completeStage()` code runs either way —
  proven by dedicated self-tests, plus one genuine (unplanned) real-world catch of a credit-card-regex
  false positive on a real commit attempt.
- **Left unproven / not migrated**: `missing_capability`'s soft-pause behavior (hard-throws instead),
  `retryPolicy`-based auto-retry, checkpoint-history-as-audit-trail tooling, and — deliberately, on
  safety grounds backed by direct experiment — any `updateState(asNode)`-based "resolve an arbitrary
  stage" CLI equivalent to today's `--resolve-stage <any-id>` flag.
