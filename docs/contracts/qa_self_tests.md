# Component Contract — `qa_self_tests`

> M6 contract; **W1: report-only wiring added.** Grounded in committed per-script `--self-test` +
> `loop-conductor.js#runQaSelfTests`. **Brutally honest: a report-only explicit CLI path now runs the
> module self-tests and records ONE verdict — it does NOT auto-run in the loop and does NOT transition
> state.** Deterministic QA layer (assert-based), distinct from CE/Codex/Ponytail/security review.

## 1. component_id
`qa_self_tests`. Deterministic per-module checks. Sibling: `qa_evals` (regression suite).

## 2. Purpose
Run each module's `--self-test` (assert-based) at the `verification` state to prove the unit-level
contract holds before review.

## 3. Interface
Per-module: `node scripts/<module>.js --self-test` → exit 0 (all asserts pass) / non-zero (fail).
**Wired (W1, report-only):** `/harness-loop --run --run-qa-self-tests --run-id <id>` →
`runQaSelfTests(runId, opts)` runs the module self-tests, aggregates, and records ONE verdict:
`PASS` (all pass) · `FAIL` (any non-zero exit) · `ERROR` (missing module / spawn failure) · `SKIPPED`
(kill switch on — no run, no write).

## 4. Inputs
The module under test; no external services. **QA executes the verification plan created during planning** — `qa_self_tests` covers the deterministic items on that plan.

## 5. Outputs
Per-module PASS/FAIL + one aggregate verdict **recorded in `reviewer-verdicts.ndjson`** (via
`verdict_log`) with reviewer `qa_self_tests`, plus a report-only `qa_self_test_run` event in
`decision-log.ndjson`. **Report-only: it records a verdict; it does NOT advance state or route to repair.**

## 6. State fields touched
**Desired:** `reviewer_verdicts[]` (the QA verdict) + `attempt_counters`. Today: none (manual run).

## 7. Gates
Ungated (temp-scoped, no side effects). Policy: **any code change starts a scaled review/QA war** — the
deterministic self-tests are the first, always-on rung; their depth scales with diff size/risk per the
plan's QA plan.

## 8. Executor
`node:*--self-test` (per-module).

## 9. Invocation contract (external components only)
N/A — local Node, no external process.

## 10. Failure modes
Assertion fail → non-zero exit. **A self-test that isn't run (the current default in `--run`) gives false
confidence** — the biggest gap. Flaky temp-fixture cleanup (rare).

## 11. Repair behavior
**W1 is report-only: a `FAIL`/`ERROR` verdict is recorded but does NOT auto-route anywhere** (`sends_back_to:
null`, no transition). The *designed* routing (**failed QA → `repair_loop`**, **repeated failures respect
`max_repair_loops`** → `escalation`, unknown/unsafe → gate/escalation/killed per `transition_model`) is a
LATER wiring slice — deliberately not wired here.

## 12. Acceptance tests
- **Exists:** the self-tests themselves (7 modules, all green at last run).
- **Needed:** the conductor runs the relevant `--self-test` at `verification` and records a verdict.

## 13. DISABLED behavior
The wired path **honors the kill switch**: under `DISABLED` it returns a `SKIPPED` verdict and **writes
nothing** (no self-test run, no verdict, no decision-log line) — consistent with other run-state writers.

## 14. Work-state
- **current:** `wired` (W1) — report-only CLI path runs the self-tests + records a verdict; covered by the
  conductor `--self-test` (PASS/FAIL/ERROR/SKIPPED + no-transition) and a live end-to-end run.
- **desired:** `auto_in_verify` (conductor auto-runs it at `verification` + routes the verdict).
- **Honest gap:** it is wired only as an **explicit, report-only** command — it does NOT auto-run in
  `--run`, does NOT transition state, and does NOT route `FAIL` to `repair_loop`. Those are later slices.

## 15. Smallest next slice
Auto-run `runQaSelfTests` at the `verification` state inside the conductor (still recording the verdict),
then — separately — route a recorded `FAIL` to `repair_loop`. (Both are conductor-autonomy slices, out of
W1 scope.) Named here; **not implemented in W1.**
