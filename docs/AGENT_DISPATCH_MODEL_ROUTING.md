# Agent-Dispatch and Host/Model-Routing Architecture (Batch 1, lane `hk/p8c-agent-dispatch`)

## Purpose and honesty scope

This document defines the missing layer between "we know which adapter *should* handle a task"
(`config/adapter-registry.json` + `router/select-adapter.js`, both real and already working) and
"a real subagent/CLI process is actually running, being watched, and can be stopped" (nothing —
this layer does not exist anywhere in HarnessKit today).

**What this is:** a full design — contract shape, role definitions, lifecycle state machine,
risk-aware routing rules, fallback semantics, cancellation mechanics, evidence/receipt shape — plus
an optional, real, self-tested partial skeleton (`scripts/dispatcher.js`, `config/dispatch-policy.json`).

**What this is not:** a wired pipeline stage. Nothing in this lane calls `execute-workflow.js`,
`bin/harnesskit.js`, `loop-conductor.js`, or any `review-independence/*` file, and nothing in those
files is edited. Every "real" claim below cites either an existing file/function this design reuses
unchanged, or a new file added in this lane with a working `--self-test`. Every "not built" claim
says so explicitly, matching this repo's own `docs/HOST_ADAPTER_CONTRACT.md` convention of never
blurring the two.

## Outsourcerer classification (governing constraint, restated explicitly)

This design uses `alexgreensh/outsourcerer`'s public, README-documented behavior as design input
(see the pattern-mapping table below) under an explicit, standing classification — restated here
verbatim rather than left implicit in the pattern-mapping table's prose alone, matching this
lane's own no-blurred-claims discipline:

- **`USE_AS_REFERENCE`** — the design patterns are real and worth learning from directly; this is
  not a claim that Outsourcerer's own code was inspected beyond its public README/metadata.
- **`DEFERRED_PENDING_WINDOWS_PROOF`** — runtime adoption of anything resembling Outsourcerer's
  actual mechanism is deferred; no such proof exists yet, and `scripts/dispatcher.js`'s stubbed
  spawn/monitor/collect/cancel functions do not constitute that proof.
- **No AGPL code copying** — Outsourcerer is AGPL-3.0-only. No source from it was ever read, cloned,
  or copied into this repo; every mapping below is a clean-room Node.js/Windows-native design derived
  from its public behavior description, never a port.
- **No required Bash/WSL dependency** — Outsourcerer's own reference implementation is a bash
  script; this design and `scripts/dispatcher.js` are Node.js-native throughout (confirmed: zero
  bash/WSL/`.sh` invocations anywhere in this lane) specifically so this project's Windows-first
  target is never made to depend on a shell HarnessKit doesn't otherwise require.

Full research provenance: `evidence/OUTSOURCERER_RESEARCH.md` (session-scratch, untracked — this
section is the shipped, repo-tracked restatement of that research's governing decision, not a
duplicate of its content).

## Why this gap is real, not invented

