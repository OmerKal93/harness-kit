# Loop Components Inventory (M0)

> Created 2026-06-27. **Brutally honest ground-truth** of every loop component before wiring more
> automation. No code changed. `[V]` = verified against committed code this session.
>
> **Status legend (current):** `auto` = a command/code path actually runs it · `directive-only` = the
> conductor only emits text telling the host to do it (no code runs it) · `helper-only` = function exists
> + tested but **no command path calls it** · `planned` = designed, not built · `missing` = nothing exists.
>
> **Hard honesty rules applied:** a skill is `directive-only` unless a code path invokes it. Ponytail is
> `helper-only` (budget arithmetic) — the `/ponytail-review` skill is **never invoked**. Codex is
> `helper-only` — **no command path fires it** (so it is NOT in the loop today, despite a verified CLI
> contract). `--continue` is the only verdict→transition that a CLI path actually drives.

## Summary (scan table)

| component_id | current | desired | executor | DISABLED-safe |
|---|---|---|---|---|
| workflow_state_writer | auto | auto | Node (`workflow-state.js`) | n/a (lib) / writes gated by caller |
| loop_conductor | kickoff (partial) | auto (driver) | Node (`loop-conductor.js`) | `--run` honors DISABLED |
| transition_model | auto | auto | Node (`ALLOWED`) | n/a |
| verdict_log | auto-when-called | auto | Node (`appendVerdict`) | n/a |
| decision_log | auto | auto | Node (`transitionStage`) | n/a |
| mem_read_facts | helper-only (manual CLI) | adapter | Node (`read-facts.js`) | ungated lib |
| mem_search | **auto in --run (before)** | auto | Node (`search-memory`) | startRun ungated; `--run` gated |
| mem_propose_candidates | helper-only (manual) | auto (after-verify) | Node (`propose-fact-candidates.js`) | ungated lib |
| mem_capture | helper-only (manual write) | human-gated | Node (`capture-fact.js`) | ungated lib |
| mem_dream | auto (`--dream`) | auto | Node (`dreamFromRecentRuns`) | read-only |
| plan_ce | directive-only | host handoff | host model `/ce-plan` | n/a |
| plan_superpowers | directive-only / unrouted | optional | host `/superpowers:*` | n/a |
| plan_grill_me | directive-only | optional auto-on-risk | host `/grill-me` | n/a |
| codex_review | **helper-only (NOT in loop)** | auto (gated) | `codex` CLI via Node | gated (DISABLED+external) |
| codex_verdict_parser | helper-only | auto | Node (regex on final msg) | n/a |
| codex_timeout_retry | partial (timeout, no retry) | bounded retry | Node | n/a |
| impl_ce_work | directive-only | host handoff | host `/ce-work` | n/a |
| ponytail_budget | helper-only | auto-on-write | Node (arithmetic) | n/a |
| ponytail_review_skill | **missing** | auto-on-write | host `/ponytail-review` | n/a |
| ponytail_always_on | planned/missing | enforced | host+Node | n/a |
| qa_self_tests | auto (manual run) | auto-in-verify | Node (`--self-test`) | ungated |
| qa_evals | exists, gated | auto-in-verify | Node (`run-evals.js`) | **DISABLED-gated** |
| review_ce_code | directive-only | host handoff | host `/ce-code-review` | n/a |
| review_ce_simplify | directive-only | optional | host `/ce-simplify-code` | n/a |
| review_ce_debug_proof_browser | directive-only | optional | host `/ce-debug` etc. | n/a |
| review_security | directive-only | auto-on-trigger | host CE + `repo-forensics` | n/a |
| repair_loop | partial (transition only) | auto | Node (`recordVerdict`) | n/a |
| max_repair_loops | **field only, NOT enforced** | enforced | Node | n/a |
| escalation | missing | auto-on-exhaust | Node | n/a |
| cap_registry | exists (advisory) | source-of-truth | `config/capability-registry.json` | read-only |
| plugin_drift_check | auto (`--check-plugins`) | auto + due | Node (`checkPlugins`) | read-only |
| plugin_update_gates | planned/missing | human-gated | host + forensics | n/a |
| finalize_commit | manual (guarded) | gated auto | me/host git | n/a |
| publish_push_gate | policy-only (no code) | enforced gate | n/a (never push) | n/a |
| handoff_summary | planned/missing | auto | Node | n/a |

---

## Core

