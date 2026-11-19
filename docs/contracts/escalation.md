# Component Contract — `escalation`

> M3 contract. **Brutally honest: missing.** The `escalated` state exists in the machine, but **no code
> ever transitions to it** — there is no exhaustion detector and no hand-to-human path today.

## 1. component_id
`escalation`. Terminal exit for `repair_loop` when `max_repair_loops` is hit (or a security hard-stop).

## 2. Purpose
Stop the loop and hand control to a human when repair cycles are exhausted or a non-recoverable block
(e.g. security non-clean) occurs — instead of spinning or proceeding unsafely.

## 3. Interface
**Desired (not built):** when `repair_loops_used >= max_repair_loops` (or a security block fires),
`transitionStage(runId, 'escalated')` + set `next_action` to a human-readable handoff. **Today:** nothing.

## 4. Inputs
`attempt_counters.repair_loops_used` vs cap; security verdict / `kill_criteria`.

## 5. Outputs
**Desired:** `status = escalated` (or `NEEDS_USER`) + a populated `next_action`. **Today: none.**

## 6. State fields touched
**Desired:** writes `status`, `next_action`. **Today: none.**

## 7. Gates
Human gate — escalation is the explicit "stop, a human decides" boundary. Terminal (`ALLOWED.escalated = []`).

## 8. Executor
`node` (intended: the repair-exhaustion check + a security-block handler).

## 9. Invocation contract (external components only)
N/A — local logic + human handoff.

## 10. Failure modes
- **Current:** never fires → a stuck run **silently spins** or stalls with no escalation signal.
- (Future) escalates too eagerly (cap too low) or fails to populate `next_action` → human gets no context.

## 11. Repair behavior
Terminal — escalation is the *end* of automated repair, not something that itself repairs. No transition
out of `escalated` (by design).

## 12. Acceptance tests
- **Exists:** none.
- **Needed:** a test that cap-exhaustion routes to `escalated` with a non-empty `next_action`, and that
  a security hard-stop escalates rather than advancing.

## 13. DISABLED behavior
N/A — terminal state logic.

## 14. Work-state
- **current:** `contract_drafted` (was missing).
- **desired:** `auto_on_exhaust`.
- **Honest gap:** the entire mechanism is absent — no detector, no transition, no handoff text. The
  `escalated` state is reachable in `ALLOWED` but nothing reaches it.

## 15. Smallest next slice
Add the exhaustion check (`repair_loops_used >= max_repair_loops → transitionStage('escalated')` +
`next_action`). (Depends on `max_repair_loops` incrementing.) Named here; **not implemented in M3.**