`config/adapter-registry.json`'s own header says its enforcement status is "advisory_only" and that
"nothing gates execution... beyond `router/select-adapter.js`'s own stub logic." `select-adapter.js`
itself only ever answers *which adapter_id should handle this*, as a pure function over static JSON
— it never spawns a process, never watches one run, never collects a result, and never cancels
anything. `scripts/codex-adapter.js` is the one adapter-specific spawn mechanism that exists, and it
is exactly that: one adapter, invoked synchronously, with no cross-adapter contract above it.
`docs/HOST_ADAPTER_CONTRACT.md` independently names two of the same gaps from the *workflow* side:
item 4 ("Cancel a workflow" — "no cancel verb at all") and item 11 ("Identify host + adapter + model
+ version + permissions + network posture" — "no such adapter has been built... nothing in this
plugin surfaces that identity back through HarnessKit's own output today"). This design closes both
gaps **at the dispatch (per-agent) level**, which is a real, independently useful, smaller-blast-radius
subset of the larger workflow-level verbs `HOST_ADAPTER_CONTRACT.md` names as still open — it does
not attempt to add `cancel`/`identify` verbs to `bin/harnesskit.js` (that remains a separate CLI-surface
decision, unchanged by this lane).

## Relationship to existing systems (reused, not duplicated)

| System | File(s) | What it already does | How this design uses it |
|---|---|---|---|
| Adapter capability/trust registry | `config/adapter-registry.json` | Per-adapter capability evidence (verified/claimed/unverified/unsupported), trust tiers (untested→quarantined→trusted-local) | Read-only input to routing. Never modified, never re-derived. |
| Adapter selection | `router/select-adapter.js` (`route()`) | Deterministic task_type→capabilities→eligible-adapters→winner, with named policies (`highest_verified_quality`, `independent_review`, `local_cli_only`, `benchmark_all`, ...) | Called as-is. The dispatch layer's only job on top of it is choosing *which policy* to pass, from risk class + role, then acting on the result. |
| Broader capability inventory | `config/capability-registry.json` | Per-capability `permissions`/`network_access`/`write_access`/`secret_access` (e.g. `claude-subagents`: `write_access:"none"`, `permissions:"read-only/inspect (single-writer rule; main agent writes)"`; `codex-cli`: `write_access:"none"`, `permissions:"read-only/adversarial review only (when wired)"`) | Source of truth for the dispatch record's `host_identity.permissions` field — never a new permissions taxonomy. |
| Actor identity / stamping | `scripts/review-independence/core/actor-identity.js` (`stampProducer`, `stampReviewer`, `validateStamp`) | Anti-spoofing producer/reviewer stamp shape; trust-sensitive fields always overwritten by trusted call-site code, never accepted from a model-writable argument | Dispatch records **wrap** a producer or reviewer stamp; they do not reinvent the anti-spoofing pattern. |
| Actor independence evaluation | `scripts/review-independence/core/evaluator.js` (`evaluateIndependence`) | Tier ladder `deterministic → isolated_actor → different_adapter → different_provider → human`, AND-composed across `actor_independence` / `review_authorized` / `review_evidence_valid` | Unmodified. A dispatched reviewer's stamp still flows through this evaluator exactly as today; the dispatch layer produces inputs to it, not a competing evaluator. |
| Claude Code hook adapter | `scripts/review-independence/adapters/claude-code-hooks.js` | Real `SubagentStart`/`SubagentStop` → `dispatch_id`/`agent_id` correlation, review-request binding | This is the **only real dispatch lifecycle wiring that exists today**, for exactly one adapter (claude-code) and exactly one role (reviewer). This design generalizes its shape (dispatch_id, lifecycle correlation, evidence-gated finalization) to other adapters/roles without touching this file. |
| Adapter-level review independence | `scripts/execute-workflow.js` (`validateReviewIndependence`) | Reviewer's `selected_adapter` must differ from the producer's, and must be a real adapter eligible under `independent_review` | Same concept as `evaluator.js` but at the *adapter* dimension instead of the *actor* dimension — both are orthogonal independence checks a dispatch record must be able to answer. |
| Concrete adapter spawn mechanism | `scripts/codex-adapter.js` (`reviewReadOnly`, `implementBounded`, `runCodex`), `scripts/resolve-codex-shim.js` | One real, Windows-hardened, non-shell, stdin-based spawn path for exactly one CLI adapter | The **pattern** (resolve real executable, stdin for untrusted content, `--output-last-message`/verdict-token parsing, DISABLED-gated) is the template every future adapter's spawn function should follow. Not copied into this lane's skeleton; cited as the reference implementation. |
| Gating conventions | `scripts/loop-conductor.js` (`isDisabled`, `ASK_BEFORE_EXTERNAL`, `runWithTimeoutRetry`, `enterRepairLoop`) | DISABLED kill switch checked first everywhere; external/cost calls need explicit approval; bounded timeout+retry; repair-loop admission is capped and never silent | Every dispatch function in this design is DISABLED-gated first, external dispatches need explicit approval, and cancellation/timeout never silently retries against a half-mutated tree — same invariants, generalized. |
| Risk signals | `scripts/detect-risk.js` (`riskLevel`/`haltConditions` via `classifyRisk`), `scripts/tool-risk-classifier.js` (`classify` → read/write/exec/network) | Path-trigger-based risk level; tool-call risk class | Read-only inputs to risk-aware routing. `detect-risk.js` has no `module.exports` today (CLI-only) — this design reuses it exactly the way `router/classify-task.js#runRiskDetectInline` already does: `spawnSync` + parse JSON stdout, never re-implemented. |
| Approval gate | `scripts/check-approval-needed.js` | Authoritative approval-required decision from `route.json` + `risk-report.json` | Never bypassed or shadowed. The dispatch layer's own `requires_human_approval` signal is advisory alongside it, not a replacement. |
| Path/commit locking | `scripts/lease.js` (`acquireLease`, `releaseLease`) | Advisory overlapping-scope write locks | A cancelled/timed-out producer dispatch that held a lease **must** release it — named as a required integration point (see Cancellation section). |
| Security scan points | `scripts/security-boundary.js` (`scanBeforeEvidencePersist`, 4 of 6 scan points unwired) | Real scanner, `scanBeforeEvidencePersist` exported but not called anywhere yet | Dispatch-evidence writes (receipts, host-identity records) are a **new real candidate call site** for `scanBeforeEvidencePersist` — named here, not wired here (Security Broker Architecture's job, see Integration Order). |

---

## 1. The Dispatch Contract

A **dispatch** is one request to run a bounded unit of work (implementation, review, or challenge)
on some adapter/host, tracked start-to-finish. The dispatch record is the single artifact that
answers every one of the task's required questions (capability match, risk gate, lifecycle,
cancellation, evidence) for one dispatch.

```jsonc
{
  "schema_version": 1,
  "dispatch_id": "string",            // claude-code: the REAL agent_id from SubagentStart (never minted) —
                                       // see claude-code-hooks.js#dispatchIdFromHookPayload.
                                       // any other adapter: minted `dispatch-<uuid>` by TRUSTED
                                       // dispatcher code at spawn time, never accepted from model output.
  "parent_run_id": "string",
  "role": "producer | reviewer",      // reuses ROLE_ALLOW from actor-identity.js verbatim — no 3rd value added
  "panel_role": "primary | challenger | null", // NEW: sub-classifies a reviewer as an advisor-panel member
  "task_type": "string",              // TASK_TYPE_CAPABILITIES vocabulary (select-adapter.js) — not reinvented
  "required_capabilities": ["string"],// resolved list actually used for routing (see 4.2)
  "risk_class": "low | med | high | critical | unknown",
  "routing_policy": "string",         // one of select-adapter.js POLICIES keys, chosen per risk_class (see 5)
  "adapter_id": "string",             // selected_adapter from route()
  "provider_id": "string",
  "model_id": "string | null",
  "model_observation_status": "unavailable | observed_trusted | observed_unverified",
  "host_identity": {
    "harness_version": "string",      // from package.json (this repo's own VERSION, not a new field format)
    "adapter_contract_version": "number", // adapter_contract_version from the selected adapter-registry.json row
    "permissions": "string | null",   // copied verbatim from capability-registry.json's matching entry, never invented
    "network_access": "string | null",// same source
    "network_posture_evidence_state": "verified | claimed | unverified"
  },
  "worktree_path": "string | null",   // only set for role:producer dispatches (see 6)
  "lifecycle": {
    "state": "PENDING | DISPATCHED | RUNNING | COMPLETED | COMPLETED_WITH_FALLBACK | TIMEOUT | CANCELLED | ERROR",
    "spawned_at": "iso8601 | null",
    "completed_at": "iso8601 | null",
    "timeout_ms": "number",
    "cancel_requested_at": "iso8601 | null",
    "cancel_reason": "string | null"
  },
  "fallback": {
    "attempted": "boolean",
    "original_adapter_id": "string | null",
    "actual_adapter_id": "string | null",
    "reason": "string | null"
  },
  "receipt": {
    "evidence_state": "verified | claimed | unverified",
    "tokens": { "input_tokens": "number", "output_tokens": "number" } ,
    "usage_populated": "boolean",
    "cost_usd": "number | null",
    "trust_tier_at_dispatch": "string",
    "note": "string"
  },
  "stamp_id": "string",
  "stamped_at": "iso8601"
}
```

Composition rule (do not violate): **the dispatch record wraps a producer/reviewer stamp — it never
replaces it.** On spawn, `stampProducer`/`stampReviewer` (`actor-identity.js`) still produce the
canonical stamp that `evaluateIndependence` consumes; the dispatch record is a superset carried
alongside it (lifecycle, risk, fallback, receipt fields `stampProducer`/`stampReviewer` intentionally
do not have, because those concerns are orthogonal to actor-independence proof).

---

## 2. Roles: producer / reviewer / challenger

| Role | Maps to | Write access (from `capability-registry.json`) | Who may hold it today |
|---|---|---|---|
| **producer** | `role:"producer"` in `actor-identity.js` | scoped/full, per adapter (`claude-code-host`: `write_access:"scoped"`) | Main-thread `claude-code` only, per the existing single-writer rule (`claude-subagents.write_access:"none"`, `permissions:"read-only/inspect (single-writer rule; main agent writes)"`). **This design does not relax that rule.** A dispatched *subagent* is never a legal producer; only the main-thread session is. |
| **reviewer** | `role:"reviewer"` | none (`claude-subagents.write_access:"none"`, `codex-cli.write_access:"none"` for `reviewReadOnly`) | Any adapter whose registry row satisfies the `independent_review` policy (`minState:2, minTier:1`) and is not the producer's adapter (`excludeAdapter`). |
| **challenger** | `panel_role:"challenger"` on a `role:"reviewer"` dispatch | none — same as reviewer | Any second (or third+) independent reviewer dispatched in parallel with the primary reviewer, for the advisor-panel/consensus primitive (§8). Not a new capability tier — a *usage pattern* of the reviewer role. |

This directly matches `capability-registry.json`'s already-declared constraints: `codex-cli`'s entry
says `"permissions": "read-only/adversarial review only (when wired)"` and `"required_approval": "C2+
(bounded execution / patches) requires explicit scoped approval; C1 read-only is open"` — i.e.
`codex-adapter.js#reviewReadOnly` (C1) needs no extra approval under this design, while
`implementBounded` (C2, a *producer*-shaped bounded-write capability) requires the same explicit
per-call approval it already requires today. This design does not create a "codex-cli as producer"
path; `implementBounded` existing is not the same as this design routing to it as a first-class
producer role — that remains a separate, explicitly-approved-per-call capability, unchanged.

---

## 3. Subagent lifecycle: spawn / monitor / collect / terminate

State machine (per dispatch):

```
PENDING → DISPATCHED → RUNNING → COMPLETED
                              ↘ → COMPLETED_WITH_FALLBACK
                              ↘ → TIMEOUT
                              ↘ → CANCELLED
                              ↘ → ERROR
```

Two execution modes exist today, and this design keeps them distinct rather than pretending one
polling abstraction covers both (naming the difference honestly beats a leaky unification):

- **Synchronous CLI mode** (what exists today — `codex-adapter.js#runCodex` via `spawnSync`): the
  calling process blocks until exit or `timeoutMs`. "Monitor" is exactly `runWithTimeoutRetry`'s
  existing bounded timeout+retry wrapper — nothing new to build here, it already works. `RUNNING` is
  implicit (the call is blocking); the state machine still records `DISPATCHED → (blocking) →
  COMPLETED/TIMEOUT/ERROR` for evidence purposes even though there is no separate poll step.
- **Asynchronous host-subagent mode** (`claude-code`'s `Task`/`Agent` tool): inherently async
  already — `SubagentStart`/`SubagentStop` hooks (`claude-code-hooks.js`) ARE the monitor/collect
  mechanism, correlated by the real `agent_id`. This design's only addition is recording that
  correlation into a dispatch record with the richer shape above (lifecycle/risk/receipt), not
  replacing the hook mechanism.
- **Asynchronous background CLI mode** (Outsourcerer's `bg`/`status`/`watch`) — **not built, and not
  in this lane's skeleton.** Today's only CLI adapter (`codex-cli`) is invoked synchronously; nothing
  in this repo needs a background-process-plus-status-file mechanism yet. Named as a real future
  extension point (§12, Known Limitations), not something this design pretends to solve today.

**Cancellation** (fills `HOST_ADAPTER_CONTRACT.md` gap #4 *at the dispatch level*, not the workflow
level):

- **claude-code subagent dispatch**: the host tool surface already has a real, available primitive
  for this — `TaskStop` (confirmed present in this repo's own
  `scripts/tool-risk-classifier.js#EXEC_TOOLS` allowlist). Cancelling a dispatched subagent is: record
  `cancel_requested_at`/`cancel_reason` on the dispatch record, then call the host's `TaskStop` (or
  equivalent) against that `dispatch_id`. HarnessKit does not need to reinvent subagent
  cancellation — it needs to *record* the cancellation as dispatch evidence and propagate the request,
  which is new; the actual stop mechanism is not.
- **CLI adapter dispatch (e.g. codex-cli)**: `codex-adapter.js`'s 2026-07-10 fix already resolves the
  *real* underlying executable and invokes it directly via `process.execPath` (bypassing the npm
  `.cmd` shim entirely — see `resolve-codex-shim.js`). Because of that existing fix, a
  `child_process.spawn()` (non-blocking) of that same resolved binary yields one real PID whose
  process tree can be killed correctly with `taskkill /PID <pid> /T /F` on Windows (this is a Windows
  necessity: `child.kill()`/`SIGTERM` does not reliably propagate to a spawned tree on Windows, the
  same category of platform gotcha this repo already hit and solved once for shim resolution).
  Cross-platform, `SIGTERM` to the process group covers POSIX. **Not built in the skeleton** — this is
  a real mechanism description for a future implementation, not code shipped in this lane.
- **Lease release on cancel/timeout**: a cancelled or timed-out **producer** dispatch that acquired a
  `lease.js` path lock **must** call `releaseLease` before the dispatch record reaches a terminal
  state — otherwise the lease sits until its 24h TTL, blocking every other writer touching an
  overlapping scope for no real reason. This is a **required integration point** for any future
  implementation; it does not exist as a hook today because no caller of `lease.js` currently ties a
  lease's lifetime to a cancellable dispatch.
- Cancellation and timeout are both terminal — **never silently retried against a half-edited
  worktree**, matching Outsourcerer's own stated behavior ("a stalled delegate is killed by a watchdog
  and reported with its last progress line, never silently retried"). This mirrors
  `enterRepairLoop`'s existing invariant (bounded, explicit, logged admission — never automatic).

---

## 4. Capability matching against `adapter-registry.json`

### 4.1 Nothing new here — `route()` is reused verbatim

The dispatch layer never re-implements capability matching. It calls
`require('../router/select-adapter.js').route({ requiredCapabilities, policy, excludeAdapter })`
exactly as `execute-workflow.js` already does, and trusts its `selected_adapter` /
`eligible_adapters` / `human_approval_needed` output unchanged.

### 4.2 What the dispatch layer adds on top: role-aware capability requirements

`select-adapter.js#TASK_TYPE_CAPABILITIES` already maps `task_type → required capabilities` (e.g.
`'review': ['review', 'security']`). A dispatch additionally applies a **role floor**, so a
`role:"reviewer"` dispatch for a `task_type` whose default capability list happens not to include
`review` (e.g. `'code-bug': ['implementation', 'debugging', 'testing', 'review']` already includes it,
but a hypothetical future task_type might not) can never silently drop below reviewer-shaped
capabilities:

```js
// config/dispatch-policy.json#role_minimum_capabilities (real, shipped — see §11)
{
  "producer": [],
  "reviewer": ["review"],
  "challenger_addition": ["security"]   // panel_role:"challenger" ORs this into the reviewer floor
}
```

`required_capabilities` passed to `route()` = `TASK_TYPE_CAPABILITIES[task_type]` **union**
role floor **union** (challenger addition, if `panel_role === "challenger"`). Never a subtraction —
the floor can only raise the bar `select-adapter.js` was already going to apply.

---

## 5. Risk-aware routing

Risk-aware routing means: **the higher the risk class of the work, the higher the trust tier the
selected adapter must clear, and the more certain a producer role requires human approval** — never
the reverse, and never a silent downgrade.

`risk_class` comes from `detect-risk.js`'s existing `riskLevel` (`low|med|high|critical`), reused via
child-process invocation exactly like `router/classify-task.js#runRiskDetectInline` already does
(`spawnSync scripts/detect-risk.js`, parse JSON stdout) — **not re-implemented**, and
`detect-risk.js` is not modified by this lane (see §11's note on the one optional non-breaking
addition a future implementation could make).

| `risk_class` | Producer policy | Reviewer/challenger policy | `requires_human_approval` |
|---|---|---|---|
| `low` | `highest_verified_quality` | `independent_review` | `false` |
| `med` | `highest_verified_quality` | `independent_review` | `false` |
| `high` | `highest_verified_quality` | `independent_review` | `false` — `check-approval-needed.js`'s own halt logic is authoritative here and is never duplicated or bypassed by this layer |
| `critical` | `local_cli_only` | `independent_review` | `true` — matches `detect-risk.js`'s own `haltConditions` semantics (`env_secrets`, `wiki_handbook_docs`); the dispatch layer must refuse to auto-select a producer without approval |
| `unknown` (risk could not be computed) | `highest_verified_quality` | `independent_review` | `false` — fail-safe default: never more permissive than `low`, never silently escalated either |

This table is real, shipped data (`config/dispatch-policy.json#risk_class_routing`, §11) — not a
hardcoded `if/else` chain, matching this repo's config-over-code convention (`adapter-registry.json`,
`capability-taxonomy.json`, `alignment-risk-policy.json` are all declarative data files consumed by
small readers).

> **Discovered while validating this design against the live registry — a real, pre-existing bug,
> not introduced by this lane:** `router/select-adapter.js#isProviderLike()`'s heuristic
> (`/raw .*api key/i.test(adapter.authentication_mode)`) false-positives on **both** `claude-code`'s
> and `codex-cli`'s own `authentication_mode` strings, because each contains the literal substring
> "no raw API key" / "no raw OpenAI API key" while *denying* raw-key usage — the regex has no
> negation-awareness. Confirmed live: `node router/select-adapter.js --task-type code-feature
> --policy local_cli_only --json` returns `selected_adapter: null, eligible_adapters: []` against
> today's real `config/adapter-registry.json` — `local_cli_only`'s entire purpose ("prefer local CLI,
> exclude provider-api") is currently broken, because it excludes the local CLIs too. This lane does
> not fix `router/select-adapter.js` (out of scope — shared file, other Batch-1 lanes may be touching
> it concurrently) but **this design's own §5 table recommends `local_cli_only` for `critical`-risk
> producer routing, and that recommendation cannot work until this bug is fixed.** Recommended fix
> (not applied here): tighten the regex to not match a negated clause, e.g. require the authentication
> string to describe raw-key usage as *present*, not merely mention the phrase — or replace the
> heuristic with an explicit `is_provider_like: true/false` field on each adapter-registry row
> (more robust than regex-sniffing prose a human wrote for a different purpose). See
> `scripts/dispatcher.js`'s self-test #10 (`critical_risk_live_plan_requires_approval_and_tighter_policy`),
> which passes on its own stated assertions but honestly returns `selected_adapter: null` for exactly
> this reason — the test was deliberately left checking policy/approval fields rather than a non-null
> adapter, so it documents the real behavior rather than being loosened to hide it.

**The dispatch layer's `requires_human_approval` signal is advisory alongside
`check-approval-needed.js`, never a replacement for it** — exactly the same non-duplication posture
`select-adapter.js`'s own `requiresApproval`/`providerFallbackBlocked` fields already take toward the
mandate's 4-condition provider-api approval gate.

---

## 6. Worktree isolation

Per `docs/LOOP_ENGINEERING_ALIGNMENT.md`'s own honest status table: *"worktrees / isolation |
`/ce-worktree`, Superpowers `using-git-worktrees`, host `Agent isolation:worktree` | PARTIAL |
available via CE/SP/host, not harnesskit core."* This design closes that gap **in harnesskit core**,
Windows-native, with zero dependency on any host's worktree skill (so a future codex-cli or other
non-Claude host gets the same isolation guarantee).

Mapping from Outsourcerer's `--worktree` (per-crew-member isolated git worktree, never
auto-deleted, `cleanup` refuses to remove one with unmerged work unless `--force`):