### workflow_state_writer
1. id: `workflow_state_writer` 2. purpose: persist per-run loop state. 3. current: **auto** (real, committed `workflow-state.js`). 4. desired: auto. 5. trigger: run init + every transition/verdict. 6. inputs: runId, workflowId, patches, verdicts. 7. outputs: `runs/<id>/workflow-state.json` (atomic), `reviewer-verdicts.ndjson`, decision-log lines. 8. state fields: all 19 schema fields. 9. gates: none (lib); callers gate writes. 10. executor: Node. 11. failure modes: disk error, bad transition. 12. repair: atomic tmp+rename (no partial); `transitionStage` rejects illegal. 13. tests: `--self-test` 14/14. 14. DISABLED: lib ungated. 15. next slice: none (done).

### loop_conductor
1. `loop_conductor` 2. orchestrate select→init→memory→advance + helpers. 3. **kickoff (partial)** — `startRun` auto; rest helper-only; no driver. 4. auto driver. 5. `--run`. 6. goal. 7. run state + first directive. 8. status/current_stage/next_action. 9. `--run` honors DISABLED. 10. Node. 11. host fails to follow handoff; no driver to advance. 12. n/a yet. 13. conductor `--self-test` 12/12. 14. `--run` no-op under DISABLED. 15. next slice: a `step(runId)` that computes + (optionally) executes the next conductor-side action.

### transition_model
1. `transition_model` 2. legal state-machine. 3. **auto** (`ALLOWED` enforced in `transitionStage`). 4. auto. 5. every transition. 6. from-status + to. 7. accept/reject. 8. status, stages_completed. 9. `force` bypass (escape hatch). 10. Node. 11. illegal `to` with force persists invalid status. 12. reject illegal unless force. 13. covered by writer self-test. 14. n/a. 15. validate `to ∈ states` even on force (N2 from review).

### verdict_log
1. `verdict_log` 2. append-only reviewer verdicts. 3. **auto-when-called** (`appendVerdict`). 4. auto. 5. on any verdict. 6. verdict object. 7. `reviewer-verdicts.ndjson` + mirror in state. 8. reviewer_verdicts[]. 9. none. 10. Node. 11. unbounded growth (state mirror). 12. n/a. 13. asserted in self-tests. 14. n/a. 15. cap/summarize old verdicts (state bloat, doc open Q).

### decision_log
1. `decision_log` 2. append-only state-transition audit. 3. **auto** (`transitionStage`). 4. auto. 5. every transition. 6. from/to/reason. 7. `runs/<id>/decision-log.ndjson`. 8. n/a. 9. none. 10. Node. 11. none material. 12. n/a. 13. self-test checks file exists. 14. n/a. 15. none.

## Memory

### mem_read_facts
1. `mem_read_facts` 2. manual structured-fact read. 3. **helper-only (manual CLI)** — NOT in loop. 4. adapter (callable by conductor). 5. n/a today. 6. tags/mention/tier. 7. fact list. 8. memory_behavior. 9. none. 10. Node `read-facts.js`. 11. missing file → []. 12. n/a. 13. `--self-test` 10/10. 14. ungated. 15. none (conductor uses search-memory instead).

### mem_search
1. `mem_search` 2. structured-fact search. 3. **auto in --run (before-plan only)** — `startRun` calls `searchStructuredFacts`. 4. auto. 5. before planning. 6. goal terms. 7. active facts → `memory_behavior`. 8. facts_read_count, active_facts_used. 9. none. 10. Node `search-memory.js`. 11. empty store → 0. 12. n/a. 13. search-memory `--self-test` 13/13. 14. lib ungated; `--run` gated. 15. add "during/after" hooks.

### mem_propose_candidates
1. `mem_propose_candidates` 2. report-only fact candidates. 3. **helper-only (manual)** — not called by loop. 4. auto after-verify. 5. after verification. 6. candidate records. 7. report (never appends). 8. capture_candidates. 9. report-only. 10. Node `propose-fact-candidates.js`. 11. invalid → status. 12. n/a. 13. `--self-test` 8/8. 14. ungated. 15. call it from the verification stage (report into state).

### mem_capture
1. `mem_capture` 2. explicit fact WRITE. 3. **helper-only (manual)** — human-run only. 4. human-gated (never auto). 5. after human review. 6. fact JSON. 7. append `facts.ndjson`. 8. captured_fact_ids. 9. human review required. 10. Node `capture-fact.js`. 11. poisoning/hash reject. 12. reject, no write. 13. `--self-test` 11/11. 14. ungated lib. 15. keep manual; never wire to auto.

