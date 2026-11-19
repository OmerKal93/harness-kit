---
description: Run HarnessKit's real preflight + local-CI health checks via the CLI (may take up to ~3 minutes).
argument-hint: (no arguments)
allowed-tools: Bash
---

# /doctor

Wraps the real `doctor` verb of `bin/harnesskit.js` (see `cmdDoctor` in that file). It runs two real
child processes under `HARNESS_ROOT`: `scripts/preflight.js` and `scripts/local-ci.js --json`, then
reports `{ ok, preflight_ok, local_ci_ok, preflight, local_ci }` -- the merged, real result of both.
Note: this is a distinct code path from `npm run doctor` (which points at `scripts/doctor.js`, a
separate script that may not exist in every checkout); the CLI's `doctor` verb does not depend on
that file.

## Invocation

```bash
HARNESS_ROOT="${CLAUDE_PLUGIN_ROOT}" node "${CLAUDE_PLUGIN_ROOT}/bin/harnesskit.js" doctor
```

Run that exact command via Bash (allow up to ~180s -- `local-ci.js` runs with a 180000ms internal
timeout) and print its stdout JSON verbatim, including nested `preflight` and `local_ci` detail
objects. Do not summarize away a `false` result as success.

## Notes

- `HARNESS_ROOT` must be set to `${CLAUDE_PLUGIN_ROOT}` for the same reason as `/capabilities` --
  without it, the CLI looks for `scripts/preflight.js` / `scripts/local-ci.js` under
  `~/.harnesskit`, not this plugin's own root, and fails with `MODULE_NOT_FOUND` (reproduced during
  this plugin's build).
- A `false` overall `ok` is a legitimate, real result, not a bug in this command. Verified during
  this plugin's build: `preflight_ok` currently comes back `true` in this repo, but `local_ci_ok`
  currently comes back `false` -- `scripts/local-ci.js` itself throws an uncaught exception partway
  through its run here (a pre-existing condition in this checkout, not something this plugin
  introduces or should paper over), so `cmdDoctor`'s catch branch reports
  `{"summary": {"ok": false}, "error": "Command failed: ..."}` instead of a clean per-check
  breakdown. Report exactly that, including the truncated error string -- do not invent a
  per-check breakdown that the process didn't actually produce.
