# Loop Engineering Alignment

> Status: read-only analysis, created 2026-06-27 (Batch 3.7b). Aligns HarnessKit with external
> loop-engineering concepts while preserving HarnessKit's own architecture/constraints. `[V]` verified
> against local code, `[I]` inference. **Analysis + one doc only — nothing implemented or wired.**
>
> Source note: the external repo `github.com/cobusgreyling/loop-engineering` was **NOT fetched** (no
> network calls this batch). This report works from the concept summary provided in the task brief +
> verified local HarnessKit state. Treat the external repo as a **reference model, not a dependency**.

## Purpose

Use the external "loop engineering" framing (loops as systems that orchestrate agents) to pressure-test
HarnessKit's plan, adopt the operational discipline that's genuinely missing (budgets, attempt caps,
readiness levels, run-log-as-contract), and explicitly reject the parts that don't fit a local,
single-committer, safety-gated harness. HarnessKit keeps its own stack (CE + Superpowers + Grill-me +
Codex + Ponytail + structured facts); this only borrows concepts.

## External Reference Summary

Concise (no large quoting):

- **Loops** = systems that prompt/orchestrate agents on a schedule or trigger, not one-shot chats.
- **Primitives + memory:** scheduling/automation; worktrees (isolation); skills; plugins/connectors/MCP; sub-agents with a **maker–checker** split; durable memory/state.
- **Readiness levels:** L0 draft → L1 report-only → L2 assisted fixes → L3 unattended.
- **Operating loops (patterns):** daily triage, PR babysitter, CI sweeper, dependency sweeper, changelog drafter, post-merge cleanup, issue triage.
- **Operational concerns:** loop budget, run log, token/cost caps, pause/kill criteria, max attempts, human escalation.
- **Anti-patterns:** same agent implements & verifies; no attempt cap; vague triage output; auto-fix too early; shared state without schema; overbroad MCP/write perms; no kill switch; fixing flakes with app code; auto-merge without allowlist; no run log.

## HarnessKit Current Match

| External concept | HarnessKit current equivalent | Status | Notes |
|---|---|---|---|
| scheduling / automation | host tools (`CronCreate`, `ScheduleWakeup`, `/schedule`, `/loop`); harnesskit core has none | PARTIAL | core is run-on-invoke; scheduling is host-level → BETTER_AS_ADAPTER |
| worktrees / isolation | `/ce-worktree`, Superpowers `using-git-worktrees`, host `Agent isolation:worktree` | PARTIAL | available via CE/SP/host, not harnesskit core [V] |
| skills | local `skills/*` + CE/SP/Ponytail plugin skills; `config/skill-registry.json` (two-hash trust) | PRESENT | [V] |
| plugins / MCP | CE/SP/Ponytail/frontend enabled; MCP `UNKNOWN`/profile-based | PARTIAL | MCP not wired in-repo [V] |
| maker–checker split | single-writer: subagents read-only, main agent writes; CE review personas | PRESENT | `capability-registry` `claude-subagents.write_access:none` [V] |
| durable memory/state | `runs/<id>/run.json` + NDJSON logs; `memory/*.md`; **structured facts** (B5a–c) | PARTIAL | facts schema present but not wired into capture/retrieval [V] |
| run log | `runs/<id>/decision-log.ndjson` + `tool-log.ndjson` + `runs/.index.ndjson` | PRESENT | append-only [V] (tool-log empty until hooks wired) |
| loop budget | — | MISSING | no budget code; concept only in `WORKFLOW_MATRIX.md` [V] |
| max attempt cap | `max_repair_loops` (planned only) | MISSING | docs only, not in code [V] |
| human gate | risk-based gate model (B3); `check-approval-needed.js`; approval ledger | PARTIAL | advisory until hooks wired [V] |
| denylist / sensitive paths | `pre_tool_use_guard.js#DESTRUCTIVE` + profile `sensitive_paths` | PRESENT | enforced only when hooks wired [V] |
| report-only rollout | `reference/autonomy-levels.md` **active tier L0 (Advisory)** | PRESENT | strong match [V] |
| assisted-fix mode | L1→L2 not reached (`L1 NOT READY`) | MISSING | gated, not active [V] |
| unattended mode | — | MISSING | intentionally not built |
| kill switch | `DISABLED` file / `HARNESSKIT_DISABLED`; `is-disabled.js` | PRESENT | every script honors it [V] |
| connector permissions | per-capability fields in `capability-registry.json` (network/write/secret access, lanes, approval) | PARTIAL | declared, not enforced-by-code [V] |
| state schema | `route.json`/`selected-agents.json`/facts schema (`structured-memory.js`) | PRESENT | validated NDJSON facts [V] |
| structured output | schema-validated JSON artifacts + facts validation | PRESENT | [V] |

