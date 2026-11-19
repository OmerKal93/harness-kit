# gstack Policy Core — Design, Extraction, and Test Report (Batch 1, Lane p6-policy-core)

Branch: `hk/p6-policy-core` (isolated git worktree at `<worktree-dir>/p6-policy-core`, based on
`f03525a`). Not merged to master. Nothing outside this worktree was written to, per this lane's own
constraint.

## 0. What this is answering

A prior real, evidence-based pass (`docs/plans/GSTACK_CAPABILITY_ANALYSIS.md` and
`docs/plans/GSTACK_SECURITY_ANALYSIS.md`, a separate repo — read but not modified here) already
established, with real evidence: `garrytan/gstack` is pinned at commit
`7c9df1c568a9ea745508f679a329332b2c338063` (GPG-signed, verified), and of its ~19 named components,
exactly three are worth adopting — `careful`, `freeze`, `guard` — small, self-contained Claude Code
`PreToolUse` hooks with genuine code-level `permissionDecision: deny` gates. Its auto-upgrade
mechanism (`GSTACK_AUTO_UPGRADE=1` → unsigned `git fetch && reset --hard origin/main` + arbitrary
script execution) is a confirmed, still-open security defect (GitHub issue #783, finding H7) and is
**permanently rejected** — nothing in this lane imports, calls, or references gstack's upgrade
mechanism in any form.

**Correction inherited from a prior independent review, restated here so it isn't lost:** gstack's
hooks are not "HarnessKit's first enforcement layer." This repo already has real, code-level,
always-enforced workflow-engine gates in `scripts/execute-workflow.js` — `scanBeforeCommit` (blocks a
commit whose staged diff has security findings), `HARD_BLOCK_STATUSES` (blocks on
`REGRESSION_DETECTED`/`FAILED` verification results with no override), and `validateReviewIndependence`
(rejects a fabricated/non-independent reviewer). What was genuinely missing, and is the actual scope
of this lane, is one specific layer below all of that: a **host tool-call-level gate** — a
`PreToolUse` hook that fires before the host (Claude Code, or another host with an equivalent
mechanism) even executes a `Bash`/`Edit`/`Write` call. That is narrower than "the first governance
mechanism," and it's exactly what gstack's three hooks fill.

## 1. A discovery that reframed this lane's scope

Before designing anything, this repo's own migration record and
`evals/core/guard-triggers/run.js` were read. They show HarnessKit **already has a named, disclosed,
currently-failing gap that this exact hook fills**:

- The migration record's "Known gaps" items 1–2: `hooks/` was never migrated in Phase 1A
  ("not named in the source's own approved-migration list... flagged here as an apparent gap... for a
  human decision"), and as a direct, disclosed consequence, `evals/core/guard-triggers/run.js`'s 8
  `bash`-type fixtures fail because they spawn `hooks/pre_tool_use_guard.js`, which did not exist.
- The release's known-limitations list (items 11 and 16) restates the same gap for the current release, reconfirmed
  live on 2026-07-12 at 20/28.
- `config/project-profiles/example-project.json`'s `self_guard` trigger already lists `hooks/**` as a
  change-controlled path ("enforcement hook code (pre_tool_use_guard, post_tool_use_ledger, ...)"),
  meaning this repo's own self-protection config already anticipated this file's existence and name.
- The eval fixture file (`evals/fixtures/guard-triggers/cases.json`) already fixes the exact
  interface: a JSON event on stdin, `{ tool_name: 'Bash', tool_input: { command }, cwd }`, and a
  decision communicated purely via **exit code** — `0` = allow, `2` = block. This is not a Claude
  Code-specific JSON shape; it's a plain, host-neutral CLI contract that happens to coincide with
  Claude Code's own documented `PreToolUse` exit-code convention (exit 2 = blocking error, stderr fed
  back to the model; exit 0 = allow) — not by this lane's design, but because that eval contract was
  already fixed before this lane started (see the migration record, dated to the Phase 1A
  migration).

Consequence: this lane's "host-neutral core + host adapter" design isn't a fresh invention layered on
top of gstack — it's built to satisfy a contract this repo already committed to. `hooks/pre_tool_use_guard.js`
is simultaneously (a) the file the pre-existing eval spawns, (b) a real, directly-usable Claude Code
`PreToolUse` hook command, and (c) gstack's own `guard` concept (`careful` + `freeze` composed) under
its literal name in this repo's self-protection config.

## 2. Extraction: what was real, and how it was obtained

`docs/plans/GSTACK_SECURITY_ANALYSIS.md` records that a shallow git clone of gstack at the pinned
commit was made into a scratch directory outside any project repo during that earlier vetting pass.
That scratch clone was still present, read-only, on this machine at
`<session scratchpad>/gstack-clone`, and was independently re-verified before use:

```
git log -1 --format='%H %ci %s'
7c9df1c568a9ea745508f679a329332b2c338063 2026-07-09 23:49:09 -0700 chore(release): v1.60.1.0
```

This matches the pinned SHA exactly — the three hook scripts below were read from that real clone,
not fabricated, not reconstructed from the capability-analysis doc's prose summary. Full paths read:
`careful/bin/check-careful.sh`, `careful/SKILL.md`, `freeze/bin/check-freeze.sh`, `freeze/SKILL.md`,
`guard/SKILL.md`.

### What was extracted (real, verbatim-read, then adapted)

- **`careful/bin/check-careful.sh`** (67 lines): a bash `PreToolUse` hook for `Bash` — destructive
  pattern table (`rm -r`/`-rf`, `DROP TABLE`/`DATABASE`, `TRUNCATE`, `git push --force`,
  `git reset --hard`, `git checkout .`/`git restore .`, `kubectl delete`, `docker rm -f`/
  `system prune`), a safe-exception allowlist for `rm -rf` of build-artifact dirs
  (`node_modules`, `.next`, `dist`, `__pycache__`, `.cache`, `build`, `.turbo`, `coverage`), and a
  `permissionDecision: "ask"` (warn, overridable) response for every match.
- **`freeze/bin/check-freeze.sh`** (80 lines): a bash `PreToolUse` hook for `Edit`/`Write` — reads a
  freeze-boundary state file, resolves the target file path, and returns `permissionDecision: "deny"`
  if the path is outside the boundary (trailing-slash match so `/src` doesn't match `/src-old`);
  fail-open (allow) if no boundary is configured.
- **`guard/SKILL.md`**: confirmed to be a pure composition — registers both hooks together, no new
  logic of its own.

### What was stripped (per this lane's instruction and per the security analysis's own finding)

Both `check-careful.sh` and `check-freeze.sh` contain an unconditional telemetry line on every hook
fire:

```bash
mkdir -p ~/.gstack/analytics 2>/dev/null || true
echo '{"event":"hook_fire","skill":"careful","pattern":"'"$PATTERN"'", ...}' >> ~/.gstack/analytics/skill-usage.jsonl 2>/dev/null || true
```

`docs/plans/GSTACK_SECURITY_ANALYSIS.md` §2 already flags this as part of gstack's broader phone-home
surface (distinct from, but adjacent to, the confirmed-open auto-upgrade defect). It is **not present
anywhere in this lane's code** — not gated behind a flag, not ported as dead code, entirely absent.
`hooks/policy/guard-policy.js` and `hooks/pre_tool_use_guard.js` write nothing to any file except the
freeze-boundary state file the user explicitly sets, and make zero network calls.

## 3. Host-neutral design

```
hooks/
  policy/
    guard-policy.js       <- host-neutral core: pure functions, zero I/O beyond what's passed in
  pre_tool_use_guard.js    <- Claude Code adapter + host-neutral exit-code CLI entry point
.claude/
  settings.json            <- project-local hook wiring (THIS worktree only)
```

**`hooks/policy/guard-policy.js`** — the actual policy logic, with zero host vocabulary. No
`permissionDecision`, no stdin/stdout/exit-code handling, no Claude-Code-specific anything. Exports:

- `evaluateBashCommand(command) -> { decision: 'block'|'ask'|'allow', pattern, reason }`
- `evaluateFileWrite(filePath, freezeBoundary) -> { decision: 'block'|'allow', pattern, reason }`

**`hooks/pre_tool_use_guard.js`** — the one real adapter built in this lane. Reads `{tool_name,
tool_input, cwd}` from stdin, calls into `guard-policy.js`, and communicates the result via exit code
(`0`/`2`) — which is both the pre-existing eval's contract *and* Claude Code's own PreToolUse
exit-code contract, so one file satisfies both without a shim. For `'ask'` decisions it additionally
writes a Claude-Code-shaped `hookSpecificOutput.permissionDecision:"ask"` JSON object to stdout while
still exiting 0 (see "Known limitations" — this half is not independently fired against a live Claude
Code session in this pass). It also exposes two small CLI utilities, `--freeze-set <dir>` and
`--freeze-clear`, since a headless `PreToolUse` hook has no `AskUserQuestion` available to prompt the
user interactively the way gstack's own `/freeze` skill setup step does — building that interactive
setup skill is explicitly out of this lane's scope (see §7).

### A deliberate divergence from gstack's own severity, and why

gstack treats every one of its destructive patterns — including `git reset --hard` — as `ask`
(warn, overridable), never a hard block. This lane hard-blocks (`decision: 'block'`, exit 2, no
override) exactly four patterns: `git checkout .`, `git checkout -- .`, `git restore .`,
`git restore --staged .`, and `git reset --hard`. Two independent reasons, not a stylistic choice:

1. This user's own global operating rules (`~/.claude/CLAUDE.md`'s auto-mode block) already require
   stashing/committing before any command that could discard uncommitted work — a warn-and-override
   is weaker than that standing rule for exactly this command class.
2. `evals/fixtures/guard-triggers/cases.json` — pre-existing in this repo, dated to the Phase 1A
   migration, **not authored by this lane** — already encodes `expect: "block"` for exactly these
   patterns (`gt-01` through `gt-08`). This rule table was built to satisfy that pre-existing contract,
   not the reverse.

Everything else gstack flagged (`rm -rf` outside the safe-exception list, `DROP TABLE`/`DATABASE`,
`TRUNCATE`, `git push --force`, `kubectl delete`, `docker rm -f`/`system prune`) keeps gstack's
original `ask` severity.

### A hardening beyond gstack's own regex, disclosed explicitly

gstack's `check-careful.sh` grep-matches the whole raw command string with no anchoring and no
command-chain awareness — `git checkout . && rm -rf important` would only be caught if the *first*
matching pattern happened to be checked first, and its `git checkout|restore` regex
(`git\s+(checkout|restore)\s+\.`, no `$` anchor) does not actually match `git checkout -- .` or
`git restore --staged .` at all (the `--`/`--staged` tokens sit between the verb and the dot,
breaking the naive regex). Since the pre-existing eval requires both of those to block, this lane
splits each command on shell chain/pipe operators (`&&`, `||`, `;`, `|`, newline) first, then applies
an anchored per-segment regex for the checkout/restore family. This is stricter and more correct than
a straight port, not merely a re-styling — verified against all 8 pre-existing fixtures (§5).

### Freeze-boundary state

Stored at `<HARNESS_ROOT>/.claude/freeze-boundary.local.txt` (overridable via
`HARNESSKIT_GUARD_STATE_DIR` for self-tests), not `$HOME/.gstack/` as gstack does — kept
project-local per this lane's own scoping constraint. Added to `.gitignore` (mutable, session-local,
never meant to be committed).

