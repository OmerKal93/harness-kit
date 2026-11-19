# Claim-Support Fixtures

Phase 4 Batch 2 seed corpus for the claim-support eval driver
(`evals/core/claim-support/run.js`) which exercises
`scripts/claim-support-check.js`.

## Layout

| Folder | Purpose |
|---|---|
| `anchored/` | `verification.md` with every claim anchorable (real paths and/or tool-log evidence). |
| `unanchored/` | Every claim contains a fabricated path / function name → flagged. |
| `mixed/` | Some claims anchor, others do not. |
| `_tool-logs/synthetic.ndjson` | Shared synthetic tool-log used when a fixture's `.expected.json` sets `with_tool_log: true`. |

## Fixture pairs

Each fixture is a pair: `<n>.md` (the verification doc) + `<n>.expected.json`:

```jsonc
{
  "category": "claim-support",
  "label": "anchored | unanchored | mixed",
  "with_tool_log": true,
  "expected": {
    "claim_lines": 2,
    "anchored": 2,
    "unanchored": 0,
    "flagged_count": 0
  }
}
```

When `with_tool_log` is `true`, the driver passes `--tool-log _tool-logs/synthetic.ndjson`
to `claim-support-check.js`.

## Repo root used by the driver

Driver invokes `claim-support-check.js --repo-root ` so path tokens like
`scripts/redact.js` resolve via the harnesskit tree. (The script's harnesskit-root fallback would
also catch these, but explicit `--repo-root` makes the test path stable on any cwd.)
