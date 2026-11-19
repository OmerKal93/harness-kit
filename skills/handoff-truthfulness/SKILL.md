---
id: handoff-truthfulness
name: HarnessKit Handoff Truthfulness
version: 0.1.2
description: Use when a run, batch, or session ends and a handoff summary must be written, or when an existing summary needs a claims-vs-evidence audit.
category: reporting
status: experimental
owner: owner
source_of_truth: this file
allowed_tools: [Read, Grep, Glob, Bash]
forbidden_tools: [Edit, Write, WebFetch, WebSearch]
risk_level: low
requires_approval: false
implicit_invocation_allowed: false
evidence_required: true
rollback: delete skills/harnesskit/handoff-truthfulness/ and remove this record from config/skill-registry.json (and the skill-handoff-truthfulness eval category if later added)
deprecation_policy: supersede-by-id; tombstone retained one batch
last_reviewed_at: 2026-07-04
security:
  trust_level: generated
  file_write_scope: none
  network_permission: none
  secret_handling: redact-always
  external_content_handling: not-applicable
  prompt_injection_exposure: reads-untrusted
  required_evals: [task-success, refusal]
  required_human_approval_conditions: [any memory/learning capture, enable-state flip]
---

# HarnessKit Handoff Truthfulness

> **Installed, QUARANTINED. Not enabled. Not yet evaluated (SKILL-2 pending).**
> Origin: SKILL-0 draft (`docs/plans/skill-0-drafts/handoff-truthfulness.SKILL.md`),
> installed per `docs/plans/SKILL-1A-handoff-truthfulness-install-plan.md`. Primary
> source contract: `docs/contracts/handoff_summary.md`.

## Purpose

Emit or audit an end-of-work handoff in which every claim anchors to recorded evidence:
commits (SHA), verification (verdict ID + provenance), state changes (decision-log event),
or files (git numstat). Unsupported "done / verified / safe / complete" claims are
downgraded, never asserted. Truthful continuity beats an impressive summary.

## Trigger phrases

"write the handoff" · "wrap up the run" · "summarize what happened" · run reaches DONE /
BLOCKED / NEEDS_USER · session ending mid-work · "audit this handoff" / "audit this report".
**Explicit invocation only — no implicit/automatic trigger, no aliases.**

## When to use

- Every run/batch close — a run without a truthful handoff is not closed.
- Session about to end or compact — the handoff is the continuity artifact.
- Auditing a past report against its evidence (AUDIT mode).

## When NOT to use

- Mid-implementation status pings — too heavy; a one-line status suffices.
- As a substitute for verification — the handoff REPORTS verification; it never performs it.
- Any request to make a handoff "sound better" than its evidence supports.

## Hard boundaries

- **Emit-only.** `file_write_scope: none`. `Edit` and `Write` are forbidden tools. The
  skill produces text; the host/human saves it. No run-folder write in this version.
- **Bash is restricted** to exactly: read-only git (`git log`, `git status`, `git diff`,
  `git rev-parse`) and `node scripts/claim-support-check.js`. No other command. No
  network. No file writes. No commits. No push/publish. No live Codex invocation
  (reads `live_codex`-provenance records; never causes one).
- **No memory writes.** Learning/pattern output is candidates only — never a direct write
  to `memory/`; human-gated capture applies.
- **No self-certification.** The skill never marks its own emission as finally verified —
  every output ends with the fixed audit-status line (see Output contract).
- HarnessKit principles: provenance and decision-log evidence · report-only before
  enforcement · no autonomy before gates · stop on ambiguity.

## Required inputs

Gathered FIRST, before any prose is drafted or any finding is made:
- `git log` / `git status` (real command output), commit SHAs.
- `reviewer-verdicts.ndjson` entries (verdict IDs + provenance).
- `decision-log.ndjson` events; eval results if run.
- The design-lock record and scope reports, if the run had them.
- (AUDIT mode) the existing handoff/report text to audit, plus the same evidence set.

## Procedure

1. **Mode check.** Determine EMIT (build a handoff from run evidence) or AUDIT (given an
   existing report + evidence, produce findings). **Ambiguous mode → NEEDS_USER; never
   guess.**
2. **Evidence sweep** — collect the inputs above via the allowed read-only commands.
   Evidence precedes writing; a handoff drafted from memory then decorated with citations
   afterward is invalid.
3. **Draft/audit the required sections** (below). Every claim of "done / verified /
   passing / wired / complete" is checked against a matching artifact; a claim without one
   is rewritten with the downgrade table (EMIT) or flagged as a finding (AUDIT).
4. **Held-file check** — report the state of `config/capability-registry.json` and any
   `DISABLED*` marker as observed in `git status`; never omit this even when unchanged.
