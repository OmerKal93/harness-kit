# Component Contract — `decision_log`

> M3 contract; **W12: WIRED.** Grounded in committed `scripts/workflow-state.js#transitionStage` (writes
> the transition line) + `#updateWorkflowState` (W12: writes the state-patch line). **Honest status:**
> every legal transition appends one audit line, `force:true` bypasses are now explicitly visible
> (never silently indistinguishable from a normal transition), and successful state patches emit their
> own event. Conductor-level *routing* decisions (which repair path, which review) still are not
> captured here — that gap is unchanged by W12 and remains open (see §14).

## 1. component_id
`decision_log`.

## 2. Purpose
Append-only audit trail of state transitions: who moved the run from `from` to `to` and why.

## 3. Interface
No public function of its own — `transitionStage` appends to `runs/<id>/decision-log.ndjson` on every
accepted transition; **W12:** `updateWorkflowState` appends a second event type on every successful
non-empty patch. (This is where `loop_conductor` is told to write its routing decisions, e.g. the
future `ponytail_always_on` scope/diff routing.)

### Event shapes (W12)
**Transition** (unchanged shape + 2 new fields, always present):
```json
{ "ts": "...", "run_id": "...", "event_type": "transition", "from": "...", "to": "...",
  "reason": "...", "forced": false, "force_reason": null, "artifact": "workflow-state.json" }
```
`forced` is **always present** (never omitted) — `true` only when the caller passed `{force:true}`
(the `ALLOWED`-map bypass escape hatch); `force_reason` carries `change.force_reason` when forced, else
`null`. W12 makes forced bypasses visible; it does **not** block or further validate them (unchanged
behavior — see `transition_model`'s own N2 gap).

**State patch** (new event type, W12):
```json
{ "ts": "...", "run_id": "...", "event_type": "state_patched",
  "changed_keys": ["attempt_counters", "next_action"], "source": null, "reason": null }
```
`changed_keys` is the **top-level key list of the patch object only** — never values, never a state
dump, never plan text, never secrets, never memory payloads. Emitted only when the patch is non-empty
(a no-op patch logs nothing). `source`/`reason` are optional caller-supplied metadata
(`opts.source`/`opts.reason`); both `null` when not provided. The decision-log append itself is
best-effort (try/catch, non-fatal) — a logging failure never blocks or partially-applies the state
write, matching the established convention of every other decision-log helper in the codebase.

## 4. Inputs
`from`, `to`, `reason`, `force`, `force_reason` (transitions); the patch object + optional
`opts.source`/`opts.reason` (state patches).

## 5. Outputs
One `{ from, to, reason, forced, force_reason, ... }` line per transition, and one
`{ event_type:"state_patched", changed_keys, ... }` line per non-empty successful patch, in
`decision-log.ndjson`.

## 6. State fields touched
None in the state document — it is a sidecar log only.

## 7. Gates
None — internal audit write.

## 8. Executor
`node:scripts/workflow-state.js#transitionStage` + `#updateWorkflowState` (the two append steps).

## 9. Invocation contract (external components only)
N/A — local module.

## 10. Failure modes
Append-only; same fs path as the state dir. A skipped transition (via direct field write instead of
`transitionStage`) would bypass the log — callers must transition through `transitionStage`. **W12:** a
direct field write instead of `updateWorkflowState` likewise bypasses `state_patched` — same advisory
perimeter as the rest of the library layer (unchanged by W12; not closed here). The `state_patched`
append is best-effort (try/catch) — a filesystem error there does not fail the state write itself.

## 11. Repair behavior
None needed.

## 12. Acceptance tests
- **Exists:** `workflow_state_writer` `--self-test` asserts `decision-log.ndjson` is written under the run dir.
- **Exists (W12):** normal transition logs `event_type:"transition"` + `forced:false`; illegal
  transition still rejected with no new line; forced transition logs `forced:true` + `force_reason` +
  `from`/`to`/`run_id`/`event_type`; a successful patch emits exactly one `state_patched` event with
  `changed_keys` (never full state, verified by key-absence assertion); an empty patch emits nothing.
- **Needed:** a test that conductor routing decisions (not just status transitions) are captured once
  `loop_conductor` writes them — unchanged gap, not addressed by W12.

## 13. DISABLED behavior
N/A — local append.

## 14. Work-state
- **current:** `wired` (W12; was `contract_drafted`).
- **desired:** `auto` (no change).
- **Honest gap:** transition audit is complete and now includes explicit force-visibility; state
  mutations via `updateWorkflowState` are now audited (key names only). Still missing: (a)
  conductor-level *routing* decisions (which repair path, which review) — unchanged, needs the
  driver/governor that isn't built; (b) a direct field write bypassing `transitionStage`/
  `updateWorkflowState` still skips the log entirely — advisory perimeter, not closed; (c) `force:true`
  is visible but still **not blocked or further validated** (the `transition_model` N2 out-of-range-`to`
  bug is untouched by W12 — see that contract).

## Context-compaction policy (CTX-0) — compact-decision event shape
Compact decisions (owned by `loop_conductor` mid-run · `handoff_summary` end-of-task · planning pre-task)
are recorded here as `decision-log.ndjson` events:
```json
{
  "event_type": "context_compaction_decision",
  "context_percent": 0,
  "band": "ge_50 | 40_49 | 30_39 | lt_30 | unknown",
  "decision": "compact_required | compact_recommended | no_compact_required | unknown",
  "reason": "<short>",
  "safe_checkpoint_required": true,
  "source": "token_optimizer_statusline | manual_user_report | unknown"
}
```
Bands: **≥50%** (`ge_50`) · **40–49%** (`40_49`) · **30–39%** (`30_39`) · **<30%** (`lt_30`).
`safe_checkpoint_required` is always `true` — never compact mid-unsafe-op.
**Honest status: directive-only** — no code emits this event yet; it is the agreed shape for when the
`loop_conductor`/`handoff_summary` wiring lands.

## 15. Wired (W12) — and the next slice
**Implemented (W12):** `transitionStage`'s event gained `event_type:"transition"` + always-present
`forced`/`force_reason` fields (visible force bypasses, unchanged behavior otherwise);
`updateWorkflowState` gained a `state_patched` event (changed top-level key names only, non-fatal
best-effort append, no logging on empty patches). A dead/duplicate schema field,
`budget.repair_loops_used`, was identified during this work (nothing reads or writes it after init;
`attempt_counters.repair_loops_used` is the single source of truth) — flagged in
`scripts/workflow-state.js` and `workflow_state_writer.md`, **not deleted** (schema-drift removal is a
separate, deliberate decision, out of scope for W12).

**Next slice (`wired → verified`, named, not implemented):** when `loop_conductor` gains routing logic
(repair vs escalate, scope vs diff), write each decision as a `decision-log.ndjson` line with a
`decision_type` — closes the one gap W12 deliberately left open.
