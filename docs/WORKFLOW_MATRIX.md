# Workflow Matrix / Loop Engine Plan

> Status: planning doc, created 2026-06-26 (Batch 3.6). Builds on B3
> (gate model), B3.5 (handoffs), B5a–c (structured memory). `[V]` verified
> against code, `[I]` inference, `[U]` unknown/needs follow-up. **Planning only — no workflow engine,
> routing, memory wiring, or Ponytail implemented here.**

## Purpose

HarnessKit should support **multiple workflow graphs**, not one rigid linear pipeline. A docs-only
edit, a runtime code change, a UI change, and a large refactor each deserve a different path through
planning, review, and verification. This doc defines those graphs, the reviewers/tools at each node,
the loop-back (repair) logic, where Ponytail governs compactness, and where humans actually enter.

## Core Principle

**Autonomous execution, adversarial review, compact patches, risk-based human gates.**

- The harness proceeds **automatically** through safe loops — diagnose, plan, implement, verify, report.
- **Reviewers reduce human load** — adversarial/security/compactness reviewers catch problems so a
  human doesn't have to babysit every step.
- **Humans enter only at risk boundaries** (the gate levels below), never at every node.
- **Rejected plans or patches loop back** — a refuted plan returns to planning; a failed review/test
  triggers a targeted repair loop, bounded by a max-loop count.

## Current vs Future

- **Current** (`[V]`): a deterministic run wrapper — `new-run.js` → `classify-task.js` →
  `select-{workflow,agents,context}.js` → `check-approval-needed.js`, then the host model **obeys
  the markdown** in `commands/harness-run.md` for plan/work/review/verify. One mostly-linear path; review
  personas are selected but the loop-back is manual; enforcement is advisory (hooks dormant). The
  `task_type_to_workflow` map in `global-policy.json` already picks a primary skill + gates per task type.
- **Future** (`[I]`): a **workflow graph** — per-task-type stage lists with **conditional loops**
  (plan→adversary→repair→plan), reviewer **rejection** as a first-class run state, and Ponytail as a
  compactness governor. Same deterministic spine; loops and reviewers added on top.

## Workflow Stages

1. **Intake** — turn a prompt into a run folder (`new-run.js`). [V]
2. **Classification** — task type + risk + triggers (`classify-task.js` + `detect-risk.js`). [V]
3. **Context / memory / knowledge alignment** — build context pack; retrieve active relevant facts (B5; not yet wired).
4. **Planning** — CE plan (`/ce-plan`) and/or Superpowers `writing-plans`.
5. **Plan hardening** — Grill-me / `zoom-out` / coherence checks tighten the plan.
6. **Adversarial review** — Codex C1 read-only adversary + CE adversarial personas try to refute the plan.
7. **Human gate if required** — only when risk class demands it (below).
8. **Implementation** — CE work (`/ce-work`); single-writer (main agent writes, subagents inspect). [V]
9. **QA / verification** — eval suite (`run-evals.js`) + tests + Playwright/browser when UI is touched.
10. **Security review** — `/ce-code-review` security personas + `repo-forensics` on integration changes.
11. **Simplification / compactness review** — `/ce-simplify-code` + **Ponytail** compactness governor.
12. **Repair loop if rejected** — targeted fix → re-review (bounded loop count).
13. **Final verification** — re-run tests/evals; confirm acceptance criteria.
14. **Memory capture / decision record** — capture fact/decision candidates (B5b capture; manual today).
15. **Handoff / next action** — `next-action.md` + (future) run summary / handoff packet (B3.5).

## Tool / Reviewer Roles

