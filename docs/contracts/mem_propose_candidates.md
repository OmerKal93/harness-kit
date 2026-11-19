# Component Contract — `mem_propose_candidates`

> M4 contract. Grounded in committed `scripts/propose-fact-candidates.js` (self-test 8/8). **Brutally
> honest: `helper_only`, manual, REPORT-ONLY — it never appends to `facts.ndjson`** and the loop does not
> call it. It is the safe staging lane between "something happened" and a gated `mem_capture`.

## 1. component_id
`mem_propose_candidates`. The candidate lane; the only path to a real write is the separate, human-gated
`mem_capture`.

## 2. Purpose
Classify proposed fact candidates (validate + poisoning scan + source-hash compare) and recommend a next
action — **without writing anything** — so workflow/plugin/code/security observations stay candidates only.

## 3. Interface
`proposeCandidates(candidates, opts) → report` · `classifyCandidate(record, opts) → { candidate_id,
valid, status, errors[], warnings[], recommended_next_action, claim }`. Statuses: `READY_FOR_REVIEW`,
`NEEDS_FIELDS`, `INVALID`, `POISONING_REJECTED`, `SOURCE_HASH_MISMATCH`.

## 4. Inputs
Candidate records (or JSON blocks extracted from a run's notes); poisoning policy; source files (for hash
compare). Never reads source contents into the output.

## 5. Outputs
A classification **report** (JSON/markdown) + per-candidate `recommended_next_action`
(`review_then_capture` | `fix_fields` | `reject` | `update_source_hash_or_reject`). **Appends nothing.**

## 6. State fields touched
None durable. When wired to verification, would write `capture_candidates` into run state (report only).

## 7. Gates
Report-only — structurally cannot write. Policy: **no silent memory writes**; candidates require human
review before any `mem_capture`. Workflow/plugin/code/security changes are surfaced here as candidates,
not facts.

## 8. Executor
`node:scripts/propose-fact-candidates.js` (manual today).

## 9. Invocation contract (external components only)
N/A — local module/CLI.

## 10. Failure modes
Missing fields → `NEEDS_FIELDS`/`INVALID`. Poisoning pattern → `POISONING_REJECTED`. Hash mismatch →
`SOURCE_HASH_MISMATCH`. Scanner unavailable → flagged in warnings (candidate not silently trusted).

## 11. Repair behavior
None to repair (no writes). A non-ready candidate carries an explicit `recommended_next_action` for the human.

## 12. Acceptance tests
- **Exists:** `--self-test` 8/8 (ready/needs-fields/invalid/poisoning/hash-mismatch classifications; never appends).
- **Needed:** a call site at the verification stage that records the report into run state (report-only).

## 13. DISABLED behavior
Ungated/read-only library; never writes regardless of kill switch.

## 14. Work-state
- **current:** `contract_drafted` (code = `helper_only`, manual, report-only).
- **desired:** `auto_after_verify` (auto-run at verification, still report-only into state).
- **Honest gap:** classification works; nothing calls it in the loop, so no candidates are surfaced
  automatically yet.

## 15. Smallest next slice
Call `proposeCandidates` at the verification stage and record the report into run state (report-only, no
append). Named here; **not implemented in M4.**
