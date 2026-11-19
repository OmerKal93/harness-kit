# Component Contract — `plan_ce`

> M5 contract. **Brutally honest: `directive-only`.** The conductor emits a host handoff to `/ce-plan`;
> **no code invokes CE and no code validates the plan it produces.** This contract also defines the
> **plan.md contract** (what every plan must contain) and the **planning gate declarations** — the
> default planner for runtime/code work.

## 1. component_id
`plan_ce`. Default planner. Siblings: `plan_grill_me` (risk hardening), `plan_superpowers` (TDD discipline).

## 2. Purpose
Author the implementation plan (`runs/<id>/plan.md`) at the `planning` state — the artifact Codex
adversarially reviews and implementation consumes — including QA, gates, reviewers, and external-surface
declarations decided **up front**.

## 3. Interface
Host directive: `/ce-plan` (host model writes `plan.md`). Re-entry: the conductor advances `planning →
plan_review` once `plan.md` exists. **No programmatic call today** — text handoff only.

## 4. Inputs
The goal + memory facts (`mem_search` output) + workflow classification (which planning lane + which
external surfaces apply).

## 5. Outputs — the plan.md contract (enforceable, required sections)
`runs/<id>/plan.md`. **Every plan MUST include, or the plan is incomplete:**
1. **scope**
2. **expected files** (the diff's intended file list)
3. **gates** (which of `DISABLED`/`ASK_BEFORE_WRITE`/`_EXTERNAL`/`_EXPANSION`/`_PUBLISH`/`_DESTRUCTIVE` apply)
4. **required reviewers** (which review personas/components must sign off)
5. **QA / verification plan** (planned *here*, during `planning` — not improvised later)
6. **skills/plugins required for QA/review** (named explicitly; see mattpocock pattern)
7. **human-like verification plan** (when UI/behavioral — local/staging/browser checks)
8. **explicit non-goals**
9. **external-surface declaration** — state whether the work involves **external tools, MCP, browser,
   network, cookies, audio, secrets, or private data**. If *any* are involved, the plan MUST **route to the
   correct gate before implementation** (see §7). "None" is an allowed, explicit answer.

## 6. State fields touched
`current_stage` (host handoff at `planning`). The conductor reads for `plan.md` presence to advance.

## 7. Gates
`NO_GATE` to *write the plan*, but the plan itself must **declare and route** every risky surface before
implementation. **Planning is hybrid by workflow:** runtime/code → `plan_ce` default; docs/simple → host
plan allowed; ambiguous/risky → `plan_grill_me` / `plan_superpowers` before or alongside. **Codex is the
adversarial reviewer of the plan, never the planner.** Hard planning gates (declared in §5.9, enforced
before `implementation`):
- **cookie/auth/social/browser/network gated** — external web/social reach (Agent-Reach class). The plan
  must NOT silently use logged-in social/browser context; route to external/data/privacy gates.
- **scraping/cloning gated** — site reconstruction/scraping/reverse-engineering (ai-website-cloner class)
  is high-risk and **not default**; the plan must distinguish *allowed* local/staging/browser verification
  from *gated* scraping/cloning of public sites.
- **audio/voice privacy gated** — mic/audio/voice-clone/local capture (voicebox class) → data/privacy
  gate; the plan must never include audio capture without explicit approval.
- **MCP/binary gated** — MCP/binary tools (codebase-memory-mcp class) route through external/data/privacy
  gates; the plan may *request* codebase intelligence but MCP memory is **not trusted memory**.
- **scheduled report / secrets gated** — finance/news/API/notification/secrets (daily_stock_analysis
  class) → external/data/privacy + secrets workflow.

## 8. Executor
`host:/ce-plan` (host model). Not a CLI the conductor spawns.

## 9. Invocation contract (external components only)
Host slash-command, not a spawned process → no programmatic invocation contract today.

## 10. Failure modes
Host skips/forgets the directive → no `plan.md` → `codex_review` returns `no_plan`, run stalls at
`planning`. Plan omits a required §5 section (no validator enforces it yet) → weak/under-gated downstream.
A risky surface left undeclared → implementation hits an ungated external/privacy boundary.

## 11. Repair behavior
Missing/insufficient plan → stay at `planning` (no advance). A `REJECT` from `codex_review` sends
`plan_review → repair_loop → planning` for a re-plan.

## 12. Acceptance tests
- **Exists:** none (host action).
- **Needed:** a `plan.md` presence + **required-section check** the conductor runs before advancing to
  `plan_review` — fails the plan if any §5 item (incl. the §5.9 external-surface declaration) is missing.

## 13. DISABLED behavior
N/A (host directive). The `--run` step that emits it honors `DISABLED` like other run steps.

## 14. Work-state
- **current:** `contract_drafted` (code = `directive-only`). **This does NOT change with W10** — the
  guard described below lives in `codex_review`, not here; `plan_ce` itself still has no code invoking
  CE and no §5/§7 required-section validator.
- **desired:** `host_handoff` (a defined `plan.md` path + required-section validator the conductor runs).
- **Honest gap:** nothing invokes CE and nothing validates the plan — §5/§7 are a documented, enforceable
  *expectation*, not yet a runtime schema.
- **W10 note:** a deterministic lexical injection tripwire now exists as a boundary guard on the
  CONSUMING side (`scripts/plan-lint.js`, wired into `codex_review`'s `runCodexReview`), scanning
  `plan.md` for HIGH-severity injection patterns before Codex ever reads it. This is NOT a §5/§7
  required-section validator and does not touch `plan_ce`'s own work-state — it protects the reviewer
  from a malicious/accidental plan, it does not validate the plan is well-formed per this contract.

## External-pattern enforcement (contract/policy inputs only — NOT adopted code)
> These are **policy inputs distilled from 10 external repos**. Nothing is cloned, installed, run, or
> vendored. They shape what a plan must do; they are not runnable tools in HarnessKit.
- **design context (design.md):** planning must **detect when a task needs design context**. UI/design
  tasks look for a project-level **design context** file (DESIGN.md-style) *before* implementation. If
  none exists, planning either creates a lightweight design-context TODO or requires user/project input —
  it must not let implementation invent brand/design rules silently (mirrored in `impl_ce_work`).
- **skills are small/composable (mattpocock/skills):** skills stay small, explicit, composable,
  trigger-driven. The plan lists **skills/plugins required for QA/review**; implementation must not
  bulk-import skills (mirrored in `impl_ce_work`).
- **security packs are inputs (Anthropic-Cybersecurity-Skills):** treat **security skill packs as review
  inputs, not trusted authorities**. Plans for code/security/external/plugin changes must explicitly name
  the required security-review skills *or* mark why none are relevant. Any adoption → `new_repo_intake` +
  repo-forensics + supply-chain/security review (also encoded in the Codex/adversarial tail).
- **staged pipelines (OpenMontage):** express complex work as a **staged pipeline with review/QA
  checkpoints** (explicit stages, tool registry, skills, cost/logging). Pipeline/checkpoint planning is a
  pattern only — OpenMontage is **not** adopted into HarnessKit core; its video relevance is **Caracu
  adapter-only**.
- **design-code is heavy (penpot):** prefer lightweight design-context conventions (DESIGN.md-style)
  first; penpot is a **future adapter, not a core dependency**.

## Context-compaction policy (CTX-0) — pre-task band check
Before a large next task, planning checks the current context **band if available** (Token Optimizer
statusline; a context signal only — see `cap_registry` / `plugin_update_gates`).
- **≥50%:** **compact required** immediately before continuing.
- **40–49% + any new task:** **compact required** before implementation.
- **30–39% + large task** (multi-step/code-heavy/review-heavy/external-tool-heavy): **compact recommended**
  before implementation.
- **<30%:** no compact required by default.
- Never compact mid-unsafe-op; log the choice as a `context_compaction_decision` event in `decision-log.ndjson`.
- **Honest status: directive-only** — band may be `unknown` (statusline not readable programmatically);
  compaction is not auto-triggerable. Recommend/require at a **safe checkpoint**, no silent auto-compaction.

## 15. Smallest next slice
Define the `plan.md` path + a presence/required-section validator (incl. the §5.9 external-surface
declaration + gate routing) that the conductor runs at `planning` before advancing to `plan_review`.
Named here; **not implemented in M5.**
