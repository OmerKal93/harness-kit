---
description: List active and recent HarnessKit runs via the CLI (real run index, not a prompt-only guess).
argument-hint: "[--all]"
allowed-tools: Bash
---

# /status

Wraps the real `status` verb of `bin/harnesskit.js` (see `cmdStatus` in that file). It calls
`listRuns()` from `scripts/_lib.js` against `HARNESS_ROOT/runs/.index.ndjson` and prints
`{ ok, count, runs: [{run_id, state, task_type, confidence, ts}, ...] }`.

## Invocation

```bash
HARNESS_ROOT="${CLAUDE_PLUGIN_ROOT}" node "${CLAUDE_PLUGIN_ROOT}/bin/harnesskit.js" status $ARGUMENTS
```

Run that exact command via Bash (`$ARGUMENTS` is empty for the default 25-row cap, or `--all` for
no limit) and print its stdout JSON verbatim.

## Notes

- `HARNESS_ROOT` must be `${CLAUDE_PLUGIN_ROOT}` -- `listRuns()` resolves the same way
  `/capabilities` and `/doctor` do; without it this would read `~/.harnesskit/runs/.index.ndjson`
  instead of this plugin's own run index.
- Verified against this repo: no runs exist yet, so the real, honest output today is
  `{"ok": true, "count": 0, "runs": []}`. This is expected for a freshly built repo, not an error.
