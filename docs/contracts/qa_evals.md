# Component Contract — `qa_evals`

> M6 contract; **W11: WIRED.** Grounded in committed `scripts/run-evals.js` (`isDisabled() → exit 0`;
> emits an `all_pass` envelope) + the `evals/` suite (baselines, fixtures, results), now driven by
> `scripts/loop-conductor.js#runQaEvals` via `harness-loop --run --run-qa-evals --run-id <id>`. Regression
> QA layer, distinct from deterministic `qa_self_tests`. **Brutally honest:** an empty/misconfigured
> local eval suite (no enabled categories) reports `FAIL`, not a false `PASS` — verified against the real
> runner in a bare temp root during implementation.

## 1. component_id
`qa_evals`. Regression eval suite. Sibling: `qa_self_tests` (per-module asserts).

## 2. Purpose
Run the eval suite (guard-triggers, project-architecture, etc.) against baselines at `verification` to
catch behavioral regressions before review.

## 3. Interface
`node scripts/run-evals.js [--run-id <id>]` → an `all_pass` envelope `{ ..., all_pass: bool, results[] }`.
Honors the kill switch first: `isDisabled()` → `process.exit(0)` (no run).

**Wired driver (W11):** `runQaEvals(runId, opts) → result` in `scripts/loop-conductor.js`, exposed via
`harness-loop --run --run-qa-evals --run-id <id>`. `opts.command`/`opts.args` optionally inject a local
fixture command in place of the real runner (hermetic tests only; default is the real
`scripts/run-evals.js`). DISABLED is checked by the CLI itself before calling `runQaEvals` (returns the
exact `{ ok:true, decision:"blocked_by_gate", gate:"DISABLED", qa_evals_invoked:false,
verdict_written:false, state_transition:false }` shape, exit 0) AND again inside `runQaEvals` (defense
in depth, matching every other guarded conductor function) — no eval execution, no verdict, no
misleading pass under the kill switch. On a real run: the runner's `all_pass`/category output is mapped
to one verdict (`reviewer:"qa_evals"`, `target:"verification"`, `provenance:"deterministic_internal"`)
and recorded via the existing `recordVerdict`/`routeVerdict` (W6/W9) — **no new routing logic, no raw
`transitionStage` call.**

## 4. Inputs
`evals/` fixtures + baselines; `--run-id`; the kill-switch state. **QA executes the verification plan created during planning** — `qa_evals` covers the regression items named there.

## 5. Outputs
`all_pass` + per-eval results (raw runner output, `results.json` under `evals/results/<run-id>/`). **W11:**
one `qa_evals` reviewer verdict recorded in `reviewer-verdicts.ndjson` + state mirror, per invocation.

### Verdict mapping (W11)
| Runner output | Verdict | Severity | Notes |
|---|---|---|---|
| `ok:true` (all_pass) | `PASS` | `info` | routes `verification → final_review` via existing `routeVerdict` |
| `ok:false` (one/more categories failed, or empty/no enabled categories) | `FAIL` | `high` | `reasons` lists failed category names; `sends_back_to:"repair_loop"`; routes via the **guarded** `enterRepairLoop` admission — never a raw transition |
| spawn failure / non-JSON stdout / missing `ok` field | `ERROR` | `high` | `reasons` include the spawn/parse detail; recorded but **not routed** (matches `routeVerdict`'s existing non-negative-verdict no-op) |
| runner script itself missing (`scripts/run-evals.js` absent) | — | — | `{ ok:false, error:"qa_evals_runner_missing" }`, no verdict written, no wiring claim |

## 6. State fields touched
`reviewer_verdicts[]` (append, via `recordVerdict`) — only on a real (non-DISABLED) run. On `PASS`/`FAIL`
also `status` and (on `FAIL`) `attempt_counters.repair_loops_used`, via the existing `routeVerdict` →
`transitionStage`/`enterRepairLoop` paths (unchanged code, reused as-is).

## 7. Gates
**`DISABLED` → checked twice (CLI + library), no run, no verdict, no transition** (code-enforced kill
switch; W11 closes the "silent skip mistaken for pass" gap named in M6 — the CLI returns an explicit
`blocked_by_gate` result, never a bare exit-0 with no explanation). Policy: complex/multi-part work uses
**staged-pipeline / checkpoint QA** — evals are a checkpoint gate between stages, not a single end gate.

## 8. Executor
`node:scripts/run-evals.js`.

## 9. Invocation contract (external components only)
N/A — local Node (no external model/network in the suite itself).

## 10. Failure modes
Baseline drift / fixture mismatch → `all_pass:false` → `FAIL`. Stale baselines after a legitimate change
→ false fail until re-baselined. **W11-observed:** an empty/misconfigured eval config (no enabled
categories) also reports `FAIL`, not a silent pass — verified against the real runner in a bare temp
root; this is honest fail-closed behavior, not a bug, but means "0 categories ran" and "all categories
failed" currently look identical in the verdict (`reasons` distinguish them: empty-config yields the
generic "qa_evals reported not all_pass" reason with no named failing category).
`DISABLED` → explicit `blocked_by_gate` (W11) — no longer a silent skip mistaken for a pass.

