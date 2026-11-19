# Structured Memory Schema

> Status: schema + local helpers, created 2026-06-26 (Batch 5a). `[V]` verified against code, `[I]` inference.
> **This batch adds the substrate only — it is NOT wired into capture, retrieval, or the context pack.**
> Existing markdown memory (`memory/*.md`) and all current harness behavior are unchanged. Reversible:
> remove `scripts/structured-memory.js` + the example file and nothing else is affected.

## Purpose

Give HarnessKit a small, **structured, queryable** memory record — one fact per line — so that future
batches can do at write time what prose memory cannot: detect staleness, detect contradiction, carry
provenance, and supersede/retract facts instead of letting them rot. Today's `memory/*.md` stays as-is;
this is an additive substrate, not a migration. The audit (Batch 1) flagged that "memory is not
structured yet" — this is the smallest correct first step toward fixing that.

## Why NDJSON first

- **Append-only, one record per line** — crash-safe, diff-friendly, trivially tailed; never rewrites history.
- **Zero dependencies** — pure Node stdlib + `scripts/_lib.js`; no DB/graph/vector to install, secure, or back up.
- **Reuses what exists** — parsed by `_lib.readNdjson`, same family as `runs/.index.ndjson` and the run logs. [V]
- **Easy to supersede later** — if scale ever demands it, NDJSON migrates cleanly into SQLite/whatever;
  starting there now would violate "adapt over build" and the ponytail/YAGNI ladder. Graph/vector are
  explicitly out of scope until structured records prove insufficient.

## Fact Record Schema

One JSON object per line. Default store path: `<HARNESS_ROOT>/memory/facts.ndjson` (via
`structured-memory.factsPath()`; honors `HARNESS_ROOT`, unset → legacy `<harness-root>`). [V]

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | number | (set by normalize) | Schema version (currently `1`). |
| `id` | string | ✅ | Stable unique fact id. |
| `kind` | string | ✅ | Must be `"fact"` (reserved for future record kinds). |
| `claim` | string | ✅ | The asserted fact, in one sentence. |
| `mentions` | string[] | ✅ | Identifiers the claim is about (used later for contradiction detection). |
| `source_path` | string | ✅ | Provenance: file/doc the claim was derived from. |
| `source_sha256` | string (64-hex) | ✅ | Provenance: content hash of the source at capture time (staleness/tamper check). |
| `trust_tier` | enum | ✅ | One of the trust tiers below. |
| `captured_run_id` | string | ✅ | Provenance: the run that captured this fact. |
| `confidence` | number [0,1] | ✅ | Capture-time confidence. |
| `state` | enum | ✅ | Lifecycle state (below). |
| `supersedes` | string\|null | (default null) | `id` of a fact this one replaces, if any. |
| `created_at` | ISO-8601 | ✅ | Capture timestamp (normalize stamps if absent). |

Callers may include extra fields; `normalizeFactRecord` preserves them without overriding the
normalized ones.

## Allowed States

| State | Meaning | Retrieved by default (future 5c)? |
|---|---|---|
| `active` | Current, believed true. | **Yes** |
| `superseded` | Replaced by a newer fact (`supersedes` points back). | No |
| `retracted` | Withdrawn as wrong/unsafe (e.g. failed a poisoning/content check). | No |
| `archived` | Historically true, no longer current (e.g. an old architecture). | No |

State transitions are expressed by appending records + flags, never by rewriting a line (append-only).

## Required Provenance Fields

Provenance is mandatory so retrieval can later verify currency and origin, and so the orphaned
`detect-context-drift.js` validator finally has a producer (Batch 5d):

- `source_path` — where the claim came from.
- `source_sha256` — 64-hex content hash of the source at capture (drift/tamper detection).
- `captured_run_id` — which run asserted it.
- `trust_tier` — how much to trust it. Vocabulary matches `detect-context-drift.js` staleness tiers:
  `source_of_truth` · `curated_memory` · `run_artifact` · `curated_external` · `untrusted_external`. [V]
- `created_at` — when.

## Examples (synthetic only)

See `examples/memory/facts.ndjson.example` — four synthetic records about a fictional `acme-*` project,
one per state. Illustrative shape (synthetic):

```json
{"schema_version":1,"id":"fact-0001","kind":"fact","claim":"The acme-billing service retries failed charges with exponential backoff.","mentions":["acme-billing","backoff"],"source_path":"examples/acme/services/billing.md","source_sha256":"aaaa...(64 hex)","trust_tier":"curated_memory","captured_run_id":"20260101-000000-example-run","confidence":0.92,"state":"active","supersedes":null,"created_at":"2026-01-01T00:00:00.000Z"}
```

