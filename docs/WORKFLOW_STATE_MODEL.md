# Workflow State Model

> Status: schema-planning doc, created 2026-06-27 (Batch 3.9). Defines the FUTURE workflow run-state
> model for the HarnessKit loop engine. Builds on `config/workflows.example.json` (B3.8, `example_not_wired`).
> `[V]` verified against existing artifacts, `[I]` inference. **Planning only — no engine, no writer, no
> new run files created; existing run structure is unchanged. All examples are synthetic.**

## Purpose

`config/workflows.example.json` defines **intended behavior** — the stages, reviewers, budgets, and
gates a workflow *should* run. This document defines **workflow state** — the structured record of what
*actually happened* in one concrete run: which stages ran, what reviewers decided, how many repair
loops were used, which gates fired, and why the run continued, stopped, or escalated. Config is the
plan; state is the evidence. Neither the engine nor this state file exists yet.

## Core Principle

**Every loop decision must be recorded as structured state.**

- Reviewers can **reject** — and a rejection is a first-class, queryable record, not a log line.
- Rejected work **loops back** to the stage named by the verdict (`sends_back_to`).
- Repair loops are **bounded** — a counter, enforced against `max_repair_loops`.
- Budgets are **tracked** — files/lines/subagents estimated and compared to thresholds.
- Human gates are **explicit** — a gate record with role, token, and decision.
- Kill criteria **leave evidence** — a triggered criterion records why + what action followed.
- The final output **explains why** the run continued, stopped at `NEEDS_USER`, escalated, or was killed.

## Relationship to Existing Run Logs

The model **extends** today's artifacts; it does not replace or migrate them. [V]

| Existing artifact | Today's role | Relationship to the model |
|---|---|---|
| `runs/<id>/run.json` | run metadata + state + approvals | superset source; workflow state references it |
| `runs/<id>/decision-log.ndjson` | append-only state transitions | unchanged; workflow stages add entries |
| `runs/<id>/tool-log.ndjson` | per-tool log (empty until hooks wired) | unchanged; evidence_refs may point here |
| session summary / `next-action.md` | human-facing wrap-up | becomes `next_action` in workflow state |
| eval output (`evals/results/<id>/`) | test/verification evidence | referenced by `evidence_refs` |
| **`workflow-state.json` (future)** | the per-run loop state | **new, not implemented** |

This model is **not implemented**. It describes files and fields a future Batch (≥3.10/4.x) would add.

## Proposed Future Files

Future layout (**not created this batch**; existing run structure unchanged):

```
runs/<run_id>/
  run.json                  (exists)
  state.json                (future: coarse run state mirror)
  workflow-state.json       (future: the loop state object below)
  decision-log.ndjson       (exists)
  tool-log.ndjson           (exists)
  reviewer-verdicts.ndjson  (future: append-only verdict log)
  handoff.json              (future: sanitized handoff packet)
```

This batch creates **none** of these — only the schemas that would shape them.

## State Machine Overview

| State | Meaning | Allowed transitions | Evidence required |
|---|---|---|---|
| `initialized` | Run folder created | → classified | run.json |
| `classified` | Task type + risk + workflow chosen | → context_ready | route.json |
| `context_ready` | Context pack + memory alignment done | → planning | context-pack.md |
| `planning` | Plan being authored | → plan_review | plan artifact |
| `plan_review` | Reviewers judging the plan | → waiting_for_human_gate, → implementation, → repair_loop | reviewer-verdicts |
| `waiting_for_human_gate` | Paused for approval | → implementation (approved), → stopped (rejected) | gate record |
| `implementation` | Patch being made | → verification | diff/stage records |
| `verification` | QA/tests/evals running | → final_review, → repair_loop | eval output |
| `repair_loop` | Fixing a rejection/failure | → planning, → implementation, → escalated, → killed | verdict + counter |
| `final_review` | Simplify + Ponytail final | → completed, → repair_loop | verdicts |
| `completed` | Success | terminal | final verification + next_action |
| `stopped` | Halted at a boundary (NEEDS_USER) | terminal | reason + next_action |
| `escalated` | Handed to a human/role | terminal | escalation reason |
| `killed` | Kill criterion fired | terminal | kill record |

## Workflow Run State Schema

Synthetic example (future `workflow-state.json`):

