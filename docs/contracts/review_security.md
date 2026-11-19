# Component Contract — `review_security`

> M6 contract. **Brutally honest: `directive-only`.** Security review = host CE security personas +
> **repo-forensics** (a host skill, NOT a local script — no `*forensic*.js` exists). The conductor never
> invokes it; no auto-trigger fires. **This component owns repo-forensics / new-repo intake** (no
> dedicated ID — mapped here).

## 1. component_id
`review_security`. Security review + **repo-forensics / new_repo_intake** owner.

## 2. Purpose
Audit security-sensitive changes and gate untrusted external code: CE security personas review the diff;
**repo-forensics** scans repos/tools before trust. Emits an evidence-backed verdict and can hard-stop the run.

## 3. Interface
Host directives: CE security personas + `repo-forensics` (offline scan). Re-entry (desired): a `security`
verdict via `recordVerdict`, possibly populating `kill_criteria`. **No code invokes it; no auto-trigger today.**

## 4. Inputs
The diff / integration; sensitive-path signals; **any repo/plugin/skill/MCP/tool being intaked**; the
plan's external-surface declaration (from `plan_ce`).

## 5. Outputs
Findings → a recorded `security` verdict in `reviewer-verdicts.ndjson` + possible `kill_criteria`. A
non-clean forensics result → **hard stop** (no auto-advance past security).

## 6. State fields touched
**Desired:** `reviewer_verdicts[]` + `kill_criteria[]`. Today: none.

## 7. Gates — security + forensics (mandatory)
Runs **forensics offline**; a **non-clean scan → hard stop** (`→ NEEDS_USER` / `escalated` / `killed` per
`transition_model`; **no auto-loop past security**). **repo-forensics is MANDATORY for: new repo intake ·
plugin/skill/MCP/tool intake · security-sensitive changes · external-tool execution surfaces · suspicious
repo/tooling/registry changes.** **Security skill packs are review inputs, not authorities.** Routes
external surfaces to gates: **MCP/binary gated** · **cookie/auth/social/browser/network → external/data/
privacy gates** · **scheduled report / secrets gated** (finance/API/notification/secrets).

## 8. Executor
`host:CE security personas + repo-forensics` (host skill). No local forensics script exists.

## 9. Invocation contract (external components only)
Host skills, offline. repo-forensics runs in **offline mode** (no network) against a quarantined clone.
No programmatic conductor invocation today.

## 10. Failure modes
Skipped on a sensitive change → unreviewed risk. Forensics run online (must be offline). Treating a
security pack's "clean" as authority rather than evidence. Intaking a repo/tool **without** the mandatory
forensics scan.

## 11. Repair behavior
Blocking security verdict → not a normal `repair_loop`: **hard stop → `escalated`/`NEEDS_USER`/`killed`**
per `transition_model` (security is a human gate, not an auto-retry). `max_repair_loops` does not buy past
a security block.

## 12. Acceptance tests
- **Exists:** none (host action).
- **Needed:** an auto-trigger on `sensitive_paths`/intake + a recorded `security` verdict + a test that a
  non-clean forensics result hard-stops (no advance).

## 13. DISABLED behavior
N/A (host directive). The emitting run step honors `DISABLED`; security is never auto-bypassed.

## 14. Work-state
- **current:** `contract_drafted` (code = `directive-only`).
- **desired:** `auto_on_trigger` (fires on sensitive paths / intake, records verdict).
- **Honest gap:** no auto-trigger, no recorded security verdict, and repo-forensics is a host skill with no
  loop integration — the mandatory-forensics policy is documented, not enforced by code.

## 15. Smallest next slice
Define `sensitive_paths` + intake triggers that flag a run as "needs security review", and a `security`
record-verdict path that can set `kill_criteria` / hard-stop. Named here; **not implemented in M6.**