No real memory, paths, claims, secrets, or client data appear anywhere in this batch.

## Local Helpers (`scripts/structured-memory.js`)

Pure stdlib, no LLM, no network, no auto-capture, does not read `memory/*.md`:

- `factsPath(root = harnessRoot())` — default store path under the resolved root.
- `validateFactRecord(record)` → `{ ok, errors[] }` — pure, never writes/throws.
- `normalizeFactRecord(record)` — fills safe defaults (schema_version, kind, state, mentions, supersedes, created_at), trims; never fabricates substantive required fields.
- `appendFactRecord(record, { root?, path? })` — normalize → validate → append one line; `{ ok:false, errors }` if invalid (nothing written).
- `readFactRecords({ root?, path? })` — all parseable records (skips blank/corrupt lines); `[]` if absent.
- `filterActiveFacts(records)` — keeps only `state === "active"`.
- CLI: `node scripts/structured-memory.js --self-test` — synthetic, temp-dir-scoped smoke test; never touches real `memory/`.

## Manual Capture CLI (`scripts/capture-fact.js`, Batch 5b)

An **explicit, manual** write path — nothing in the harness calls it; a human/script runs it on
purpose. No auto-capture, no pipeline wiring. Pure stdlib + `structured-memory.js` + the optional
`memory-poisoning-scan.js`.

```
node scripts/capture-fact.js --json '<json object>'     # inline record
node scripts/capture-fact.js --file path/to/fact.json   # record from a file
  [--dry-run]                  # validate/scan/check, do NOT append
  [--allow-source-mismatch]    # accept a source_sha256 that no longer matches the file
  [--root <dir>]               # write under <dir>/memory/facts.ndjson (else HARNESS_ROOT/legacy)
  [--self-test]                # synthetic, temp-dir smoke test (never touches real memory/)
```

Pipeline: parse → `normalizeFactRecord` → `validateFactRecord` → poisoning scan on `claim`
(reject if any **instruction**-classified hit / `exclude`) → if `source_path` is a local file,
recompute SHA-256 and compare to `source_sha256` (reject on mismatch unless
`--allow-source-mismatch`) → `appendFactRecord`. Output is one JSON line
`{ ok, id?, path?, warnings, rejected_reason?, errors? }`.

**Privacy:** the CLI never prints the `claim`, source contents, or any secret from the fact — only
metadata (`id`/`path`) and generic warning/reason strings. It does not read existing facts or
`memory/*.md`. It is intentionally not kill-switch-gated (it is a manual tool); capture-time
gating, if wanted, is a future decision.

## Manual Read CLI (`scripts/read-facts.js`, Batch 5c)

An **explicit, manual, read-only** query path — nothing in the harness calls it. No wiring into
`search-memory.js` / `build-context-pack.js` / `summarize-session.js`. Pure stdlib +
`structured-memory.js`. Reads only the structured NDJSON store, never `memory/*.md`.

```
node scripts/read-facts.js [--active] [--include-historical]
  [--mention <term>] [--trust-tier <tier>] [--json]
  [--no-verify-sources] [--root <dir>] [--self-test]
```

- **Default:** active-only (`state === "active"`); one compact JSON line per fact
  (`id/state/trust_tier/mentions/claim`) + a `# count=N warnings=M` summary line.
- **`--include-historical`:** also returns `superseded` / `retracted` / `archived`.
- **`--mention <term>`:** keep facts whose `mentions` include `term` (case-insensitive).
- **`--trust-tier <tier>`:** keep facts with that exact `trust_tier`.
- **`--json`:** a single envelope `{ ok, count, facts, warnings }`.
- **Source verification (default on):** for each returned fact whose `source_path` is a readable
  local file, recompute SHA-256 and **warn** on drift (`source_sha256 mismatch`). Read-only and
  non-fatal — never rejects, never prints source contents. `--no-verify-sources` skips it.
- Missing `facts.ndjson` → empty result (`count: 0`), never a crash.

## Search Integration (`scripts/search-memory.js`, Batch 5d)

`search-memory.js` can **optionally** include structured facts in its results — **off by default**, so
existing learnings + markdown-memory search behaves exactly as before unless explicitly opted in.

- **Enable:** `--include-structured` flag **or** `HK_STRUCTURED_MEMORY=1` env. When neither is set, no
  `structured_facts` key is added and output is byte-unchanged.
