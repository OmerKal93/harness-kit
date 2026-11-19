---
id: zoom-out
name: zoom-out
version: 0.1.0
description: Tell the agent to zoom out and give broader context or a higher-level perspective. Use when you're unfamiliar with a section of code or need to understand how it fits into the bigger picture.
category: productivity
status: quarantined
owner: owner
source_of_truth: this file
allowed_tools: [Read, Grep, Glob]
forbidden_tools: [Edit, Write, Bash, WebFetch, WebSearch]
risk_level: low
requires_approval: false
implicit_invocation_allowed: false
evidence_required: false
rollback: delete ~/.claude/skills/zoom-out/ and remove the zoom-out record from harnesskit config/skill-registry.json
deprecation_policy: supersede-by-id; tombstone retained one batch
last_reviewed_at: 2026-06-06
disable-model-invocation: true
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

I don't know this area of code well. Go up a layer of abstraction. Give me a map of all the relevant modules and callers, using the project's domain glossary vocabulary.
