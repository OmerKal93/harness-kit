# Component Contract — `publish_push_gate`

> M7 contract. **Honest status: `policy`-only — no code, no remote.** Nothing has ever been pushed; the
> repo is local-only. This is a hard policy boundary, not an implemented gate.

## 1. component_id
`publish_push_gate`. The push/publish/deploy/release boundary.

## 2. Purpose
Block any push, publish, deploy, or external release without an explicit human gate — and prevent
accidental exposure of secrets/private data.

## 3. Interface
No code path performs a push. Policy: any push/publish attempt → **stop and require explicit approval**.

## 4. Inputs
A would-be publish action (push, PR, deploy, external send) + its payload (diff, artifacts, target remote).

## 5. Outputs
Block (default) or a human-approved, gated publish. **Default: nothing leaves the machine.**

## 6. State fields touched
None — policy boundary.

## 7. Gates
**Push/publish requires an explicit gate** (`ASK_BEFORE_PUBLISH`). Push/publish/deploy/external release are
high-risk → always gated. **Never auto-publish, auto-deploy, auto-send, or auto-expose customer/private
data.** Publishing must check **secrets · private data · generated artifacts · external links · target
remote** first. A draft PR may be future-gated, **but not automatic now**.

## 8. Executor
`none` (no remote configured). Any future publish is human + gated.

## 9. Invocation contract (external components only)
N/A — no publish executor exists.

## 10. Failure modes
**Accidental push** (the risk the policy blocks). Publishing artifacts/links that leak secrets or private
data. Pushing to the wrong remote.

## 11. Repair behavior
Block before send. If something were published in error → treat as an incident (rotate any exposed
secrets, per the global security rule). No auto-publish to "fix" anything.

## 12. Acceptance tests
- **Exists:** the standing "never push" policy (no remote, every batch local-only).
- **Needed:** if a remote is ever added: a pre-publish secrets/private-data/target-remote check + explicit approval.

## 13. DISABLED behavior
N/A — no executor. The policy holds regardless: no auto-push ever.

## 14. Work-state
- **current:** `contract_drafted` (status = `policy`-only, no code).
- **desired:** `enforced_gate`.
- **Honest gap:** it is a rule, not a mechanism — there is no remote and no publish code, so nothing
  enforces it but discipline.

## 15. Smallest next slice
Keep as a hard policy; no auto-push ever. If a remote is added, add a pre-publish checklist
(secrets/private-data/artifacts/links/target) gated by explicit approval. Named here; **not implemented in M7.**