5. **Provenance check** — every cited verdict states its provenance class
   (`live_codex | cli_human | deterministic_internal | fixture`); a verdict cited as one
   class while the record's typed `provenance` field is another — or while no record carries
   the cited class at all — is a finding, not a rounding error. The typed `provenance` field
   is authoritative: do not infer a different "true" class from a verdict's free-text
   `reasons` and flag the field against it.
6. **Redaction pass** — strip raw memory, secrets, and unneeded private paths.
7. **Independent check (when feasible)** — a different model class or the human re-checks
   the claims-vs-evidence pass. The author never solely certifies their own claims; the
   audit-status line reflects this regardless of who ran step 7.

### Downgrade table (mandatory wording, EMIT mode)

| Draft claim | Without a matching artifact, becomes |
|---|---|
| "done" / "complete" | "attempted — not verified" |
| "tests pass" | "tests not run this session" (or cite the actual run output) |
| "verified" | "unverified" + what verification would require |
| "wired" | "drafted" unless registry + contract state say wired |
| "should work" | "not verified" |
| "Codex ran" / "reviewed by Codex" | "no live_codex verdict recorded" (unless one exists) |

## Output contract

Fixed section set (EMIT and AUDIT share the same headings):

```
# Handoff — <run/batch label>
## Objective
## Files changed            (path — anchor)
## Commits                  (sha · subject)
## Verification             (verdict_id · reviewer · verdict · provenance)
## Gates held               (incl. held-file status: capability-registry / DISABLED*)
## Known gaps
## What was NOT done        (never empty unless "none — checked against <plan path>")
## Next safe slice
## Learning candidates      (candidates only — no memory writes)
## Context-compaction status (source: user-supplied <n>% | UNKNOWN)
## Claims audit             (claim · anchor · ANCHORED | DOWNGRADED | UNVERIFIED)
Audit status: pending-independent-check — this handoff does not certify itself
```

AUDIT mode appends, before the closing line:

```
## Findings                  (finding_class · severity · evidence cited · required downgrade wording)
## Verdict                    (PASS | WARN | REJECT)
```

The closing line is fixed text, always present, always last.

## Evidence rules

- Claim classes and required anchors: commits → SHA · verification → verdict ID with
  provenance from the enum · state changes → decision-log event · scope → scope report ·
  file changes → git numstat line.
- Path/tool-log anchoring may be delegated to `node scripts/claim-support-check.js`
  (existing, read-only, no new helper written for this skill).
- An anchor must exist in the artifact cited — citing a file that does not contain the
  claimed content is fabrication, not evidence.
- Compaction status is **user-supplied percent, or `UNKNOWN`** — never measured or
  estimated by the skill itself (the statusline is not programmatically readable).
- **A definitive full-scope negative check licenses claims about any specific item within
  that scope, without requiring the evidence text to name the item verbatim.** A
  `git status --porcelain` that produced zero lines of output means, by logical entailment,
  that no specific path — held file, `DISABLED*` marker, or otherwise — appears in the
  working tree; the handoff may name that specific path as absent and cite the zero-line
  check as its anchor. Do not flag a valid entailment from aggregate evidence as unanchored
  or "embellished" — only flag a claim the evidence does not actually support. (Demonstrated
  RED gap, SKILL-2: a bare model repeatedly treated this valid inference as unsupported.)

## Gates

`REPORT_ONLY` for content (advisory) · run-folder write is out of scope for v0.1.0 (no
`ASK_BEFORE_WRITE` applies — nothing is written) · learning capture behind human approval
(advisory, absolute) · `DISABLED` / `HARNESSKIT_DISABLED` honored → no-op.

## Stop conditions

- A claim can neither be anchored nor honestly downgraded (evidence contradicts it) →
  stop, report the contradiction, NEEDS_USER.
- Required evidence surface missing entirely (e.g. verdicts claimed but no ndjson found)
  → stop; the gap IS the headline finding.
- Mode is ambiguous → NEEDS_USER before any drafting begins.
- `claim-support-check.js` errors → report the failure; never infer its result.

## Anti-overclaiming rules

- Over-claiming is the cardinal sin. One unanchored "verified" invalidates the handoff.
- Never total "N of M checks passed" without naming the failing/skipped ones first.
- The handoff reports what the run DID, not what it intended — plans are cited as plans.
- Brief reasoning summaries only; no reconstruction of private deliberation, no
  chain-of-thought reveal — evidence tables and decision citations carry the load, not a
  narrated thought process.
- Held-file status and provenance class are reported even when "nothing changed" — silence
  on these two is itself a violation.

## Failure modes

- **Decorated-memory handoff** — prose drafted first, citations added after; countered by
  evidence-sweep-first ordering (Procedure step 2 before step 3).
