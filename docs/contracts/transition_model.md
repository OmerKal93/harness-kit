# Component Contract — `transition_model`

> M3 contract. Grounded in committed `scripts/workflow-state.js#ALLOWED` + `transitionStage`. **Honest
> status: `auto` and real** — the legal state-machine is enforced on every transition. Owns the
> **blocked/gate-pause** state legality (`waiting_for_human_gate`) and the **killed** terminal legality.

## 1. component_id
`transition_model`. Also the home of "blocked state / gate handling" legality (the
`waiting_for_human_gate` state — there is **no separate `blocked` component or state**; see mapping).

## 2. Purpose
Define and enforce the legal 14-state machine — which `to` status is reachable from each `from` — so the
loop cannot enter an out-of-order state.

## 3. Interface
`transitionStage(runId, to, change = { reason, force }, opts) → { ok, ... }`. Reads the frozen `ALLOWED`
map. Rejects `to` unless `to ∈ ALLOWED[from]`, **unless** `change.force` is set (escape hatch).

## 4. Inputs
Current `from` status (from state), requested `to`, `change.reason`, `change.force`.

## 5. Outputs
Accept (writes new `status`, appends `stages_completed`, writes `decision-log.ndjson` line) or reject
(no write). Returns `{ ok }`.

## 6. State fields touched
`status` (write on accept), `stages_completed[]` (append). Reads current `status`.

## 7. Gates
No external gate — this **is** an internal correctness gate. `force:true` bypasses validation (escape
hatch) — code-enforced bypass, used deliberately by callers.

## 8. Executor
`node:scripts/workflow-state.js#transitionStage`.

## 9. Invocation contract (external components only)
N/A — local module.

## 10. Failure modes
- **Open bug (N2):** with `force:true`, an out-of-range `to` (not even a defined state) is persisted — `force`
  skips the `to ∈ states` sanity check entirely, not just the adjacency check.
- Caller relies on `force` routinely → state machine silently weakened.

## 11. Repair behavior
Illegal transition without `force` → rejected, no state change, caller must pick a legal `to`.

## 12. Acceptance tests
- **Exists:** covered by `workflow_state_writer` `--self-test` (legal accept / illegal reject).
- **Needed:** a test that `force` still rejects a `to` that is not a member of the state set (the N2 fix),
  and that `waiting_for_human_gate` only exits to `implementation`/`stopped`.

## 13. DISABLED behavior
N/A — pure validation, no side effects beyond the write it guards; no kill-switch check.

## 14. Work-state
- **current:** `contract_drafted` (code = `auto`, enforced). **Unchanged by decision_log's W12** — force
  bypasses are now *visible* in `decision-log.ndjson` (`forced:true` + `force_reason`, see
  `decision_log.md`), but this component's own N2 defect (force skips the `to ∈ states` sanity check)
  is untouched. Visibility ≠ validation.
- **desired:** `auto` (no change) — plus the N2 hardening.
- **Honest gap:** enforcement is real; the only defect is the `force` escape hatch not validating `to` is
  a real state.

## Mapping note
The state machine (`ALLOWED`) is: `initialized→classified→context_ready→planning→plan_review→
{waiting_for_human_gate|implementation|repair_loop}→…→{completed|stopped|escalated|killed}`. "Blocked /
gate handling" = the `waiting_for_human_gate` pause state here; per-component gates (`DISABLED`,
`ASK_BEFORE_*`) are config fields on each component, not modeled here. No new ID invented.

## 15. Smallest next slice
Validate `to ∈ states` even when `force:true` (the N2 fix) + add the two legality tests above. Named here;
**not implemented in M3.**