- Only **producer** (`role:"producer"`) dispatches get a worktree — reviewer/challenger dispatches
  are read-only by contract (`write_access:"none"`, §2) and need no isolation from the target repo,
  since they never write to it.
- `worktree_path` is created via plain `git worktree add <path> -b <branch>` (child_process,
  `execFileSync`, no shell:true — same non-shell-injection discipline `codex-adapter.js` already
  established for untrusted content) at dispatch time, and recorded on the dispatch record.
- Worktrees are **preserved after the dispatch completes** (never auto-deleted) — same as
  Outsourcerer's stated behavior, and consistent with this very lane's own worktree
  (`<worktree-dir>/p8c-agent-dispatch`) never being deleted mid-task.
  Removal is a separate, explicit action (`git worktree remove`) that **refuses** to proceed if the
  worktree has unmerged/uncommitted work, unless a `--force` flag is passed — this is native `git
  worktree remove` behavior already, not new logic to build.
- **Built for real in the skeleton** (`allocateWorktree`/`releaseWorktree`, §11) — this is genuinely
  low-risk (only ever touches a fresh temp directory in self-tests, never the caller's real
  checkout) and directly operationalizes this section rather than leaving it as prose only.

---

## 7. Fallback behavior — `COMPLETED_WITH_FALLBACK`

