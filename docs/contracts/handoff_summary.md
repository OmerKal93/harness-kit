# Component Contract — `handoff_summary`

> M7 contract. **Brutally honest: `planned`/missing.** The `handoff_behavior` fields exist in
> `workflow-state.json` but are **never populated** — no code emits a handoff packet today.

## 1. component_id
`handoff_summary`. The structured, sanitized end-of-run report.

## 2. Purpose
Emit a redacted run summary at completion so the next session/human picks up safely — truthful about what
was and wasn't done.

## 3. Interface
**Desired (not built):** `emitHandoff(runState) → summary` (redacted; reads final state + verdicts).
**Today:** none.

## 4. Inputs
Final run state + `reviewer_verdicts` + decision log + commit shas.

## 5. Outputs — required contents
A sanitized summary including: **objective · files changed · commits · verification run · gates held ·
known gaps · next safe slice · what was NOT done · any learning/memory candidates · context-compaction
status (whether compact is required/recommended before the next task)**. **No raw memory** in
the output (`private_memory_shared: false`).

## 6. State fields touched
`handoff_behavior` (currently unpopulated). Reads `reviewer_verdicts`, decision log. **Does not write
memory** (`facts.ndjson`).

## 7. Gates
`private_memory_shared: false` — the summary is **redacted** (no raw facts/secrets). **Handoff must not
claim more than was verified.** It **may feed learning/dreaming candidates** (via `mem_propose_candidates`/
`mem_dream`) but **must not directly write uncontrolled memory** — candidates only, human-gated capture.

## 8. Executor
`node` (intended; not built).

## 9. Invocation contract (external components only)
N/A — local.

## 10. Failure modes
- **Over-claiming** — reporting "done/verified" beyond the recorded verdicts (the cardinal sin; §7 forbids it).
- Leaking raw state / secrets into the summary (must redact).
- Silently writing memory instead of proposing candidates.

## 11. Repair behavior
None of its own — it reports. If a summary over-claims, the fix is to ground it in recorded verdicts
(objective truth from state), not to assert.

## 12. Acceptance tests
- **Exists:** none (planned).
- **Needed:** a test that the summary contains all §5 sections, redacts raw memory, and **does not assert
  any "verified" status without a matching recorded verdict**.

## 13. DISABLED behavior
Read/report only — safe; writes no memory regardless of the kill switch.

## 14. Work-state
- **current:** `contract_drafted` (was `planned`/missing).
- **desired:** `auto` (emitted at end of run).
- **Honest gap:** `handoff_behavior` is dead schema; nothing produces a handoff, so continuity depends on
  manual notes today.

## Context-compaction policy (CTX-0) — end-of-task rule owner
**This component owns the end-of-task compact rule. Handoff MUST report compact status before the next
task, and must not start the next task without it.**
- **40–49% at task end:** handoff must say **compact required** before the next task (even though 50% was
  not reached).
- **30–39% at task end + next task clearly large** (multi-step/code-heavy/review-heavy/external-tool-heavy):
  handoff must say **compact recommended** before the next task.
- **<30%:** no compact required by default.
- The compact-status line is part of the required §5 handoff contents; the decision is logged as a
  `context_compaction_decision` event (see `decision_log`).
- **Honest status: directive-only** (planned component; the Token Optimizer statusline is not readable
  programmatically and compaction is not auto-triggerable). Report at a **safe checkpoint**, no silent
  auto-compaction.

## 15. Smallest next slice
Emit a redacted summary from final state covering the §5 sections (incl. **what was not done** + **next
safe slice**), grounded only in recorded verdicts; route any learning to candidates, not direct memory
writes. Named here; **not implemented in M7.**
