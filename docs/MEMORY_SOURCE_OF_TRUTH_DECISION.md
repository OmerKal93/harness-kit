# Memory Source-of-Truth Decision: `facts.ndjson` / `structured-memory.js`

> Lane: `hk/p7a-memory-model` (Batch 1 Foundation, decision lane — no capture-side code touched).
> Status: **DECIDED.** Gates any future `capture-fact.js` auto-wiring and the GBrain-completion track.

## 0. Why this decision exists

`scripts/structured-memory.js` (Batch 5a) plus its siblings (`capture-fact.js` 5b, `read-facts.js` 5c,
`search-memory.js` 5d integration, `build-context-pack.js` 5e integration, `propose-fact-candidates.js`
5f) form a fully-built, fully-self-tested NDJSON fact store. **Retrieval is wired** (`loop-conductor.js`
`startRun()` calls `searchStructuredFacts()` unconditionally on every real run, line 52; `build-context-pack.js`
has an opt-in `## Structured Memory Facts` section). **Write is not wired** — nothing in the harness calls
`capture-fact.js`; `memory/facts.ndjson` does not exist on disk in this worktree. Meanwhile a completely
separate, external system — **GBrain** (bun-based, lives at `~/gbrain`, wrapped by `scripts/gbrain-doctor.js` /
`gbrain-query-memory.js` / `gbrain-export-curated.js`) — is HarnessKit's other "memory" story. The two
have **zero mutual references** in either direction today. If `capture-fact.js` gets wired up before this
question is settled, HarnessKit ends up with two competing, uncoordinated "memory" systems by accident.
This document settles the question before that happens.

## 1. Decision

**`facts.ndjson` / `structured-memory.js` is role (a): a local, deterministic event/evidence journal that
feeds GBrain.** It is not (b) a GBrain-outage fallback, not (c) short-lived staging, and not (d) legacy.

### Reasoning, grounded in what's actually in the repo

1. **The repo has already made this call once, in prose, and never acted against it.**
   `docs/EXTERNAL_TOOL_INTAKE.md` (Memory Tool Policy section) states, unconditionally: *"Structured
   NDJSON memory remains the canonical local substrate for now"* and *"No external memory tool may
   replace the local facts store without an explicit migration plan"* and *"Codebased Memory MCP must
   not replace `structured_memory_capture` / `structured_memory_read`."* That is already option (a)'s
   framing — a local substrate that persists and matters regardless of what external tools (including
   GBrain) exist — not a fallback, not staging, not legacy.

2. **A promotion pathway already exists in skeleton form — for markdown memory, not facts, but the
   pattern is exactly "local capture → curate → stage → human-reviewed import into GBrain."**
   `scripts/gbrain-export-curated.js` already implements: read `config/gbrain-import-policy.json`'s
   `harness_allowlist` → path/content blocklist → trust-level computation → poisoning scan → global
   redaction → write to a staging dir → emit a human-reviewable diff report (`gbrain-import-diff.md`)
   with a "Verification checklist for the owner (G2 review)" — and it explicitly does **not** call
   upstream `gbrain import` itself. That is a feeder pipeline into GBrain, already built, already gated
   on human review. `memory/facts.ndjson` is conspicuously **absent** from `harness_allowlist` today
   (only `memory/*.md` and `learnings-index.json` are listed) — meaning the feeder exists but hasn't
   been extended to facts yet. Choosing role (a) says: extend that same pipeline to facts later, don't
   invent a second one.

3. **Both systems already speak the same "evidence, not authority" language, independently.**
   `config/capability-registry.json`'s `gbrain` entry declares `"output_contract": "evidence candidates
   (never authority)"`. `structured-memory.js`'s schema independently carries `confidence` (0–1),
   `trust_tier`, and full source provenance on every record — the same "this is evidence, weigh it,
   don't trust it blindly" posture, arrived at separately. A journal that captures rigorously-provenanced
   local evidence, destined to be curated into a bigger evidence store, is a natural fit for a system
   that already treats its own bigger store as non-authoritative.

