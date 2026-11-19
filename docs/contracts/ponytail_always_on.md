# Component Contract — `ponytail_always_on`

> M2b contract. **Brutally honest: this component is `planned` / effectively `missing` today — it does
> NOT exist as running code.** `/harness-loop` does **not** invoke Ponytail during writing; there is no
> writing-time compactness governor. The only Ponytail-adjacent code is the arithmetic `ponytail_budget`
> helper, which no caller fires in `--run`. This contract defines the *desired* implementation-time
> governor; it wires nothing and invokes nothing.

## 1. component_id
`ponytail_always_on`. Relatives: `ponytail_budget` (arithmetic gauge, `helper_only`) ·
`ponytail_review_skill` (the real `/ponytail-review`, never invoked) · this one is the desired
**writing-time** enforcer that combines them and runs *during* the `implementation` stage.

## 2. Purpose
A compactness governor active throughout `implementation` that constrains writing **before/during** edits —
catching scope creep (files, lines, new abstractions, new dependencies) at write-time rather than only
after the fact — and emitting a verdict that can shrink, block, or redirect the change.

## 3. Interface
**Desired (not built):**
`ponytailGovern(state, change = { files, lines, new_abstractions, new_deps }) → { verdict, reason, target_stage }`
- `verdict`: `"PASS"` | `"WARN"` | `"SHRINK"` | `"BLOCK_EXPANSION"`.
- `target_stage`: where a non-PASS sends the run — `"planning"` (scope wrong) | `"implementation"` (repair the diff).
- On a recorded verdict it **appends** to `reviewer-verdicts.ndjson` (via `appendVerdict`) and the
  conductor writes its routing decision to `decision-log.ndjson`.
**Today:** no interface — no function, no caller, no host directive.

## 4. Inputs
The in-progress change: `change.files`, `change.lines` (real counts, e.g. from `git diff --numstat`),
`change.new_abstractions`, `change.new_deps`; the workflow `state.budget` thresholds; current stage
(must be `implementation`). Optionally a `/ponytail-review` pass on the working diff (host action).

## 5. Outputs
- A verdict record appended to `runs/<id>/reviewer-verdicts.ndjson` (reviewer `ponytail_always_on`).
- A conductor routing entry in `runs/<id>/decision-log.ndjson` (which `target_stage`, why).
- A control signal that either lets the write proceed (`PASS`/`WARN`) or pauses it
  (`SHRINK`/`BLOCK_EXPANSION`). **Today: no outputs — component does not run.**

## 6. State fields touched
**Desired:** appends `reviewer_verdicts[]` (via `appendVerdict`); the conductor transition writes the
`decision-log.ndjson` line; reads `state.budget` + `state.stage`. **Today: none.**

## 7. Gates
`ASK_BEFORE_EXPANSION` when over budget / new abstraction / new dep → **`BLOCK_EXPANSION`**; `WARN` is
`REPORT_ONLY`; `PASS` `NO_GATE`. Honest caveat: the numeric part (`ponytail_budget`) is **advisory**
today (no enforcer); a `/ponytail-review` pass is a **host** action, not code-enforced. So "always-on
enforcement" is aspirational until both a write-stage caller and a record-verdict path exist.

## 8. Executor
`host+node` — Node computes diff counts + runs the budget arithmetic (`ponytail_budget`); host optionally
runs `/ponytail-review` on the working diff (`ponytail_review_skill`). **No executor runs today.**

## 9. Invocation contract (external components only)
The host-skill half reuses `ponytail_review_skill`'s contract (`/ponytail-review` on a diff) — see that
contract; **unverified in this role** (never invoked at write-time). The Node half is a local function,
no external process. No verified invocation exists for this component yet.

## 10. Failure modes
- **Primary (current):** does not exist → silent over-budget writes; scope creep caught late or never.
- Caller passes stale/zero diff counts → false `PASS` (inherits `ponytail_budget`'s trust-the-caller flaw).
- Host skips the `/ponytail-review` directive → only the numeric gate runs (weaker).
- Mis-routing: `target_stage` sends a scope problem to `implementation` (or vice-versa) → wasted loop.

## 11. Repair behavior
**Desired:** `SHRINK`/`BLOCK_EXPANSION` → pause the write; route by issue type — wrong **scope** →
`target_stage:"planning"` (re-plan smaller); over-budget **diff** → `target_stage:"implementation"`
(shrink the change) under `ASK_BEFORE_EXPANSION`. `WARN` → proceed, log. Bounded by `max_repair_loops`
→ `escalation` when exhausted. **Today: none.**

## 12. Acceptance tests
- **Exists:** `ponytail_budget`'s `--self-test` (over-budget → `BLOCK_EXPANSION`, under → `PASS`) covers the
  numeric core only.
- **Needed (none exist):** (a) at `implementation`, real diff counts are computed + governed; (b) a
  `SHRINK`/`BLOCK_EXPANSION` actually pauses the write and records a verdict; (c) routing test —
  scope issue → `planning`, diff bloat → `implementation`; (d) a recorded line lands in both
  `reviewer-verdicts.ndjson` and `decision-log.ndjson`.

## 13. DISABLED behavior
**Desired:** when the kill switch is on, the governor no-ops (no host call, no spawn) like other `--run`
steps — writing proceeds ungoverned with a logged note. **Today:** N/A — nothing runs regardless.

## 14. Work-state
- **current:** `contract_drafted` (was `planned`/`inventoried`; enforcement **missing**, hooks dormant).
- **desired:** `enforced` — active at every `implementation` write, governing before/during edits.
- **Honest gap:** there is **no writing-time governor**. "Ponytail always-on during writing" in past docs
  = the arithmetic `ponytail_budget` only, and even that has no caller in `--run`. This component is the
  plan to make that real; M2b only contracts it.

## Relation to siblings & stages
- **`ponytail_budget`** — the numeric engine this governor *calls* (files/lines vs budget). Reused, not replaced.
- **`ponytail_review_skill`** — the qualitative `/ponytail-review` pass this governor *may* invoke on the
  working diff for abstraction/over-engineering smell the arithmetic can't see.
- **`final_review`** — distinct stage: `ponytail_review_skill` reviews the **final** diff *after* writing;
  `ponytail_always_on` governs **during** writing. They are complementary, not duplicates — write-time
  prevention vs end-of-change check.

## 15. Smallest next slice
At the `implementation` write directive, add a required pre-step: compute real changed files/lines (e.g.
`git diff --numstat`) and run `ponytail_budget`; on `BLOCK_EXPANSION`, pause for `ASK_BEFORE_EXPANSION`
and record a `ponytail_always_on` verdict. (Defer the `/ponytail-review` qualitative pass + scope/diff
routing to a later slice.) Named here; **not implemented in M2b.**
