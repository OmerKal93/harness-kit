# Component Contract — `plan_grill_me`

> M5 contract. **Brutally honest: `directive-only` and quarantined.** `/grill-me` is a host skill the
> conductor never invokes; no risk-trigger routes to it. It is the ambiguous/risky planning lane.

## 1. component_id
`plan_grill_me`. Risk-hardening planner lane, alongside `plan_ce` (default) / `plan_superpowers` (TDD).

## 2. Purpose
Adversarial decision-tree interrogation of a plan — surface gaps, unstated assumptions, and risky
decisions **before** implementation, for ambiguous or high-risk work.

## 3. Interface
Host directive: `/grill-me` on the plan. Output (gap questions / hardened decisions) re-enters by tightening
`plan.md`. **No code invokes it; no routing criterion fires it.**

## 4. Inputs
The draft `plan.md`; the workflow's risk classification (ambiguous/risky → eligible).

## 5. Outputs
Gap questions + hardened plan edits (host-applied). No state writes of its own.

## 6. State fields touched
None directly (host hardens `plan.md`). Could later record a `plan_hardened` signal.

## 7. Gates
`NO_GATE` to run (read/question only). Policy: **ambiguous/risky workflows → grill before or alongside
planning**; routine runtime/code or docs/simple → skip. Selection is a host/conductor decision, not enforced today.

## 8. Executor
`host:/grill-me` (quarantined — present but unrouted).

## 9. Invocation contract (external components only)
Host slash-command → no programmatic contract.

## 10. Failure modes
Host skips it on a risky plan → unhardened plan proceeds (the current default, since nothing triggers it).
Over-applied on trivial work → wasted effort.

## 11. Repair behavior
None of its own — its output feeds back into `plan_ce`'s plan before `plan_review`.

## 12. Acceptance tests
- **Exists:** none (host, quarantined).
- **Needed:** a risk-trigger rule (which workflow classes / sensitive paths require grilling) the conductor checks.

## 13. DISABLED behavior
N/A (host directive). The run step that would emit it honors `DISABLED`.

## 14. Work-state
- **current:** `contract_drafted` (code = `directive-only`, quarantined/unrouted).
- **desired:** `optional_auto_on_risk`.
- **Honest gap:** no risk-trigger criteria exist, so it never runs automatically; it is a manual host skill.

## External-pattern enforcement (contract/policy inputs only — NOT adopted code)
> Policy inputs from external repos; nothing cloned/installed/run. Risky surfaces are exactly what this
> lane exists to interrogate before implementation.
- **cookie/auth/social/browser/network gated (Agent-Reach):** any plan touching logged-in social/browser
  context, cookies, auth, or external network reach is a hard grilling trigger → must route to external/
  data/privacy gates; never silently used.
- **scraping/cloning gated (ai-website-cloner-template):** plans that scrape/clone/reverse-engineer public
  sites are high-risk and **not default**; grilling must separate allowed local/staging/browser
  verification from gated scraping/cloning.
- **audio/voice privacy gated (voicebox):** any mic/audio/voice-clone capture in a plan is a grilling
  trigger requiring explicit approval + data/privacy gate.

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
Define risk-trigger criteria (workflow class + sensitive paths, incl. the external/scraping/audio surfaces
above) that flag a plan as "needs grilling" — a report-only flag first, no auto-invoke. Named here;
**not implemented in M5.**