### mem_dream
1. `mem_dream` 2. recent-run consolidation. 3. **auto (`--dream`)**, report-only. 4. auto. 5. on `--dream` (and post-run later). 6. recent run states. 7. improvement candidates report. 8. n/a (reads). 9. report-only, never auto-apply. 10. Node `dreamFromRecentRuns`. 11. no runs → empty. 12. n/a. 13. conductor self-test (report-only). 14. read-only. 15. optionally auto-run at end of `--run`.

## Planning

### plan_ce
1. `plan_ce` 2. author the plan. 3. **directive-only** (host `/ce-plan`; no code invokes). 4. host handoff. 5. planning. 6. goal+context. 7. `plan.md`. 8. current_stage. 9. NO_GATE. 10. host model. 11. host skips. 12. n/a. 13. none (host). 14. n/a. 15. define plan.md contract + path the conductor checks for.

### plan_superpowers
1. `plan_superpowers` 2. TDD-first plan discipline. 3. **directive-only / unrouted** (`superpowers_enabled:false`). 4. optional. 5. planning. 6. plan. 7. tightened plan. 8. n/a. 9. forensics before enable. 10. host `/superpowers:writing-plans`. 11. not enabled → absent. 12. n/a. 13. none. 14. n/a. 15. decide route-on flag later.

### plan_grill_me
1. `plan_grill_me` 2. adversarial decision-tree on plan. 3. **directive-only** (host `/grill-me`, quarantined). 4. optional auto-on-risk. 5. plan hardening. 6. plan. 7. gap questions. 8. n/a. 9. none. 10. host. 11. host skips. 12. n/a. 13. none. 14. n/a. 15. risk-trigger criteria.

## Adversarial review

### codex_review
1. `codex_review` 2. external adversarial plan review. 3. **helper-only — NOT in loop** (`runCodexReview` exists, gated, but **no command path calls it**). 4. auto (gated). 5. plan_review (before implementation). 6. `plan.md`. 7. verdict → appendVerdict. 8. reviewer_verdicts. 9. **double-gated: DISABLED + ASK_BEFORE_EXTERNAL** (`allowExternal`). 10. `codex` CLI via Node. 11. timeout (xhigh slow, ~obs >2min), auth, no plan.md. 12. returns error; no retry. 13. gate-refusal asserted in self-test; live path untested. 14. blocked under DISABLED. 15. add `--run-codex --allow-codex` CLI that fires it past both gates.

### codex_verdict_parser
1. `codex_verdict_parser` 2. extract PASS/REJECT. 3. **helper-only** (regex on `--output-last-message`). 4. auto. 5. after codex run. 6. agent final message. 7. PASS/REJECT/WARN. 8. verdict. 9. n/a. 10. Node. 11. ambiguous output → WARN. 12. WARN ≠ pass (no advance). 13. **not unit-tested on real output** (live call timed out). 14. n/a. 15. test against a captured real codex message fixture.

### codex_timeout_retry
1. `codex_timeout_retry` 2. bound the external call. 3. **partial** — 240s timeout, **no retry**. 4. bounded retry (≤1). 5. codex run. 6. timeoutMs. 7. error on timeout. 8. n/a. 9. n/a. 10. Node `execFileSync` timeout. 11. slow model → timeout error. 12. none (fails). 13. none. 14. n/a. 15. add 1 retry + clearer "slow/timeout" status; consider lower reasoning effort.

## Implementation

### impl_ce_work
1. `impl_ce_work` 2. write the code. 3. **directive-only** (host `/ce-work`). 4. host handoff. 5. implementation (after codex PASS). 6. plan + facts. 7. scoped diff. 8. current_stage. 9. **ASK_BEFORE_WRITE** (advisory; hooks dormant). 10. host model. 11. scope expansion. 12. ponytail expansion gate (helper). 13. none (host). 14. n/a. 15. record files/lines changed into state so ponytail_budget can read them.

## Ponytail

### ponytail_budget
1. `ponytail_budget` 2. file/line budget verdict. 3. **helper-only** (`ponytailBudgetCheck` arithmetic) — not auto-called in `--run`. 4. auto-on-write. 5. during writing. 6. {files,lines} + budget. 7. PASS/BLOCK_EXPANSION + gate. 8. budget. 9. ASK_BEFORE_EXPANSION when over. 10. Node. 11. caller forgets to pass real counts. 12. block expansion. 13. self-test (over/under). 14. n/a. 15. feed real diff counts; call on the write stage.

