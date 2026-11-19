---
id: grill-me
name: grill-me
version: 0.1.0
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
category: productivity
status: quarantined
owner: owner
source_of_truth: this file
allowed_tools: [Read, Grep, Glob]
forbidden_tools: [Edit, Write, Bash, WebFetch, WebSearch]
risk_level: low
requires_approval: false
implicit_invocation_allowed: true
evidence_required: false
rollback: delete ~/.claude/skills/grill-me/ and remove the grill-me record from harnesskit config/skill-registry.json
deprecation_policy: supersede-by-id; tombstone retained one batch
last_reviewed_at: 2026-06-06
security:
  trust_level: imported
  file_write_scope: none
  network_permission: none
  secret_handling: none
  external_content_handling: not-applicable
  prompt_injection_exposure: reads-untrusted
  required_evals: []
  required_human_approval_conditions: []
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.
