# Security Broker Architecture Report — Batch 1, Lane P4 (Security Brokers — Core)

Branch: `hk/p4-security-brokers` · Worktree: `<worktree-dir>/p4-security-brokers` · Base commit:
`f03525a`. Scope per `evidence/WORKTREE_FILE_OWNERSHIP_MATRIX.md`: broker modules
(`scripts/security-brokers/*.js`), the static conformance eval, and migration of the 2
already-wired `security-boundary.js` call sites. This lane does **not** own the other 4 boundary
call sites (ingestion, context-transfer, evidence-persist, remote-action) — see "Division of labor"
below.

## Why this design, not the original one

An earlier design's acceptance test was "deliberately attempt a bypass and confirm it's caught." A
prior review correctly flagged that as untestable here: this is a plain JS/CLI codebase with no
in-process interposition layer (no middleware chain, no import hook, no runtime instrumentation
that every module passes through involuntarily). A script that simply never calls the broker is
invisible at runtime — nothing can force it through a gate it never approaches. Chasing that test
would have meant either faking a pass (asserting behavior the harness can't actually guarantee) or
building a much heavier interception layer than this mandate calls for.

The corrected design replaces one unfalsifiable runtime test with three independently real,
independently checkable mechanisms:

### Mechanism 1 — Static boundary-conformance eval

A grep-shaped-but-path-resolution-aware static check (`scripts/check-broker-conformance.js`) that
walks every `.js` file in the repo and fails if any file **outside** `scripts/security-brokers/`
directly `require()`s `scripts/security-boundary.js`. This turns "did this code go through the
broker layer" into a mechanical fact about the require graph, checkable in under 150ms, not a
convention someone has to remember.

**Scope decision, disclosed explicitly:** this checks `security-boundary.js`'s own require graph
only — not `scripts/redact.js`. `redact.js` is a lower-level utility with several pre-existing,
legitimate direct callers unrelated to the 6 trust-boundary scan points (e.g.
`execute-workflow.js`'s own tool-output redaction, `detect-context-drift.js`,
`propose-fact-candidates.js`). Broadening the rule to cover `redact.js` would flag pre-existing
code this lane does not own and was never asked to touch — exactly the ownership-boundary ambiguity
`WORKTREE_FILE_OWNERSHIP_MATRIX.md`'s "division of labor" note warns against. Likewise, this does
**not** statically grep for "invokes git commit/push primitives" as a separate rule — that
enforcement lives in Mechanism 2 below, which is a strictly stronger guarantee (it verifies the
actual content about to be committed carries a broker-minted token) than pattern-matching
`execFileSync('git', ['commit', ...])` call sites across an evolving codebase.

### Mechanism 2 — Provenance tokens

Every broker wrapper in `scripts/security-brokers/` stamps a token on the content it scans:
`{ contentHash, scannedAt, clean, findingCount, sig }`, where `sig` is an HMAC-SHA256 over the other
four fields, keyed by a random secret generated once per process
(`scripts/security-brokers/provenance-token.js`). A downstream gate calls `verifyToken(content,
token)`, which fails closed (`{valid:false, reason}`) if the token is missing, malformed, minted
for different content (`content_mismatch` — catches TOCTOU-style substitution between scan and
gate), or has a tampered field (`invalid_signature` — catches e.g. someone flipping `clean:false` →
`true` without re-signing). `scripts/execute-workflow.js#handlePrepareCommit` now requires a valid
token before accepting the staged diff as scanned, in addition to (not instead of) the existing
`scan.clean` check.

**Disclosed threat model:** this is cooperative-only, single-process. The signing secret is
generated fresh per process and never persisted or exported — a token minted in one process run
verifies only within that same run. It does not need to survive across processes: nothing in this
codebase asks a token to outlive one `execute-workflow.js` invocation. What it does catch: a future
refactor that quietly stops calling the broker (no token to present → rejected), and content
substituted between the scan and the gate (hash mismatch → rejected). What it does not catch: a
determined attacker with code-execution rights forging a token by reading `PROCESS_SECRET` out of
the same process's memory — no in-process mechanism can defend against that, and none claims to.

### Mechanism 3 — Disclosed cooperative-only scope

Both mechanisms above bind cooperating code paths only. This repo has no OS/host-level interception
(no sandboxing, no seccomp-style syscall filtering, no forced-through-a-proxy execution model), and
a standing project constraint (the Assistant Execution Freeze / A2 workflow-scoped-enforcement
policy referenced elsewhere in this program) keeps host-level enforcement explicitly out of scope.
Stated plainly rather than implied: **a script that is never invoked through `execute-workflow.js`,
or that is invoked but never calls a broker module, is not caught by anything built in this lane.**
This is the honest tradeoff Mechanism 1 (static, whole-repo) and Mechanism 2 (runtime, per-call)
were chosen to cover as much of as is realistically checkable in a plain-JS codebase, not a claim
that bypass is impossible.

## Files and modules built

```
scripts/security-brokers/
  provenance-token.js         Mechanism 2 primitive: mintToken / verifyToken / contentHash
  commit-broker.js             wraps scanBeforeCommit           — REAL, wired (handlePrepareCommit)
  tool-output-broker.js        wraps scanAfterToolOutput        — REAL, wired (handleDeterministicVerify)
  ingestion-broker.js          wraps scanBeforeIngestion        — real wrapper, UNWIRED (GBrain runtime lane)
  context-transfer-broker.js   wraps scanBeforeContextTransfer  — real wrapper, UNWIRED (Dispatcher lane)
  evidence-persist-broker.js   wraps scanBeforeEvidencePersist  — real wrapper, UNWIRED (GBrain runtime lane)
  remote-action-broker.js      wraps scanBeforeRemoteAction     — real wrapper, UNWIRED (deferred to release phase)
  index.js                     barrel re-export of all 6 + provenance-token, convenience only

scripts/check-broker-conformance.js   Mechanism 1: static require-graph conformance eval
```

Every broker module (including the 4 unwired ones) is a real, working, self-tested wrapper — not a
placeholder. "Unwired" means no current call site in this lane's own files, not "not implemented."
Each is a thin pass-through to its `security-boundary.js` counterpart plus a `mintToken` call; no
detection logic is duplicated anywhere.

`scripts/execute-workflow.js` changes (the only file this lane modified outside the new directory):

- Replaced `const { scanBeforeCommit, scanAfterToolOutput } = require('./security-boundary.js');`
  with `require('./security-brokers/commit-broker.js')`,
  `require('./security-brokers/tool-output-broker.js')`, and
  `require('./security-brokers/provenance-token.js')` (for `verifyToken`).
- `handleDeterministicVerify`: both `scanAfterToolOutput(tail)` call sites now call
  `toolOutputBroker.scanAfterToolOutput(tail)`. No other logic changed.
- `handlePrepareCommit`: `scanBeforeCommit(diff)` now calls `commitBroker.scanBeforeCommit(diff)`.
  One new check inserted immediately after (`verifyToken(diff, scan.token)`) — if invalid, the
  commit is blocked and unstaged with `outputs.token_check` reporting why, *before* the existing
  `!scan.clean` check runs. This is additive: the pre-existing clean/dirty blocking behavior is
  unchanged, byte-for-byte, for every case where the token is valid (which is every case in the
  current, real call graph, since `handlePrepareCommit` always calls the broker itself with the
  same `diff` variable it then verifies).
- Two new self-test blocks added to `execute-workflow.js`'s own `selfTest()`:
  `forged_or_mismatched_token_blocks_commit_even_though_content_is_clean` and
  `restoring_the_real_broker_lets_the_same_clean_content_commit_normally` (see below).

## Division of labor (restated from the ownership matrix, for this doc's own completeness)

| Boundary | Broker module | Wired by | Status |
|---|---|---|---|
| (1) before ingestion | `ingestion-broker.js` | GBrain runtime (`hk/p7b-gbrain-runtime`) | built, unwired |
| (2) before context transfer | `context-transfer-broker.js` | Dispatcher (`hk/p8c-agent-dispatch`) | built, unwired |
| (3) after tool output | `tool-output-broker.js` | **this lane** | built, wired |
| (4) before evidence persist | `evidence-persist-broker.js` | GBrain runtime (`hk/p7b-gbrain-runtime`) | built, unwired |
| (5) before commit | `commit-broker.js` | **this lane** | built, wired |
| (6) before remote action | `remote-action-broker.js` | deferred to release phase — no push/PR/export tooling exists yet | built, unwired |

## Test results (real output, this session)

### Individual broker module self-tests (7 modules)

```
provenance-token.js          — 11/11 PASS  (self-test: ALL PASS)
commit-broker.js             — 5/5 PASS    (self-test: ALL PASS)
tool-output-broker.js        — 3/3 PASS    (self-test: ALL PASS)
ingestion-broker.js          — 2/2 PASS    (self-test: ALL PASS)
context-transfer-broker.js   — 2/2 PASS    (self-test: ALL PASS)
evidence-persist-broker.js   — 2/2 PASS    (self-test: ALL PASS)
remote-action-broker.js      — 3/3 PASS    (self-test: ALL PASS)
scripts/security-brokers/index.js --self-test  →  security-brokers/index.js self-test: ALL MODULES PASS
```

Key assertions covered (provenance-token.js): round-trip valid for unchanged content; a dirty scan
result still carries a valid (non-forged) token; content substituted after minting is rejected
(`content_mismatch`); a tampered `clean` flag without re-signing is rejected (`invalid_signature`);
missing/malformed tokens are rejected, never treated as an implicit pass; a token never verifies
against unrelated content.

### Mechanism 1 — the conformance-eval self-test (fixture-based, decoupled from real repo state)

```
PASS  self-test:clean_fixture_passes
PASS  self-test:disallowed_require_is_detected
PASS  self-test:removing_the_disallowed_require_restores_a_pass
PASS  self-test:nested_relative_require_detected
PASS  self-test:broker_dir_and_self_reference_are_exempt
self-test: ALL PASS
```

### Mechanism 1 — the real-repo demonstration (not just asserted — actually run, both directions)

**Failing case** — after migration was already complete (baseline PASS), a disallowed direct
`require('./security-boundary.js')` was appended to the real `scripts/redact.js` (a file this lane
does not own) as a deliberate test-of-the-test:

```
=== STEP 1: baseline PASS on real repo (current, migrated state) ===
PASS  broker-conformance: no disallowed direct requires of security-boundary.js found outside scripts/security-brokers/
exit=0

=== STEP 2: deliberately inject a disallowed direct require into a REAL, non-broker file ===
--- injected line: ---
// TEMPORARY TEST-OF-THE-TEST INJECTION -- proves the conformance eval actually fails
const sb_bypass_test = require('./security-boundary.js');

=== STEP 3: run the conformance eval again -- must now FAIL and cite the exact file/line ===
FAIL  broker-conformance: found 1 disallowed direct require(s) of security-boundary.js outside scripts/security-brokers/:
  <worktree-dir>/p4-security-brokers/scripts\redact.js:125  const sb_bypass_test = require('./security-boundary.js');
exit=1
```

**Passing case** — the injected line was removed and the original file restored:

```
=== STEP 4: remove the injected disallowed require, restore the real file ===
(git diff --stat / git status --short scripts/redact.js  →  empty: file byte-identical to HEAD)

=== STEP 5: run the conformance eval again -- must PASS again (not a one-way/stuck detector) ===
PASS  broker-conformance: no disallowed direct requires of security-boundary.js found outside scripts/security-brokers/
exit=0
```

`git status --short` after the restore confirmed `scripts/redact.js` was untouched (byte-identical
to HEAD) — the injection-and-revert left no trace in the working tree.

One real bug was found and fixed while building this proof: the conformance eval's own self-test
builds synthetic fixture files whose *contents* are string literals like
`"require('./security-boundary.js')"` written as test data. A naive line-based regex scan, when
first run in `--self-test`, flagged the checker's own source file (`check-broker-conformance.js`)
because those fixture-building strings look, textually, like real require calls. Fixed by exempting
the checker's own file path from the scan (documented inline in the file) — every other file in the
repo is still checked at full strictness; this exemption is structural (the one file guaranteed to
contain such literals as legitimate self-test fixtures), not a loophole.

### Mechanism 2 — provenance-token gate, end-to-end through the real integration point

Two new self-tests added to `execute-workflow.js`'s own suite (not a separate ad-hoc script):

```
PASS  self-test:forged_or_mismatched_token_blocks_commit_even_though_content_is_clean
      ({"result":{"status":"blocked","outputs":{"reason":"security-broker provenance check failed
      (content_mismatch) -- staged diff could not be verified as having gone through the commit
      broker's scan -- commit refused","token_check":{"valid":false,"reason":"content_mismatch"}}},
      "shaBefore":"26f29cf...","shaAfter":"26f29cf..."})
PASS  self-test:restoring_the_real_broker_lets_the_same_clean_content_commit_normally
      ({"status":"completed","outputs":{"commit_sha":"cf33ba2...", ...}})
```

The first test temporarily monkey-patches `commitBroker.scanBeforeCommit` (restored in a `finally`
block) to return a token minted for unrelated content — simulating a broker call whose result was
substituted, reused stale, or never actually ran against the real diff. `handlePrepareCommit`
blocks it (`status: 'blocked'`, HEAD SHA unchanged — no commit created) even though the underlying
content itself was clean, proving the token gate is a real, independent check, not redundant with
the `!scan.clean` check. The second test proves the patch didn't leave anything broken: with the
real broker restored, the identical clean content commits normally.

### All 8 of this repo's self-test suites (`HARNESS_ROOT` = this worktree)

```
node scripts/security-boundary.js --self-test       → self-test: ALL PASS   exit=0
node scripts/verification-classifier.js --self-test → self-test: ALL PASS   exit=0
node scripts/execute-workflow.js --self-test         → self-test: ALL PASS   exit=0
node scripts/langgraph-workflow.js --self-test       → self-test: ALL PASS   exit=0
node bin/harnesskit.js --self-test                   → self-test: ALL PASS   exit=0
node scripts/doctor.js --self-test                   → self-test: ALL PASS   exit=0
node scripts/content-provenance.js --self-test       → self-test: ALL PASS   exit=0
node scripts/task-discovery.js --self-test           → self-test: ALL PASS   exit=0
```

No pre-existing self-test regressed, including every prepare-commit and deterministic-verify
security-boundary test already in `execute-workflow.js` (secret-in-diff blocks the commit;
secret-in-tool-output gets redacted before persisting; the large-diff/`ENOBUFS` fail-closed path;
idempotent-replay-vs-genuinely-different-run detection).

**Environment note, disclosed:** this worktree had no `node_modules` at all when this session
started (a `git worktree add` does not install dependencies) — `langgraph-workflow.js` and
`bin/harnesskit.js` both failed with `Cannot find module '@langchain/langgraph'` on the first run,
unrelated to any code change in this lane. Fixed by creating a filesystem junction
`node_modules → <repo-root>/node_modules` (lockfiles confirmed byte-identical via `diff`
first) rather than duplicating ~hundreds of MB via `npm install`/copy. `node_modules/` is
`.gitignore`d, so the junction is invisible to git and was excluded from the conformance-eval scan
(confirmed: the eval completed in 0.118s, meaning it did not traverse into it).

## Honest completeness assessment

**What this lane finished, fully:**
- All 6 broker wrapper modules built, real (not stubs), self-tested.
- Mechanism 1 (static conformance eval) built, self-tested, and demonstrated live against the real
  repo in both directions (fail → fix → pass).
- Mechanism 2 (provenance tokens) built, self-tested at the primitive level, and wired into the one
  real gate this lane owns (`handlePrepareCommit`), with an end-to-end test proving the gate
  actually rejects a forged/mismatched token.
- The 2 already-wired call sites (`scanBeforeCommit` in `handlePrepareCommit`,
  `scanAfterToolOutput` in `handleDeterministicVerify`) migrated to route through the broker layer,
  with zero behavioral regression on any pre-existing self-test.
- All 8 of this repo's self-test suites pass with `HARNESS_ROOT` set to this worktree.

**What this lane explicitly did NOT do, by design (not an oversight):**
- Did not wire `ingestion-broker.js`, `context-transfer-broker.js`, or `evidence-persist-broker.js`
  into any real call site — those files (`capture-fact.js`, `structured-memory.js`,
  `build-context-pack.js`, a future dispatcher module) belong to other lanes per the ownership
  matrix, and this lane does not have write ownership of them.
- Did not wire `remote-action-broker.js` anywhere — there is no push/PR/export tooling in this
  repo yet to wire it into.
- Did not build any OS/host-level interception (sandboxing, syscall filtering, forced-execution
  proxying) — out of scope per the standing project constraint and Mechanism 3's disclosed scope.
- Did not add a static rule for "invokes git commit/push/memory-write primitives directly" as a
  separate grep-based check — that enforcement is Mechanism 2's job (see Mechanism 1's scope
  section above for the reasoning).