## 4. Codex CLI enforcement-equivalent investigation (real, bounded, honestly incomplete)

Investigated via `codex --help`, `codex doctor --summary`, `codex features list`, `codex plugin
--help`, and `codex plugin list --help` on this machine (Codex CLI v0.144.1, Windows x86_64) — no
fabricated claims, no assumption that an equivalent exists without evidence.

**Confirmed, real evidence that Codex CLI has *some* hook mechanism:**
- `codex --help` lists a real flag: `--dangerously-bypass-hook-trust` — "Run enabled hooks without
  requiring persisted hook trust for this invocation. DANGEROUS. Intended only for automation that
  already vets hook sources." This directly implies (a) hooks are a real, nameable concept in Codex
  CLI, and (b) they carry a trust/approval model analogous to Claude Code's own hook-trust prompt.
- `codex features list` shows a feature flag `hooks` with stage `stable` and `true` (enabled) on this
  installation.

**What could not be determined from this pass, disclosed rather than guessed:**
- No `codex hooks` subcommand exists to introspect the schema (event names analogous to `PreToolUse`,
  the stdin/stdout/exit-code contract a hook script must implement, or where a hook is declared —
  presumably `~/.codex/config.toml` or a project-local Codex config, by analogy with Claude Code, but
  this is an inference, not a confirmed fact).
