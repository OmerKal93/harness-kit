# Component Contract — `verdict_log`

> M3 contract; **W9: WIRED.** Grounded in `scripts/workflow-state.js#appendVerdict` +
> `#validateVerdict` + `#stampProvenance`. W9 adds write-time schema validation and caller-proof
> provenance so the audit trail can no longer be spoofed by typed JSON. **Brutally honest:** the
> `live_codex` stamp is verified STATICALLY (preflight `provenance:stamping-sites`), not runtime-tested
> against real Codex — runtime-testing it would spawn a live external call.

## 1. component_id
`verdict_log`.

## 2. Purpose
Record every reviewer verdict as an append-only line in `reviewer-verdicts.ndjson` and mirror it into
the state document's `reviewer_verdicts[]` — with a schema-validated shape and a truthful
`provenance` field naming the write path that produced the record.

## 3. Interface
- `appendVerdict(runId, verdict, opts) → { ok:true, verdict_record } | { ok:false, error:'invalid_verdict', violations[] }`
  (`verdict` key kept as an alias of `verdict_record` for pre-W9 callers).
- `validateVerdict(verdict) → violations[]` (pure; empty = valid).
- `stampProvenance(verdict, provenance) → copy` (pure; overwrites any caller-supplied provenance on a
  COPY, never mutates the input — the spoof fix's core primitive).

### Schema (enforced on NEW writes only)
**Mandatory:** `reviewer` ∈ `codex_cli|qa_self_tests|ponytail_budget|qa_evals|ponytail_review`;
`verdict` ∈ `PASS|REJECT|FAIL|WARN|ERROR|SKIPPED`; `provenance` ∈ write-time enum below;
`target` non-empty string (not enum-constrained in W9).
**Auto-filled if absent (never rejection grounds):** `verdict_id` (`<reviewer>-<iso>`), `created_at`.
**Optional, validated when present:** `severity` ∈ `info|low|medium|high|critical`; `reasons` string[];
`sends_back_to` ∈ `ce_plan|ce_work|repair_loop` or null.
**Passthrough:** `reviewer_kind`, `required_repairs`, `metadata`.

### Provenance enum
Write-time: `live_codex | cli_human | deterministic_internal | fixture`.
Read-side ONLY: `unknown_legacy` — the in-memory interpretation of a pre-W9 record with no
provenance; **rejected on any new write.**

Provenance = HOW the record reached the log (write path). Orthogonal to `reviewer_kind` (the
reviewer's nature); the two may share vocabulary where they coincide.

### Stamping map (who writes what)
| Write path | Provenance |
|---|---|
| `runCodexReview` success (past BOTH gates — sole legal source) | `live_codex` (hardcoded) |
| `--continue --record-verdict` (typed JSON) | `cli_human` — **unconditionally overwritten by the CLI via `stampProvenance`; a typed claim of `live_codex` is stored as `cli_human`** |
| `runQaSelfTests` / `runPonytailBudget` | `deterministic_internal` (hardcoded) |
| self-test / fixture writes | `fixture` (explicit in test code) |
| future `qa_evals` (NOT wired in W9) | `deterministic_internal` (documented intent) |
| `routeVerdict`-only calls | no append → no stamp; missing provenance on old records read as `unknown_legacy` in memory only |

## 4. Inputs
`runId`; a verdict object from any stamping path above.

## 5. Outputs
On valid input: one appended ndjson line + a mirrored entry in `workflow-state.json#reviewer_verdicts[]`
+ the normalized `verdict_record` returned. On invalid input: `{ ok:false, error:'invalid_verdict',
violations[] }` and **nothing else** — no ndjson line, no mirror update, no ERROR-verdict write, no
throw, no route, no transition.

## 6. State fields touched
`reviewer_verdicts[]` (append, ndjson sidecar + state mirror) — only on valid input.

## 7. Gates
None of its own (append-only writer; callers decide *whether* to record). W9 adds the schema gate on
*what* may be recorded. Routing is NOT provenance-gated in W9 (observability only): a `cli_human` PASS
still advances; enforcement is a deliberate later policy decision once real `live_codex` data exists.

## 8. Executor
`node:scripts/workflow-state.js#appendVerdict` (+ `validateVerdict`, `stampProvenance`).

## 9. Invocation contract (external components only)
N/A — local module.

## 10. Failure modes
- **State-mirror bloat:** unchanged from M3 — every valid verdict duplicates into `workflow-state.json`;
  no cap/summarize policy yet (open design question).
- Malformed verdict → refused with violations (was: caller's responsibility, silently accepted).
- A caller bypassing `stampProvenance` and hardcoding a false provenance in its own source would lie —
  mitigated by the preflight static check over the known stamping sites, not by runtime enforcement.

## 11. Repair behavior
None needed (append is idempotent per distinct `verdict_id`). No retry. W9 observability: when a
REJECT/FAIL routes into `repair_loop` via the guarded admission, the `repair_loop_entered`
decision-log event now carries the verdict's `provenance` (or `unknown_legacy` for legacy records).

## 12. Acceptance tests
- **Exists (W9, `workflow-state --self-test`):** 7 malformed-rejection cases (unknown reviewer, bad
  verdict enum, missing provenance, `unknown_legacy` on write, bad severity, bad `sends_back_to`,
  empty target) each refused with zero ndjson lines and zero mirror entries (count-asserted);
  `verdict_id`/`created_at` auto-fill; `stampProvenance` overwrites a spoofed claim on a copy without
  mutating the original.
- **Exists (W9, conductor `--self-test`):** spoof round-trip (typed `live_codex` claim stored as
  `cli_human`); malformed verdict via `recordVerdict` refused with no route/transition; legacy record
  (no provenance) still routes, logged as `unknown_legacy`, disk never rewritten; qa/ponytail records
  stamped `deterministic_internal`; all W8 no-double-append regressions intact.
- **Exists (W9, preflight):** `provenance:stamping-sites` static check — the honest substitute for the
  untestable live path.
- **Needed:** cap/summarize policy test for the state mirror (unchanged from M3, still deferred).

## 13. DISABLED behavior
N/A — local append; runs when called; callers gate (unchanged).

## 14. Work-state
- **current:** `wired` (W9; was `contract_drafted`).
- **desired:** `auto` (no change).
- **Honest gap:** (a) the `live_codex` stamp has never been runtime-exercised — static verification
  only, by design; (b) routing is not provenance-enforced (level A observability — a `cli_human`
  verdict claiming reviewer `codex_cli` is now VISIBLE as such, but still routes); (c) the state-mirror
  bloat question remains open; (d) validation binds `appendVerdict` callers — a direct-fs writer would
  bypass it (advisory perimeter, same as the rest of the library layer).

## 15. Smallest next slice
Provenance-based routing enforcement (level B): auto-advance on `codex_cli` PASS requires
`provenance:'live_codex'`; `cli_human` requires an explicit attestation flag. Decide AFTER real
`live_codex` records exist. Alternative slice: cap/summarize the state mirror. Named here; **not
implemented in W9.**