## Known limitations

1. **Cooperative-only enforcement** (see Mechanism 3). A script that never runs through
   `execute-workflow.js`, or that runs but never calls a broker module, is not caught by anything
   built here.
2. **Provenance tokens are single-process.** They intentionally do not survive across process
   boundaries (fresh HMAC secret per process). If a future architecture needs a scan result to be
   trusted across separate process invocations (e.g. a scan performed by one CLI invocation, a gate
   checked by a later, separate one), this exact mechanism will need a different key-management
   story — flagged here rather than silently assumed to already cover that case.
3. **The conformance eval's own self-referential blind spot.** The checker exempts its own source
   file from the scan (see the "one real bug was found" note above). This is a narrow, documented,
   structural exemption — not a general escape hatch — but it is worth an independent reviewer's
   explicit attention rather than being buried in a code comment alone.
4. **Static check covers `security-boundary.js` requires only, not `redact.js`.** A file could
   still call `redact.js`'s primitives directly without ever touching `security-boundary.js` or a
   broker — that was already true before this lane existed, is unrelated to the 6 trust-boundary
   scan points this task governs, and was a deliberate scope decision (see Mechanism 1 above), not
   an unnoticed gap.

## Real overlap risk with `hk/p5a-shared-handlers` — stated plainly, not hidden

