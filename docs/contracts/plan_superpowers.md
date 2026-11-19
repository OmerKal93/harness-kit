# Component Contract — `plan_superpowers`

> M5 contract. **Brutally honest: `directive-only` and unrouted** (`superpowers_enabled: false`). The
> Superpowers planning skill is not wired in; nothing invokes it. TDD-first planning discipline lane.

## 1. component_id
`plan_superpowers`. Optional discipline lane, alongside `plan_ce` (default) / `plan_grill_me` (risk).

## 2. Purpose
Apply TDD-first / writing-plans discipline to a plan (tests-before-code framing, tighter slices) for work
that benefits from it.

## 3. Interface
Host directive: `/superpowers:writing-plans` (when enabled). Output: a tightened plan. **Gated off** by
`superpowers_enabled: false` → currently absent.

## 4. Inputs
The draft `plan.md`; the `superpowers_enabled` flag.

## 5. Outputs
A discipline-tightened plan (host-applied). No state writes of its own.

## 6. State fields touched
None directly.

## 7. Gates
**`forensics_before_enable`** — Superpowers is an external plugin; enabling it requires a repo-forensics
scan first (per global rule). Policy: ambiguous/risky or TDD-suited work may route here; not for trivial docs.

## 8. Executor
`host:/superpowers:writing-plans` (unrouted while `superpowers_enabled: false`).

## 9. Invocation contract (external components only)
Host slash-command from an installed plugin → no spawned-process contract. Enable path is gated by forensics + explicit decision.

## 10. Failure modes
Not enabled → absent (current state). If enabled without forensics → policy violation. Over-applied on
docs/simple work → overhead.

## 11. Repair behavior
None of its own — output feeds `plan_ce`'s plan before `plan_review`.

## 12. Acceptance tests
- **Exists:** none (unrouted).
- **Needed:** a route-on decision (when to enable) gated behind a forensics check.

## 13. DISABLED behavior
N/A (host directive); additionally gated off by `superpowers_enabled: false` regardless.

## 14. Work-state
- **current:** `contract_drafted` (code = `directive-only` / unrouted).
- **desired:** `optional`.
- **Honest gap:** disabled and unrouted — no decision exists for when to turn it on; forensics-gated.

## External-pattern enforcement (contract/policy inputs only — NOT adopted code)
> Policy inputs from external repos; nothing cloned/installed/run.
- **small/composable skills (mattpocock/skills):** discipline = small, explicit, composable,
  trigger-driven skills; the plan names the **skills/plugins required for QA/review**, it does not
  bulk-import skill packs.
- **staged pipeline + checkpoints (OpenMontage):** TDD-first discipline expresses work as a staged
  pipeline with review/QA checkpoints (pattern only — OpenMontage not adopted; Caracu/video is
  adapter-only).
- **enabling is forensics-gated (supply-chain):** Superpowers is an external plugin — enabling it requires
  `new_repo_intake` + repo-forensics + supply-chain review; it is a policy input until then.

## Context-compaction policy (CTX-0) — pre-task band check
Before a large next task, planning checks the current context **band if available** (Token Optimizer
statusline; a context signal only — see `cap_registry` / `plugin_update_gates`).
- **≥50%:** **compact required** immediately before continuing.
- **40–49% + any new task:** **compact required** before implementation.
- **30–39% + large task:** **compact recommended** before implementation.
- **<30%:** no compact required by default.
- Never compact mid-unsafe-op; log as a `context_compaction_decision` event.
- **Honest status: directive-only** — band may be `unknown` (statusline not readable programmatically);
  compaction not auto-triggerable. Require/recommend at a **safe checkpoint**, no silent auto-compaction.

## 15. Smallest next slice
Decide + document the route-on flag (which workflow classes opt in) — leave `superpowers_enabled: false`
until a forensics scan clears enabling it. Named here; **not implemented in M5.**
