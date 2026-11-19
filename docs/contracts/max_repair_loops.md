# Component Contract — `max_repair_loops`

> M3 contract; **W4: the cap-CHECK is wired (`checkMaxRepairLoops`).** Grounded in committed
> `scripts/loop-conductor.js#checkMaxRepairLoops`. **Brutally honest: the GUARD now reads the counter/cap
> and blocks (fail-closed) — but NOTHING increments the counter yet** (that increment is `repair_loop`'s
> own unwired slice), so on a live `--run` the guard reads `0` and allows until something bumps it. The
> check is real and tested; the auto-increment + auto-call are later slices.

## 1. component_id
`max_repair_loops`. The cap for `repair_loop`; its trip-point feeds `escalation`.

## 2. Purpose
Bound the number of repair cycles so a failing run cannot spin forever — when `repair_loops_used` reaches
the cap, escalate instead of retrying.

## 3. Interface
**Wired (W4):** `checkMaxRepairLoops(runId, opts) → { ok, decision, allow, current_repair_count,
max_repair_loops, escalated?, note }`. Reads `attempt_counters.repair_loops_used` (counter) vs
`budget.max_repair_loops` (cap). `decision`: `allow` (count `<` cap) · `block` (count `>=` cap) · `error`
(missing/malformed cap or counter — **fail-closed, `allow:false`**) · `skipped` (DISABLED). On `block` it
writes a decision-log event and, **iff the run is in `repair_loop`** (the only `from` where `escalated` is
legal), transitions `repair_loop → escalated` (terminal) so no further repair can be entered; otherwise the
block is advisory (no illegal transition forced). **It does NOT increment the counter** (that is
`repair_loop`'s slice) and runs **no** repair/reviewer.
CLI: `/harness-loop --run --check-max-repair-loops --run-id <id>`.

## 4. Inputs
`budget.max_repair_loops` (cap, exists); `attempt_counters.repair_loops_used` (counter — never incremented today).

## 5. Outputs
A decision object (`allow`/`block`/`error`/`skipped`). On `block`/`error`: one `max_repair_loops_check`
event in `decision-log.ndjson` (`no_repair_executed:true`). On enforced `block` in `repair_loop`: the
`repair_loop → escalated` transition (its own decision-log line). `allow`/`skipped` write nothing.
**Emits no reviewer verdict** — this is a guard, not a reviewer.

## 6. State fields touched
**Reads:** `budget.max_repair_loops` (cap) + `attempt_counters.repair_loops_used` (counter). **Writes:**
only `status` — and only via the `repair_loop → escalated` transition on an enforced block. **Does NOT
write the counter** (a duplicate `budget.repair_loops_used` also exists in the schema; the contract counter
is `attempt_counters.repair_loops_used`). Incrementing is `repair_loop`'s slice, deliberately not done here.

## 7. Gates
`NO_GATE` for the threshold logic, but the **wired guard honors `DISABLED`** → `skipped` (no evaluation,
no write); safe because a frozen run runs no repair anyway.

## 8. Executor
`node` (intended inside `recordVerdict`/the repair entry path).

## 9. Invocation contract (external components only)
N/A — local logic.

## 10. Failure modes
- **Live input now exists (W5/W6):** the `repair_loop` admission increments the counter, and `recordVerdict`
  drives that admission on every REJECT/FAIL — so the cap now bites through the explicit `--continue` path.
  Still NOT auto-driven: `recordVerdict`/`enterRepairLoop` run only when called (no conductor autonomy), so a
  flow that never calls them leaves the counter at `0`.
- **Boundary:** uses `count >= max` (at-cap blocks). Fail-closed: missing/malformed cap or counter →
  `error` (`allow:false`), never an unbounded `allow`.
- Block is only **enforced** (escalated) when the run is in `repair_loop`; elsewhere it is advisory and a
  caller that ignores it could still start repair.

## 11. Repair behavior
This component *is* the bound. On exhaustion **in `repair_loop`** it now performs the minimal stop:
`repair_loop → escalated` (terminal), so the cycle cannot continue. It runs no repair work itself. Full
`escalation` automation (handoff packet, human notify) remains out of scope.

## 12. Acceptance tests
- **Exists (W4):** conductor `--self-test` — below cap → `allow` (no transition, no verdict); at cap in
  `repair_loop` → `block` + `escalated` (status becomes terminal `escalated`); over cap NOT in `repair_loop`
  → `block` advisory (no forced transition); missing cap → `error`; missing counter → `error`; block/error
  write a `max_repair_loops_check` decision-log event; DISABLED → `skipped` (no write).
- **Exists (W5/W6):** the `repair_loop` admission increments the counter and `recordVerdict` repeated
  REJECTs stop at the cap (conductor `--self-test`) — the guard now trips on real input.
- **Still needed:** an end-to-end test under a conductor that auto-calls the verdict→admission path.

## 13. DISABLED behavior
The wired guard returns `skipped` and **writes nothing** under the kill switch — consistent with the other
guards. Safe: a frozen run cannot enter `repair_loop`, so there is nothing to bound.

## 14. Work-state
- **current:** `wired` (W4) — `checkMaxRepairLoops` reads the cap/counter, decides allow/block/error/skipped
  (fail-closed), writes the decision-log event, and enforces `repair_loop → escalated` on exhaustion;
  reachable via `/harness-loop --run --check-max-repair-loops`; covered by the conductor `--self-test`.
- **desired:** `enforced` (end-to-end) — the verdict→admission path is auto-driven by the conductor.
- **Honest gap (post-W5/W6):** the counter IS now incremented (by the `repair_loop` admission) and
  `recordVerdict` drives it on REJECT/FAIL — but only via the explicit `--continue`/`--enter-repair-loop`
  CLI; the conductor does not auto-call them, and block-enforcement (escalate) is automatic only once the
  run is already in `repair_loop`.

## 15. Smallest next slice
A conductor driver that auto-runs the verdict→admission path (so the cap is enforced without an explicit
CLI call). Conductor-autonomy slice. Named here; **not implemented in W6.**