Fallback triggers when the originally `selected_adapter` fails, times out, or errors **after** a
dispatch was already granted (not when `route()` simply finds no eligible adapter at all — that case
is `human_approval_needed`/`no_eligible_adapter`, unchanged, and never silently falls back to a
provider-api or a weaker adapter without approval, per the existing mandate).

Rule: on a `TIMEOUT`/`ERROR` terminal state for the originally selected adapter, the dispatcher may
re-run `route()` with `excludeAdapter: original_adapter_id` under the **same** policy (never a looser
one) and, if a new `full_match` is found, dispatch to it. The resulting record:

```jsonc
"lifecycle": { "state": "COMPLETED_WITH_FALLBACK", ... },
"fallback": {
  "attempted": true,
  "original_adapter_id": "codex-cli",
  "actual_adapter_id": "claude-code",
  "reason": "original adapter timed out after 240000ms (2 attempts)"
}
```

`COMPLETED_WITH_FALLBACK` is a **distinct, honest status** — it is never collapsed into plain
`COMPLETED` (which would hide that the plan changed mid-flight) and never silently retried under a
relaxed policy (which would hide a trust-tier downgrade). A caller reading dispatch records can
always tell "this ran exactly as planned" from "this ran, but not on the adapter originally chosen."
If no fallback adapter is found under the same policy, the terminal state stays `TIMEOUT`/`ERROR`
(honest failure), never a fabricated `COMPLETED_WITH_FALLBACK`.