- This machine's own `~/.codex/config.toml` (81 lines, read in full) has no `[hooks]` block configured
  — there is no live, working example to read the schema off of.
- `codex doctor` (both normal and `--summary` output, and with a synthetic `-c hooks.test=1` override
  to see if it surfaced a validation error) shows no hooks-specific status row, and the override was
  silently accepted without revealing schema.

**Conclusion, stated honestly:** Codex CLI almost certainly has *some* real pre-action/hook gating
mechanism (the feature flag and the trust-bypass flag are real, current-version evidence, not
speculation) — but this lane could not determine, from the CLI surface available, a concrete-enough
schema to design a real Codex adapter against `guard-policy.js` today. **This is a genuine open
question, and per this task's own framing, may need to be its own separate follow-up
investigation** (reading OpenAI's Codex CLI hook documentation directly, or finding a real
`[hooks]`-configured `config.toml` example to reverse-engineer the contract from) rather than
something this lane's own scope could close. No Codex adapter was built, because building one against
an unconfirmed schema would mean inventing a contract, not extracting/adapting a real one — which
this whole lane is explicitly trying not to do.

## 5. Test results

### 5a. Policy-core self-test (pure logic, no subprocess, no host)

```
node hooks/policy/guard-policy.js --self-test
{ "module": "guard-policy", "pass": true, "total": 32, "passed": 32, "failed": 0, "failures": [] }
```

