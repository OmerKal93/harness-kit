# Component Contract — `review_ce_simplify`

> M6 contract. **Brutally honest: `directive-only` and optional.** `/ce-simplify-code` is a host skill the
> conductor never invokes; no verdict path. Reuse/simplify review — complements, does not replace,
> Ponytail compactness.

## 1. component_id
`review_ce_simplify`. Optional reuse/simplification review at `final_review`.

## 2. Purpose
Host CE review for reuse, YAGNI, and simplification opportunities on the diff — a quality lens, optional
per workflow.

## 3. Interface
Host directive: `/ce-simplify-code` on the diff. Optional verdict path (desired). **No code invokes it; no
record path today.**

## 4. Inputs
The implementation diff; the plan's scope/non-goals.

## 5. Outputs
Simplification findings → (desired) a recorded verdict. **If recorded, lands in
`reviewer-verdicts.ndjson`.** Today: none.

## 6. State fields touched
**Desired:** `reviewer_verdicts[]` (optional). Today: none.

## 7. Gates
`NO_GATE` (read-only). Policy: **Ponytail remains the compactness/scope reviewer (`ponytail_*`) and is
NOT a full QA substitute**; `review_ce_simplify` is an additional, optional simplification lens, not a
replacement for deterministic QA or correctness review.

## 8. Executor
`host:/ce-simplify-code`. Not a CLI the conductor spawns.

## 9. Invocation contract (external components only)
Host slash-command → no programmatic contract.

## 10. Failure modes
Host skips it → no simplification pass (acceptable — it's optional). Over-applied → bikeshedding on trivial
diffs.

## 11. Repair behavior
Findings are advisory; a strong simplify finding can route `final_review → repair_loop` (optional), else
recorded as advisory. No hard block by default.

## 12. Acceptance tests
- **Exists:** none (host, optional).
- **Needed:** an optional verdict path if/when simplify findings should be recorded.

## 13. DISABLED behavior
N/A (host directive). The run step honors `DISABLED`.

## 14. Work-state
- **current:** `contract_drafted` (code = `directive-only`, optional).
- **desired:** `optional`.
- **Honest gap:** never invoked; no verdict recorded; purely a documented optional lens today.

## 15. Smallest next slice
Add an optional `ce_simplify` verdict path (advisory by default) for workflows that want a recorded
simplification pass. Named here; **not implemented in M6.**