| Tool / reviewer | Role | When triggered | Can reject? | Sends back to |
|---|---|---|---|---|
| CE plan (`/ce-plan`) | Produce the plan | Planning stage | n/a (author) | — |
| Superpowers plan (`writing-plans`) | TDD-first plan discipline | Planning, if enabled (`superpowers_enabled:false` today) [V] | No (advisory) | Planning |
| Grill-me (`skills/grill-me`) | Stress-test plan via decision-tree Qs | Plan hardening (manual today) [V] | Soft (raises gaps) | Planning |
| Codex adversary review (C1 read-only) | Refute the plan/diff adversarially | Adversarial review; risk ≥ medium | **Yes** | Planning (plan) / Repair (patch) |
| Ponytail | Compactness governor (see below) | Plan + final patch | Recommends only (REPORT_ONLY); ASK on large expansion | Planning / Repair |
| Security review (`ce-security-*`, `repo-forensics`) | Find exploitable issues / supply-chain | Security-sensitive paths/integrations | **Yes** | Repair / Human gate |
| Codex review (C1 read-only) | Correctness/quality second opinion on diff | After implementation, risk ≥ medium | **Yes** | Repair |
| CE simplify (`/ce-simplify-code`) | Reuse/simplify the diff | Simplification stage | Soft (findings) | Repair |
| Playwright / browser QA | Verify UI behavior | UI/browser change [U: local availability] | **Yes** (fail) | Repair |
| Server debugging | Reproduce/trace runtime failures | Backend/server bug | n/a (diagnostic) | Implementation |
| QA / tests / evals (`run-evals.js`) | Gate on tests/evals green | Verification (mandatory) [V] | **Yes** (fail) | Repair |
| Knowledge alignment / structured memory (B5) | Align with active facts/decisions | Before planning + after verify | Soft (conflict → flag) | Planning |
| Human gate | Approve a risk boundary | Per gate level | **Yes** (deny) | Planning / stop |

## Ponytail Role

**Ponytail is the compactness governor.** It reviews plans and patches and pushes for the smallest
change that is still safe and correct. It reviews for:

- too many lines; too many files touched;
- unnecessary abstractions; unnecessary dependencies; overengineering;
- duplicate code; failure to adapt existing code (reuse over rewrite);
- a large patch where a small patch would do.

**Required hierarchy (Ponytail never inverts it):**

> **Safety > Correctness > Maintainability > Compactness**

Ponytail can **recommend shrinking**, but **cannot override** safety, correctness, verification, or
required auditability. A smaller patch that drops a security check, a needed error path, or a required
audit/log line is rejected by the higher tiers — compactness yields.

**Triggers:**

- patch exceeds a line threshold; many files touched;
- a new dependency is introduced; a new abstraction/helper is added;
- a large refactor; an architecture-heavy plan;
- a small bugfix turning into a big rewrite;
- repeated repair loops that keep increasing scope.

**Likely gate mode:**

- **`REPORT_ONLY`** for normal patches (note findings, keep moving).
- **`ASK_BEFORE_EXPANSION`** (proposed new gate) when scope crosses a threshold — pause and ask the
  human before the change grows (e.g. before adding a dependency, a new module, or blowing past the
  line/file budget). If `ASK_BEFORE_EXPANSION` is not adopted as a formal level, fall back to
  `ASK_BEFORE_WRITE` for the expanding write.

## Main Workflow Graph

```
intake
  → classify (task_type + risk + triggers)
  → context + memory alignment (retrieve active facts/decisions)
  → ce-plan  (+ superpowers-plan if enabled)
  → grill-me?  (plan hardening, if risk/ambiguity)
  → ponytail: plan compactness check (REPORT_ONLY | ASK_BEFORE_EXPANSION)
  → codex:adversary-review
        rejected → ce-plan repair loop  (≤ max_repair_loops)
        accepted → human gate IF risk boundary
  → implementation (ce-work; single-writer)
  → qa / tests / evals  (+ playwright if UI, + server-debug if backend bug)
        failed → repair loop → implementation
  → security review  IF security-sensitive
        rejected → repair loop
  → codex:review (diff second opinion)
        rejected → repair loop
  → ce-simplify
  → ponytail: final compactness check
        rejected (too large / avoidable) → repair loop
        accepted → final verification
  → memory capture / decision record (poisoning scan + provenance + source hash)
  → handoff / next action (next-action.md; future: run summary / handoff packet)
```

Repair loops are **bounded** (`max_repair_loops`); on exhaustion the run stops at `NEEDS_USER`.