32 cases: the same 8 bash cases as the pre-existing eval's bash fixtures (kept as an independent,
hand-written witness — not imported from `cases.json` — so drift between this self-test and that
fixture file would be a real signal, not silently masked by a shared source), plus the broader `ask`
tier (`rm -rf`, `DROP TABLE`/`DATABASE`, `TRUNCATE`, force-push, `kubectl delete`, docker), the
safe-exception carve-out, chained-command hardening (`cd /tmp && git reset --hard ...`), and 7 freeze
boundary cases (including a Windows-style-path case).

### 5b. Hook-adapter self-test (real subprocess, real piped stdin — matches how Claude Code and the
eval both actually invoke it)

```
HARNESS_ROOT=<worktree> node hooks/pre_tool_use_guard.js --self-test
{ "module": "pre_tool_use_guard", "pass": true, "total": 14, "passed": 14, "failed": 0, "failures": [] }
```

14 cases: all 8 pre-existing bash fixtures spawned as real child processes, plus freeze
unconfigured/in-boundary/out-of-boundary/cleared, using a disposable temp state directory
(`HARNESSKIT_GUARD_STATE_DIR`) so the worktree's real `.claude/freeze-boundary.local.txt` is never
touched by the self-test.

### 5c. The pre-existing repo eval this lane was built to satisfy

Before this lane's changes (`HARNESS_ROOT=<worktree> node scripts/run-evals.js`):

```
"guard-triggers": { "pass": false, "score": 0.7142857142857143, "total": 28, "passed": 20, "failed": 8 }
```

After (`node evals/core/guard-triggers/run.js --fixtures-dir evals/fixtures/guard-triggers`):

```
"guard-triggers": { "pass": true, "score": 1, "total": 28, "passed": 28, "failed": 0 }
```

All 8 previously-failing `bash`-type fixtures now pass; all 20 `glob`-type fixtures (unrelated to
this change, they exercise `sensitivePathHits`) continue to pass unchanged.

### 5d. Full repo eval suite (regression check across all 17 categories, not just guard-triggers)