### ponytail_review_skill
1. `ponytail_review_skill` 2. real compactness review. 3. **MISSING** — `/ponytail-review` is **never invoked** (only arithmetic exists). 4. auto-on-write. 5. during/after writing. 6. diff. 7. shrink findings. 8. reviewer_verdicts. 9. none (read-only review). 10. host `/ponytail-review`. 11. host skips. 12. n/a. 13. none. 14. n/a. 15. directive + a record-verdict path for `ponytail_review` (host-run).

### ponytail_always_on
1. `ponytail_always_on` 2. enforce compactness on every write. 3. **planned/missing** (no enforcement; hooks dormant). 4. enforced. 5. every write. 6. diff. 7. allow/expansion-gate. 8. budget. 9. ASK_BEFORE_EXPANSION. 10. host+Node. 11. silent over-budget writes. 12. gate. 13. none. 14. n/a. 15. wire budget check into the write directive as a required pre-step.

## QA / review

### qa_self_tests
1. `qa_self_tests` 2. per-module checks. 3. **auto (manual run in dev loop)** — not auto in `--run`. 4. auto-in-verify. 5. verification. 6. module. 7. PASS/FAIL. 8. attempt_counters. 9. none. 10. Node `--self-test`. 11. assertion fail. 12. → repair_loop (when wired). 13. self. 14. ungated (temp). 15. conductor runs the relevant `--self-test` at verification.

### qa_evals
1. `qa_evals` 2. regression suite. 3. **exists, DISABLED-gated** — not in loop. 4. auto-in-verify. 5. verification. 6. `--run-id`. 7. all_pass envelope. 8. n/a. 9. none. 10. Node `run-evals.js`. 11. baseline drift. 12. → repair_loop. 13. self (eval suite). 14. **DISABLED → exits 0, no run**. 15. call at verification when not DISABLED; report gated.

### review_ce_code
1. `review_ce_code` 2. correctness/quality review. 3. **directive-only** (`/ce-code-review`). 4. host handoff. 5. final_review. 6. diff. 7. findings → verdict. 8. reviewer_verdicts. 9. none. 10. host. 11. host skips. 12. → repair_loop. 13. none. 14. n/a. 15. record-verdict path for `ce_code_review`.

### review_ce_simplify
1. `review_ce_simplify` 2. reuse/simplify. 3. **directive-only** (`/ce-simplify-code`). 4. optional. 5. final_review. 6. diff. 7. simplify findings. 8. n/a. 9. none. 10. host. 11. skips. 12. n/a. 13. none. 14. n/a. 15. optional verdict path.

### review_ce_debug_proof_browser
1. `review_ce_debug_proof_browser` 2. debug / test / browser QA. 3. **directive-only** (`/ce-debug`, `/ce-proof`, `/ce-test-browser`). 4. optional per workflow. 5. debug/QA. 6. error/UI. 7. fix/result. 8. n/a. 9. ASK_BEFORE_EXTERNAL (browser/network). 10. host. 11. env-specific. 12. → repair_loop. 13. none. 14. n/a. 15. wire per ui/backend workflows only.

### review_security
1. `review_security` 2. security/forensics. 3. **directive-only** (CE personas + `repo-forensics`). 4. auto-on-trigger. 5. security-sensitive stage. 6. diff/integration. 7. findings/verdict. 8. reviewer_verdicts + kill_criteria. 9. forensics offline; non-clean → hard stop. 10. host + `repo-forensics`. 11. skipped. 12. → NEEDS_USER (no auto-loop past security). 13. none. 14. forensics offline mode. 15. trigger on sensitive_paths; record verdict.

## Repair

### repair_loop
1. `repair_loop` 2. fix→re-review cycle. 3. **partial (transition only)** — `recordVerdict` moves to `repair_loop`; nothing drives the re-do. 4. auto. 5. on REJECT/fail. 6. reject verdict. 7. status=repair_loop. 8. status, attempt_counters. 9. NO_GATE. 10. Node + host. 11. infinite loop. 12. bounded by max_repair_loops (NOT enforced yet). 13. REJECT→repair_loop self-test. 14. n/a. 15. increment counter on entry.

