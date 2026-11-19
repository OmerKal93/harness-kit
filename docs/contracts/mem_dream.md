# Component Contract — `mem_dream`

> M4 contract. Grounded in committed `scripts/loop-conductor.js#dreamFromRecentRuns`. **Honest status:
> `auto` on `--dream`, but strictly REPORT-ONLY** — `note: 'recent-run consolidation; never auto-applied'`.
> This is the dreaming/consolidation + (future) learning channel. **There is no separate `learning`
> component ID** (see mapping).

## 1. component_id
`mem_dream`. Also the nearest existing home for "learning" (no `learning` ID exists): consolidation here
+ candidates via `mem_propose_candidates` are the learning channels.

## 2. Purpose
Offline consolidation of **recent runs only**: tally outcomes by status and collect improvement candidates
(repair/escalated/killed/stopped runs + REJECT reasons) — surfaced for human review, never auto-applied.

## 3. Interface
`dreamFromRecentRuns(opts) → { ok, report_only:true, runs_scanned, by_status, improvement_candidates[],
note }`. CLI: `harness-loop --dream`.

## 4. Inputs
`runs/.index.ndjson` (recent run index, last `opts.limit||15`); each run's `workflow-state.json`
(`status`, `reviewer_verdicts`). Recent runs only — not full history.

## 5. Outputs
A **report**: `by_status` counts + `improvement_candidates` (`{run_id, status, reject_reasons[]}`).
**Writes nothing durable; auto-applies nothing.**

## 6. State fields touched
None — reads recent run states; produces an in-memory/report object.

## 7. Gates
Report-only. Policy encoded: dreaming = **offline recent-run consolidation**; scans **recent runs only**;
**may auto-record verified repeated patterns** (future, into the candidate lane / decision-log signals
only); **may NOT auto-edit** workflows, plugins, commands, code, or a downstream project. Learning/dreaming output feeds
**candidates + decision-log signals**, never uncontrolled self-modification.

## 8. Executor
`node:scripts/loop-conductor.js#dreamFromRecentRuns`.

## 9. Invocation contract (external components only)
N/A — local module.

## 10. Failure modes
No runs / missing index → empty report (safe). A run with no state file → skipped. Risk to guard against
(future): mistaking a one-off for a "repeated pattern" → only verified, repeated signals may be recorded.

## 11. Repair behavior
None — read/report only. Any acted-upon insight goes through the normal candidate → human-gated
`mem_capture` path, never a direct edit.

## 12. Acceptance tests
- **Exists:** conductor `--self-test` (report-only; recent-window scan; never auto-applies).
- **Needed:** when "auto-record verified repeated patterns" is built — a test that a repeated, verified
  pattern becomes a **candidate** (not a fact) and a decision-log signal, and that no workflow/plugin/code
  file is touched.

## 13. DISABLED behavior
Read-only — safe to run; produces only a report. No writes regardless of kill switch.

## 14. Work-state
- **current:** `contract_drafted` (code = `auto` on `--dream`, report-only).
- **desired:** `auto` (optionally auto-run at end of `--run`, still report-only).
- **Honest gap:** consolidation works as a report; the "auto-record verified repeated patterns →
  candidates/decision-log" step is **not built**, and there is no first-class `learning` component yet.

## Mapping note (no new IDs invented)
"Learning" and "memory validation / poisoning scan" have **no standalone component IDs**. Learning ≈
`mem_dream` (consolidation) + `mem_propose_candidates` (candidates); validation/poisoning live inside
`mem_capture`/`mem_propose_candidates`. A first-class learning-promotion gate is a future slice (LEARN-0),
not invented here.

## 15. Smallest next slice
Add an opt-in: at the end of `--run`, run `dreamFromRecentRuns` and emit its report (still no auto-apply).
The "verified repeated pattern → candidate + decision-log signal" promotion is a later, separate slice.
Named here; **not implemented in M4.**