4. **The schema's own stated purpose is journal-shaped, not fallback- or staging-shaped.**
   `docs/STRUCTURED_MEMORY_SCHEMA.md`: *"so that future batches can do at write time what prose memory
   cannot: detect staleness, detect contradiction, carry provenance, and supersede/retract facts instead
   of letting them rot."* That's describing a durable, append-only record of claims-with-evidence — a
   journal — not a temporary buffer (rules out (c)) and not something meant to sit inert waiting for an
   outage (rules out (b), see §2). It was built two weeks before this decision with real validation,
   real poisoning-scan integration, and 11/11–13/13 self-tests across every module — this is not
   abandoned or accidental work (rules out (d)).

5. **Ruling out (b) specifically:** the capability registry already assigns the fallback role to
   something else. `gbrain`'s own registry entry (`config/capability-registry.json`) declares
   `"fallback": "learnings-index + search-memory.js"` — i.e., the harness's own documented answer to
   "what do we use when GBrain is down" is the **prose learnings index**, not `facts.ndjson`. Making
   facts.ndjson *also* a GBrain fallback would create two fallback stories for the same failure mode,
   with no rule for which one a caller should prefer. Don't do that — see §3 for what actually happens
   when GBrain is absent.

## 2. GBrain-absent behavior (fresh/second machine, no `~/gbrain` at all)

**The chosen role does not change based on GBrain's presence or absence.** The journal's job — capture
locally-verifiable evidence with full provenance — is exactly as useful with GBrain permanently absent as
with it present; nothing about "detect staleness, carry provenance, supersede/retract" depends on GBrain
existing. What changes is only the *downstream consumer*:

- **With GBrain present:** curated, human-reviewed facts eventually get promoted through the (to-be-extended)
  `gbrain-export-curated.js` pipeline, same as markdown memory today.
- **With GBrain absent (including permanently, on a machine that will never run it):** there is no
  promotion destination. Facts still accumulate locally, still get searched via `search-memory.js`
  (`--include-structured` / `HK_STRUCTURED_MEMORY=1`) and surfaced in the context pack
  (`--include-structured-memory`), still get read/verified via `read-facts.js`. This is already exactly
  how the code behaves today — every module degrades to `[]`/empty output on a missing store or missing
  GBrain, never crashes (`gbrain-doctor.js`'s own comment: *"degrades gracefully... if bun or ~/gbrain
  aren't reachable"*; `doctor.js`'s `checkGbrainRuntime` reports `DEGRADED`, never `BLOCKING`).