`HARNESS_ROOT=<worktree> node scripts/run-evals.js`, before and after this lane's changes:

| Category | Before | After |
|---|---|---|
| redaction | PASS 22/22 | PASS 22/22 |
| poisoning | PASS 16/16 | PASS 16/16 |
| gbrain-ab | PASS | PASS |
| claim-support | PASS 9/9 | PASS 9/9 |
| trajectory | PASS 34/34 | PASS 34/34 |
| tool-risk | PASS 57/57 | PASS 57/57 |
| routing | PASS | PASS |
| spec-gaming | PASS 40/40 | PASS 40/40 |
| approval-registry | PASS 81/81 | PASS 81/81 |
| agent-identity | PASS 85/85 | PASS 85/85 |
| context-quality | PASS 40/40 | PASS 40/40 |
| goal-drift | PASS 12/12 | PASS 12/12 |
| skill-registry-security | PASS 12/12 | PASS 12/12 |
| skill-langgraph-plan-review | PASS 13/13 | PASS 13/13 |
| **guard-triggers** | **FAIL 20/28** | **PASS 28/28** |
| run-lifecycle | PASS 21/21 | PASS 21/21 |
| run-lock | PASS 12/12 | PASS 12/12 |

**16 of 17 categories were already passing and remain passing (zero regressions). The 1 category that
was failing (`guard-triggers`, the exact, disclosed, named gap this lane exists to fix) now passes.**

Note on this task's own instruction to run "the repo's 8 self-test suites": no literal set of exactly
8 suites was found anywhere in this repo. The actual match for "8" is `guard-triggers`'s 8 previously-
failing `bash`-type fixtures (named that way in the migration record and the
known-limitations list) — stated here rather than silently reinterpreted, since the instruction's
literal wording doesn't match anything real in this repo. What was actually run: the full 17-category
`scripts/run-evals.js` suite (above) plus `scripts/local-ci.js`'s self-test module sweep (§5e), which
is the repo's real nothing-else-regressed mechanism.

### 5e. `scripts/local-ci.js` self-test module sweep

`hooks/policy/guard-policy.js` and `hooks/pre_tool_use_guard.js` were added to `local-ci.js`'s
`SELF_TEST_MODULES` list, following the exact existing precedent used for `router/select-adapter.js`
and `bin/harnesskit.js` (`path.join('..', ...)`, since those two files also live outside `scripts/`).

`node scripts/local-ci.js --mode full --json` (`HARNESS_ROOT` = this worktree): **33 of 34 checks
pass**, including both new entries —

```
self_test:validate-capability-matrix.js True
self_test:harnesskit.js                 True
self_test:guard-policy.js                True
self_test:pre_tool_use_guard.js          True
```

All 26 self-test modules (24 pre-existing + the 2 added here) pass, alongside `preflight`,
`skill_registration`, `adapter_registration`, and `commit_lease`. The 1 remaining failure is
`capability_matrix_drift`, and it was run down rather than left unexplained:

- Running `node scripts/validate-capability-matrix.js --json` directly (the exact command
  `local-ci.js` spawns) returns `{"ok": true, "results": [...18 capabilities, all verified...]}` —
  a real pass.
- `local-ci.js`'s own wrapper (`runJsonScript`) nonetheless records `ok: false, data: null` for this
  one check specifically when it spawns the script as a subprocess of *its own* subprocess chain (via
  `execFileSync` with `stdio: ['ignore', 'pipe', 'pipe']`) — i.e. the failure reproduces only through
  `local-ci.js`'s own invocation path, not the script itself.
- `config/capability-matrix.json` was checked for any reference to `hooks/`, `guard-policy.js`, or
  `pre_tool_use_guard.js` — **zero matches**; the two "hooks" hits in that file are pre-existing,
  unrelated prose (`"known_limitations": ["tool-log completeness depends on hooks, which are dormant
  by default"]`) and a reference to the already-existing `claude-code-hooks.js` review-independence
  adapter.
