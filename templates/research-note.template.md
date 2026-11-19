---
source: <URL or paper-id>
tier: <1|2|3>
authors: <list>
date_published: <YYYY-MM-DD>
date_ingested: <YYYY-MM-DD>
ingested_by: <owner or persona-id>
domain: <agent-safety | context-engineering | agentic-se | hallucination | tool-security | memory-retrieval | agent-eval | other>
principles_extracted: <integer>
trust_level: untrusted_external
status: <draft | reviewed | adopted | rejected | watch>
related_harness_controls:
  - <path to control file this might affect, if known>
---

# <source title>

## Summary (≤200 words)

<paraphrase in your own words; cite specific passages>

## Principles extracted

- **<principle name>**: <one-line statement>
- **<principle name>**: <one-line statement>
- <add as needed>

## Decisions

| Principle | Decision | Rationale | Target control | Proposed change (diff sketch) |
|---|---|---|---|---|
| <name> | adopt | <why this becomes operational> | <path> | <short sketch> |
| <name> | adapt | <why + how it changes from source> | <path> | <short sketch> |
| <name> | reject | <why> | n/a | n/a |
| <name> | watch | <when to revisit> | n/a | n/a |

## Open questions

- <question that this source does not answer>
- <ambiguity that requires the owner review>

## Conflicts with existing HarnessKit posture

- <if any principle here contradicts an existing control, name the control and surface the conflict>

## Eval coupling

- <if `adopt` / `adapt`, what new eval-harness fixture should be added in evals/core/<category>/ to detect future regressions?>

## Citation

<full citation in your preferred format — APA, arXiv ID, URL with retrieval date>

---

> **Ingestion checklist (the owner fills before status flips from `draft` → `reviewed`):**
>
> - [ ] Source verified Tier classification (per `config/research-watchlist.json#tiers`)
> - [ ] Frontmatter is complete and parses as YAML
> - [ ] Every principle has a decision row
> - [ ] Every `adopt`/`adapt` decision names a target control file
> - [ ] Every `reject` decision is recorded in `research/rejected-ideas.json` (prevents re-debating)
> - [ ] Note passed through `memory-poisoning-scan.js` before being staged for any memory layer
> - [ ] Eval coupling specified for every adopted control
> - [ ] Conflicts surfaced (none silently dropped)