```json
{
  "schema_version": 1,
  "run_id": "20990101-000000-example-runtime-change",
  "workflow_id": "runtime_code_change",
  "readiness_level": "L1_REPORT_ONLY",
  "allowed_action_level": "report_only",
  "status": "planning",
  "current_stage": "ce_plan",
  "stages_completed": ["intake", "classify", "context_alignment", "structured_memory_read"],
  "pending_stage": "ponytail_plan_review",
  "attempt_counters": { "repair_loops_used": 0, "plan_rejects": 0, "qa_failures": 0 },
  "budget": {
    "max_repair_loops": 2, "repair_loops_used": 0,
    "max_files_changed_without_expansion_gate": 5, "files_changed_estimate": 2,
    "max_lines_changed_without_expansion_gate": 250, "lines_changed_estimate": 60,
    "max_subagent_spawns": 3, "subagent_spawns_used": 1,
    "expansion_gate_required": false
  },
  "gates": [],
  "reviewer_verdicts": [],
  "kill_criteria": [],
  "memory_behavior": { "facts_read_count": 0, "active_facts_used": [], "historical_facts_used": [], "memory_warnings": [], "capture_candidates": [], "captured_fact_ids": [] },
  "handoff_behavior": { "handoff_required": false, "handoff_packet_id": null, "target_user_or_team": null, "reviewer_visibility": "summary_only", "private_memory_shared": false },
  "next_action": { "what": "run ponytail plan compactness check", "why": "plan authored", "who": "harness", "blocking": false },
  "created_at": "2099-01-01T00:00:00.000Z",
  "updated_at": "2099-01-01T00:01:00.000Z"
}
```

## Stage Record Schema

One record per stage execution (synthetic):

```json
{
  "stage_id": "stg-0004",
  "stage_name": "ce_plan",
  "tool_or_reviewer": "ce_plan",
  "started_at": "2099-01-01T00:01:00.000Z",
  "ended_at": "2099-01-01T00:02:00.000Z",
  "status": "passed",
  "inputs_summary": "context-pack + 2 active facts",
  "outputs_summary": "plan.md (3 steps, 2 files targeted)",
  "evidence_refs": ["runs/<id>/plan.md"],
  "warnings": [],
  "next_stage": "ponytail_plan_review"
}
```

Statuses: `pending` · `running` · `passed` · `failed` · `skipped` · `rejected` · `blocked` · `killed`.

## Reviewer Verdict Schema

Append-only (future `reviewer-verdicts.ndjson`), synthetic:

```json
{
  "verdict_id": "vd-0001",
  "reviewer": "codex_cli",
  "reviewer_kind": "adversary_external",
  "target": "plan",
  "verdict": "REJECT",
  "severity": "high",
  "reasons": ["plan mutates a shared cache without an invalidation step"],
  "required_repairs": ["add cache-invalidation step before write"],
  "evidence_refs": ["runs/<id>/codex/plan-review-0001.txt"],
  "sends_back_to": "ce_plan",
  "created_at": "2099-01-01T00:03:00.000Z"
}
```

Verdicts: `PASS` · `WARN` · `REJECT` · `SHRINK` · `BLOCK_EXPANSION` · `NEEDS_HUMAN`.

**Reviewer → allowed verdicts:**

| Reviewer | Verdicts |
|---|---|
| Codex adversary | PASS / WARN / REJECT |
| Ponytail | PASS / SHRINK / BLOCK_EXPANSION |
| security review | PASS / WARN / REJECT / NEEDS_HUMAN |
| CE simplify | PASS / WARN / SHRINK |
| QA / tests | PASS / REJECT |
| human gate | PASS / BLOCK / NEEDS_MORE_INFO |

## Repair Loop Logic

- A **REJECT** (or QA `failed`) increments the relevant counter (`plan_rejects`, `qa_failures`) and `repair_loops_used`.
- The run transitions to `repair_loop`, then back to the stage named by `sends_back_to` (plan → `planning`; patch → `implementation`).
- **`max_repair_loops` enforcement:** before re-entering a loop, if `repair_loops_used >= max_repair_loops` → **escalate** (`status: escalated` / `stopped` at `NEEDS_USER`) with the accumulated verdicts; do not loop again.
- **Auto-retry when:** the failure is reproducible, the fix is in-scope, and the counter is under the cap.
- **Escalate to human when:** cap hit, a `NEEDS_HUMAN` verdict, a risk-gate boundary, or scope keeps expanding (Ponytail `BLOCK_EXPANSION`).
- **Kill when:** a kill criterion fires (below) — distinct from escalation (kill = abort with evidence).
- **Repeated rejects** are recorded as the count + the verdict chain; a `repeated_rejects` kill criterion may trigger on N consecutive same-target REJECTs.

