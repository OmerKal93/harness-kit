# Component Contract — `mem_search`

> M4 contract. Grounded in committed `scripts/search-memory.js` (self-test 13/13). **Honest status: the
> ONE memory component that is actually `auto` in `--run`** — `startRun` calls `searchStructuredFacts`
> before planning. Read/search only; **does not verify source hashes** (that is `mem_read_facts`).

## 1. component_id
`mem_search`.

## 2. Purpose
Retrieve active facts relevant to the run goal (before planning) by matching goal terms against fact
`mentions`/`claim`, returning provenance-tagged hits for the context pack.

## 3. Interface
`searchStructuredFacts(args, terms, limit) → hits[]` · `factMatches(fact, lcTerms)` ·
`structuredEnabled(args)`. Each hit retains `{claim, source_path, source_sha256, trust_tier, confidence,
state}`.

## 4. Inputs
Goal terms; `facts.ndjson` (read); `limit`; the **opt-in flag** (`structuredEnabled`) — structured search
is off unless enabled (historical memory opt-in, not default).

## 5. Outputs
Ranked active-fact hits → `memory_behavior` in state; counters `facts_read_count`, `active_facts_used`.
**Reads only.**

## 6. State fields touched
Writes `memory_behavior`, `facts_read_count`, `active_facts_used` (when called in `--run`). Reads `facts.ndjson`.

## 7. Gates
Library is ungated; the **`--run` call is gated** (honors `DISABLED`). Opt-in: no structured search unless
`structuredEnabled`. Provenance is retained but **not verified** here (search, not verification).

## 8. Executor
`node:scripts/search-memory.js#searchStructuredFacts` (called from `loop_conductor#startRun`).

## 9. Invocation contract (external components only)
N/A — local module.

## 10. Failure modes
Empty store → 0 hits (safe). Could surface a fact whose source later changed (no hash check here) — by
design; verification is `mem_read_facts`' job. Over-broad term match → noise (bounded by `limit`).

## 11. Repair behavior
None — read path. Bad/irrelevant hits are a relevance-tuning issue, not a write to repair.

## 12. Acceptance tests
- **Exists:** `--self-test` 13/13 (match/no-match, active-only, provenance retained, opt-in gating).
- **Needed:** "during/after" retrieval hooks (today: before-plan only).

## 13. DISABLED behavior
`--run` retrieval is skipped under `DISABLED` (the caller gates it); the library itself is ungated/read-only.

## 14. Work-state
- **current:** `contract_drafted` (code = `auto` in `--run`, before-plan only).
- **desired:** `auto` (+ during/after hooks).
- **Honest gap:** retrieval happens only once (pre-plan). No mid-run or post-run retrieval; no hash
  verification (intentional split from `mem_read_facts`).

## 15. Smallest next slice
Add a during/after retrieval hook so facts can inform implementation/verification, not just planning.
Named here; **not implemented in M4.**
