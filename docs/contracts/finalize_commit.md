# Component Contract — `finalize_commit`

> M7 contract. **Honest status: `manual` (guarded).** Commits are human-initiated, staged explicitly,
> after review + QA + Ponytail — exactly the discipline used across this contract series. Not routine
> implementation; a finalization action.

## 1. component_id
`finalize_commit`. The guarded commit step.

## 2. Purpose
Commit green, scoped work to the **local** repo after all gates pass — explicitly staged, never a blanket
`git add -A`.

## 3. Interface
Human/host `git add <explicit paths>` + `git commit -m "<conventional>"`. Staging is per-file and verified
before commit.

## 4. Inputs
The reviewed diff; the verification summary (QA/review verdicts); the held-file exclusion list.

## 5. Outputs
One local commit (conventional message) + a shown `git status` + recent `git log`. **No push.**

## 6. State fields touched
None in run state (git is the store). Optionally records the commit sha in the run/handoff.

## 7. Gates
Commit only **after review + QA + Ponytail pass**. **Commits require a clean scoped diff and a verification summary.** Required: clean scoped diff · verification summary · **no held files staged accidentally** ·
**do not stage held `config/capability-registry.json`** unless explicitly approved · no unrelated files ·
honest status · recent log/status output. `ASK_BEFORE_PUBLISH`-adjacent — commit is local; **auto-push is
not allowed here**.

## 8. Executor
`human:git` (host-initiated). No autonomous commit today.

## 9. Invocation contract (external components only)
N/A — local git.

## 10. Failure modes
**Wrong files staged** (esp. the held `capability-registry.json`) → guard: explicit per-file staging +
count/exclude check → reset if violated. Committing with failing gates. Over-broad `git add`.

## 11. Repair behavior
Mis-stage → `git restore --staged` the offending file before commit. A bad commit → a new corrective
commit (never history rewrite by default).

## 12. Acceptance tests
- **Exists:** the manual guard (explicit staging + held-file exclusion) used every batch.
- **Needed:** if ever auto-commit: a check that staged set == intended set and the held registry is absent.

## 13. DISABLED behavior
Human-initiated — `DISABLED` doesn't apply to a manual commit, but no autonomous commit occurs regardless.

## 14. Work-state
- **current:** `contract_drafted` (behavior = `manual`/guarded).
- **desired:** `gated_auto` — trusted auto-commit only for **explicitly defined safe workflows**, later.
- **Honest gap:** keep human-initiated for now; runtime auto-commit is future and scoped, never blanket.

## 15. Smallest next slice
Keep manual; optionally add a pre-commit assertion (staged set matches intended set; held registry
excluded) as a helper the human runs. Named here; **not implemented in M7.**