**Example sequence (synthetic):** Codex `REJECT` plan → `repair_loops_used=1` → CE replans → Ponytail `SHRINK` (drop a speculative helper) → second Codex pass `PASS` → human gate not required (non-sensitive) → implementation → QA `PASS` → `completed`.

## Budget Tracking

```json
{
  "max_repair_loops": 2, "repair_loops_used": 1,
  "max_files_changed_without_expansion_gate": 5, "files_changed_estimate": 3,
  "max_lines_changed_without_expansion_gate": 250, "lines_changed_estimate": 140,
  "max_subagent_spawns": 3, "subagent_spawns_used": 2,
  "expansion_gate_required": false
}
```

- Ponytail should later read these fields to emit `SHRINK` / `BLOCK_EXPANSION` and to set `expansion_gate_required` when an estimate crosses a threshold.
- **This batch does not implement budget enforcement** — fields are a contract for a future counter helper.

## Human Gate Records

```json
{
  "gate_id": "gate-0001",
  "gate_level": "ASK_BEFORE_WRITE",
  "reason": "write touches a sensitive path (auth)",
  "requested_by_stage": "implementation",
  "required_role": "project_owner",
  "status": "pending",
  "approval_token": null,
  "expires_at": null,
  "decision": null,
  "decided_by": null,
  "decided_at": null,
  "evidence_refs": []
}
```

Statuses: `not_required` · `pending` · `approved` · `rejected` · `expired`. (Open question: reuse the
existing approval registry / `matchingApprovalIndexes` semantics vs new workflow gate records.)

## Kill Criteria Records

```json
{
  "criterion": "budget_exceeded",
  "triggered": true,
  "reason": "lines_changed_estimate 410 > 250 and expansion gate denied",
  "evidence_refs": ["runs/<id>/workflow-state.json"],
  "triggered_at": "2099-01-01T00:20:00.000Z",
  "action_taken": "stopped_at_needs_user"
}
```

Required criteria: `repeated_rejects` · `budget_exceeded` · `source_drift` · `security_risk` ·
`dependency_install_requested` · `publish_requested_without_gate` · `private_data_exposure_risk` ·
`workflow_config_missing` · `verifier_missing`.

## Memory / Knowledge State

```json
{
  "facts_read_count": 4,
  "active_facts_used": ["fact-1001", "fact-1002"],
  "historical_facts_used": [],
  "memory_warnings": ["fact-1002: source changed since capture (source_sha256 mismatch)"],
  "capture_candidates": [{ "claim_summary": "cache uses LRU+TTL", "source_path": "examples/x.md" }],
  "captured_fact_ids": []
}
```

Memory read/write remains **manual today** (`read-facts.js` / `capture-fact.js`, B5b–c, not wired).
A future **Batch 5d/5e** may wire active-fact retrieval into context and candidate capture after verify.

## Handoff / Team State

```json
{
  "handoff_required": false,
  "handoff_packet_id": null,
  "target_user_or_team": null,
  "reviewer_visibility": "summary_only",
  "private_memory_shared": false
}
```

`private_memory_shared` is **false by default**; cross-instance sharing is only via a sanitized handoff
packet (B3.5). Managers/reviewers see summaries + verdicts + gates, never raw memory/runs.

## Synthetic End-to-End Example

One compact `runtime_code_change` run — first plan rejected, one repair loop, Ponytail SHRINK, then pass, no human gate, QA passes, completed (all fake IDs/paths):

