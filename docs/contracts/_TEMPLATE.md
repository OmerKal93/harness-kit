# Component Contract — `<component_id>`

> Template for loop-component contracts (M1). Every component in `config/loop-components.json` gets one
> of these before its automation is wired. **Be brutally honest** — describe what IS, not what's desired.
> A contract documents the agreed interface + gates + tests + work-state; writing it changes no behavior.

## 1. component_id
`<id>` — must match an entry in `config/loop-components.json`.

## 2. Purpose
One sentence: what this component does in the loop.

## 3. Interface
Exact signature(s) the rest of the loop depends on. For code: `fn(args) → return shape`. For a CLI:
`command --flags`. For a host skill: the slash-command + how its result re-enters the loop.

## 4. Inputs
What it consumes (args, files, state fields).

## 5. Outputs
What it produces (return value, files written, state fields set, verdicts appended).

## 6. State fields touched
Which `workflow-state.json` fields it reads/writes.

## 7. Gates
Which gates apply: `DISABLED` (kill switch) · `ASK_BEFORE_WRITE` · `ASK_BEFORE_EXTERNAL` ·
`ASK_BEFORE_DESTRUCTIVE` · `ASK_BEFORE_PUBLISH` · `ASK_BEFORE_EXPANSION` · `NO_GATE` · `REPORT_ONLY`.
State whether the gate is **code-enforced** or **advisory** (label only).

## 8. Executor
Who actually runs it: `node:<file>#<fn>` · `host:/<skill>` · `external:<cli>` · `human` · `none`.

## 9. Invocation contract (external components only)
The exact, **verified** command + args. Note verification date/method. If unverified, say so loudly.

## 10. Failure modes
Concrete ways it fails (timeout, auth, missing input, ambiguous output, etc.).

## 11. Repair behavior
What happens on failure: retry? gate? transition to `repair_loop`/`escalated`? nothing?

## 12. Acceptance tests
Named, runnable checks that prove the contract holds. Mark which **exist** vs **are needed**.

## 13. DISABLED behavior
What it does when the kill switch is on (no-op / blocked / runs anyway because temp-scoped).

## 14. Work-state
`current` and `desired` from `config/loop-components.json` (`inventoried → contract_drafted → wired → verified`),
plus the honest gap between current code and the contract.

## 15. Smallest next slice
The single smallest change that advances work-state by one step (e.g. `contract_drafted → wired`).
Name it; do not implement it in the contract.
