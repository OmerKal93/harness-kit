# Component Contract — `codex_timeout_retry`

> M5 contract; **W7: extracted to a generic timeout + bounded-retry wrapper (`runWithTimeoutRetry`),
> fixture-tested, and put on the gated path (`runCodexReview` reuses it).** Grounded in committed
> `scripts/loop-conductor.js#runWithTimeoutRetry`. **Brutally honest: the wrapper is exercised only over
> LOCAL fake-command fixtures — it has NEVER run against real Codex (the parent is still gated/unfired), and
> it retries ONLY on timeout (≤1).** A **reliability** sub-component of `codex_review`, not a planner. It
> invokes NO Codex/model/network itself.

## 1. component_id
`codex_timeout_retry`. Reliability sub-component of `codex_review` (separate from `codex_verdict_parser`).

## 2. Purpose
Bound the external Codex call so it cannot hang the loop — and (desired) recover transient slowness with
at most one retry.

## 3. Interface
**Wired (W7):** `runWithTimeoutRetry({ command, args, timeoutMs=240000, maxRetries=1, runId?, root? }) →
{ ok, outcome, attempts, ... }`. `outcome`: `success` (exit 0 in time) · `fail` (non-zero exit, `exit_code`,
**no retry**) · `timeout` (killed; retried ≤ `maxRetries`, then `retries_exhausted`) · `error` (spawn/missing
command or `no_command`) · `skipped` (DISABLED). **Retries ONLY on timeout**, hard-capped at
`CODEX_RETRY_MAX = 1`. The `command` is INJECTED — the wrapper NEVER defaults to `codex`. When `runId` is
given it writes ONE `codex_timeout_retry_check` decision-log event. The gated `runCodexReview` now calls it
(`command:'codex'`) so the bound lives on the Codex path — but that path is still unfired. Report-only CLI:
`/harness-loop --run --check-codex-timeout-retry --fixture success|nonzero|sleep|malformed|missing`.

## 4. Inputs
`opts.timeoutMs` (default 240000); the spawned Codex process.

## 5. Outputs
A report-only outcome object (above). On a non-zero exit / timeout / spawn error it is **never** reported as
`success` (no unsafe PASS). Optional `codex_timeout_retry_check` decision-log event (`report_only:true`,
`no_codex_invoked:true`) when `runId` is supplied. **Writes no reviewer verdict; performs no transition.**

## 6. State fields touched
None directly — the error/verdict it gates flows through `codex_review`.

## 7. Gates
None of its own (parent `codex_review` is gated). `ASK_BEFORE_EXTERNAL` already covered the cost decision
upstream — a bounded retry must not silently re-spend past that approval.

## 8. Executor
`node:scripts/loop-conductor.js` (`execFileSync` timeout in `runCodexReview`).

## 9. Invocation contract (external components only)
Bounds the `codex exec ...` call defined in `codex_review.md` §9. The 2-min Bash tool cap was observed to
trip before the 240s timeout during a live `xhigh` review.

## 10. Failure modes
- **Bounded retry only on timeout** (≤1); a non-zero exit or spawn error is a hard outcome with **no retry**
  (cannot mask a real failure as transient).
- Timeout too low for `xhigh` reasoning → chronic `timeout` outcomes (consider lower reasoning effort).
- The retry doubles cost in the worst case — capped at `1` and within the existing external approval; the
  wrapper itself spends nothing (it only spawns the injected command, never Codex).
- **Content-agnostic:** an exit-0 with malformed output is `success` here — judging output is
  `codex_verdict_parser`'s job, not this wrapper's.

## 11. Repair behavior
Report-only — the wrapper itself drives no transition and no `repair_loop` admission. On timeout it retries
once internally, then returns a `timeout` outcome; the caller (`runCodexReview`) maps a non-`success`
outcome to `codex_invocation_failed` and the run stays at `plan_review` (no advance).

## 12. Acceptance tests
- **Exists (W7):** conductor `--self-test` over `evals/fixtures/codex-timeout/` — `success.js`→`success`(1
  attempt); `nonzero.js`→`fail`(exit 3, no retry); `sleep.js`→`timeout` (killed; `maxRetries:1`→2 attempts
  exhausted; `maxRetries:0`→1 attempt); missing path→`error`; no command→`error`(never defaults to codex);
  `malformed.js`→`success` (content-agnostic); decision-log event written w/ `runId`; **no transition / no
  repair admission / no verdict**; DISABLED→`skipped` (no command run).
- **Still needed:** validation against a real (gated, approved) slow Codex call — never exercised.

## 13. DISABLED behavior
The wrapper returns `skipped` and **runs no command** under the kill switch (and writes no decision-log) —
consistent with the other guards. (The parent `runCodexReview` is also blocked before the spawn.)

## 14. Work-state
- **current:** `wired` (W7) — `runWithTimeoutRetry` is a real, exported, fixture-tested timeout + bounded
  retry over an injected command; distinguishes `success`/`fail`/`timeout`/`error`/`skipped`; reachable via
  `/harness-loop --run --check-codex-timeout-retry`; reused by the gated `runCodexReview`.
- **desired:** `bounded_retry` validated end-to-end against real Codex.
- **Honest gap:** fixtures are **local fakes** — the wrapper has **never run against real Codex** (the parent
  is gated and unfired, so no command path spawns `codex`); it retries **only** on timeout (≤1), and a
  `timeout` outcome is still surfaced to the caller as a generic `codex_invocation_failed`.

## External-pattern enforcement (contract/policy inputs only — NOT adopted code)
> Reliability framing reinforced by the staged-pipeline pattern (`OpenMontage`) — pattern only, not adopted.
- **Pipeline/checkpoint planning:** the external call is one **stage** in a staged pipeline; its timeout/
  retry behavior is a **review checkpoint's** reliability boundary, with cost/logging surfaced — not an
  unbounded external dependency. Any retry stays bounded and logged (cost-aware), consistent with the
  external/data gate the plan already declared.

## 15. Smallest next slice
Surface the `timeout` outcome distinctly to the caller (a `slow`/`timeout` status instead of a generic
`codex_invocation_failed`), and validate the retry against one real (gated, approved) slow Codex call.
Named here; **not implemented in W7.**
