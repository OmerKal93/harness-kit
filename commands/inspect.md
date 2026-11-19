---
description: Inspect a target repo's stack/git/CI profile and write real evidence files under its .harnesskit/ directory.
argument-hint: --target <path>
allowed-tools: Bash
---

# /inspect

Wraps the real `inspect` verb of `bin/harnesskit.js` (see `cmdInspect` in that file). It calls
`inspectRepo()` from `scripts/inspect-repo.js` against the given target, then writes four real JSON
files into `<target>/.harnesskit/`: `repo-profile.json`, `repo-facts.json`, `repo-risk-report.json`,
`repo-knowledge-index.json`. Nothing here is simulated -- these are the same files a terminal
invocation produces.

## Invocation

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/harnesskit.js" inspect $ARGUMENTS
```

Run that exact command via Bash (with `$ARGUMENTS` replaced by whatever the user typed after
`/inspect`, e.g. `--target C:/example/repo`) and print its stdout JSON verbatim. Do not paraphrase the
`profile` object -- relay exactly what the process wrote.

## Notes

- `--target <path>` is required; the CLI itself returns `{"ok": false, "error": "--target <path> required"}`
  if omitted -- do not pre-validate or fabricate a friendlier error, just run the command and show
  what it actually says.
- `--target` accepts a local path only (this verb does not clone; use `/run` for a remote
  `--repo` spec).
- Unlike `/capabilities`, `/doctor`, and `/status`, this verb does not depend on `HARNESS_ROOT` --
  it only touches the target path given.