**`facts.ndjson` does NOT become "the only memory" / a GBrain replacement when GBrain is absent.** It
structurally can't fill that role: it has no semantic/embedding retrieval (substring match only, by
explicit design — see `config/gbrain-import-policy.json`'s `"embedding_mode": "keyword_only"` note and
`STRUCTURED_MEMORY_SCHEMA.md`'s "graph/vector are explicitly out of scope until structured records prove
insufficient"), and it is fact-record-shaped (one atomic claim per line) rather than prose-shaped. The
already-declared, already-correct fallback for "GBrain is down/absent, what do I search" is the prose
memory tier (`learnings-index.json` + `personal-patterns.md`/`recurring-failures.md`/etc. via
`search-memory.js`'s default, non-opt-in behavior) — confirmed by the capability registry's own
`fallback` field for `gbrain` (§1.5). `facts.ndjson` keeps doing its own job — provenanced local
capture — in parallel, on every machine, with or without GBrain, and is surfaced as an *additional*,
clearly-labeled opt-in section, never as a silent substitute for what GBrain would have returned.

## 3. Embedding-provider question: **out of scope**, and why

GBrain's `overall_score` is 10/100 partly because `embedding_mode: "keyword_only"` — no remote or local
embedding provider is wired in (`config/gbrain-import-policy.json`: *"BM25 + RRF only. No remote embedding
API call. Vector mode... deferred to a future phase decision."*). This is explicitly **out of scope** for
this decision:

- It is a question about **GBrain's own internal retrieval implementation** — an external tool that
  lives in a separate repo (`~/gbrain`, bun-based) that this HarnessKit repo does not own, build, or
  modify. Zero embedding-provider code exists anywhere in this repo.
- Resolving it doesn't gate anything decided here. The promotion relationship this document establishes
  (§1.2) operates at the **curated-document layer** — `gbrain-export-curated.js` stages redacted markdown
  pages for human-gated import — which is agnostic to whether GBrain's *own* internal query engine is
  keyword-only or embedding-based. Whether GBrain gets vector search someday doesn't change what a fact
  looks like when staged for import, and it doesn't change the journal's local role either way.
- Conversely, this decision doesn't gate the embedding-provider question. GBrain could add an embedding
  provider tomorrow with zero changes to `structured-memory.js`, `capture-fact.js`, or this document.

They are genuinely independent axes; naming this explicitly is meant to stop the two questions from
getting silently merged in a future planning pass.

## 4. Specification (given the chosen role)

### 4.1 Deduplication

No embeddings exist here (by design — see §2), so dedup is **exact/near-exact keyword-level only**, at
capture time, in `capture-fact.js` (not implemented in this lane — specified for the gated future work):

- Normalize the candidate `claim` (lowercase, collapse whitespace, strip terminal punctuation) and compare
  against **active** records only (never against `superseded`/`retracted`/`archived` — a fact is allowed
  to be re-asserted after it was retracted for an unrelated reason).
- Match = normalized claim equality **and** `mentions` set overlap ≥ 1. On match: reject by default
  (`rejected_reason: "duplicate_active_fact"`, carrying the existing fact's `id`), mirroring the existing
  `--allow-source-mismatch` override pattern with a symmetric `--allow-duplicate` flag for the rare
  legitimate re-capture-from-a-different-source case.
- **Known, accepted limitation:** two differently-worded claims about the same thing will not be caught
  (no semantic similarity available). This is a real gap, not a hidden one — acceptable because the
  volume here is human-gated, low-frequency capture, not high-volume ingestion.
- Dedup is **not** re-run at the GBrain-promotion boundary beyond "only promote `state: active` facts,
  one row per fact `id`" — `gbrain-export-curated.js`'s existing content-blocklist/poisoning layers are
  the right place for any promotion-time filtering, not a second dedup pass.

### 4.2 Promotion path into GBrain

Not automatic, not scheduled — matches `gbrain-import-policy.json`'s existing
`"scheduling": "manual_only"` / `"scheduling_forbid": ["cron","sync_watch","fs_watch","autopilot"]`.

- **Eligibility:** `state === "active"` only, and `trust_tier` not in the tiers already forbidden for
  import (`policy.trust_levels_forbidden_in_phase_3b`, currently `["untrusted_external"]`) — reuse the
  existing forbidden-tier check in `gbrain-export-curated.js`, don't invent a parallel one.
  `superseded`/`retracted`/`archived` facts are never promoted.
- **Mechanism (future work, not built in this lane):** extend `config/gbrain-import-policy.json`'s
  `harness_allowlist` with a facts-aware entry, and give `gbrain-export-curated.js` (or a small sibling
  adapter) a mode that renders each eligible fact as one staged page (claim + provenance in frontmatter,
  `trust_level` injected exactly as it already does for `.md`/`.json` today) into the **same** staging →
  diff-report → G2-human-review pipeline that markdown memory already uses. No new approval mechanism.
- **Promotion bookkeeping without violating append-only:** do **not** re-append or mutate a fact's own
  record to mark it promoted. Track promotion in a separate small sidecar index
  (e.g. `memory/facts-promoted.ndjson`, one line per `{fact_id, promoted_run_id, promoted_at}`) so the
  facts journal itself stays a pure claims log and promotion state stays a separate, equally append-only
  concern. This keeps `readFactRecords`/`filterActiveFacts` untouched.

### 4.3 Retention policy

- **Default: never delete a line.** Append-only is the whole point (crash-safe, diff-friendly, auditable).
  Retracted facts are especially not to be deleted — the retraction event (e.g. a claim that was later
  caught by the poisoning scanner) is itself security-relevant audit evidence, consistent with this repo's
  redact-don't-delete posture everywhere else (`redact.js`, `gbrain-export-curated.js`'s redaction layer).
- **Visibility is pruned by `state`, not deletion.** `filterActiveFacts` already does this correctly.
- **Operational rotation (future, not needed yet — the store is empty today):** once `facts.ndjson`
  is real and large, a manual, human-triggered compaction — moving `superseded`/`retracted`/`archived`
  lines older than N months into a dated rollup file (`facts-archive-2026H1.ndjson`) — keeps the live file
  small without ever deleting history. Specified here so it isn't invented ad hoc later; explicitly not
  built now (YAGNI while the file doesn't exist).

### 4.4 Provenance requirements

Keep the existing schema exactly as-is — it is already correctly strict and should not be weakened:
`source_path`, `source_sha256` (64-hex), `trust_tier`, `captured_run_id`, `confidence` ([0,1]),
`created_at` remain mandatory on every record (`REQUIRED_FIELDS` in `structured-memory.js`). No new
required field is being added by this decision. This document does **not** recommend adding a
`promotable` boolean or similar — the sidecar index in §4.2 already carries that concern without touching
the fact schema.

### 4.5 Freshness / supersession handling — **a real gap found while researching this decision**

The schema defines `supersedes` (id of the fact a new record replaces) and a `superseded` state, but
**nothing in the current code ever resolves this.** Verified directly: `grep -rn "supersedes"
scripts/*.js` returns exactly one hit outside `structured-memory.js` itself (the schema doc) — no read
path (`read-facts.js`, `search-memory.js`, `build-context-pack.js`) ever walks the `supersedes` graph or
excludes a fact because a newer record points back at it. Today, the *only* way an old fact's record shows
`state: superseded` is if a human manually captures a second line with the same `id` and that state — which
nothing currently prevents or requires, and which `filterActiveFacts` was never designed to reconcile
across duplicate ids.

**Resolution specified here (for the future capture/read wiring to implement, not built in this lane):**
- An `id` appears in the store **exactly once, ever** — never re-appended. This keeps "id" a clean primary
  key with no last-write-wins ambiguity.
- Supersession is expressed **purely via the new fact's `supersedes` pointer** — capturing fact B with
  `supersedes: A` is the only action needed; A's own record is never touched or duplicated.
- "Effective active facts" (what every read path should actually return) = records where
  `state === "active"` **AND** `id` does not appear as the `supersedes` value of any other record in the
  store. This is a small, pure addition to `filterActiveFacts` (and the equivalent filtering in
  `search-memory.js` / `build-context-pack.js`) — currently absent. **This must land before any real
  capture-fact.js wiring goes live**, or supersession will silently not work (an old, superseded claim
  will keep showing up as active forever).

### 4.6 Conflict resolution: `facts.ndjson` vs. GBrain disagree about the same fact

Both are already, independently, declared "evidence, never authority" (§1.3) — so the answer is **surface
the disagreement, never silently auto-resolve it**:

- Today this is a forward-looking concern, not a live bug: `memory/facts.ndjson` is absent from
  `harness_allowlist`, so no fact has ever reached GBrain yet, and `search-memory.js` / `gbrain-query-memory.js`
  are two entirely separate, never-merged code paths — there is no existing single ranked list where a
  silent overwrite could even happen.
- **Recommendation for when promotion exists:** keep the two surfaces side-by-side in any output that
  shows both (e.g. a context pack), each clearly labeled with its source, rather than merging them into
  one ranked answer. A local fact carries something GBrain content (once staged/redacted/imported) no
  longer does: a live-checkable `source_sha256` back to a real file on *this* machine, verifiable right
  now via `read-facts.js`'s `verifySources()`. That verifiability is a reason to keep the local fact
  visible next to a GBrain hit, not a reason to silently prefer one over the other by fiat.
- There is already a structural home for detecting this automatically, if this project wants it later:
  `scripts/detect-context-drift.js` already implements a generic `doc_code_conflict` pattern — "two
  sections share a `mentions` identifier without an explicit `conflict_resolution`" — against a
  provenance-tagged JSON context pack. `build-context-pack.js`'s structured-facts section already emits
  `mentions`/`trust_tier`/`source_path`/`source_sha256` per fact. Pointing `detect-context-drift.js` at a
  JSON (not markdown) variant of the pack would let it flag a facts-vs-GBrain `mentions` collision using
  a validator that already exists — but `detect-context-drift.js` is itself explicitly not fed anything
  live today (its own header: *"nothing in the live `/harness-run` flow feeds this detector"*), so this is
  named as a future option, not built here.

## 5. Honest disclosures / uncertainty

- **The supersession gap (§4.5) is a real finding, not a hypothesis** — verified by direct grep, not
  inferred. I'm confident in the diagnosis (no code resolves `supersedes`); I'm less certain the exact
  fix I specified (exclude-if-referenced-by-another's-`supersedes`) is the only reasonable design — an
  alternative (allow same-`id` re-append, last-line-wins) was considered and rejected here for cleanliness,
  but a reviewer may weigh that trade-off differently.
- **The promotion mechanism in §4.2 is a plausible extension of `gbrain-export-curated.js`, not a verified
  one.** I did not attempt to build or prototype the facts-aware adapter; whether "one staged page per
  fact" is the right shape (vs. one page for all active facts, or some other batching) is a genuine open
  design question for whoever builds it.
- **Retention/rotation thresholds (§4.3) are unvalidated** — there's no real data in `facts.ndjson` yet
  (the file doesn't exist), so the "N months" rotation trigger is a placeholder for a future decision, not
  a calibrated number.
- **Whether `capture-fact.js` ever actually gets wired to real call sites is a product decision, not
  settled by this document.** This document settles *what facts.ndjson is for, given that it is used* —
  it does not argue that it must be wired up on any particular timeline.
- I did not have live access to `~/gbrain`'s actual current state (bun installed or not, doctor output) on
  this machine while writing this — all GBrain behavior claims here are grounded in reading
  `gbrain-doctor.js`/`gbrain-query-memory.js`/`doctor.js`'s code and comments, not a live run.

## 6. Recommended independent reviewer

**`ce-data-integrity-guardian`** — this document makes a data-model correctness claim (§4.5, the
unresolved `supersedes` graph) that is exactly that reviewer's specialty (migration/data-model safety,
constraint correctness, persistent-data review). Recommend a pass specifically on §4.5 and §4.2 (the
append-only-vs-promotion-bookkeeping split) before either is implemented.

## 7. Integration-order note

This decision **gates two downstream tracks**, in this order:

1. **Any future `capture-fact.js` wiring** (auto-capture call sites, real writes to `memory/facts.ndjson`)
   — must implement the dedup (§4.1), promotion eligibility (§4.2), and — critically — the supersession
   fix (§4.5) *before* going live, or the store will silently accumulate facts that look permanently
   active even after being superseded.
2. **The GBrain-completion track's own acceptance criteria** — that track cannot define "done" for
   GBrain integration without knowing what `facts.ndjson`'s role is (this document), since GBrain's
   completion criteria plausibly include "receives promoted facts from the local journal" (§1.2, §4.2).
   Sequence: **this decision → capture-fact.js wiring (with §4.5 fixed) → GBrain-completion track's
   promotion-pipeline work (§4.2)**, not the reverse.

No code in `scripts/` was modified to produce this document. This is a design/decision artifact only.
