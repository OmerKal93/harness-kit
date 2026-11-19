# Component Contract — `repair_loop`

> M3 contract; **W5: ADMISSION + COUNTER wired (`enterRepairLoop`); W6: `recordVerdict` REJECT/FAIL now
> ROUTE through it (bypass closed).** Grounded in committed `scripts/loop-conductor.js#enterRepairLoop` +
> `recordVerdict` + `ALLOWED.repair_loop`. **Brutally honest: the safe *admission* is wired and every
> negative-verdict path into `repair_loop` now goes through it — but the actual fix→re-review cycle is
> STILL not driven, `recordVerdict` only runs via the explicit `--continue` CLI, and the conductor is NOT
> autonomous.**

## 1. component_id
`repair_loop`. Paired with `max_repair_loops` (the cap) and `escalation` (the exit on exhaustion).

## 2. Purpose
The fix→re-review cycle: on a REJECT/fail verdict, send the run back to `planning` or `implementation`
to redo the work, then re-review.

## 3. Interface
**Wired (W5):** `enterRepairLoop(runId, opts) → { ok, decision, previous_status?, new_status?,
repair_loops_used?, max_repair_loops?, note }`. `decision`: `entered` (cap ok + legal source → counter +1,
log, transition) · `blocked` (cap guard returned block/error — no increment) · `error` (illegal
source / no state) · `skipped` (DISABLED). It **reuses `checkMaxRepairLoops`** for the cap, increments
`attempt_counters.repair_loops_used` **exactly once**, and transitions only when `repair_loop ∈
ALLOWED[from]` (i.e. from `plan_review` / `verification` / `final_review`). CLI: `/harness-loop --run
--enter-repair-loop --run-id <id> [--reason <text>]`.
**W6:** `recordVerdict(...)` no longer takes a raw transition to `repair_loop` — a REJECT (codex_cli @
`plan_review`) or FAIL (qa_evals @ `verification`) is routed through `enterRepairLoop` (the verdict is
still appended first via `verdict_log`). PASS forwards; WARN/ERROR record only. Legal exits
(`ALLOWED.repair_loop`): `planning`, `implementation`, `escalated`, `killed`. **No driver runs the fix.**

## 4. Inputs
The rejecting verdict (`sends_back_to`); current `attempt_counters`.

## 5. Outputs
On `entered`: `status = repair_loop`, `attempt_counters.repair_loops_used += 1`, a `repair_loop_entered`
decision-log event (`no_repair_executed:true`) + the transition's own decision-log line. On `blocked`: the
W4 `max_repair_loops_check` event (no increment). On illegal source: a `repair_loop_admission` error event.
**The redo + re-review are still host/manual — no code drives them.** Emits no reviewer verdict.

## 6. State fields touched
**Writes (on `entered` only):** `status` (→ `repair_loop`, via `transitionStage`) + `attempt_counters.repair_loops_used`
(+1, exactly once). **Reads:** `status`, `attempt_counters.repair_loops_used`, `budget.max_repair_loops`.
This is the increment `max_repair_loops` needs — now wired, here, on admission.

## 7. Gates
`NO_GATE` for admission, but **cap-gated** (re-entry is now blocked at `max_repair_loops` via the W4 guard)
and **DISABLED-gated** (skipped, no write). Legal-source check is an internal correctness gate.

## 8. Executor
`node:scripts/loop-conductor.js#recordVerdict` (entry) + host (the actual fixing).

## 9. Invocation contract (external components only)
N/A — local + host handoff.

## 10. Failure modes
- **Infinite loop:** now bounded — admission increments the counter and the W4 cap blocks at the limit.
- **No driver** re-runs the review after a fix → the cycle still stalls at the redo stage waiting on a human
  (admission is wired; the loop is not).
- Admission requires a legal source (`plan_review`/`verification`/`final_review`); a call from any other
  state → `error`, no increment (cannot silently double-count or enter illegally).

## 11. Repair behavior
Self-referential — this *is* the repair mechanism. Its safety (bounding) is delegated to `max_repair_loops`
(**now wired**, W4) → `escalation` (minimal stop wired). The actual repair *execution* is host/manual and
**not wired** — W5 only admits the run and counts the attempt.

## 12. Acceptance tests
- **Exists (W5):** conductor `--self-test` — admit from `plan_review` → `entered`, counter 0→1, status
  `repair_loop`, `repair_loop_entered` event, no reviewer verdict; second admit (after legal walk back) 1→2;
  at-cap & over-cap → `blocked`, no increment; bad config → fail-closed (not entered); illegal source
  (`implementation`) → `error`, no increment, status unchanged; DISABLED → `skipped`, no write.
- **Exists (W6):** `recordVerdict` routing — codex PASS → implementation (no admission); WARN → record only;
  REJECT → admission (counter +1, `repair_loop_entered` carries reviewer + verdict_id); REJECT at cap →
  `blocked` (verdict still recorded, no increment); qa_evals FAIL@verification → admission; invalid
  `sends_back_to` → no unsafe transition (admission only ever targets `repair_loop`); REJECT at a non-trigger
  status → no `repair_loop`; repeated REJECTs stop at cap.
- **Still needed:** a driver that runs the fix + re-review (conductor-autonomy slice, unwired).

## 13. DISABLED behavior
`enterRepairLoop` returns `skipped` and **writes nothing** under the kill switch (no admission, no
increment, no log) — consistent with the other wired guards.

## 14. Work-state
- **current:** `wired` (W5 admission + W6 routing) — `enterRepairLoop` admits safely (cap-check, single
  increment, decision-log, legal transition); `recordVerdict` routes every REJECT/FAIL through it (no raw
  transition); reachable via `/harness-loop --run --enter-repair-loop` and `--continue`; covered by the
  conductor `--self-test`.
- **desired:** `auto` — a driver runs the fix→re-review automatically.
- **Honest gap:** **only admission + counting + routing is wired.** Actual repair *execution* is NOT wired;
  `recordVerdict` runs only via the explicit `--continue` CLI (the conductor does NOT call it on its own);
  nothing drives the redo or the re-review.

## 15. Smallest next slice
A driver that, after a `repair_loop` entry, runs the redo stage (re-plan / re-implement) and re-review —
then loops back through `recordVerdict`. Conductor-autonomy slice. Named here; **not implemented in W6.**