## What HarnessKit Should Adopt

- **Readiness levels L0–L4** — formalize beyond the existing L0/L1 ladder (see proposal below).
- **Explicit loop budget** — per-workflow caps (subagent spawns, files/lines before an expansion gate).
- **Append-only loop run log** — already have per-run logs; make a run-log entry a *required* output of every loop iteration (contract, not optional).
- **Max repair loops** — a hard `max_repair_loops` so plan↔review / implement↔QA can't spin forever.
- **Pause/kill criteria** — explicit `kill_criteria` (repeated rejects, budget exceeded, scope expansion) on top of the manual `DISABLED` switch.
- **Report-only-first rollout** — keep L0/L1 as the default; never start a new loop above report-only.
- **Maker/checker separation as a first-class rule** — promote the single-writer convention to an explicit, named workflow rule (the verifier is never the implementer).
- **State/memory schema** — done for facts (B5a); extend the same discipline to loop state.
- **Connector permission tiers** — turn the `capability-registry` access fields into enforced tiers (read-only / scoped-write / gated).
- **No auto-merge / no publish without an explicit gate** — `ASK_BEFORE_PUBLISH` already proposed (B3); make it mandatory for any loop.

## What HarnessKit Should Not Adopt Blindly

- **No npm/npx dependency** just because the reference ships CLIs — HarnessKit is zero-dep Node stdlib; keep it.
- **Don't make scheduling core too early** — scheduling stays a host/adapter concern, not core.
- **Don't require GitHub Actions / CI** — the harness must work fully local (a downstream project policy is even "No CI"); CI integration is optional adapter only.
- **Don't copy pattern names blindly** — "PR babysitter / CI sweeper" etc. are GitHub-centric; adopt the *shape* (triage→report→gated-fix), not the brand names.
- **Don't enable unattended (L3) before L1/L2 quality is proven** — current state is L0; L3 is far off.
- **Don't make connectors write-capable by default** — default read-only; writes are gated.
- **Don't replace the Ponytail/CE/Codex workflow with a generic loop template** — HarnessKit's reviewer stack is the differentiator; the loop model wraps it, not the reverse.

## HarnessKit-Specific Additions (beyond the reference)

- **Ponytail compactness governor** — the reference has no compactness tier; HarnessKit gates patch/scope size (Safety > Correctness > Maintainability > Compactness).
- **CE + Superpowers + Grill-me planning stack** — layered plan authoring + hardening, not a single planner.
- **Codex CLI adversarial review** — optional external read-only checker (C1), a second engine cross-checking the first.
- **Structured facts with provenance / source-hash / poisoning scan** — memory isn't just "durable state"; it's validated, scanned, and provenance-tagged (B5a–c).
- **Team/org model with private-memory boundaries** — multi-user, role-aware, handoff-packet-based (B3.5); the reference is single-operator.
- **Public/private split for transfer/open-source** — extraction discipline (B2/B4).
- **`HARNESS_ROOT` portability seam** — relocatable/transferable harness (B3-impl).

## Readiness Level Proposal

| Level | Name | Allowed behavior | Required evidence |
|---|---|---|---|
| **L0** | Draft | Read/inspect, write run artifacts + plans/reports only; no project writes | run folder + decision log produced (matches current `autonomy-levels.md` L0) [V] |
| **L1** | Report-only | All L0 + emit findings/diags + *propose* patches (not applied); reviewers run | green eval suite + run log + no project mutation; the existing L0→L1 gates satisfied |
| **L2** | Assisted fix | Apply **scoped** non-sensitive patches with maker/checker + human gate on risk boundaries | verifier ≠ implementer; tests/evals pass; Ponytail PASS/SHRINK; gates honored |
| **L3** | Unattended bounded | Autonomous within budget + kill criteria; stops at any gate/limit | budget caps + `max_repair_loops` + kill_criteria all enforced; clean L2 track record |
| **L4** | Team/org governed | L3 within a team/org: role-aware gates, handoff packets, manager visibility | **team policy + role-aware gates + handoff packets + manager/reviewer visibility + private-memory boundaries** (HarnessKit-specific, B3.5) |