- **Active-only by default;** `--include-historical-structured` also returns superseded/retracted/archived.
- **Matching:** query terms (from `--tags` / `--topic`) are matched as simple substrings against
  `claim` / `mentions` / `source_path` / `trust_tier` — no embeddings/vectors.
- **Output:** each fact returns `id, claim, mentions, trust_tier, source_path, source_sha256,
  captured_run_id, confidence, state`. `claim` and `source_path` pass through `redactString`.
- **Read-only, no verification:** this is search, not validation — it does **not** recompute source
  hashes (that's `read-facts.js`) and never reads/prints source file contents.
- Missing `facts.ndjson` → empty (no crash). Honors `HARNESS_ROOT` (or `--root` for tests).
- **Not wired** into `build-context-pack.js` or `summarize-session.js`; no auto-capture.

## Context Pack Integration (`scripts/build-context-pack.js`, Batch 5e)

`build-context-pack.js` can **optionally** add a clearly-labeled `## Structured Memory Facts` section
to the context pack — **off by default**, so existing pack output is unchanged unless opted in.

- **Enable:** `--include-structured-memory` flag **or** `HK_STRUCTURED_MEMORY=1` env. When neither is
  set, the section is **omitted entirely** (default output byte-unchanged).
- **Active-only by default;** `--include-historical-structured` also includes superseded/retracted/
  archived facts, each marked `[HISTORICAL:<state>]`.
- **Matching:** the pack's existing query terms (`memory_tags` = task_type + triggers) are matched as
  simple substrings against `claim` / `mentions` / `source_path` / `trust_tier` — no embeddings.
- **Provenance per fact:** `id, claim, mentions, trust_tier, confidence, source_path, source_sha256,
  captured_run_id, state`. Reuses `search-memory.searchStructuredFacts` (claim/source_path redacted).
- **Read-only, no verification:** does not recompute source hashes and **never reads source file
  contents**. Missing `facts.ndjson` → a compact `- (none found)` line, no crash.
- **Not wired** into `summarize-session.js`; no auto-capture. Honors `HARNESS_ROOT` (or `--root` for tests).

## Capture Candidate Reports (`scripts/propose-fact-candidates.js`, Batch 5f)

A **report-only** path that prepares fact candidates for human review — it **never** writes
`memory/facts.ndjson` and **never** calls `appendFactRecord` (not even imported). To persist a reviewed
candidate, a human still runs `capture-fact.js` explicitly. No auto-capture; no pipeline wiring; does
not read markdown memory.

```
node scripts/propose-fact-candidates.js --json '<object|array>'
node scripts/propose-fact-candidates.js --file path/to/candidates.json
node scripts/propose-fact-candidates.js --from-markdown path/to/report.md   # ONLY fenced ```json blocks
  [--json-output] [--out <path>] [--root <dir>] [--self-test]
```

Per candidate: normalize → validate → poisoning scan (reused from `capture-fact`) → source-hash compare
(when `source_path` is a local file). Emits `{ candidate_id, valid, status, errors, warnings,
recommended_next_action, claim }` (claim redacted + truncated; **source contents never printed**).

| status | meaning | recommended_next_action |
|---|---|---|
| `READY_FOR_REVIEW` | valid, clean, source verified-or-unverifiable | `review_then_capture` |
| `NEEDS_FIELDS` | missing required fields | `fix_fields` |
| `INVALID` | structurally invalid (bad state/type) | `fix_fields` |
| `POISONING_REJECTED` | claim has an instruction-classified injection hit | `reject` |
| `SOURCE_HASH_MISMATCH` | source file changed vs `source_sha256` | `update_source_hash_or_reject` |

`--from-markdown` extracts only explicit fenced ```json blocks — it never infers facts from prose.
`--out` writes only the report (refuses any path ending in `facts.ndjson`); memory is never modified.

## Future Batches

- **5b — capture-time checks:** before `appendFactRecord` is called from real capture, run
  `memory-poisoning-scan.scanContent` (reject `exclude`) and a `source_sha256` content check; set
  `state` accordingly. Wires into capture only then.
- **5c — retrieval active-state filtering:** extend `search-memory.js` to read facts, drop non-`active`,
  recompute/flag stale sources at read time, and surface provenance per hit.
- **5d — context-pack provenance:** have `build-context-pack.js` emit `sections[].provenance` from facts,
  giving `detect-context-drift.js` a live producer (closes the orphaned-validator gap from Batch 1).

These are **not** implemented here. This batch is schema + helpers + example only.