```json
{
  "schema_version": 1,
  "run_id": "20990101-120000-example-runtime-change",
  "workflow_id": "runtime_code_change",
  "readiness_level": "L1_REPORT_ONLY",
  "allowed_action_level": "report_only",
  "status": "completed",
  "current_stage": "final_verification",
  "stages_completed": ["intake","classify","context_alignment","structured_memory_read","ce_plan","ponytail_plan_review","codex_adversary_optional","ce_plan","ponytail_plan_review","codex_adversary_optional","ce_work","qa_evals","ce_code_review","ce_simplify_code","ponytail_final_review","final_verification"],
  "pending_stage": null,
  "attempt_counters": { "repair_loops_used": 1, "plan_rejects": 1, "qa_failures": 0 },
  "budget": { "max_repair_loops": 2, "repair_loops_used": 1, "max_files_changed_without_expansion_gate": 5, "files_changed_estimate": 2, "max_lines_changed_without_expansion_gate": 250, "lines_changed_estimate": 90, "max_subagent_spawns": 3, "subagent_spawns_used": 2, "expansion_gate_required": false },
  "gates": [{ "gate_id": "gate-0001", "gate_level": "ASK_BEFORE_WRITE", "status": "not_required", "reason": "no sensitive path touched" }],
  "reviewer_verdicts": [
    { "verdict_id": "vd-0001", "reviewer": "codex_cli", "reviewer_kind": "adversary_external", "target": "plan", "verdict": "REJECT", "severity": "high", "reasons": ["missing cache invalidation"], "required_repairs": ["add invalidation step"], "sends_back_to": "ce_plan", "created_at": "2099-01-01T12:03:00.000Z" },
    { "verdict_id": "vd-0002", "reviewer": "ponytail_review", "reviewer_kind": "compactness", "target": "plan", "verdict": "SHRINK", "severity": "low", "reasons": ["speculative helper not needed"], "required_repairs": ["inline the helper"], "sends_back_to": "ce_plan", "created_at": "2099-01-01T12:05:00.000Z" },
    { "verdict_id": "vd-0003", "reviewer": "codex_cli", "reviewer_kind": "adversary_external", "target": "plan", "verdict": "PASS", "severity": "none", "reasons": ["invalidation added; scope tight"], "sends_back_to": null, "created_at": "2099-01-01T12:08:00.000Z" },
    { "verdict_id": "vd-0004", "reviewer": "qa_evals", "reviewer_kind": "tests", "target": "patch", "verdict": "PASS", "severity": "none", "reasons": ["all evals green"], "sends_back_to": null, "created_at": "2099-01-01T12:14:00.000Z" }
  ],
  "kill_criteria": [],
  "memory_behavior": { "facts_read_count": 2, "active_facts_used": ["fact-1001","fact-1002"], "historical_facts_used": [], "memory_warnings": [], "capture_candidates": [], "captured_fact_ids": [] },
  "handoff_behavior": { "handoff_required": false, "handoff_packet_id": null, "target_user_or_team": null, "reviewer_visibility": "summary_only", "private_memory_shared": false },
  "next_action": { "what": "none — run completed", "why": "plan passed after 1 repair loop; QA green; no gate needed", "who": "harness", "blocking": false },
  "created_at": "2099-01-01T12:00:00.000Z",
  "updated_at": "2099-01-01T12:15:00.000Z"
}
```

## Implementation Implications

A future engine would need:

- a **workflow-state writer** (atomic update of `workflow-state.json`).
- an **append-only verdict log** (`reviewer-verdicts.ndjson`, same family as existing NDJSON logs).
- a **stage transition helper** (validate allowed transitions; append to `decision-log.ndjson`).
- a **budget counter helper** (estimate files/lines/spawns; set `expansion_gate_required`).
- a **gate status updater** (create/resolve gate records; likely bridges the existing approval registry).
- a **kill-criteria checker** (evaluate the criteria list each iteration; write a kill record + stop).
- **compatibility with existing run logs** (extend, never rewrite `run.json`/`decision-log.ndjson`).
- **no direct private memory sharing** (handoff only via sanitized packet; `private_memory_shared:false`).

## Open Questions

- Should workflow-state be a single JSON object or NDJSON event stream (or both: `workflow-state.json` snapshot + NDJSON events)?
- Should reviewer verdicts be a separate NDJSON (`reviewer-verdicts.ndjson`) vs embedded in state? (lean: separate, append-only.)
- Where to store Codex CLI output safely (per-run `runs/<id>/codex/` with redaction)?
- How much of Ponytail output to persist (verdict + reasons only, vs full review text)?
- Should budgets be estimates before the patch and actuals after? (lean: both — `*_estimate` pre, `*_actual` post.)
- Should human gates consume the existing approval registry / `matchingApprovalIndexes`, or new workflow gate records? (lean: bridge — reuse approval semantics, mirror into gate records.)
- How to redact workflow-state before a team handoff (drop `evidence_refs` to private paths, claim text, source contents)?
- How to prevent state bloat (cap verdict/stage history; summarize old loops)?

## Recommended Next Step

**Batch 3.10 — a static `workflow-state.example.json` fixture** (the synthetic end-to-end object above as
a standalone, validated file under `examples/` or `config/`). Justification: this doc defines the schemas;
a single validated fixture turns them into a concrete, lint-able contract that a future writer/reader can
test against — completing the "config (3.8) + state schema (3.9) + state fixture (3.10)" trio before any
engine code, with zero runtime risk. Batch 5d (memory wiring) is the higher-value *functional* step if you
want retrieval working first; pick 5d over 3.10 if you'd rather ship behavior than another fixture.