## Workflow Types

| Workflow | Trigger | Required stages | Optional stages | Human gate |
|---|---|---|---|---|
| docs-only | task_type=docs; only `.md`/comments | intake, classify, plan(light), ponytail(report), verify(render) | grill-me | `NO_GATE` / `REPORT_ONLY` |
| small code change | low-risk, ≤ N lines/files, non-sensitive | intake, classify, context, plan, implement, qa, ce-simplify, ponytail | codex-review | `REPORT_ONLY` (write); risk-based |
| runtime code change | non-trivial logic, runtime behavior | context, ce-plan, ponytail-plan, codex-adversary, implement, qa, codex-review, ce-simplify, ponytail-final, verify | superpowers-plan, grill-me, security | `ASK_BEFORE_WRITE` on sensitive paths |
| UI / browser change | frontend/UI files | plan, implement, **playwright/QA**, ponytail-final, verify | design review | risk-based |
| backend / server debugging | server bug/error/trace | classify(debug), **server-debug**, repro, implement, qa, verify | codex-review | risk-based |
| security-sensitive change | sensitive_paths/auth/secrets/integration | context, plan, codex-adversary, **security review + repo-forensics**, implement, qa, security re-review, verify | grill-me | **`ASK_BEFORE_WRITE` + security approver** |
| large refactor | many files / architecture-heavy | plan, **ponytail-plan (hard)**, codex-adversary, implement(staged), qa, codex-review, ce-simplify, ponytail-final, verify | — | **`ASK_BEFORE_EXPANSION`** + risk-based |
| memory / schema change | `memory/`, schema, facts store | plan, ponytail, implement, qa(self-test+evals), verify | security | `ASK_BEFORE_WRITE` |
| adapter / project-specific change | `adapters/<x>`, project profile/maps | plan, project-owner context, implement, qa, verify | security | **project-owner approval** (B3.5) |
| open-source / transfer package change | publishable core / release bundle | plan, security, ponytail, license/secret scan, verify | — | **`ASK_BEFORE_PUBLISH`** |

## Reject / Repair Logic

