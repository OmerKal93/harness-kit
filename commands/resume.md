---
description: Resume a HarnessKit run-id, or continue a paused per-target .harnesskit workflow, via the CLI.
argument-hint: "--run-id <id>  |  --target <path> [--resolve-stage <id> --resolve-status <status> --resolve-outputs '<json>'] [--commit-message \"<msg>\"] [--verification-override '<json>']"
allowed-tools: Bash
---

# /resume

Wraps the real `resume` verb of `bin/harnesskit.js` (see `cmdResume`/`cmdResumeTarget` in that
file). This one verb covers two distinct, real mechanisms:

1. **`--run-id <id>`** -- the harnesskit run-id state machine. Shells out to
   `scripts/resume-run.js --run-id <id>` and relays its JSON.
2. **`--target <path>`** -- continues a paused `.harnesskit/workflow-dag.json` under that path
   (written by a prior `/run`). Optionally apply an orchestrator resolution to one paused stage
   first via `--resolve-stage`, `--resolve-status`, `--resolve-outputs '<json>'` (e.g. resolving a
   `discover-task` tie with `--resolve-outputs '{"selected_task":"X","resolution_reason":"..."}'`),
   then re-invokes `executeWorkflow` and reports where it paused next.

## Invocation

```bash
HARNESS_ROOT="${CLAUDE_PLUGIN_ROOT}" node "${CLAUDE_PLUGIN_ROOT}/bin/harnesskit.js" resume $ARGUMENTS
```

Run that exact command via Bash with `$ARGUMENTS` set to exactly what the user typed after
`/resume` (one of the two flag shapes above) and print its stdout JSON verbatim, including the
`stages` array and `paused_at` / `note` fields.

## Notes

- `HARNESS_ROOT` is required for the `--run-id` path (it resolves `scripts/resume-run.js` under
  `HARNESS_ROOT`) exactly as in `/capabilities` and `/doctor`. The `--target` path additionally
  reads/writes files under `<target>/.harnesskit/` directly and does not depend on `HARNESS_ROOT`
  for that part.
- If neither `--run-id` nor `--target` is given, the real CLI returns
  `{"ok": false, "error": "--run-id (harnesskit run state) or --target (a paused .harnesskit workflow) required"}`
  -- relay that verbatim rather than guessing which mode the user meant.
- `--resolve-outputs` must be a single-quoted JSON string; if it fails to parse, the CLI returns a
  real `{"ok": false, "error": "--resolve-outputs is not valid JSON: ..."}` -- do not pre-validate
  the JSON yourself, let the process report it.
- The `--target` path also accepts `--commit-message "<msg>"` and `--verification-override '<json>'`
  (the latter must likewise be valid JSON, and is recorded verbatim in the resolved stage's
  `outputs` rather than applied silently -- it exists to let an explicit, named override through
  deterministic-verify's overridable statuses, e.g. `KNOWN_PREEXISTING_FAILURES`). This is
  under active concurrent development in this repo as of this writing (`scripts/execute-workflow.js`
  / `scripts/verification-classifier.js`) -- re-check `bin/harnesskit.js`'s own top-of-file usage
  comment if this stops matching real behavior.
