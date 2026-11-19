# Component Contract — `codex_verdict_parser`

> M5 contract; **W3: extracted to a pure function `parseCodexVerdict`, hardened, fixture-tested, and put
> on the live path (`runCodexReview` now delegates to it).** Grounded in committed
> `scripts/loop-conductor.js#parseCodexVerdict` + `docs/contracts/codex_review.md` §9. **Brutally honest:
> the 5 fixtures are SYNTHETIC Codex-like samples — the parser is STILL not validated against a captured
> REAL `--output-last-message` (the one live review timed out).** A **reliability** sub-component of
> `codex_review`, not a planner. It records NOTHING itself — callers decide.

## 1. component_id
`codex_verdict_parser`. Reliability sub-component of `codex_review` (separate from `codex_timeout_retry`).

## 2. Purpose
Extract a PASS/REJECT verdict from Codex's **final message file**, mapping anything ambiguous to `WARN`
(treated as not-PASS → no advance).

## 3. Interface
**Pure function (W3):** `parseCodexVerdict(text) → { component: "codex_verdict_parser", verdict, severity,
reasons[], sends_back_to }`. Hardened regex `/VERDICT\s*[:\-—]?\s*(PASS|REJECT|FAIL|WARN|NEEDS_CHANGES)/ig`
applied to the contents of `--output-last-message <file>` (the agent's final message — **not** stdout,
which echoes the prompt's literal `VERDICT:` tokens). **Last match wins** (the verdict is the final line;
also defeats a leading prompt-echo). `FAIL→REJECT`, `NEEDS_CHANGES→WARN`, **no token / ambiguous → `ERROR`
(never PASS)**. `sends_back_to` only passes through an allowlist (`ce_plan`/`ce_work`/`repair_loop`); a
REJECT with no valid target defaults to `ce_plan`; anything else is rejected to `null` + a reason.
**Report-only CLI (W3):** `/harness-loop --run --parse-codex-verdict --file <path>` prints the normalized
object — pure read+parse, no Codex, no spawn, no write. Live caller: `runCodexReview` (gated) maps the
parser's `ERROR` back to `WARN` to keep its existing "ambiguous = no-advance" semantics.

## 4. Inputs
The final-message file written by `codex exec --output-last-message`.

## 5. Outputs
A normalized in-memory object `{ component, verdict (`PASS`/`REJECT`/`WARN`/`ERROR`), severity, reasons[],
sends_back_to }`. **Pure: writes nothing.** `runCodexReview` consumes it to build the `codex_cli` verdict
it appends via `verdict_log`; the `--parse-codex-verdict` CLI just prints it.

## 6. State fields touched
None directly — feeds the verdict object that `verdict_log` appends.

## 7. Gates
None — pure parse. (Its parent `codex_review` is double-gated `DISABLED` + `ASK_BEFORE_EXTERNAL`.)

## 8. Executor
`node:scripts/loop-conductor.js` (inline regex in `runCodexReview`).

## 9. Invocation contract (external components only)
N/A — local parse of a file produced by the external call (the external invocation is `codex_review`'s contract).

## 10. Failure modes
- **Still untested on REAL output** — fixtures are synthetic; the regex's behavior against an actual Codex
  final message remains unverified (the live review timed out).
- No `VERDICT:` token → `ERROR` (parser) → `runCodexReview` maps to `WARN` (safe: no advance).
- Codex phrasing drift beyond the covered separators (`:`/`-`/`—`) and tokens → could miss → `ERROR`/`WARN`
  (fails safe, but a true PASS would be lost). Widen the regex when a real sample breaks it.
- Parsing stdout instead of the file would false-match the echoed prompt — avoided by reading the file and
  by **last-match-wins**.

## 11. Repair behavior
None — the parser is pure and **does not transition state or route to `repair_loop`**. It only proposes a
`sends_back_to` hint (allowlisted/sanitized); the gated `runCodexReview` + `recordVerdict` own any actual
routing. Ambiguous → `ERROR`/`WARN` → no advance, no retry.

## 12. Acceptance tests
- **Exists (W3):** conductor `--self-test` parses 5 committed fixtures under
  `evals/fixtures/codex-verdict/` — `pass.txt`→PASS/info, `reject.txt`→REJECT/high/`ce_plan`,
  `warn.txt` (NEEDS_CHANGES)→WARN/low, `malformed.txt`→ERROR (asserted **never PASS**),
  `invalid-sends-back-to.txt`→`sends_back_to:null` (rejected) — plus empty/`null` input → ERROR.
- **Still needed:** the same fixtures captured from a **real** `--output-last-message` (synthetic today).

## 13. DISABLED behavior
N/A — never reached under `DISABLED` (parent call is blocked).

## 14. Work-state
- **current:** `wired` (W3) — pure `parseCodexVerdict` is hardened, exported, fixture-tested in the
  conductor `--self-test`, reachable via the report-only `--parse-codex-verdict` CLI, and used by
  `runCodexReview`.
- **desired:** `verified` — validated against a captured **real** Codex `--output-last-message`.
- **Honest gap:** fixtures are **synthetic** Codex-like text; the parser is **still never validated on a
  real Codex message**, and its live parent `runCodexReview` is itself unfired (no command path runs Codex).
  The phrasing-drift regex covers common cases only.

## External-pattern enforcement (contract/policy inputs only — NOT adopted code)
> Policy input from `Anthropic-Cybersecurity-Skills`; nothing cloned/installed/run.
- **Security skill packs as review inputs, not trusted authorities:** a Codex/adversarial verdict — and
  any security-skill-pack finding it cites — is an **input** to the human/loop decision, never an
  authority that auto-advances or auto-blocks beyond its recorded verdict. A `PASS` is evidence, not
  proof; a security pack's "clean" is one signal among the required reviewers the plan named.
- **Adoption is gated:** importing any external security skill pack as a reviewer requires
  `new_repo_intake` + repo-forensics + supply-chain/security review first — it is a contract/policy input
  here, **not** an adopted runnable reviewer.

## 15. Smallest next slice
Capture one **real** Codex `--output-last-message` (PASS + REJECT), add it alongside the synthetic
fixtures, and widen the regex if it breaks → advances `wired → verified`. (Requires a gated, approved live
Codex run.) Named here; **not implemented in W3.**