---

## 8. Producer/reviewer separation, generalized from the real ART dogfood run

The real precedent: `loop-conductor.js#runCodexReview` is a hardcoded, Codex-specific
producer/reviewer separation — it always dispatches to `codex-cli` (via the resolved executable),
always in `read-only` sandbox mode, and its independence proof is purely "it's a different CLI
process" (no adapter-agnostic selection). This was proven for real in the HarnessKit Productization
Phase 1 dogfood run against an example target repository (9-round real Codex review, real defects
found and fixed).

**Generalization this design proposes** (conceptual — not applied to `loop-conductor.js` itself in
this lane):

```js
// conceptual future dispatchReview(runId, { producerAdapterId, taskType, targetArtifact })
function dispatchReview(runId, opts) {
  const routing = route({
    requiredCapabilities: ROLE_MIN_CAPS.reviewer,
    policy: 'independent_review',
    excludeAdapter: opts.producerAdapterId       // never the same adapter that produced the artifact
  });
  if (!routing.selected_adapter) return { ok: false, reason: 'no_independent_reviewer_available' };
  // dispatch to whichever adapter won — today that's still codex-cli most of the time (it's the
  // only quarantined-or-better adapter besides claude-code), but the SELECTION is now evidence-driven
  // (same honesty property select-adapter.js already proved for producer selection), not hardcoded.
}
```

The value: today, if a second real CLI adapter (`agy`, once investigated and promoted past
`untested`) becomes reviewer-eligible, `runCodexReview`'s hardcoded Codex-only path would need a
manual rewrite to consider it. A `dispatchReview` built on `route()` with `excludeAdapter` picks it
up automatically, the same way `execute-workflow.js`'s own adapter selection already does for the
producer side. This is **not built or wired in this lane** — it is the explicit generalization
recommendation, cited against the real file/function it would eventually replace.

---

## 9. Advisor panels and consensus — first-class dispatch primitive

