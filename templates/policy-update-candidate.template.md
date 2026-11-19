---
proposal_id: <YYYY-MM-DD-NNN-short-slug>
generated_at: <YYYY-MM-DDTHH:mm:ssZ>
generated_by: <scripts/research-to-controls.js | manual>
source_principle:
  source: <URL or paper-id>
  tier: <1|2|3>
  principle_id: <slug from research note>
target_control: <path to control file this proposal modifies>
severity: <high | medium | low>
risk_class: <memory_poisoning | secret_leak | trust_violation | out_of_scope_drift | other>
status: <draft | review | accepted | rejected>
rollback_command: <one-line shell command to revert the proposed change>
related_proposals: <list of related proposal IDs>
---

# Policy Update Candidate — <short description>

## Current state of target control

<copy the relevant section(s) of the target control file verbatim — the exact bytes this proposal would change>

```
<verbatim>
```

## Proposed change (diff sketch)

```diff
<before / after diff sketch; not executable, but reviewable>
```

## Rationale

<2-4 sentences explaining why this change is being proposed. Trace back to:>
- **Source:** <which research note in `research/notes/`>
- **Principle:** <which principle from that note>
- **Why now:** <what triggered this — new advisory? recurring failure? eval regression?>

## Coverage gap this closes

<what risk / control gap this proposal addresses; cite the relevant section of agent-safety-constitution.md or alignment-risk-policy.json>

## Eval coupling

- **New fixture(s):** <which `evals/core/<category>/` directories gain new fixtures because of this change>
- **Existing categories affected:** <which eval categories might regress; baseline delta expected>
- **Regression criterion:** <how this proposal's success is measured post-merge>

## Validation plan

1. <how to verify the change does what's claimed>
2. <how to verify it does not introduce a regression in other categories>
3. <how to verify rollback works>

## Risks of accepting

- <what might go wrong if this is merged>
- <false-positive class>
- <false-negative class>

## Risks of rejecting

- <what risk remains uncovered if this is rejected>
- <how often does the rejected-risk fire today?>

## Open questions for the owner review

- <decision points only the owner can make>
- <ambiguity in the source that needs clarification before merge>

## Rollback procedure (detail)

1. <step-by-step rollback>
2. <backup paths if any>
3. <how to record the rollback in `recurring-failures.md`>

---

> **The owner's review actions:**
>
> - **Accept:** type `approve proposal <proposal_id>` → proposal moves to `proposals/accepted/`; target control edited per the diff sketch; eval fixtures added.
> - **Reject:** type `reject proposal <proposal_id>` → proposal moves to `proposals/rejected/` with `reject_reason` field appended; entry added to `research/rejected-ideas.json` (prevents re-debating).
> - **Defer:** type `defer proposal <proposal_id> until <YYYY-MM-DD>` → proposal stays in `proposals/policy-updates/` with `defer_until` field; surfaced again on that date.
> - **Edit:** make manual changes to this file before accepting; the diff sketch above is the proposed change, not the authoritative final form.