## 11. Repair behavior
**Failed QA (`FAIL`) routes to `repair_loop`** via the guarded `enterRepairLoop` admission (W6/W9 —
never a raw transition). **Repeated failures respect `max_repair_loops`** → `escalation`. `ERROR`
(spawn/parse failure) is recorded but not routed (matches existing `routeVerdict` behavior for
non-negative-but-not-PASS verdicts). A `DISABLED` block is neither pass nor fail — no verdict recorded.

## 12. Acceptance tests
- **Exists:** the eval suite + baselines (all_pass at last run).
- **Exists (W11):** hermetic self-tests in `loop-conductor --self-test` — DISABLED blocks before
  execution (no verdict, no transition); all-pass fixture → exactly one `PASS`, routes to
  `final_review`; failing fixture → exactly one `FAIL`, routes via guarded `enterRepairLoop`; malformed
  output → `ERROR`, no transition; missing run id → CLI misuse (`ok:false`, exit 2); missing runner
  binary → `ERROR`, never a false `PASS`; no double-append (single `recordVerdict` call per invocation).
  `scripts/preflight.js` `guard:*`/`provenance:*`/`honesty:disabled-check-coverage` statically confirm
  the `--run-qa-evals` branch, its DISABLED coverage, and its `reviewer:'qa_evals'` +
  `provenance:'deterministic_internal'` stamp.
- **Needed:** a real end-to-end run against a populated `evals/` suite (not a bare temp root) to confirm
  the mapping against genuine category-level failures, not just the injected fixtures.

## 13. DISABLED behavior
**Checked twice — CLI (`harness-loop.js`) and library (`runQaEvals`) — before any execution.** Returns
`{ ok:true, decision:"blocked_by_gate", gate:"DISABLED", qa_evals_invoked:false, verdict_written:false,
state_transition:false }` at exit 0. Never `all_pass`, never a silent skip.

## 14. Work-state
- **current:** `wired` (W11; was `contract_drafted`).
- **desired:** `auto_in_verify` — fired automatically at `verification`, not yet implemented (still
  explicit human `--run-qa-evals` only; conductor NOT autonomous at this gate).
- **Honest gap:** the CLI path, DISABLED-explicit gating, verdict mapping, and existing-routing reuse are
  wired and reachable. Still missing: (a) no auto-trigger at `verification`; (b) the empty-config-vs-real-
  failure ambiguity noted in §10; (c) no end-to-end test against a real populated eval suite (only
  injected fixtures + one real-runner smoke call against an empty temp root, both during
  implementation — see §12).

## 15. Wired (W11) — and the next slice
**Implemented (W11):** `harness-loop --run --run-qa-evals --run-id <id>` — DISABLED-gated twice (CLI +
library); spawns the real `scripts/run-evals.js` (or an injected local fixture, tests only); maps its
output to exactly one `qa_evals` verdict (`PASS`/`FAIL`/`ERROR`); records via the existing
`recordVerdict`/`routeVerdict` (W6/W9) — reuses `verification → final_review` (PASS) and the guarded
`enterRepairLoop` admission (FAIL); no new routing code, no raw `transitionStage` call anywhere in this
slice; provenance always `deterministic_internal` (W9-valid, schema-checked).

**Next slice (`wired → verified`, named, not implemented):** a real end-to-end run against the populated
`evals/` suite to confirm category-level failure reporting beyond the empty-config case — OR an
auto-trigger firing `--run-qa-evals` when a run reaches `verification`, still requiring explicit human
invocation until conductor autonomy is a deliberate, separately-approved decision.