This session has already used the *pattern* ad hoc (Fable-5 + Codex dispatched in parallel for
independent review) without a named primitive. This design promotes it to one:
`dispatchPanel(runId, { targetTaskType, panelSize, consensusRule })`.

Behavior, mapped from Outsourcerer's advisor-panel/consensus feature (multiple strong models review
a plan/diff simultaneously; proceeds only on consensus; a split returns to the human, never
auto-resolved):

1. Resolve `panelSize` independent reviewer dispatches via `route({ policy: 'benchmark_all', ... })`
   filtered to adapters that are `tier_ok` under `independent_review` (`minTier:1`) — i.e. every
   adapter capable of an honest second opinion, not just the single strongest one `independent_review`
   alone would pick.
2. Dispatch all of them **in parallel** (one is `panel_role:"primary"`, the rest `"challenger"`).
3. Collect verdicts (`PASS`/`REJECT`/`WARN`/`FAIL`/`ERROR` — reusing
   `workflow-state.js#VERDICT_VALUE_ALLOW` verbatim, not a new vocabulary).
4. Compute consensus via a **new, pure, real, self-tested function** in the skeleton
   (`computePanelConsensus`, §11):
   - All `PASS` → consensus `PASS`.
   - Any `REJECT`/`FAIL` → consensus `REJECT`, dissenting adapters named.
   - Anything else mixed (e.g. some `PASS`, some `WARN`, no `REJECT`) → consensus `SPLIT` —
     **never auto-resolved**, always escalated to a human decision point (matches Outsourcerer's
     explicit stated behavior exactly: *"treats a split as a signal to return to the human rather
     than auto-resolving it"*).

This is deliberately a **different, orthogonal** consensus mechanism from
`evaluator.js#evaluateIndependence` — that function answers "is this reviewer independent enough to
count at all," a structural/identity question; `computePanelConsensus` answers "given N independent
verdicts, do they agree," a content/agreement question. Both apply to the same panel dispatch; they
are not merged into one function, matching this repo's existing preference for narrow, named,
separately-testable checks over one collapsed boolean (`evaluator.js`'s own header comment states
this preference explicitly for its own three checks).

---

## 10. Cost / evidence receipt (honest "Tab", adapted concept)

Outsourcerer's "Tab" is two honest columns: real metered cash vs. subscription-quota usage, never
labeling a `$0` subscription lane as "free." HarnessKit's adapters mostly don't have per-token
billing the same way (`claude-code` is an authenticated CLI/app session, not a raw API key; `codex-cli`
similarly OAuth-based) — so the receipt concept is adapted, not copied literally, using evidence this
repo already has:

- **When real usage data exists** (`codex-adapter.js`'s `usage`/`usage_populated` fields, or
  `claude-code`'s `total_cost_usd` — already proven populated in the Gate-1 batch per
  `adapter-registry.json`'s own evidence_root, "$14.85 of $25 ceiling, zero estimation"): the receipt
  carries it verbatim, `evidence_state: "verified"`.
- **When no usage data is available** (most current CLI-adapter calls, per `codex-adapter.js`'s own
  comment: *"observed empty/zero on live Windows read-only-sandbox calls this session"*): the receipt
  says so explicitly — `evidence_state: "unverified"`, `tokens: null` — never a fabricated estimate.
- **The second honest column, adapted for this project**: instead of a cash-vs-subscription split,
  the receipt's second column is `trust_tier_at_dispatch` — the adapter's trust tier *at the moment of
  dispatch*, copied from `adapter-registry.json`. This is this project's actual second axis of
  "what did this dispatch really cost/risk," since trust-tier promotion here is git-history-paced
  (`scripts/validate-adapter-registry.js --check-transition`), not a token meter. A receipt never
  fabricates a promotion — the field is read-only evidence, never written back to the registry by the
  dispatcher.

Reuse discipline: `codex-adapter.js`'s `parseEventStream` (usage extraction) and
`normalizeResult`/`usage_populated` logic are **not duplicated** — a future real implementation of
`buildReceipt` reads those existing fields off whatever the adapter's own spawn function returned,
it does not re-parse event streams itself.

---

## 11. Skills/MCP portability — honest gap, not solved here

Outsourcerer's `--with skills=<name>` / `--with mcp=<name>` carries the user's own skills/MCP servers
to whichever engine runs the delegated job. For `claude-code` subagents this is already automatic —
skills are host-resident and a dispatched subagent inherits the same skill/plugin surface as the
main thread, no bridging needed. For `codex-cli` (or any future non-Claude adapter), **this is a real,
unsolved gap**: Codex has its own separate plugin/skill system (bundled plugins declared in
`~/.codex/config.toml`, confirmed present this session — browser, computer-use, documents, etc.), and
nothing in this repo bridges HarnessKit's own `config/skill-registry.json` skills into a Codex
invocation. This design does not solve it — it is named explicitly as a known limitation (§13), not
quietly assumed away.

---

## 12. Host/model/version/permissions/network evidence capture per dispatch

Fills `HOST_ADAPTER_CONTRACT.md` gap #11 at the dispatch level:

- **host / adapter / model**: already covered by the wrapped producer/reviewer stamp
  (`adapter_id`/`provider_id`/`model_id`/`model_observation_status`, unchanged from
  `actor-identity.js`).
- **version** (new): `host_identity.harness_version`, read from this repo's own `VERSION` file /
  `package.json#version` (currently `0.2.0-internal`) — not a new versioning scheme, just surfacing
  the existing one into dispatch evidence.
- **adapter contract version** (new): `host_identity.adapter_contract_version`, copied from the
  selected adapter's own `adapter_contract_version` field in `adapter-registry.json` (already exists
  on every row, e.g. `1` for all four adapters today — simply not surfaced anywhere before now).
- **permissions / network posture** (new, but sourced from existing data): `host_identity.permissions`
  and `host_identity.network_access` are copied **verbatim** from the matching entry in
  `config/capability-registry.json` (e.g. `claude-subagents`: `"read-only/inspect (single-writer
  rule; main agent writes)"` / `"gated"`) — never a new, independently-asserted permissions taxonomy.
  `network_posture_evidence_state` is `claimed` unless something actually observed network activity
  during the dispatch (nothing does today — stays `claimed`, never asserted `verified` without real
  evidence, matching this repo's evidence-state discipline everywhere else).

This is deliberately **not** the same as adding a `harnesskit identify` verb to `bin/harnesskit.js` —
that remains the larger, separate CLI-surface decision `HOST_ADAPTER_CONTRACT.md` names. This design
makes the *evidence* available per-dispatch; exposing it through a public verb is future, separate
work.

---

## Outsourcerer pattern-mapping table (explicit deliverable)

| Outsourcerer behavior (public, README-derived, real) | Windows-native / Node.js HarnessKit equivalent | Status |
|---|---|---|
| Multi-host/model routing (`sol`/`terra`/`luna`, `fable`/`opus`/`sonnet`/`haiku`, OpenRouter, Antigravity, Ollama, per-tier prompting) | `config/adapter-registry.json` + `router/select-adapter.js#route()` — already real, capability/trust-evidence-driven (not per-tier prompt templates; this project's routing axis is *evidence*, not *model tier naming*) | **Already exists**, reused unchanged |
| `fanout --agents ./crew --route '...' --worktree` | `dispatchPanel()` (§9) fans out N dispatches in parallel via `route({policy:'benchmark_all'})`; per-dispatch `worktree_path` via `allocateWorktree` (§6, §14) | Designed; `allocateWorktree`/`releaseWorktree` real in skeleton, `dispatchPanel` itself a stub |
| Advisor panels + consensus (proceed only on agreement; split → human) | `dispatchPanel()` + `computePanelConsensus()` (§9) | Designed + `computePanelConsensus` real/self-tested in skeleton |
| `bg`/`status`/`watch`/`result`/`logs`/`cancel` verb group; watchdog kills stalled delegate, reports last progress line; exit codes distinguish done/done-but-unverified/blocked | Dispatch `lifecycle.state` enum (§3) incl. `COMPLETED_WITH_FALLBACK` as the "done-but-not-as-planned" honest distinct status; cancellation via `TaskStop` (claude-code) / `taskkill /T /F` on the resolved PID (CLI adapters) (§3) | Designed; sync-mode monitor already works via `runWithTimeoutRetry`; async background mode named as future (not this lane) |
| `--worktree` per-crew-member isolation; never auto-deleted; `cleanup` refuses removal with unmerged work unless `--force` | `allocateWorktree`/`releaseWorktree` (§6, §14) — plain `git worktree add`/`remove`, no shell:true, no host-skill dependency | Real, self-tested in skeleton |
| Cost/subscription-quota "Tab" — two honest columns, never mislabels `$0` as free | Per-dispatch `receipt` — real usage/cost when populated (reuses `codex-adapter.js` usage fields, `claude-code`'s `total_cost_usd`) vs. `trust_tier_at_dispatch` as this project's actual second honesty axis (§10) | Designed; `buildReceipt` real/self-tested in skeleton |
| Skills/MCP portability (`--with skills=`/`--with mcp=`) | Automatic for claude-code subagents (host-resident); **unsolved** for codex-cli/other adapters (§11) | Named gap, not solved |
| Fallback lanes (`suggest`/`deals`, degrade to what's available) | `fallback` block + `COMPLETED_WITH_FALLBACK` (§7) — same policy, different adapter, never a silent trust downgrade | Designed; not built (needs live spawn wiring first) |
| Local/private models (Ollama/LM Studio, `$0`, nothing leaves the machine, `doctor` auto-detects) | Out of scope for this lane — `config/adapter-registry.json`'s `provider-api` row is "deliberately unpopulated" per the mandate's 4-condition gate; a local-model adapter would be a new adapter-registry row, not a dispatch-layer concern | Not addressed (correctly out of scope — adapter registration precedes dispatch) |

---

## 13. Exact files any future implementation would touch

New files this lane adds (see §14 for what's real vs. stub):
- `docs/AGENT_DISPATCH_MODEL_ROUTING.md` — this document.
- `scripts/dispatcher.js` — the skeleton.
- `config/dispatch-policy.json` — the risk_class→policy mapping data.

Files a **future wiring lane** would touch (none touched here):
- `scripts/execute-workflow.js` — to route stage execution through `dispatcher.js` instead of calling
  `route()` directly (the current `executeWorkflow`/`validateReviewIndependence` call sites, around
  lines 449-508 and 415-446 per this session's reading).
- `scripts/loop-conductor.js` — to replace `runCodexReview`'s hardcoded Codex path with the
  generalized `dispatchReview()` (§8).
- `scripts/lease.js` — to add a cancel/timeout → `releaseLease` hook (§3).
- `scripts/detect-risk.js` — **optional, non-breaking**: add `module.exports = { classifyRisk, ... }`
  so `dispatcher.js` can call it in-process instead of via `spawnSync`. Not required — the
  `spawnSync` pattern `classify-task.js` already uses is sufficient and zero-risk.
- `bin/harnesskit.js` / `docs/HOST_ADAPTER_CONTRACT.md` — to eventually add `cancel`/`identify` verbs
  at the *workflow* level, once the *dispatch*-level mechanics this design describes have been built
  and proven. Explicitly a later, separate CLI-surface decision.
- `scripts/security-boundary.js`'s `scanBeforeEvidencePersist` call site — dispatch-evidence writes
  (receipts, host-identity records) are a new real candidate (see Security Broker cross-reference,
  Integration Order below).

---

## 14. What's real vs. stub in `scripts/dispatcher.js`

Built for real, with `--self-test` passing, zero process spawning, zero pipeline wiring:

- `resolveRequiredCapabilities({ taskType, role, panelRole })` — pure; applies the role floor (§4.2)
  over `select-adapter.js#TASK_TYPE_CAPABILITIES`.
- `selectRoutingPolicy({ riskClass, role })` — pure; reads `config/dispatch-policy.json` (§5).
- `buildDispatchPlan(opts)` — pure; composes the two functions above and calls the real, unmodified
  `route()` from `router/select-adapter.js`. This is a genuinely complete, working routing-plan
  builder — it stops short only of *acting* on the plan (no spawn).
- `computePanelConsensus(verdicts)` — pure; PASS/REJECT/SPLIT logic (§9).
- `buildReceipt({ adapterResult, adapterId })` — pure; assembles the honest two-column receipt (§10)
  from whatever usage/cost fields the caller's adapter result already carried.
- `validateDispatchRecord(record)` — pure; allowlist-gate validation of the full dispatch shape (§1),
  mirroring `actor-identity.js#validateStamp`'s pattern for this richer shape.
- `allocateWorktree({ repoPath, dispatchId, baseRef })` / `releaseWorktree({ worktreePath, force })` —
  real `git worktree add`/`remove` via `execFileSync`, no `shell:true`, self-tested against a real
  temp git repo created and destroyed within the test itself (never touches the caller's real repo).

Left as explicit stubs (`throw new Error('not yet implemented — see
docs/AGENT_DISPATCH_MODEL_ROUTING.md §<n>')`), because each requires either live process actuation,
a host-side tool call this Node script cannot make itself, or wiring into another file this lane is
explicitly not allowed to touch:

- `spawnDispatch(plan)` — needs adapter-specific actuation. For `claude-code`, that's a literal
  host `Task`/`Agent` tool call — the exact same structural fact `loop-conductor.js`'s own header
  comment already states for its stages ("Model-authored stages are HOST handoffs — a Node script
  cannot invoke /ce-* skills"). For `codex-cli`, it would delegate to
  `codex-adapter.js#reviewReadOnly`/`implementBounded` — real, existing, working functions — but
  wiring that call is deliberately left to a future lane, matching this task's own instruction that
  "wiring into bin/harnesskit.js or any other file" is separate, later work; the same restraint
  applies to wiring a first real spawn path here.
- `monitorDispatch(dispatchId)` — needs live PID/hook state to watch.
- `collectDispatch(dispatchId)` — needs a real completed process/hook result to normalize.
- `cancelDispatch(dispatchId, reason)` — needs a real PID or a real `TaskStop` call (§3).

This split is deliberate, not a shortcut: every stub is something that *cannot* be honestly faked
with a passing self-test (it would either lie about spawning a process or silently couple this lane
to files it isn't scoped to touch), while everything marked real is genuinely complete, tested,
and side-effect-free outside of `allocateWorktree`'s own self-test temp directories.

---

## Known limitations

0. **`router/select-adapter.js`'s `local_cli_only` policy is currently non-functional** (see the
   callout in §5) — its `isProviderLike()` false-positives on both real CLI adapters' own
   `authentication_mode` prose, so it excludes everything. This is a pre-existing bug this lane
   discovered but does not fix; §5's `critical`-risk producer routing recommendation depends on it
   being fixed first. Flagged as limitation zero because it is the one item here that blocks a
   design recommendation from working today, not just an unbuilt future extension.
1. **No live spawn path for any adapter.** This is the single biggest honest gap — the design is
   complete, but zero bytes of actual process actuation exist. A future lane must wire at least one
   real `spawnDispatch` path (codex-cli is the obvious first target, reusing `codex-adapter.js`
   unchanged) before any of this is more than documentation-plus-pure-helpers.
2. **Skills/MCP portability to non-Claude adapters is unsolved** (§11).
3. **Async/background CLI dispatch mode (Outsourcerer's `bg`/`status`/`watch`) is not designed in
   depth** — today's only CLI adapter is synchronous, so there was no live need to design polling
   semantics beyond naming it as a future extension point.
4. **`agy` adapter has zero capability rows populated for review/challenger roles beyond `claimed`**
   (per `adapter-registry.json`) — it cannot participate in `dispatchPanel()` under
   `independent_review`'s `minState:2` bar until it accumulates real evidence; this design does not
   change that bar to admit it prematurely.
5. **The dispatch record's `network_posture_evidence_state` will realistically stay `claimed`
   indefinitely** until something in this repo actually instruments network activity per-dispatch —
   named honestly rather than implying a false near-term fix.
6. **This design does not itself enforce anything** — like every other config/mechanism cited above
   (`adapter-registry.json`, `capability-registry.json`, `capability-taxonomy.json`), it is
   advisory-only until a future lane wires `dispatcher.js` into a real call site.

## Recommended independent reviewer

`ce-architecture-strategist` — this is a structural/design-integrity review (pattern compliance
against the existing adapter-registry/select-adapter/review-independence architecture, not a
diff-correctness review), matching that agent's stated scope exactly.

## Integration order

Review this design at the **Stage-1 exit gate**, alongside:
- **Security Broker Architecture** (`hk/p4-security-brokers`) — mutually constraining specifically
  because dispatch-evidence persistence (receipts, host-identity records, §10/§12) is a real new
  candidate call site for `scanBeforeEvidencePersist` (the security-boundary scan
  point #4, currently unwired). Whichever design lands its evidence-persist boundary first should
  define the call shape the other conforms to, not duplicate it.
- **Install/Config design** (`hk/p9b-install-config`) — mutually constraining because
  `config/dispatch-policy.json` (§5/§11, new in this lane) needs to be accounted for in whatever
  install/config manifest enumerates HarnessKit's shipped config files, and because any future
  adapter/host identification (§12) touches the same "what's installed, what version" surface an
  install/config design would also need to answer.

Both sibling worktrees are at baseline `f03525a` as of this writing (no commits ahead yet), so no
specific file-level conflict exists today — the constraint above is about review sequencing and
shared concepts, not a merge conflict.
