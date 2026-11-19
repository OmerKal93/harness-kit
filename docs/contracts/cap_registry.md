# Component Contract — `cap_registry`

> M7 contract. Grounded in `config/capability-registry.json` (advisory). **Brutally honest: it is a
> `reference` file — advisory, nothing consumes it as enforcement today.** It is also a **held, modified
> file** in this working tree; this contract describes it but **does not edit or stage it**.

## 1. component_id
`cap_registry`. The capability inventory / trust surface.

## 2. Purpose
Inventory tool/plugin/skill **capabilities, permission surfaces, and allowed execution classes** — the
intended source-of-truth for what the harness is permitted to do.

## 3. Interface
`config/capability-registry.json` (JSON data). Read by humans/tooling; **desired** consumers:
`plugin_drift_check` (compare installed vs registry) + gates. No code currently enforces it.

## 4. Inputs
Capability rows (tool/plugin/skill → permissions, execution class, gates). Maintained by humans, gated.

## 5. Outputs
The capability inventory other components *should* check. Today: advisory data only.

## 6. State fields touched
None in run state — it is config, not run state. (Drift checks read it; nothing writes run state from it.)

## 7. Gates
**The capability registry is a trust/control surface** — any change to it is **security-sensitive**.
**No automatic capability expansion.** New capabilities require: **source/provenance · intended use · risk
class · gates · reviewer requirements · rollback path**, and **repo-forensics for plugin/skill/MCP/tool
intake**. Read-only at runtime.

## 8. Executor
`config:capability-registry.json` (data; no executor). Edits are human + gated.

## 9. Invocation contract (external components only)
N/A — data file.

## 10. Failure modes
Stale versions vs reality (the gap a drift check closes). **Silent capability expansion** (forbidden).
Treating advisory data as if enforced. Accidental edit/stage of the **held** working-tree modification.

## 11. Repair behavior
Drift → flagged by `plugin_drift_check` (report-only) → human-gated reconciliation, never auto-edit. A
bad capability change → revert via the rollback path recorded at add-time.

## 12. Acceptance tests
- **Exists:** none (advisory data).
- **Needed:** a schema/validation check + a drift comparison (registry vs installed) — both report-only.

## 13. DISABLED behavior
Read-only data — unaffected by the kill switch; nothing executes from it.

## 14. Work-state
- **current:** `contract_drafted` (file = advisory `reference`; **held/modified, do-not-edit**).
- **desired:** `source_of_truth` (gates actually consult it).
- **Honest gap:** nothing enforces the registry; it is documentation of intent. The current working-tree
  modification is **out-of-scope for this pack and must not be touched or staged** (`do not stage held
  config/capability-registry.json`).

## Context-compaction policy (CTX-0) — Token Optimizer as a capability surface
The **Token Optimizer / statusline** is treated as a **capability/plugin/tool surface**, not
generally-trusted infrastructure.
- It may be used as a **context signal only after it is already installed/trusted by the owner** (it is, on
  the owner's machine) — its statusline feeds the compaction bands (`token_optimizer_statusline` source).
- Any install/update/enable/disable or capability change still routes through the plugin gates (see
  `plugin_update_gates`) — **no automatic capability expansion**.
- **This patch does NOT mark Token Optimizer as generally trusted or adopted by HarnessKit** — it is a
  context signal the owner already runs, nothing more. Not cloned/installed/run/updated here.

## 15. Smallest next slice
Add a read-only schema/validation check for `capability-registry.json` (no edits, no enforcement) so drift
tooling has a stable shape to compare against. Named here; **not implemented in M7** — and the held file
stays untouched.
