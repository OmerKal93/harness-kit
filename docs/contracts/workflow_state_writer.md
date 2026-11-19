# Component Contract — `workflow_state_writer`

> M3 contract. Grounded in committed `scripts/workflow-state.js` (self-test 14/14). **Honest status: this
> one is real and `auto`** — unlike most loop components. It also **owns the persistence of the
> blocked/killed states and `kill_criteria`** (no separate component exists for those — see mapping below).

## 1. component_id
`workflow_state_writer`. Absorbs two concepts with no dedicated ID: the **gate-pause state**
(`waiting_for_human_gate`) and **kill criteria / killed state** (`kill_criteria[]` field + `killed`
terminal status). Those are persisted here, validated by `transition_model`.

## 2. Purpose
Persist per-run loop state atomically: the `workflow-state.json` document plus the append-only
`reviewer-verdicts.ndjson` and `decision-log.ndjson` sidecars.

## 3. Interface
`initWorkflowState(runId, fields, opts) → state` · `readWorkflowState(runId, opts)` ·
`updateWorkflowState(runId, patch, opts)` · `transitionStage(runId, to, change, opts)` ·
`appendVerdict(runId, verdict, opts)`. (`transitionStage`/`appendVerdict` are also contracted separately
as `transition_model` / `verdict_log` — they live in this module.)

## 4. Inputs
`runId`, `workflowId`, field patches, verdict objects; `opts.root` (HARNESS_ROOT-relative run dir).

## 5. Outputs
`runs/<id>/workflow-state.json` (atomic tmp+rename) · `reviewer-verdicts.ndjson` (append) ·
`decision-log.ndjson` (append). Sets all schema fields incl. `status`, `kill_criteria[]`, `stages_completed`.

## 6. State fields touched
All schema fields (read/write). Notably `status` (incl. `waiting_for_human_gate`, `killed`, `escalated`,
`stopped`), `kill_criteria[]`, `reviewer_verdicts[]`, `stages_completed[]`, `attempt_counters`.

## 7. Gates
None at the library level — it is an ungated writer; **callers gate the writes** (e.g. `--run` honors
`DISABLED`, codex double-gates). Atomicity is the only built-in safety. **Advisory** w.r.t. gates.

## 8. Executor
`node:scripts/workflow-state.js`.

## 9. Invocation contract (external components only)
N/A — local Node module, no external process.

## 10. Failure modes
Disk/IO error mid-write (mitigated by tmp+rename → no partial file); illegal transition (rejected by
`transition_model` unless `force`); a `force` write can still persist an out-of-range `status` (open bug
N2, owned by `transition_model`).

## 11. Repair behavior
Atomic write = all-or-nothing (no partial state to repair). Illegal transition → rejected, no write.
No retry needed (local fs).

## 12. Acceptance tests
- **Exists:** `--self-test` 14/14 (incl. atomic write, decision-log written, appendVerdict ok).
- **Needed:** an explicit assertion that `kill_criteria`/`killed` round-trip, and that `waiting_for_human_gate`
  persists + only transitions to `implementation`/`stopped`.

## 13. DISABLED behavior
Library is **ungated** — runs regardless. The kill switch is enforced one level up (the `--run` caller),
not here.

## 14. Work-state
- **current:** `contract_drafted` (code is `auto`/done; contract was missing).
- **desired:** `auto` (no change — already real).
- **Honest gap:** code is complete; the only gaps are test coverage for the gate/kill states it persists
  and the `force` out-of-range bug (tracked under `transition_model`).
- **W12 note:** `budget.repair_loops_used` (set at `initWorkflowState`) is a **dead/duplicate field** —
  `attempt_counters.repair_loops_used` is the single source of truth read by `checkMaxRepairLoops` and
  written by `enterRepairLoop`; nothing reads or writes `budget.repair_loops_used` after init. Flagged
  inline in `scripts/workflow-state.js`, **not deleted** — schema-drift removal is a separate decision.
  `updateWorkflowState` now also emits a `state_patched` decision-log event per successful non-empty
  patch (see `decision_log.md`) — key names only, no value/state dump.

## Mapping note (no new IDs invented)
"Blocked state / gate handling" and "killed / kill criteria" have **no standalone component ID**. They are
states/fields persisted here and validated by `transition_model`; per-component gates (`DISABLED`,
`ASK_BEFORE_*`) are config fields on each component, not a component. Mapped explicitly per the M3 rule.

## 15. Smallest next slice
Add self-test assertions for `kill_criteria` round-trip + `waiting_for_human_gate` legal exits. (The
`force` out-of-range fix is `transition_model`'s slice.) Named here; **not implemented in M3.**
