# Component Contract — `review_ce_code`

> M6 contract. **Brutally honest: `directive-only`.** `/ce-code-review` is a host skill the conductor
> never invokes, and there is **no `ce_code_review` record-verdict path**. CE correctness/quality review —
> distinct from deterministic QA, Codex (adversary), Ponytail (compactness), and security review.

## 1. component_id
`review_ce_code`. CE correctness/maintainability review at `final_review`.

## 2. Purpose
Host CE personas review the diff for correctness, maintainability, and project-standards compliance,
emitting an **evidence-backed** verdict — reviewers are inputs, not trusted blindly.

## 3. Interface
Host directive: `/ce-code-review` on the diff. Re-entry (desired): a `ce_code_review` verdict via
`recordVerdict` → `appendVerdict`. **No code invokes it; no record path exists today.**

## 4. Inputs
The implementation diff + the plan's required-reviewers list (from `plan_ce`).

## 5. Outputs
Findings → a recorded verdict. **Every QA/review verdict must be recorded in `reviewer-verdicts.ndjson`**
(via `verdict_log`) — today nothing records `ce_code_review`.

## 6. State fields touched
**Desired:** `reviewer_verdicts[]` (the CE verdict). Today: none.

## 7. Gates
`NO_GATE` to review (read-only). Policy: **any code change starts a scaled review/QA war** — diff size/risk
scales how many CE personas + depth, per the plan. **Reviewers are not trusted blindly; verdicts must be
evidence-backed** (cite file:line). **Security skill packs, if cited, are inputs, not authorities.**

## 8. Executor
`host:/ce-code-review` (CE personas). Not a CLI the conductor spawns.

## 9. Invocation contract (external components only)
Host slash-command, not a spawned process → no programmatic contract today.

## 10. Failure modes
Host skips the directive → no review, no verdict (current default). A non-evidence-backed "LGTM" → false
confidence. Findings not recorded → lost audit trail.

## 11. Repair behavior
A review verdict with blocking findings → **failed review routes to `repair_loop`** (`final_review →
repair_loop`). **Repeated failures respect `max_repair_loops`** → `escalation`.

## 12. Acceptance tests
- **Exists:** none (host action).
- **Needed:** a `ce_code_review` record-verdict path + a test that a blocking verdict routes
  `final_review → repair_loop`.

## 13. DISABLED behavior
N/A (host directive). The run step that would emit it honors `DISABLED`.

## 14. Work-state
- **current:** `contract_drafted` (code = `directive-only` — **not wired**).
- **desired:** `host_handoff` (recorded verdict path).
- **Honest gap:** nothing invokes CE and no `ce_code_review` verdict is ever recorded.

## 15. Smallest next slice
Add a `ce_code_review` record-verdict path so a host review can enter `reviewer_verdicts` and route a
blocking verdict to `repair_loop`. Named here; **not implemented in M6.**
