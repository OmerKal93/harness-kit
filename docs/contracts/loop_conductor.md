# Component Contract — `loop_conductor`

> M3 contract. Grounded in committed `scripts/loop-conductor.js` (self-test 12/12). **Brutally honest: it
> is a `kickoff` conductor, not a loop driver.** `startRun` runs automatically; everything after is
> helper-only and there is **no driver that advances the run** beyond the first directive.

## 1. component_id
`loop_conductor`.

## 2. Purpose
Orchestrate the run start: `select workflow → init state → read memory → advance to planning → emit the
first host directive`, plus house the (mostly unwired) helpers (codex review, budget, dream, plugin check).

## 3. Interface
`harness-loop --run "<goal>"` (kickoff) · `--plan` (print-only) · `--continue --record-verdict <json>` (one
real transition) · `--dream` · `--check-plugins`. Internally: `startRun(goal, opts)`,
`recordVerdict(...)`, `runCodexReview(...)`, `ponytailBudgetCheck(...)`, `dreamFromRecentRuns(...)`,
`checkPlugins(...)`.

## 4. Inputs
The goal string; `opts.root`; the kill-switch state; for `--continue` a verdict JSON.

## 5. Outputs
A new run dir + initialized `workflow-state.json` at `planning`; the first directive text (host handoff);
report output for `--dream`/`--check-plugins`. **No autonomous advance past the first stop.**

## 6. State fields touched
Via `workflow_state_writer`: `status`, `current_stage`, `next_action`, memory fields on init; one
transition on `--continue`.

## 7. Gates
`--run` honors `DISABLED` (no-op). External helpers it *contains* are independently gated (codex =
`DISABLED` + `ASK_BEFORE_EXTERNAL`). The conductor itself is otherwise ungated orchestration.

## 8. Executor
`node:scripts/loop-conductor.js`.

## 9. Invocation contract (external components only)
N/A for the conductor core; the codex sub-call's verified invocation lives in `docs/contracts/codex_review.md`.

## 10. Failure modes
Host fails to follow the emitted directive → run stalls (no driver to detect/resume). No `step()` to
compute the next conductor-side action. Mis-selection of workflow (mitigated by word-boundary match fix).

## 11. Repair behavior
None autonomous. `--continue` records a verdict that drives exactly one transition (codex PASS→implementation
/ REJECT→repair_loop). Nothing loops it.

## 12. Acceptance tests
- **Exists:** `--self-test` 12/12 (select, init, advance-to-planning, gate refusals, dream/plugin report).
- **Needed:** a test of a real `step(runId)` once it exists (the next-slice driver).

## 13. DISABLED behavior
`--run` is a no-op under `DISABLED` (logged). Report modes (`--dream`, `--check-plugins`) are read-only.

## 14. Work-state
- **current:** `contract_drafted` (code = kickoff/partial).
- **desired:** `auto_driver`.
- **Honest gap:** there is no loop. `startRun` auto-runs once and stops; the rest are helpers with no
  caller chaining them. The whole "closed loop" is, today, kickoff + one manual `--continue` hop.

## Context-compaction policy (CTX-0) — mid-run threshold owner
> Token Optimizer statusline = a context signal only (see `cap_registry` / `plugin_update_gates`). NOT
> adopted/run here. **This component owns mid-run context-threshold enforcement.**
- **≥50% context:** compact **boundary** — stop at the **next safe checkpoint**, record state, then
  compact before continuing (**compact required**).
- **Never compact mid-unsafe-op:** file write, patch apply, commit, plugin update, publish, external
  execution, or memory write — reach a safe checkpoint first.
- Every compact decision → a `context_compaction_decision` event in `decision-log.ndjson` (see `decision_log`).
- **Honest status: directive-only.** The harness **cannot currently read the Token Optimizer statusline
  programmatically**, and **cannot trigger compaction programmatically**. Enforceable behavior today =
  report/block at a safe boundary, **not silent automatic compaction**. No runtime enforcement until wired.

## 15. Smallest next slice
Add `step(runId)` that computes the next conductor-side action from current `status` and (optionally,
behind gates) executes it — the seam a real driver would call in a loop. Named here; **not implemented in M3.**
