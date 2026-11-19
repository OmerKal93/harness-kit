# Component Contract — `ponytail_review_skill`

> M2 contract. (Registry id `ponytail_review_skill` = the task's "ponytail_review".) **Brutally honest:
> this component is currently `missing` — `/harness-loop` NEVER invokes the real `/ponytail-review` skill.
> Only the arithmetic `ponytail_budget` exists.** This contract defines the desired wired behavior; it
> wires nothing and invokes nothing.

## 1. component_id
`ponytail_review_skill`. (Related: `ponytail_budget` = arithmetic gauge; `ponytail_always_on` = planned
writing-time enforcement — a separate registry entry, still `inventoried`.)

## 2. Purpose
Real compactness / over-engineering review by the Ponytail plugin skill (`/ponytail-review` on a diff;
`/ponytail-audit` on a repo), producing a `PASS`/`SHRINK`/`BLOCK_EXPANSION` verdict that, once recorded,
informs whether a change is allowed to proceed or must be made smaller.

## 3. Interface
- **Executor (host):** `/ponytail-review` (diff over-engineering) · `/ponytail-audit` (repo).
- **Loop re-entry (desired, not built):** a `ponytail_review` verdict fed back via a future
  `harness-loop --run --continue --record-verdict '{"reviewer":"ponytail_review","verdict":"PASS|SHRINK|BLOCK_EXPANSION",...}'` → `recordVerdict`.
- **Today:** no interface — nothing calls the skill and there is no `ponytail_review` record path.

## 4. Inputs
The change to review: a plan (plan/scope role) or a diff (writing-time / final role).

## 5. Outputs
Shrink/over-engineering findings (human-readable) → a `ponytail_review` verdict record (when the
record-verdict path exists). Today: **no outputs in the loop** (skill never run).

## 6. State fields touched
(Desired) `reviewer_verdicts[]` via `appendVerdict`. Today: none.

## 7. Gates
Read-only review skill → `NO_GATE` to *run* it (no writes). Honest caveat: invoking it is a **host**
action (a Node script cannot call `/ponytail-review`), so it is a host handoff, not code-enforced.

## 8. Executor
`host:/ponytail-review` (+ `/ponytail-audit`). Plugin present + enabled (`.ponytail-active`), but **never invoked by the loop**.

## 9. Invocation contract (external)
Host slash-command, not a CLI the conductor spawns. No code path invokes it → no programmatic contract today.

## 10. Failure modes
- **Primary (current):** the skill is simply never called → no review happens; the loop relies on the
  arithmetic `ponytail_budget` and mislabels it `ponytail_review`.
- (Future) host skips the directive; verdict not recorded; ambiguous findings.

## 11. Repair behavior
(Desired) a `SHRINK`/`BLOCK_EXPANSION` verdict → shrink the change (or `ASK_BEFORE_EXPANSION`) before
proceeding; a real `REJECT`-equivalent → `repair_loop`. Today: none.

## 12. Acceptance tests
- **Needed (none exist):** a directive at the relevant stage(s) + a `ponytail_review` record-verdict
  path + a test that a recorded `SHRINK`/`BLOCK_EXPANSION` blocks the write/advance.

## 13. DISABLED behavior
N/A (host skill, read-only). The loop wiring that *triggers* it would honor `DISABLED` like other `--run` steps.

## 14. Work-state
- **current:** `contract_drafted` (was `missing` — skill never invoked).
- **desired:** `auto_on_write` (invoked + verdict recorded).
- **Honest gap:** the real Ponytail review does not participate in the loop at all today. "Ponytail
  always-on during writing" (past docs) = the arithmetic budget only; this skill is absent.

## Future wired behavior (defined separately, NOT built)
1. **Plan/scope reviewer** — run `/ponytail-review` on `plan.md` at `plan_review` (alongside Codex) to catch over-scoped plans before implementation.
2. **Writing-time compactness governor** — enforce during writing; tracked under the separate
   `ponytail_always_on` component (combine the `ponytail_budget` numeric gate with a `/ponytail-review`
   pass on the working diff). Contract for that component is deferred to a later M-slice.
3. **Final review** — `/ponytail-review` on the final diff at `final_review` → recorded verdict;
   `SHRINK`/`BLOCK_EXPANSION` sends back to a shrink/repair step.

## 15. Smallest next slice
Add a `ponytail_review` directive at `final_review` (host runs `/ponytail-review` on the diff) + a
record-verdict path so its verdict enters `reviewer_verdicts`. Keep the arithmetic `ponytail_budget`
separate and stop mislabeling it. Named here; **not implemented in M2.**
