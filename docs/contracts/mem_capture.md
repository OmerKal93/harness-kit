# Component Contract — `mem_capture`

> M4 contract. Grounded in committed `scripts/capture-fact.js` + `structured-memory.js` +
> `memory-poisoning-scan.js` (self-test 11/11). **Brutally honest: `helper_only`, human-run ONLY — never
> auto.** This is the **only memory WRITE path**, and it is the home of validation + poisoning scan
> (no separate component ID for those — see mapping).

## 1. component_id
`mem_capture`. Absorbs "memory validation / poisoning scan" (no standalone ID): `structured-memory.js#
validateFactRecord` + `memory-poisoning-scan.js#scanContent` run *inside* capture.

## 2. Purpose
The gated, explicit append of one fact to `facts.ndjson` — after normalize → validate → poisoning scan →
source-hash provenance check — so memory grows only with provenanced, verified, reversible records.

## 3. Interface
`captureFact(record, opts) → { ok, id, rejected_reason?, warnings[] }`. Pipeline:
`normalizeFactRecord → validateFactRecord → scanClaim (poisoning) → sha256File provenance → appendFactRecord`
(skipped on `--dry-run`).

## 4. Inputs
A fact `record` (must carry `id, kind, claim, mentions, source_path, source_sha256, trust_tier,
captured_run_id, confidence, state`); `opts` (`--dry-run`, `--allow-source-mismatch`). The source file
(for hash check). Poisoning policy (`memory-poisoning-policy.md`).

## 5. Outputs
On accept: one appended line in `facts.ndjson` (raw evidence preserved via `source_path`/`source_sha256`).
On reject: `{ ok:false, rejected_reason }` — `poisoning_scan_exclude` | `source_sha256_mismatch`. **No
silent writes** — every outcome is explicit.

## 6. State fields touched
`facts.ndjson` (append, the durable store). When wired to a run, would set `captured_fact_ids`.

## 7. Gates
**Human-gated — never auto.** Policy encoded: auto-capture allowed ONLY for explicit owner decisions or
technically verified facts; workflow/plugin/code/security changes stay **candidates only** (→ `mem_propose_candidates`).
Every write requires **provenance** (`source_sha256`), **confidence** ([0,1]), **reversibility** (append-only
+ `state` supersede/retract, never destructive), and **poisoning/validation** pass. Missing scanner →
`poisoning_scan_exclude` (fail-closed).

## 8. Executor
`node:scripts/capture-fact.js` (human-initiated).

## 9. Invocation contract (external components only)
N/A — local module/CLI; no network, no LLM.

## 10. Failure modes
Poisoning hit → reject (`poisoning_scan_exclude`). Scanner unavailable → reject (fail-closed, not bypass).
Source hash mismatch → reject unless `--allow-source-mismatch` (logged). Invalid `confidence`/`source_sha256`
format → validation error, no write.

## 11. Repair behavior
Reversible by design: facts are append-only; correction = append a `superseded`/`retracted` record, never
edit/delete in place. A rejected capture writes nothing (re-submit after fixing fields).

## 12. Acceptance tests
- **Exists:** `--self-test` 11/11 (validate, poisoning reject, source-hash match/mismatch, dry-run no-write).
- **Needed:** none for current scope — keep manual.

## 13. DISABLED behavior
Ungated library, but **policy** keeps it human-only; it is never invoked by `--run`. Auto-capture is out of scope.

## 14. Work-state
- **current:** `contract_drafted` (code = `helper_only`, manual write).
- **desired:** `human_gated` (never auto).
- **Honest gap:** the write path is complete and safe; the deliberate non-goal is auto-capture — it stays
  human-initiated.

## 15. Smallest next slice
None — keep manual. (Any future auto-capture is limited to verified facts / explicit decisions and must
go through this same gated pipeline.) Named here; **not implemented in M4.**