Per `evidence/WORKTREE_FILE_OWNERSHIP_MATRIX.md`, the Shared Handlers lane (`hk/p5a-shared-handlers`)
owns `scripts/execute-workflow.js`'s `require()` lines and is extracting handler logic into a new
`scripts/workflow-handlers.js`, in parallel, in a different worktree, off the same base commit
(`f03525a`). This lane's diff to `execute-workflow.js` is real and touches:

- The top-of-file `require()` block (3 lines changed: broker requires replacing the old direct
  `security-boundary.js` require).
- Two call sites inside `handleDeterministicVerify` (function-name change only:
  `scanAfterToolOutput(tail)` → `toolOutputBroker.scanAfterToolOutput(tail)`).
- One new check inside `handlePrepareCommit` (the `verifyToken` block), plus the `scanBeforeCommit`
  call-site rename to `commitBroker.scanBeforeCommit`.
- Two new self-test blocks appended to the file's own `selfTest()` function.

**This is a genuine merge-conflict risk, not a hypothetical one**, if p5a's handler-extraction
touches the same lines (very likely, since p5a's whole job is moving these handler functions
elsewhere). The changes here are deliberately small, additive, and localized (one new
`if (!tokenCheck.valid) { ... }` block, three renamed function calls, one changed require block) —
chosen specifically to minimize surface area for a 3-way merge — but a clean auto-merge is not
guaranteed. Recommended resolution order: **land this lane (P4 core) after p5a's extraction lands**,
per the ownership matrix's own stated dependency (`P4`'s base commit note: "post shared-handler-
extraction (impl)"), and re-apply this lane's 3 call-site edits against whatever
`scripts/workflow-handlers.js` shape p5a produces, rather than merging both independently and
hoping git resolves it. If p5a lands first, this lane's diff should be re-derived against the new
file layout before merging, not merged blindly.

## Recommended independent reviewer

`ce-security-reviewer`, per the ownership matrix's own designation for this lane. Specific things
worth an adversarial pass: (a) the conformance eval's self-exemption (limitation #3 above), (b)
whether the provenance-token's single-process scope is disclosed clearly enough for whoever wires
the 4 remaining broker call sites to not assume more than it guarantees, (c) whether the
`execute-workflow.js` diff is small enough to actually merge cleanly with p5a in practice, not just
in theory.

## Integration order

1. **This lane merges first** among anything that needs to call into the broker modules — GBrain
   runtime (ingestion + evidence-persist) and Dispatcher (context-transfer) both depend on the
   broker modules existing and are later/other lanes per the ownership matrix.
2. **Coordinate explicitly with `hk/p5a-shared-handlers`** before either merges, given the shared-file
   overlap on `scripts/execute-workflow.js` described above — ideally p5a lands first (per the
   ownership matrix's own base-commit note for this lane) and this lane's 3 call-site edits get
   re-applied against the post-extraction file layout.
3. Remote-action wiring stays deferred to whichever future lane builds real push/PR/export tooling.
