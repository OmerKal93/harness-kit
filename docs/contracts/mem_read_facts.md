# Component Contract — `mem_read_facts`

> M4 contract. Grounded in committed `scripts/read-facts.js` (self-test 10/10). **Brutally honest:
> `helper_only` — a manual CLI; NOT called by the loop.** The loop uses `mem_search` instead. This is the
> read path that also **verifies provenance** (source-hash) at read time.

## 1. component_id
`mem_read_facts`.

## 2. Purpose
Read structured facts from `facts.ndjson`, filter to active state, and **verify each fact's
`source_sha256`** against its source file — surfacing facts whose source changed since capture.

## 3. Interface
`readFacts(opts) → facts[]` · `verifySources(facts) → { warnings[] }`. CLI: `node scripts/read-facts.js`
(emits one JSON fact per line: `{id,state,trust_tier,mentions,claim}`).

## 4. Inputs
`facts.ndjson` (read-only); optional filters (tags/mention/tier/state). Source files referenced by
`source_path` (for hash verification).

## 5. Outputs
Active fact list (JSON lines) + provenance `warnings[]` (e.g. `source_sha256 mismatch`). **Reads only —
never writes facts.**

## 6. State fields touched
None in `workflow-state.json` (the loop doesn't call it). Reads `facts.ndjson`. (When wired, would feed
`memory_behavior`.)

## 7. Gates
None — read-only library. **Historical memory is opt-in, not default**: nothing reads facts unless a
caller asks; the loop currently asks only via `mem_search`.

## 8. Executor
`node:scripts/read-facts.js`.

## 9. Invocation contract (external components only)
N/A — local module / CLI.

## 10. Failure modes
Missing `facts.ndjson` → `[]`. Source file unreadable/changed → `source_sha256` mismatch warning (fact is
surfaced, not silently trusted). Malformed line → skipped.

## 11. Repair behavior
None — read path. A mismatch is reported (not auto-corrected); remediation is a human/curation decision.

## 12. Acceptance tests
- **Exists:** `--self-test` 10/10 (active-state filter; hash match vs mismatch vs unreadable; superseded/retracted excluded).
- **Needed:** none for current scope (it is done as a helper).

## 13. DISABLED behavior
Ungated library — runs regardless (read-only, no side effects). The kill switch matters only for writers.

## 14. Work-state
- **current:** `contract_drafted` (code = `helper_only`, manual CLI).
- **desired:** `adapter` (callable by the conductor if needed).
- **Honest gap:** works, but the loop doesn't use it — `mem_search` covers retrieval. Distinct roles:
  this **verifies** provenance; `mem_search` does **not** (search ≠ verification).

## 15. Smallest next slice
None planned — keep as the verification-capable read helper. If the loop ever needs hash-verified reads
(not just search), expose `readFacts` to the conductor. Named here; **not implemented in M4.**
