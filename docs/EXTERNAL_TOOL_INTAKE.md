# External Tool Intake / Adapter Triage

> Status: triage report, created 2026-06-27 (Batch 3.9b). Decides where externally-mentioned tools
> belong relative to HarnessKit **before** any install or integration. `[V]` verified locally,
> `[I]` inference, `[U]` unverified-external.
>
> **External facts are UNVERIFIED.** No internet/probe was used this batch — no repo was fetched,
> cloned, or scanned. Classifications below are from the owner's video-summary list + HarnessKit's own
> direction, and are **provisional pending the Adoption Gates**. Nothing is installed, enabled, or wired.

## Purpose

Prevent tool-chasing. A stream of interesting external AI/OSS tools is a distraction unless each is
deliberately placed: core vs optional adapter vs skill pack vs project adapter vs research-only vs
defer/reject. This report fixes that placement up front so HarnessKit's small, local-first, zero-dep
core is not diluted, and so nothing gets installed or routed without passing the gates below.

## Core Rule

**External tools are adapters until proven core.**

- **Core stays small** — generic, local-first, zero-dependency where possible; an external tool earns
  core status only after sustained proof, never by default.
- **Adapters are optional** — the core must run with zero adapters installed.
- **Skills require security review** — scan (repo-forensics/Skillspector-class) before enablement.
- **MCP/connectors are read-only by default** — write capability is a separate explicit gate.
- **No install without explicit approval** — discovery ≠ adoption.
- **No private data exposure during testing** — smoke tests use synthetic data only; never point a new
  tool at real memory, runs, or a project repo.

## Tool Triage Table

All rows **provisional / `inspect_later`-gated**; external attributes `[U]`.

| Tool | Category | Proposed HarnessKit role | Priority | Risk | Decision |
|---|---|---|---|---|---|
| Skillspector | security_tool | optional_skill_pack (pre-install scanner) | **High** | Med (runs over untrusted skills) | inspect_later |
| Anthropic Cyber Security Skills | security_tool / skill_pack | optional_skill_pack | **High** | Med (must scan + keep optional) | inspect_later |
| Codebased Memory MCP | memory_tool / codebase_indexing | optional_adapter | **High** | **High** (MCP perms + codebase data egress) | inspect_later (gate hard) |
| Matt Pocock's Skills | skill_pack | optional_skill_pack | Med | Low–Med (TS workflows; scan) | inspect_later |
| GStack | skill_pack / loop_engine_reference | optional_skill_pack or optional_adapter | Med | Med (content/licensing/security unverified) | inspect_later |
| Deerflow | loop_engine_reference | research_reference | Med | Low (reference only) | research_only / inspect_later |
| Hermes Agent | loop_engine_reference | research_reference | Med | Low (reference only) | research_only / inspect_later |
| Open Montage | video_content_adapter | project_adapter | Low | Low (not core) | defer |
| Hyperframes | video_content_adapter | project_adapter | Low | Low (not core) | defer |
| Pomeierre Pro | video_content_adapter | project_adapter | Low | Low (Mac/video-specific) | defer |
| Voice Box | audio_voice_adapter | project_adapter | Low | Med (audio + possible model/network) | defer |
| BYU Vision Language Model | document_ocr_adapter | project_adapter | Low | Med (model weights / compute) | defer |

## Recommended Classification

Adopted stance (unless local evidence contradicts):

- **Deerflow** — research_reference / inspect_later: compare long-horizon task patterns; do **not** replace HarnessKit's loop model.
- **Hermes Agent** — research_reference / inspect_later: study self-healing/repair loops; do **not** adopt blindly into core.
- **GStack** — optional_skill_pack or optional_adapter / inspect_later: not core; verify actual content, licensing, security first. *(Local note: `gstack` currently appears only as incidental string mentions in HarnessKit — no real integration exists. [V])*
- **Anthropic Cyber Security Skills** — optional_skill_pack / inspect_later: high relevance to the security-review stage, but must be scanned and kept optional (never auto-routed).
- **Skillspector** — security_tool / inspect_later: likely useful as a pre-install **skill scanner**; evaluate alongside the already-present `repo-forensics`.
- **Codebased Memory MCP** — optional_adapter / inspect_later: relevant to codebase memory, but MCP permissions + data-exposure risk require a hard gate; must **not** replace the local NDJSON facts store.
- **Matt Pocock's Skills** — optional_skill_pack / inspect_later: useful for TypeScript workflows; not core.
- **Open Montage** — project_adapter / defer: maybe relevant to Caracu/video work, not HarnessKit core.
- **Hyperframes** — project_adapter / defer: video/demo generation, not core.
- **Pomeierre Pro** — project_adapter / defer: Mac/video-specific, not core.
- **Voice Box** — project_adapter / defer: audio/voice, not core.
- **BYU Vision Language Model** — document_ocr_adapter / defer: not core; maybe a future document pipeline.

