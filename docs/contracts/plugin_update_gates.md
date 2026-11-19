# Component Contract — `plugin_update_gates`

> M7 contract. **Brutally honest: `planned`/missing — there is NO install/enable/update path, by design.**
> This component is the *gate* that any future plugin/skill/tool update must pass; today it exists only as
> policy. Risky auto-install is **forbidden**.

## 1. component_id
`plugin_update_gates`. The human gate for plugin/skill/tool changes; consumes `plugin_drift_check` output.

## 2. Purpose
Gate the enable/install/update of any plugin/skill/tool so nothing risky lands automatically — convert a
drift finding into a **gated proposal**, never an action.

## 3. Interface
**Desired (not built):** `proposeUpdate(driftItem) → gatedProposal` (report only). **Today:** none — no
install/enable/disable code exists.

## 4. Inputs
A drift item / candidate update (from `plugin_drift_check`); its source, diff, and risk class.

## 5. Outputs
A **gated proposal** for human approval (source + diff + forensics + review + rollback). **Never an
install/enable.**

## 6. State fields touched
None today. (Desired: a proposal record, report-only.)

## 7. Gates
**Plugin updates require gates** — every update requires source validation · diff review ·
**repo-forensics for repo/skill/plugin/MCP/tool intake** · security/supply-chain review ·
external/data/privacy gates when relevant · rollback plan. **No bulk-import of skill packs.** Skills are **small, explicit, composable,
trigger-driven**. **Security skill packs are review inputs, not trusted authorities.** Risky auto-install
is FORBIDDEN.

## 8. Executor
`host + repo-forensics` (human-driven, gated). No automatic installer.

## 9. Invocation contract (external components only)
No spawned installer. Any intake goes through `new_repo_intake` (quarantine clone + forensics) under
`review_security` — host/manual, gated.

## 10. Failure modes
- **Forbidden:** an auto-install/enable path (must never exist).
- Bulk-importing a skill pack instead of small composable skills.
- Trusting a security pack as authority rather than as an input.
- Updating without a rollback plan.

## 11. Repair behavior
A failed gate → reject the update (no install). A bad update that slipped through → rollback via the
required rollback plan. Never auto-retry an install.

## 12. Acceptance tests
- **Exists:** none (planned).
- **Needed:** a report-only proposal generator + a test that **no** code path can install/enable without
  the full gate set + explicit approval.

## 13. DISABLED behavior
N/A — no executor. Policy holds regardless: no auto-install ever.

## 14. Work-state
- **current:** `contract_drafted` (was `planned`/missing).
- **desired:** `human_gated`.
- **Honest gap:** the gate is a documented process, not code — and deliberately so; the only "next step"
  is a report-only proposal, never an installer.

## Context-compaction policy (CTX-0) — Token Optimizer is gated like any plugin
Token Optimizer / statusline is a plugin/tool surface. Reading its statusline as a **context signal** is
allowed only because the owner already installed/trusts it — **reading its output is not adoption**. **Any
install/update/enable/disable or capability expansion still requires the full plugin gates** (source
validation · diff review · **repo-forensics for repo/skill/plugin/MCP/tool intake** · security/supply-chain
· external/data/privacy · rollback). **No bulk-import** or auto-enable of it or its skills; **no automatic
capability expansion**.

## 15. Smallest next slice
A report-only "update proposal" that bundles source + diff + required-forensics + rollback for human
review — **no install/enable code**. Named here; **not implemented in M7.**
