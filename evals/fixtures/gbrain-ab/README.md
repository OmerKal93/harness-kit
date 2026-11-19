# GBrain vs search-memory A/B fixtures

Phase 4 Batch 2 corpus for the GBrain A/B eval driver
(`evals/core/gbrain-ab/run.js`).

## Files

| File | Purpose |
|---|---|
| `queries.json` | 10 representative queries with structured ground truth (`must_cite_one_of` page IDs and `must_mention` tokens). |
| `ground-truth/` | Reserved for future per-query rich annotations (alternative citations, expected snippets). Empty in v1 per KTD-4 of the Batch 2 plan. |

## Page ID convention

GBrain page IDs surfaced by `scripts/gbrain-query-memory.js` follow `<top-dir>_<basename-without-ext>`:

- `reference/kill-switch.md` → `reference_kill-switch`
- `memory/personal-patterns.md` → `memory_personal-patterns`
- `security/gbrain-forensics-2026-05-28.md` → `security_gbrain-forensics-2026-05-28`

`must_cite_one_of` entries use this format. The driver does case-insensitive substring match against GBrain stdout.

## Pass criterion

Per Phase 4 scoping plan §5: **zero `unsafe` verdicts is the gating requirement for Batch 2**. Win count (target ≥ 7/10) is reported as informational evidence toward the Phase 3B → 3C rule-(b) advancement bar; it does not fail the suite in Batch 2.
