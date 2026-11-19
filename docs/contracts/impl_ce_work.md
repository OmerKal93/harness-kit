# Component Contract — `impl_ce_work`

> M5 contract. **Brutally honest: `directive-only`.** The conductor emits a host handoff to `/ce-work`;
> **no code invokes CE, no code captures the diff, and the `ASK_BEFORE_WRITE` gate is advisory (hooks
> dormant).** Default writer for runtime/code work — *when actually wired*; today it is directive/future.

## 1. component_id
`impl_ce_work`. Default implementation writer. (Codex is **not** an implementation writer — it only reviews.)

## 2. Purpose
Write the code/changes at the `implementation` state (after a Codex `PASS`), scoped to the approved plan
and its declared gates/non-goals.

## 3. Interface
Host directive: `/ce-work` (host model writes the diff). Re-entry: `implementation → verification` once
work is done. **No programmatic call; no diff capture today.**

## 4. Inputs
The approved `plan.md` (incl. its design-context decision + external-surface declaration) + memory facts.
**Implementation is hybrid by workflow:** runtime/code → `/ce-work` default; docs/simple → host writer;
future → adapter-based writers selected by workflow.

## 5. Outputs
A scoped diff (files created/edited) matching the plan's **expected files**. **Should record changed
files/lines into state** so `ponytail_budget` can read real counts — it does **not** today (the missing seam).

## 6. State fields touched
`current_stage` (host handoff). **Desired:** write `files_changed`/`lines_changed` for `ponytail_budget` /
`ponytail_always_on`.

## 7. Gates
**`ASK_BEFORE_WRITE`** — advisory only today (no hook enforces it). Policy: **any code change starts the
review/QA "war" at a scaled level** — the size/risk of the diff scales how many reviewers + how deep the QA
(per the plan's required-reviewers + QA plan from `plan_ce`). Scope expansion → `ponytail_budget`
expansion gate (helper, uncalled). Implementation inherits every gate the plan declared (external/MCP/
browser/network/cookies/audio/secrets) — it may not cross a declared boundary that the plan did not route.

## 8. Executor
`host:/ce-work` (runtime/code default). Docs/simple → host writer. Future → workflow-selected adapter writer.

## 9. Invocation contract (external components only)
Host slash-command, not a spawned process → no programmatic contract today.

## 10. Failure modes
Host skips the directive → no diff → run stalls at `implementation`. **Scope expansion** beyond plan (no
enforced write gate, no real diff counts → `ponytail_budget` can't see it). Wrong writer lane for the
workflow. **Silent brand/design invention** when no design context exists (the design.md failure mode).

## 11. Repair behavior
A failing verification/review → `verification → repair_loop → implementation` (or `planning`) to redo.
Bounded by `max_repair_loops` (unenforced) → `escalation` (missing).

## 12. Acceptance tests
- **Exists:** none (host action).
- **Needed:** record `files_changed`/`lines_changed` into state at end of `implementation` (the seam
  `ponytail_budget` needs), + a check that the diff stays within the plan's expected files.

## 13. DISABLED behavior
N/A (host directive). The `--run` step emitting it honors `DISABLED`; no autonomous writes occur regardless.

## 14. Work-state
- **current:** `contract_drafted` (code = `directive-only` — **not wired**; CE is the *intended* default
  writer, marked directive/future, not a running integration). **Unchanged by PR13/W13.**
- **desired:** `host_handoff` (defined diff-capture + scaled review trigger).
- **Honest gap:** nothing invokes CE, the write gate is advisory, and the diff is never measured *by
  this component* — so Ponytail/scaled-review can't act on real change size via `impl_ce_work` itself.
- **PR13/W13 note:** a standalone, manually-invoked, report-only diff-capture tool now exists —
  `scripts/scope-fence.js` (real `git diff --numstat` for tracked changes **plus** `git status
  --porcelain` for untracked new files — a brand-new out-of-scope file is not invisible; untracked
  line counts are read from disk and marked `line_count_unknown` rather than silently 0 when a file is
  binary/unreadable — glob-based scope comparison, optional
  decision-log event). It is a **consuming-side** guard, not `impl_ce_work` wired: nothing auto-fires
  it at the end of `implementation`, it is not tied to this component's own state machine, and it does
  not itself write `files_changed`/`lines_changed` into `workflow-state.json`. Closes the *measurement*
  half of §12's "Needed" acceptance test (real counts are now computable on demand); does not close the
  *invocation* half (no auto-trigger, no enforced scope check at the `implementation → verification`
  boundary — still directive-only, still human-invoked).

## External-pattern enforcement (contract/policy inputs only — NOT adopted code)
> Policy inputs from external repos; nothing cloned/installed/run/vendored.
- **design context (design.md):** implementation must **not invent brand/design rules silently**. If the
  plan flagged a UI/design task with no project-level **design context** (DESIGN.md-style), the writer
  stops and requires the design-context input/TODO rather than guessing brand/colors/voice.
- **no bulk skill import (mattpocock/skills):** the writer uses only the small, explicit, trigger-driven
  skills the plan named for QA/review; it must not bulk-import skills or pull a whole skill pack.
- **MCP/binary gated context (codebase-memory-mcp):** the writer may consume codebase context, but **MCP
  memory is not trusted memory** — any MCP/binary tool is **MCP/binary gated** through external/data/
  privacy gates before use, never silently trusted as fact.
- **adapter, not core (penpot / OpenMontage):** heavy design-code (penpot) or video (OpenMontage) tooling
  is **adapter-only/future**, never a HarnessKit core write dependency.

## 15. Smallest next slice
At the end of `implementation`, record real changed files/lines (e.g. `git diff --numstat`) into state so
`ponytail_budget` and the scaled review can read them. Named here; **not implemented in M5.**