- **Conclusion: this is a pre-existing `local-ci.js` subprocess-invocation quirk, not a regression
  introduced by this lane.** It was present (with the identical `ok:false, data:null` shape) even
  before `npm install` was run in this worktree, when the *other* blocking failure
  (`self_test:harnesskit.js`, a genuine `MODULE_NOT_FOUND` from a never-installed `node_modules/` —
  also unrelated to this lane, fixed by running `npm install`) was also present. Not investigated
  further because it is out of this lane's scope (no `hooks/` involvement) — flagged here rather than
  silently omitted.

## 6. CWD-coverage finding (verified, not assumed)

This task asked specifically whether project-local `.claude/settings.json` hooks would fire during a
future session rooted somewhere else (e.g. an ART-dogfood session rooted in ART's own directory, not
HarnessKit's). This was investigated via a fresh, specialized agent (`claude-code-guide`, which has
`WebFetch`/`WebSearch` access to Claude Code's own documentation) rather than assumed.

**Finding, with citations the agent provided:**

- Claude Code resolves `.claude/settings.json` based on the session's actual working directory —
  there is no `--project`/`--cwd` flag; the cwd is simply where `claude` was invoked from
  (`how-claude-code-works.md`).
- The documented settings-scope table (`hooks-guide.md`) states `.claude/settings.json` and
  `.claude/settings.local.json` are **"Single project"** scope, versus `~/.claude/settings.json`
  which is **"All your projects."** Project-local hooks do not cross into a session rooted in a
  different project directory.
- Relative paths inside a hook `command` are resolved relative to the project root, and
  **`${CLAUDE_PROJECT_DIR}`** is the officially documented environment variable for referencing that
  root reliably (distinct from `${CLAUDE_PLUGIN_ROOT}`, which this repo's *existing*
  `.claude-plugin/plugin.json`-based commands already use).
- Settings precedence (managed policy > CLI args > `.claude/settings.local.json` >
  `.claude/settings.json` > `~/.claude/settings.json`) doesn't change this — none of those levels let
  a project-local file apply outside its own project.

**Conclusion: confirmed, not assumed — these hooks, wired only into this worktree's
`.claude/settings.json`, will NOT fire during a future session rooted in a different project
directory (e.g. ART).** The one honest caveat the investigating agent itself flagged: Claude Code's
docs do not explicitly state whether resolution is strictly cwd-based or walks up to a git-repo root
from cwd — "not formally documented" per that pass. Either way, a session rooted in ART's own
directory tree is a different project root under both readings, so the conclusion above holds; the
undocumented detail only matters for the (out-of-scope) question of exactly which directory *within*
HarnessKit's own tree still sees the hook.

**Implication for a real future rollout:** if these hooks are meant to protect a target repo being
worked on *through* HarnessKit (e.g. during an ART dogfood run), project-local `.claude/settings.json`
is the wrong mechanism — coverage would need to come from HarnessKit's own existing
`.claude-plugin/plugin.json` packaging (which already declares `commands`/`skills` fields and, per the
plugin schema this repo's own plugin notes already cite, supports a `"hooks"` field
pointing at a hooks-config JSON, using `${CLAUDE_PLUGIN_ROOT}`) — because plugins apply wherever
they're installed/enabled, independent of session cwd. That is a materially different, larger-blast-
radius change than this lane's explicit instruction ("scoped to HarnessKit's own project-local
`.claude/settings.json` only, never any global/user-level config"), so it was not attempted here —
named explicitly as the integration-order question in §7.

## 7. Known limitations

1. **The `'ask'` (soft-warn) half of the Claude Code JSON contract was not independently fired
   against a live Claude Code session.** The `hookSpecificOutput.permissionDecision:"ask"` stdout
   shape is a best-effort port of Claude Code's documented behavior; only the exit-code half (which
   the pre-existing eval and the subprocess self-test both exercise for real) has been verified
   end-to-end in this pass.
2. **No interactive `/freeze`-setup skill was built.** `--freeze-set`/`--freeze-clear` are real,
   tested CLI entry points, but a headless `PreToolUse` hook has no `AskUserQuestion` equivalent to
   prompt a user for a boundary directory the way gstack's own skill does. Building that interactive
   skill (if wanted) is a separate, small follow-up.