- **Empty NOT-done section** — "nothing left" by omission; the section is mandatory and
  checked against the plan.
- **Silent memory write** — learning captured directly instead of as a candidate; forbidden
  absolutely.
- **Provenance blur** — a `cli_human` verdict cited as if `live_codex`; caught by the
  mandatory provenance check (Procedure step 5).
- **Self-graded PASS** — an AUDIT verdict presented as final; the fixed closing line
  prevents this regardless of the computed verdict.

## Model-routing guidance

Emission: any model class (Haiku acceptable — it is transcription of gathered evidence
against a fixed template). Claims-audit / AUDIT-mode judgment: prefer Sonnet or stronger,
and prefer a **different** model class than whichever authored the material being audited.
Never requires Fable-class availability.

## Acceptance tests

- **Exists:** none — SKILL-2 not yet run (this installation is SKILL-1 only).
- **Needed:** see `docs/plans/SKILL-1A-handoff-truthfulness-install-plan.md` §3 for the
  full fixture plan (5 known-good W9/W10/W12/PR13 + honest-hedges fixtures, 8 mutated
  fixtures covering unanchored-verification, fake-Codex, held-file omission, out-of-scope
  omission, fabricated registry count, suppressed failed/skipped check, complete-without-
  artifact, and wrong-provenance-class). Not created by this installation.

## Examples

1. **EMIT, clean.** Evidence shows commit `a823852`, one `deterministic_internal` verdict
   `qa_evals-2026-06-13T...`, `git status` clean. → Handoff cites both by ID/SHA;
   "Known gaps" and "What was NOT done" filled honestly; closing line present.
2. **EMIT, downgrade.** Draft note says "tests pass" but no fresh verdict exists for this
   diff. → Rewritten to "tests not run this session" per the downgrade table; not silently
   dropped, not asserted anyway.
3. **AUDIT, REJECT.** Existing report claims "Codex review ran clean" but the evidence
   ndjson has zero `live_codex` records. → Finding `provenance-absence`, severity critical,
   required downgrade "no live_codex verdict recorded; Codex did not run", verdict REJECT.

## Eval criteria

Not yet wired. Graded fixtures and a `skill-handoff-truthfulness` eval category are
SKILL-2 work, specified in full in
`docs/plans/SKILL-1A-handoff-truthfulness-install-plan.md` §3–§4 (13 fixtures, pass bar
13/13, GREEN required on ≥2 model classes, RED baseline must show ≥1 miss without the
skill). No driver exists yet; this skill is **quarantined and untested** until that work
runs and a human explicitly flips `enable_state`.

## Escalation

Contradictory evidence, missing evidence surfaces, ambiguous mode, or any request to
soften wording against the evidence → NEEDS_USER. The handoff's wording is not negotiable
against its cited evidence.

## Changelog

- **0.1.2** (2026-07-05) — SKILL-2 Gate-1 clarification, still quarantined, not enabled.
  Tightened Procedure Step 5 (Provenance check): the comparison is the cited class against the
  record's **typed `provenance` field** (or absence of any record carrying the cited class), and
  the typed field is authoritative — a verdict's free-text `reasons` must not be used to infer a
  different "true" class and flag the field against it. Grounded in the w10 diagnostic: `good/w10`
  cites `cli_human` matching its record's field, yet a stable 2/2 WARN was manufactured by reading
  the "local deterministic review" `reasons` text as if it re-classed the verdict. The provenance
  mutations `m2` (claims `live_codex`, no such record → `provenance-absence`) and `m8` (cites
  `live_codex`, field is `cli_human` → `provenance-class-mismatch`) still REJECT under the
  clarified wording — detection unchanged, only the false positive removed. No other rule changed.
- **0.1.1** (2026-07-04) — SKILL-2 adjustment, still quarantined, not enabled. Added one
  Evidence rule: a definitive full-scope negative check (zero-line `git status --porcelain`)
  licenses claims about any specific item in that scope without requiring verbatim naming
  in the evidence text. Grounded in an isolated RED baseline on Sonnet 5 (13 fixtures): a
  bare model repeatedly flagged this valid logical entailment as "unanchored" or
  "embellished" across 4 of 5 known-good fixtures (w9, w10, w12, pr13) — the single most
  consistent false-positive-adjacent pattern observed. No other rule added; no speculative
  changes.
- **0.1.0** (2026-07-04) — SKILL-1 installation. Quarantined, not enabled, not evaluated.
  Adapted from the SKILL-0 draft per the SKILL-1A design lock: write surface narrowed to
  emit-only (`file_write_scope: none`, Edit/Write forbidden); Bash scope narrowed to
  read-only git + `claim-support-check.js`; compaction status set to user-supplied/UNKNOWN;
  Examples and Eval criteria sections added (house-schema requirement).
