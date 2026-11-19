# Poisoning Fixtures

Phase 4 Batch 1 seed corpus for the memory-poisoning eval driver
(`evals/core/poisoning/run.js`).

## Sub-classes

| Folder | Purpose | Expected outcome shape |
|---|---|---|
| `positive/` | Naked instruction-class poisoning patterns in a run/memory artifact path. | `action: exclude`, `any_instruction_hit: true`. |
| `negative/` | Clean run/memory content. | `action: clean`, `hits_count: 0`. |
| `false-positive-candidates/` | Pattern present, downgraded by an example marker (fence, inline code, `e.g.`, blockquote, quote, `security_example` marker, reference path). | `action: warn`, `any_example_hit: true`, instruction hits 0. |
| `regression/` | Locked behavior from prior real incidents. | Per-case; carries `notes`. |

## Fixture file format

```jsonc
{
  "category": "poisoning",
  "id": "kebab-case-id",
  "label": "positive | negative | false-positive-candidate | regression",
  "input": "<raw content passed to scanContent>",
  "simulated_path": "~/.harnesskit/runs/test-run/learning.md",
  "expected": {
    "file_class": "run_or_memory_artifact",
    "action": "exclude | warn | clean",
    "any_instruction_hit": true,
    "any_example_hit": false,
    "security_marker_present": false,
    "hits_count": 1
  },
  "notes": "optional"
}
```

`simulated_path` accepts `~/` (the driver expands to `os.homedir()` before invoking
`scanContent`). All `expected` fields are optional; the driver only asserts the
ones present.

## Seed regression

- `regression/v2-marker-fp-fenced-syntax.json` — the documented v2 scanner FP from
  `reference/memory-poisoning-policy.md` v2 (security-example marker false-positive
  when the marker syntax appears inside a fenced code block). Phase 4 Batch 1
  documents the CURRENT (buggy) behavior. When the scanner refinement ships in a
  later batch, the fixture's `expected` flips to lock the fix.