- **Codex adversary rejects the plan** → return to **Planning**; CE re-plans addressing the refutation; re-submit to adversary. Counts against `max_repair_loops`.
- **Security review rejects** → **Repair** the specific finding; on a non-clean forensics result or a relaxed claim gate → **stop at `NEEDS_USER`** (don't auto-loop past a security block).
- **Playwright/tests fail** → **Repair loop** back to Implementation with the failure as the repro; re-run QA.
- **Ponytail says patch too large** → REPORT_ONLY: note + continue for normal patches; for a scope *expansion* → `ASK_BEFORE_EXPANSION` (pause), or loop back to shrink before proceeding.
- **Retry automatically** when: the failure is reproducible and the fix is in-scope, and loop count < max.
- **Stop and ask human** when: `max_repair_loops` hit, a security/forensics block, a risk-gate boundary, or repair keeps *expanding* scope (Ponytail expansion signal).
- **Max loop count** (`max_repair_loops`, e.g. 2) prevents infinite plan↔review or implement↔QA cycles; on exhaustion → `NEEDS_USER` with the accumulated findings.

## Risk-Based Human Gates in Workflows

| Gate level | Workflow point |
|---|---|
| `NO_GATE` | read-only inspection, classification, docs-only safe edits |
| `REPORT_ONLY` | normal patches; Ponytail/simplify findings; routine QA pass |
| `ASK_BEFORE_WRITE` | write to sensitive paths / runtime code (per profile `sensitive_paths`) |
| `ASK_BEFORE_EXTERNAL` | network/API/cost during a stage (e.g. live integration test) |
| `ASK_BEFORE_DESTRUCTIVE` | delete/move/migration/force-git during implementation |
| `ASK_BEFORE_PUBLISH` | commit/push/PR/open-source / transfer-package release |
| **`ASK_BEFORE_EXPANSION`** (proposed) | Ponytail scope-expansion: new dep, new module, line/file budget exceeded |

Human approval is **not** required at every node — only at these boundaries. Gate *level* = risk class
(B3); gate *approver* = role (B3.5). Everything else runs autonomously.

## Memory / Knowledge Alignment

Structured memory (B5) participates at four points (**not implemented yet**):

- **Before planning:** retrieve **active** relevant facts (`read-facts.js --active --mention …`) so the plan is grounded in known facts/decisions.
- **During planning:** cite known decisions/policies (e.g. "approver-gated migrations", profile hard rules); flag a plan that contradicts an active fact.
- **After verification:** capture new fact/decision **candidates** for review.
- **Before capture:** poisoning scan + provenance + source-hash check (`capture-fact.js`, B5b) — reject injected/contradictory facts.
- **Currency:** `superseded` / `retracted` / `archived` facts are **not** default context (5c default is active-only).

## Team / Handoff Integration

Workflow outputs should eventually become the B3.5 primitives — **sanitized**, redaction-passed:

- **run summary** — digest of what/why/outcome (no raw logs).
- **decision record** — a decision + rationale + alternatives (append-only).
- **handoff packet** — transfer work + context to another user/team (B3.5 schema).
- **review request** / **approval request** — route a diff/plan/gate to the right reviewer/approver.

**No raw private memory or run history is shared by default** — only these explicit, sanitized artifacts.

## Future Config Shape Proposal

Proposal only — not created or wired:

```json
{
  "workflows": {
    "runtime_code_change": {
      "stages": ["context", "ce_plan", "superpowers_plan", "ponytail_plan", "codex_adversary",
                 "implementation", "qa", "codex_review", "ce_simplify", "ponytail_final", "verification"],
      "required_reviewers": ["codex_adversary", "codex_review"],
      "optional_reviewers": ["grill_me", "security_review", "playwright"],
      "human_gate": "risk_based",
      "max_repair_loops": 2,
      "ponytail": { "mode": "report_only", "expansion_gate": "ask_before_expansion",
                    "line_budget": 200, "file_budget": 10 }
    }
  }
}
```

This generalizes today's `global-policy.json#task_type_to_workflow` (which already maps task type →
primary skill + gates) into per-workflow stage graphs with reviewers, loops, and Ponytail budgets. [V]

## Open Questions

1. Exact **Codex** command/invocation names (C1 read-only review/adversary) — `[U]`.
2. Exact **Ponytail** command/skill path (a `ponytail:*` plugin skill exists; confirm invocation) — `[U]`.
3. Is **Ponytail** a skill, a reviewer persona, or a script in the loop? (lean: reviewer skill invoked at plan + final).
4. Thresholds for **line count / file count** (line_budget / file_budget defaults).
5. Is **Grill-me** automatic (risk-triggered) or manual?
6. **`max_repair_loops`** default (proposed 2).
7. Is **Playwright** available locally? — `[U]`.
8. How to represent **reviewer rejections** in run state (new `REJECTED`/`REPAIR` sub-states + a reviewer-verdict artifact?).
9. Adopt **`ASK_BEFORE_EXPANSION`** as a formal gate level? (recommended).
10. How this interacts with the **Compound Engineering plugin** (CE skills are the default engine; Codex/Superpowers/Ponytail compose around them).

## Immediate Next Step

**Recommendation: inspect current availability/paths of Codex, Ponytail, Playwright, Superpowers, and CE commands (a read-only capability probe) next — before either Batch 5d or a workflow config skeleton.**

Justification: this matrix has ~7 `[U]` unknowns (exact Codex/Ponytail invocations, Playwright local
availability, reviewer-rejection representation). Writing a workflow config skeleton now would bake in
guessed command names; wiring memory (5d) is orthogonal and can follow. A small read-only probe
(`capability-registry.json` already records Codex C1, Ponytail, Superpowers, CE versions/paths — verify
they still resolve and capture exact invocations) turns the unknowns into facts, so the *next* config
skeleton is grounded, not speculative. If you'd rather keep memory momentum, 5d (retrieval wiring into
`search-memory.js`/context-pack) is the safe alternative — but the workflow engine should wait on the probe.
