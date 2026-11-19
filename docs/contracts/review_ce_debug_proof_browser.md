# Component Contract — `review_ce_debug_proof_browser`

> M6 contract. **Brutally honest: `directive-only`, optional per workflow.** `/ce-debug`, `/ce-proof`,
> `/ce-test-browser` are host skills the conductor never invokes. **This is the home of human-like /
> browser verification** (no dedicated `browser_verification` ID — mapped here).

## 1. component_id
`review_ce_debug_proof_browser`. Debug / proof / browser-QA lane; owns **human-like/browser verification**.

## 2. Purpose
Behavioral verification of UI/flow/API changes via host debug/proof/browser skills — exercising the change
like a user, in a **safe** environment, before it is trusted.

## 3. Interface
Host directives: `/ce-debug`, `/ce-proof`, `/ce-test-browser`. Re-entry (desired): a verdict via
`recordVerdict`. **No code invokes them; no record path today.**

## 4. Inputs
The change + the plan's **human-like verification plan** (from `plan_ce`) + the workflow class
(UI/browser/form/API/user-flow → required; pure backend/docs → often N/A).

## 5. Outputs
Behavioral result (repro/fix/UI evidence) → (desired) a recorded verdict in `reviewer-verdicts.ndjson`.

## 6. State fields touched
**Desired:** `reviewer_verdicts[]`. Today: none.

## 7. Gates — human-like/browser verification rules (hard)
`ASK_BEFORE_EXTERNAL` (browser/network). **Human-like/browser verification is REQUIRED for UI / browser /
form / API / user-flow changes**, run on **local/staging where safe**, using **dummy accounts / test data
only** unless an explicit gate clears more. **No real login, submit, payment, publish, customer data,
cookies, auth, social, audio, or scraping/cloning without the relevant gate first** — these all route to
**external/data/privacy gates** before execution:
- **cookie/auth/social/browser/network gated** · **audio/voice privacy gated** · **scraping/cloning
  gated** (allowed local/staging verification ≠ scraping/cloning public sites).
- **design context:** for UI/design work, verify against the project **design context** (DESIGN.md-style);
  do not assert brand/design correctness with no design context.

## 8. Executor
`host:/ce-debug` · `/ce-proof` · `/ce-test-browser` (+ the chrome browser tools, gated).

## 9. Invocation contract (external components only)
Host slash-commands / gated browser MCP — `ASK_BEFORE_EXTERNAL` must clear before any browser/network
action. No programmatic conductor invocation today.

## 10. Failure modes
Env-specific flake; a verification that **touches real accounts/data** without a gate (the dangerous mode
this contract forbids); skipped verification on a UI change → unverified user-facing behavior.

## 11. Repair behavior
A failing behavioral check → **failed QA routes to `repair_loop`**. **Repeated failures respect
`max_repair_loops`** → `escalation`. A gate-blocked real-data action → stop, request the gate (never
proceed).

## 12. Acceptance tests
- **Exists:** none (host, optional).
- **Needed:** wire per ui/backend workflow class + a verdict path; a test that a real-login/submit/payment
  attempt is blocked without the gate.

## 13. DISABLED behavior
N/A (host directive). Browser/network steps additionally blocked unless `ASK_BEFORE_EXTERNAL` clears; under
`DISABLED` the emitting run step is a no-op.

## 14. Work-state
- **current:** `contract_drafted` (code = `directive-only`, optional).
- **desired:** `optional` (wired per UI/backend workflow class).
- **Honest gap:** no human-like/browser verification runs in the loop today; the safety rules above are
  documented policy, not enforced code.

## 15. Smallest next slice
Wire it only for UI/browser/form/API/user-flow workflows, with a verdict path + an enforced "dummy
data/local-staging only unless gated" check. Named here; **not implemented in M6.**
