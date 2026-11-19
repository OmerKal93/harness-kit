---
description: Locate/clone a target repo and drive it through inspect -> discover -> compose -> execute (automated prefix), via the real CLI.
argument-hint: --repo <url-or-path> [--workspace <path>] --instruction "<text>"
allowed-tools: Bash
---

# /run

Wraps the real `run` verb of `bin/harnesskit.js` (see `cmdRun` in that file). It resolves `--repo`
to a local path (cloning it into the workspace first if it's a URL or `owner/repo` spec, including
real recovery from Windows-hostile fixture paths during clone -- see `recoverHostileFixtureClone`),
runs `inspectRepo()`, composes a workflow DAG (`composeWorkflow`), and executes its automated prefix
(`executeWorkflow`). It **never claims end-to-end completion from one call** -- orchestrator stages
(plan/execute/independent-review) genuinely require the calling agent, so it reports exactly where
execution paused and why (`paused_at`), plus per-stage status.

## Invocation

```bash
HARNESS_ROOT="${CLAUDE_PLUGIN_ROOT}" node "${CLAUDE_PLUGIN_ROOT}/bin/harnesskit.js" run $ARGUMENTS
```

Run that exact command via Bash with `$ARGUMENTS` set to exactly what the user typed after `/run`
(e.g. `--repo owner/repo --instruction "fix the flaky test"`) and print its stdout JSON verbatim,
including the `stages` array, `paused_at`, and `workflow_dag_path`.

## Notes

- `--repo` and `--instruction` are both required; the real CLI returns
  `{"ok": false, "error": "--repo <url-or-path> required"}` or `{"ok": false, "error": "--instruction \"<text>\" required"}`
  if either is missing -- relay verbatim.
- `--workspace <path>` overrides where a remote `--repo` gets cloned; default precedence is
  `--workspace` flag > `HARNESSKIT_WORKSPACE` env var > `os.tmpdir()/harnesskit-workspace` (never a
  hardcoded machine path).
- If `<target>/.harnesskit/workflow-dag.json` already exists with any non-pending stage, the CLI
  refuses to start over and instead returns
  `{"ok": false, "error": "an in-progress workflow already exists at ... -- use 'harnesskit resume --target <path>' ..."}`
  -- point the user at `/resume` rather than retrying `/run`.
- After a paused run, continue it with `/resume --target <target_path> ...` (see `/resume`), not by
  re-running `/run`.