### max_repair_loops
1. `max_repair_loops` 2. cap repair cycles. 3. **field only, NOT enforced** (`budget.max_repair_loops` exists; no counter increment, no check). 4. enforced. 5. on each repair entry. 6. counter vs cap. 7. continue or escalate. 8. attempt_counters.repair_loops_used. 9. NO_GATE. 10. Node. 11. never increments → no cap. 12. → escalation. 13. none. 14. n/a. 15. increment in `recordVerdict` on repair; compare to cap.

### escalation
1. `escalation` 2. stop + hand to human on exhaustion. 3. **missing**. 4. auto-on-exhaust. 5. when cap hit / security block. 6. counters. 7. status=escalated/NEEDS_USER + next_action. 8. status, next_action. 9. human gate. 10. Node. 11. silent spin. 12. terminal escalate. 13. none. 14. n/a. 15. when repair_loops_used ≥ cap → transition escalated + next_action.

## Plugins

### cap_registry
1. `cap_registry` 2. capability inventory. 3. **exists (advisory)** — `config/capability-registry.json` (do not edit this batch). 4. source-of-truth. 5. plugin check. 6. n/a. 7. capability rows. 8. n/a. 9. n/a. 10. JSON. 11. stale versions. 12. n/a. 13. n/a. 14. read-only. 15. (out of scope — held).

### plugin_drift_check
1. `plugin_drift_check` 2. report version/scan drift. 3. **auto (`--check-plugins`)**, report-only. 4. auto + ~2-day due. 5. on demand + due. 6. registry. 7. drift + review_needed + due. 8. n/a (writes `runs/.plugin-check.json`). 9. report-only. 10. Node `checkPlugins`. 11. registry missing → empty. 12. n/a. 13. conductor self-test (report-only). 14. read-only. 15. surface a one-line due summary inside `--run`.

### plugin_update_gates
1. `plugin_update_gates` 2. gate enable/install of updates. 3. **planned/missing** (no install/enable path; by design report-only). 4. human-gated (forensics + approval). 5. when drift found. 6. candidate update. 7. gated proposal. 8. n/a. 9. forensics + ASK_BEFORE_* + explicit approval. 10. host + `repo-forensics`. 11. risky auto-install (FORBIDDEN). 12. block. 13. none. 14. n/a. 15. keep report-only; gate is a doc/process, never auto-install.

## Finalization

### finalize_commit
1. `finalize_commit` 2. commit green work. 3. **manual (guarded)** — me, staged-explicitly, after review+QA+ponytail. 4. gated auto (later). 5. after all green. 6. file list. 7. local commit. 8. n/a. 9. ASK_BEFORE_PUBLISH-adjacent; commit only after gates. 10. me/host git. 11. wrong files staged. 12. guard: count + exclude registry → reset. 13. n/a. 14. n/a. 15. keep human-initiated for now.

### publish_push_gate
1. `publish_push_gate` 2. block push/publish without approval. 3. **policy-only (no code)** — never pushed; no remote. 4. enforced gate. 5. on push attempt. 6. n/a. 7. block. 8. n/a. 9. **ASK_BEFORE_PUBLISH**. 10. n/a (manual). 11. accidental push. 12. block. 13. n/a. 14. n/a. 15. keep as hard policy; no auto-push ever.

### handoff_summary
1. `handoff_summary` 2. sanitized run summary / handoff packet. 3. **planned/missing** — `handoff_behavior` fields exist in state but are never populated. 4. auto (end of run). 5. completion. 6. run state + verdicts. 7. sanitized summary (no raw memory). 8. handoff_behavior. 9. private_memory_shared:false. 10. Node. 11. leaks raw state. 12. redact. 13. none. 14. n/a. 15. emit a redacted summary from final state.

---

## Brutal-honesty summary (what is actually in the loop today)

- **Genuinely auto in `--run`:** workflow select → init state (L2) → **memory search (before)** → advance to planning → emit directive → STOP. Plus `--continue` drives **one** real transition (codex PASS/REJECT). That is the entire automated surface.
- **Auto elsewhere:** `--dream` (report), `--check-plugins` (report + due).
- **NOT in the loop (honest):** Codex (helper, no caller), Ponytail (arithmetic, skill never invoked), all CE skills (directive-only), QA/evals (manual/gated), repair counting + escalation (missing/field-only), memory after/capture (manual), handoff (missing), commit/publish (manual/policy).
- **Method change accepted:** each component above needs its own contract + work-state before more automation. M0 = this inventory. No code changed; `capability-registry.json` untouched; nothing pushed.