L4 is HarnessKit-specific and explicitly requires the B3.5 team primitives; it is not in the external model.

## Workflow Config Implications

Batch 3.8's skeleton should carry, per workflow: `readiness_level`, `allowed_action_level`,
`max_repair_loops`, `budget` fields, a **run-log requirement**, `human_escalation` rules, the
allowed action level, connector permission scope, **Ponytail budget fields**, verifier requirements,
and `kill_criteria`. Proposed shape (future, not created):

```json
{
  "workflow_id": "runtime_code_change",
  "readiness_level": "L1",
  "allowed_action_level": "report_only",
  "max_repair_loops": 2,
  "requires_verifier": true,
  "requires_ponytail": true,
  "budget": {
    "max_subagent_spawns": 3,
    "max_files_changed_without_expansion_gate": 5,
    "max_lines_changed_without_expansion_gate": 250
  },
  "human_escalation": {
    "on_repair_loop_exhausted": true,
    "on_security_risk": true,
    "on_publish": true
  },
  "kill_criteria": ["repeated_rejects", "budget_exceeded", "scope_expansion"]
}
```

This composes with the verified capabilities (B3.7): reviewers reference **real** invocations
(`/ce-*`, `/grill-me`, `/ponytail-review`, `codex` CLI), and `requires_ponytail` maps to the
compactness governor's PASS/SHRINK/BLOCK verdict (interface still `[U]`).

## Anti-Pattern Guardrails

| External anti-pattern | HarnessKit guardrail |
|---|---|
| same agent implements & verifies | **maker/checker rule**: subagents read-only, main writes; verifier ≠ implementer; CE/Codex review personas are separate from `/ce-work` [V] |
| no attempt cap | `max_repair_loops` (per-workflow) → `NEEDS_USER` on exhaustion |
| vague triage output | schema-validated structured outputs (`route.json`, facts schema, verdict objects) — no free-text-only verdicts |
| auto-fix too early | readiness ladder: L0/L1 report-only default; fixes only at L2 with gates |
| shared state without schema | NDJSON facts with `validateFactRecord` + provenance (B5a); loop state schema'd in 3.8 |
| broad connector permissions | default read-only; `capability-registry` access tiers; MCP gated/profile-based; `additionalDirectories` not pointed at project repos |
| no kill switch | `DISABLED` file / `HARNESSKIT_DISABLED`, honored by every script [V] |
| fixing flakes with app code | tests/evals gate is mandatory; flake → repair the test/fixture, not application logic (workflow rule) |
| auto-merge/publish without allowlist | **`ASK_BEFORE_PUBLISH`** gate mandatory; no commit/push/PR/merge without explicit named approval (push-control rule) [V] |
| no run log | per-run append-only `decision-log.ndjson` + `tool-log.ndjson` + `.index.ndjson` [V]; run-log entry required per loop iteration |
| **overengineering / code sprawl** | **Ponytail compactness governor** — line/file budgets + `/ponytail-review`; `ASK_BEFORE_EXPANSION` on scope growth; Safety > Correctness > Maintainability > Compactness |

## Recommended Next Step

**Batch 3.8 — workflow config skeleton, informed by this alignment.** Justification: B3.7 verified the
real tool invocations and B3.7b supplies the operational frame the matrix lacked (readiness level,
budget, run-log requirement, kill criteria, maker/checker rule, anti-pattern guardrails). The skeleton
can now encode those fields against real capabilities — turning two batches of design into one concrete,
reviewable artifact — while still implementing nothing (it's a config schema + examples). Batch 5d
(memory wiring) remains the better choice only if you want retrieval working before the loop engine;
otherwise 3.8 consolidates the most design debt.
