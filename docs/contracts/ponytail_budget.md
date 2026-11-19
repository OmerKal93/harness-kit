# Component Contract — `ponytail_budget`

> M2 contract; **W2: report-only wiring added.** Grounded in committed
> `scripts/loop-conductor.js#ponytailBudgetCheck` + `#runPonytailBudget`. **Brutally honest: arithmetic
> only on PROVIDED counts — it does NOT invoke Ponytail, does NOT read a git diff, does NOT enforce during
> writing.** Distinct from `ponytail_review_skill` (real `/ponytail-review`) and `ponytail_always_on`
> (planned writing-time enforcement). The wired wrapper records the honest reviewer label `ponytail_budget`
> (fixing the cosmetic `ponytail_review` defect at the recorded-verdict level).

## 1. component_id
`ponytail_budget`.

## 2. Purpose
A pure-arithmetic compactness budget check: compare a change's file/line counts against the workflow's
budget and emit a `PASS`/`BLOCK_EXPANSION` verdict + an expansion-gate flag. **It is not a review** — it
calls no skill and reads no diff content.

## 3. Interface
Helper (arithmetic core): `ponytailBudgetCheck(state, change = { files, lines }) → { reviewer, verdict,
expansion_gate, gate, files, lines, budget }` — returns `PASS`/`BLOCK_EXPANSION`; its `reviewer:
"ponytail_review"` field is a **cosmetic label** (ignored by the wrapper).
**Wired (W2, report-only):** `/harness-loop --run --run-ponytail-budget --run-id <id> [--files N] [--lines L]`
→ `runPonytailBudget(runId, {files, lines})` grades the **provided** counts vs the soft gate (and a
documented hard ceiling = `2×` soft) and records ONE verdict:
`PASS` (within soft) · `WARN` (over soft gate) · `FAIL` (over hard ceiling) · `ERROR` (missing/malformed
counts) · `SKIPPED` (kill switch — no run, no write). Recorded reviewer = `ponytail_budget`.

## 4. Inputs
`state.budget.max_files_changed_without_expansion_gate` (default 5), `…max_lines_changed_without_expansion_gate` (default 250); `change.files`, `change.lines` (integers the caller supplies).

## 5. Outputs
Helper: an in-memory verdict object (writes nothing). **Wired wrapper:** records ONE verdict to
`reviewer-verdicts.ndjson` (reviewer `ponytail_budget`, `sends_back_to: null`) + a report-only
`ponytail_budget_check` event in `decision-log.ndjson`. The verdict `reasons` state the soft/hard
thresholds and that it is provided-counts-only with no diff inspection. **Report-only: no state advance,
no repair routing.**

## 6. State fields touched
Reads `budget`. Writes none.

## 7. Gates
`ASK_BEFORE_EXPANSION` when over budget, else `REPORT_ONLY`. **Advisory only** — the function just returns the label; nothing enforces it (no caller acts on it in `--run`).

## 8. Executor
`node:loop-conductor.js#ponytailBudgetCheck`.

## 9. Invocation contract (external)
N/A — pure local function, no external process.

## 10. Failure modes
- Caller passes `0`/missing/wrong counts → false `PASS` (the check trusts the caller's numbers; it does not measure the diff itself).
- The `reviewer: "ponytail_review"` label is **misleading** — it implies a real review happened. It did not.
- Not auto-called in `--run` today → effectively dormant.

## 11. Repair behavior
**W2 is report-only: a `WARN`/`FAIL` is recorded but routes nowhere** (`sends_back_to: null`, no
transition). The intended behavior (a `FAIL`/over-budget pausing for `ASK_BEFORE_EXPANSION` or routing to
`repair_loop`) is a LATER wiring slice — deliberately not wired here.

## 12. Acceptance tests
- **Exists:** conductor `--self-test` — over-budget → `BLOCK_EXPANSION` + `expansion_gate:true`; under-budget → `PASS`.
- **Needed:** a test that real diff counts are passed at the write stage (today they are not).

## 13. DISABLED behavior
The wired path **honors the kill switch**: under `DISABLED` it returns `SKIPPED` and **writes nothing**
(no verdict, no decision-log line). The bare helper remains a pure function with no kill-switch check.

## 14. Work-state
- **current:** `wired` (W2) — report-only CLI grades **provided** counts and records a verdict; covered by
  the conductor `--self-test` (PASS/WARN/FAIL/ERROR/SKIPPED + no-transition) and a live end-to-end run.
  **Unchanged by PR13/W13** — still `wired`, not re-promoted; see note below.
- **desired:** `auto_on_write` — invoked with **real** diff counts during/after the write stage.
- **Honest gap:** it grades only **caller-supplied counts** — it does **not** inspect a git diff itself,
  does **not** run during writing, and a `WARN`/`FAIL` routes nowhere. When the run state lacks budget
  fields it uses the helper defaults (soft `5`/`250`). The hard ceiling (`2×` soft) is a transparent
  heuristic, not a budget field. Real `/ponytail-review` is still never invoked (that is
  `ponytail_review_skill`).
- **PR13/W13 note:** `scripts/scope-fence.js` now computes real `files`/`lines` counts from **both**
  tracked changes (`git diff --numstat`) **and** untracked new files (`git status --porcelain`, disk
  line-read) — standalone, manually invoked. A human can now pipe scope-fence's real counts into
  `--run-ponytail-budget --files N --lines L` instead of guessing — **but nothing auto-feeds them**; no
  code path connects the two components automatically. This closes part of §15's smallest-next-slice
  (real counts are computable, including new files), not the auto-invocation half.

## 15. Smallest next slice
At the implementation/write stage, **automatically** pass scope-fence's real changed files/lines to
`runPonytailBudget` instead of requiring a human to type `--files`/`--lines`; and (separately) populate
the run state's budget from the workflow config so the gauge stops falling back to defaults. Named here;
**not implemented in PR13/W13** — remains a future auto-wiring slice, deliberately deferred (no conductor
autonomy in PR13).
