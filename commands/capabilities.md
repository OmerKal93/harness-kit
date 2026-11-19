---
description: Print HarnessKit's real capability inventory (config/capability-inventory.json) via the CLI.
argument-hint: (no arguments)
allowed-tools: Bash
---

# /capabilities

Wraps the real `capabilities` verb of `bin/harnesskit.js` (see `cmdCapabilities` in that file). It
reads `config/capability-inventory.json` from `HARNESS_ROOT` and prints it verbatim. It does not
invoke or simulate any capability -- it only reports the declared inventory.

(P2 capability-inventory supersession: this used to read `config/capability-matrix.json`, 18
HarnessKit-native rows only. It now reads `config/capability-inventory.json`, which supersedes both
`capability-matrix.json` and `config/capability-registry.json` -- 56 rows: the same 18
HarnessKit-native rows unchanged, 37 carried forward from the ecosystem registry with a
`classification` + `source_registry` added, plus 1 new Outsourcerer reference row. Both
predecessor files are deprecated in place but kept on disk.)

## Invocation

```bash
HARNESS_ROOT="${CLAUDE_PLUGIN_ROOT}" node "${CLAUDE_PLUGIN_ROOT}/bin/harnesskit.js" capabilities
```

Run that exact command via Bash and print its stdout JSON verbatim.

## Notes

- `HARNESS_ROOT` must point at this plugin's own repo root (`${CLAUDE_PLUGIN_ROOT}`) -- the CLI
  resolves this path itself only via `HARNESS_ROOT` (falling back to `~/.harnesskit` if unset), it
  is never derived from where `bin/harnesskit.js` physically lives. Omitting `HARNESS_ROOT` here
  would silently point the lookup at `~/.harnesskit` instead of this plugin's own config.
- Verified against this repo with `HARNESS_ROOT` set correctly: `config/capability-inventory.json`
  exists and the CLI prints the real inventory (56 capabilities as of this writing, each with
  `status`, `classification`, `source_registry`, `real_run_evidence`, and `known_limitations`
  fields -- e.g. `unified_cli` is marked `"status": "experimental"` and honestly notes "only 6 of
  the 12 originally-requested verbs are exposed"). Verified *without* `HARNESS_ROOT` set (i.e.
  omitting the env var above): the CLI looks under `~/.harnesskit` instead, finds nothing there,
  and returns
  `{"ok": false, "error": "config/capability-inventory.json not found -- run has not been built yet"}`
  -- a real failure mode caused by the missing env var, not a property of this repo. Relay whatever
  the process actually prints either way -- do not invent or omit fields.
