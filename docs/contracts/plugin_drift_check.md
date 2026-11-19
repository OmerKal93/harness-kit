# Component Contract — `plugin_drift_check`

> M7 contract. Grounded in committed `scripts/loop-conductor.js#checkPlugins` (writes
> `runs/.plugin-check.json`). **Honest status: `auto` on `--check-plugins`, strictly REPORT-ONLY.** It
> detects drift; it changes nothing.

## 1. component_id
`plugin_drift_check`. The read-only drift detector over `cap_registry`.

## 2. Purpose
Compare installed/known plugins/skills/tool definitions against the expected registry/contracts and report
drift + a ~2-day "due" signal — **without changing anything**.

## 3. Interface
`checkPlugins(opts) → { drift[], review_needed, due }`. CLI: `harness-loop --check-plugins`. Writes a report
to `runs/.plugin-check.json`.

## 4. Inputs
`config/capability-registry.json` (expected) + installed plugin/skill/tool state; last-check timestamp.

## 5. Outputs
A drift report (`runs/.plugin-check.json`) + `review_needed` flag + `due` summary. **No mutation of
plugins or the registry.**

## 6. State fields touched
None in run state — writes its own report sidecar only.

## 7. Gates
**Plugin drift is report-only** (no approval can be implied from a report). It **must not auto-update,
auto-enable, auto-disable, install, delete, or rewrite plugins.** Any drift affecting **security,
permissions, external tools, MCP, browser, network, auth, cookies, secrets, audio, or private data must
route to security review** (`review_security`).

## 8. Executor
`node:scripts/loop-conductor.js#checkPlugins`.

## 9. Invocation contract (external components only)
N/A — local read + report. (It does not run plugins; it inspects definitions.)

## 10. Failure modes
Registry missing → empty report (safe). False "no drift" if the installed state isn't fully observed.
Drift on a security-relevant surface that is *not* escalated to `review_security` (the rule above prevents this).

## 11. Repair behavior
None of its own — it reports. Acting on drift is a separate, gated step (`plugin_update_gates`), never
automatic.

## 12. Acceptance tests
- **Exists:** conductor `--self-test` (report-only; due logic).
- **Needed:** a test that a security-relevant drift sets `review_needed` → routes to `review_security`.

## 13. DISABLED behavior
Read-only — safe to run; produces only a report. No mutation regardless of the kill switch.

## 14. Work-state
- **current:** `contract_drafted` (code = `auto`/report-only).
- **desired:** `auto_plus_due` (surface a one-line due summary inside `--run`).
- **Honest gap:** detection works; nothing routes security-relevant drift to review automatically yet.

## 15. Smallest next slice
Surface a one-line "plugins due / drift" summary inside `--run` (still report-only) and flag
security-relevant drift for `review_security`. Named here; **not implemented in M7.**