3. **Codex CLI adapter feasibility is a confirmed-open, not resolved, question** — see §4. Real
   evidence a hook mechanism exists; no confirmed schema to adapt against.
4. **CWD-coverage for a target-repo-scoped rollout (e.g. ART dogfood) is not solved by this lane** —
   see §6's "Implication for a real future rollout." Project-local `.claude/settings.json` only
   protects sessions rooted in *this* worktree.
5. **Freeze is explicitly not a security boundary**, carried forward from gstack's own documented
   caveat: a `Bash` command (e.g. `node -e "require('fs').writeFileSync(...)"`, or `sed -i`) is not
   intercepted by the freeze check, only literal `Edit`/`Write` tool calls are.
6. **The `'ask'` tier's destructive-pattern regexes are whole-command substring matches** (not
   segment-split like the hard-blocked checkout/restore family), matching gstack's own original
   precision for that tier — a command like `echo "rm -rf /"` (printing, not executing) would still
   trigger an `ask`. This is an inherited, disclosed false-positive risk, not new to this lane.
7. **This is one isolated worktree lane** (`hk/p6-policy-core`); nothing here is merged to master, and
   the release notes on master still correctly describe the 20/28 state
   until a maintainer decides to merge this lane.

## 8. Re-pin / re-attestation trigger

This is not an open-ended pin. Re-review and re-extract if **any** of the following happen:

1. gstack's own `careful`/`freeze`/`guard` hook scripts change upstream from the pinned commit
   (`7c9df1c568a9ea745508f679a329332b2c338063`) — re-diff the three files against the new HEAD before
   pulling forward any change; do not blindly re-pull `main`.
2. Claude Code's own `PreToolUse` hook API changes (exit-code semantics, the JSON output shape for
   `permissionDecision`, or the `${CLAUDE_PROJECT_DIR}` resolution mechanism documented in §6) —
   re-verify §6's CWD-coverage finding and the `'ask'` JSON contract against the new docs.
3. `evals/fixtures/guard-triggers/cases.json`'s bash-type fixtures change (new patterns added, or
   `expect` values change) — `hooks/policy/guard-policy.js`'s `BASH_RULES` table must be re-synced;
   the two self-tests in this repo (§5a/§5b) are independent witnesses precisely so a silent mismatch
   between the eval fixtures and this hook's own understanding of the contract gets caught, not
   papered over.
4. A real Codex CLI hooks schema becomes available (a documented example, or a working
   `[hooks]`-configured `config.toml` to read) — revisit §4 as a first-class follow-up, not a
   someday-maybe.

## 9. Recommended independent reviewer

`ce-security-reviewer` (Compound Engineering's conditional persona for diffs touching permission
checks / user input handling) — this diff is exactly its trigger condition: a new permission-gating
mechanism parsing untrusted tool-call JSON from stdin.

## 10. Integration order (for a future merge decision, not decided by this lane)

1. Human review of this report + the diff (per this lane's own instruction: propose, don't merge).
2. `ce-security-reviewer` pass on `hooks/policy/guard-policy.js` + `hooks/pre_tool_use_guard.js`
   specifically (regex-injection surface via untrusted `command`/`file_path` strings, freeze-state
   file handling).
3. If approved: merge to master, re-run `scripts/run-evals.js` there, re-baseline
   `evals/baselines/guard-triggers.json` (currently reflects a pre-existing source-repo score per
   known-limitations item 17 — a `--establish-baseline` pass is already a named, separate gap;
   doing it here would conflate two different follow-ups).
4. **Only after** the Codex-enforcement-equivalent question (§4) gets a real answer — either a
   dedicated follow-up investigation, or a maintainer decision to explicitly defer it — should this
   be represented anywhere as "the multi-host policy layer" rather than "the Claude Code layer,
   Codex still open."
5. The plugin-level (`${CLAUDE_PLUGIN_ROOT}`, `.claude-plugin/plugin.json` `"hooks"` field)
   broader-coverage rollout named in §6 is a distinct, larger-blast-radius change and should go
   through its own explicit approval — not bundled into this lane's project-local scope.