## Adoption Gates

No external tool may be installed or routed until **all** pass (in order):

1. **Source verification** — confirm the real upstream repo/author/provenance.
2. **License check** — compatible with HarnessKit's intended OSS license; record it.
3. **Local install surface review** — what it writes, where, and what it pulls in (no `curl|bash`, no auto-git, no postinstall surprises).
4. **Security scan** — `repo-forensics` (offline mode) on the artifact; clean or explained.
5. **Secrets / data-egress review** — does it read env/credentials or phone home? Default-deny.
6. **Permission scope review** — least privilege; MCP/connector read-only unless a write gate is granted.
7. **Offline / local behavior check** — does it function without network? Does it degrade safely?
8. **Minimal smoke test with synthetic data** — temp dir, fake inputs; never real memory/runs/project data.
9. **Ponytail compactness review** — is it worth the surface it adds, or does a few lines of local code do it? (adapt-over-add).
10. **Human approval** — explicit, named approval to install/route; discovery never auto-adopts.

## MCP / Connector Policy

- **MCPs are not core** — none ships in core; they are optional adapters per profile.
- **MCPs start read-only** — read-only by default; no writes without an explicit gate.
- **Write-capable MCP requires explicit gate** — `ASK_BEFORE_WRITE`/named approval, scoped.
- **No MCP accesses private memory/runs by default** — `memory/`, `runs/`, project maps are off-limits unless explicitly granted and sanitized.
- **Project-specific MCPs belong in project adapters** — `adapters/<project>/mcp/`, not core.

## Skill Pack Policy

- Skills are **optional packs**, not core (except the few vendored local skills already registered).
- Must be **inspected before enablement** (forensics/Skillspector-class scan + manifest review).
- Must **not override core safety policy** (kill switch, gates, push-control, redaction).
- Must **not add hidden network/model calls** — any egress is surfaced and gated.
- Must be **classified** core / generic / project-specific in `config/skill-registry.json` (two-hash trust).
- **Skillspector (or equivalent)** should be considered as the standard pre-import review before trusting any untrusted skill.

## Memory Tool Policy

- **Structured NDJSON memory remains the canonical local substrate** for now (`scripts/structured-memory.js` + `capture-fact.js` + `read-facts.js`, B5a–c). [V]
- **Codebased Memory MCP or similar may become adapters** — read-only, gated, never authority.
- **No external memory tool may replace the local facts store** without an explicit **migration plan** (schema map + provenance preservation + rollback).
- **No private codebase indexing without explicit project approval** — indexing a real repo is a data-egress decision, not a convenience.

## Video / Content Tool Policy

- **Open Montage, Hyperframes, Pomeierre Pro, Voice Box are not HarnessKit core.**
- They may be relevant to the **Caracu/video pipeline as project adapters**, evaluated on that track.
- **Do not mix video-production tools into the engineering harness core** — different domain, different risk surface; keep them in their own adapter.

## Workflow Config Implications

For a future `config/workflows.example.json` (do **not** edit it now):

- Add external tools **only as optional adapters**, never required reviewers/stages.
- Introduce tool-registry statuses like `research_reference`, `optional_adapter`, `project_adapter` (alongside the existing `available` / `optional_external` / `manual_not_wired`).
- **Codebased Memory MCP must not replace** `structured_memory_capture` / `structured_memory_read`.
- **Skillspector** may become a `pre_install_skill_review` stage (gate before enabling any new skill).
- **Anthropic Cyber Security Skills** may become **optional reviewers** in `security_sensitive_change` (optional, scanned, never auto-routed).
- **GStack** may become an **optional planning pack**, not core — composes with CE/Superpowers, doesn't replace them.
- Everything stays behind the Adoption Gates; config references are inert until a tool passes.

## Recommended Next Step

**Batch 5d — structured facts integration into `search-memory.js`.** Justification: the workflow track
(3.6–3.9) is now well-specified (matrix, capability probe, alignment, config skeleton, state model) and
this triage cleanly parks every external tool behind gates — so the highest-value *functional* move is
to make the memory substrate actually participate (retrieve active facts at recall time), which several
later batches (workflow memory_behavior, Codebased-Memory-MCP comparison) depend on. A dedicated
**external-tool web-verification batch** is the right follow-up *only when* a specific tool (Skillspector
or Anthropic Cyber Security Skills — the two High-priority/High-relevance items) is chosen for the
Adoption Gates; do that next if you'd rather harden the toolchain than wire memory. Batch 3.10 (state
fixture) and 4-impl (project docs) remain lower-urgency.

## Appendix — Verification Caveat

External attributes (purpose, license, security posture, network behavior) of all 12 tools are `[U]`
unverified — no fetch/clone/scan occurred. Treat every classification as a **starting hypothesis** that
the Adoption Gates must confirm before any install or routing. The only locally-verified fact used here
is that `gstack` has no real HarnessKit integration today (incidental mentions only). [V]
