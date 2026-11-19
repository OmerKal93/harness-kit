# Redaction Fixtures

Phase 4 Batch 1 seed corpus for the redaction-effectiveness eval driver
(`evals/core/redaction/run.js`).

## Sub-classes

| Folder | Purpose | Expected outcome shape |
|---|---|---|
| `positive/` | Strings carrying a known secret pattern. | `redacted_contains` placeholder; `redacted_not_contains` original secret. |
| `negative/` | Clean prose/code. | `unchanged: true`. |
| `false-positive-candidates/` | Near-misses that naive regexes might catch. | `unchanged: true`. |
| `regression/` | Locked behavior from prior real incidents. | Per-case; carries `notes` citing the incident. |

## Fixture file format

Each fixture is a standalone `.json` file:

```jsonc
{
  "category": "redaction",
  "id": "kebab-case-id",
  "label": "positive | negative | false-positive-candidate | regression",
  "input": "<the raw string redactString is applied to>",
  "expected": {
    "unchanged": true,
    "redacted_contains": "[REDACTED:placeholder]",
    "redacted_not_contains": "original-secret-substring",
    "idempotent": true
  },
  "notes": "optional free-text"
}
```

All fields under `expected` are optional; the driver only asserts the ones present.

## Seed regression

- `regression/g2-redacted-url-creds-rematch.json` — the literal placeholder string
  from the 2026-05-28 G2 audit FP (see
  `runs/20260528-190211-phase-3b-hotfix-dry-run-v2/gbrain-secret-audit.md`).
  `redactString` is idempotent on this string. The companion fix for
  `gbrain-audit-secrets.js` (placeholder strip before scan) lands in this batch.
