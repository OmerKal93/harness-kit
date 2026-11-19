# Host Adapter Contract (Phase 4)

## Purpose and honesty scope

This document defines a **stable, host-agnostic interface** that any host running HarnessKit
(Claude Code, Codex CLI, or something else later) could implement, so a workflow driven by
HarnessKit's real CLI (`bin/harnesskit.js`) is not accidentally coupled to one host's specific UI or
plugin system.

**What this is:** a contract definition, plus exactly one real implementation (the Claude Code
plugin built in this same phase).

**What this is not:** a multi-host framework, an abstraction layer with pluggable adapter code, or a
promise that a Codex CLI adapter exists. No such adapter has been built. Every "how Claude satisfies
this" section below cites a real file/command in this repo. Every "not yet implemented" section
below is a real gap in the underlying CLI itself (`bin/harnesskit.js` has six verbs, full stop) --
not a Claude-specific limitation a different host could route around. A future Codex adapter would
hit the exact same gaps, because the gaps are in the thing being adapted, not in the adapter.

## The six real verbs this contract is built on

`bin/harnesskit.js` exposes exactly six verbs (verified by reading the file and running each):
`inspect`, `capabilities`, `doctor`, `status`, `resume` (two modes: `--run-id` and `--target`), and
`run`. Nothing below invents a seventh.

---

## Contract surface

Each item states: the operation, whether it exists in `bin/harnesskit.js` today, and if so which
file/command implements it for Claude Code.

### 1. Start a workflow

- **Exists:** yes -- `run --repo <url-or-path> [--workspace <path>] --instruction "<text>"`
  (`cmdRun` in `bin/harnesskit.js`).
- **Claude Code satisfies this via:** `commands/run.md`, which shells out to
  `node "${CLAUDE_PLUGIN_ROOT}/bin/harnesskit.js" run $ARGUMENTS`.
- **Real behavior:** resolves/clones the repo, inspects it, composes a workflow DAG, executes its
  automated prefix, and returns where it paused. It never claims full completion from one call.

### 2. Pause a workflow

- **Exists:** partially, and not as a client-initiated action. The workflow engine
  (`scripts/execute-workflow.js`) decides its own pause points (`paused_at`) when a stage requires
  the calling agent (orchestrator stages) or a missing capability. There is no verb that lets a host
  say "pause the currently-running workflow right now."
- **Claude Code satisfies this via:** nothing -- there is no pause command to wire up.
- **Not yet implemented:** a client-initiated pause API. Any future adapter (Claude, Codex, or
  otherwise) is limited to the same self-pausing behavior; none can force an external pause today.

### 3. Resume a workflow

- **Exists:** yes, two real modes -- `resume --run-id <id>` (the harnesskit run-id state machine,
  via `scripts/resume-run.js`) and `resume --target <path> [--resolve-stage ... --resolve-status ...
  --resolve-outputs '<json>']` (continues a paused `.harnesskit/workflow-dag.json`, optionally
  applying one orchestrator resolution first).
- **Claude Code satisfies this via:** `commands/resume.md`, shelling out to
  `node "${CLAUDE_PLUGIN_ROOT}/bin/harnesskit.js" resume $ARGUMENTS`.

### 4. Cancel a workflow

- **Exists:** no. There is no `cancel`/`abort` verb anywhere in `bin/harnesskit.js`.
- **Claude Code satisfies this via:** nothing.
- **Not yet implemented:** cancellation is a real gap in the underlying CLI, not something this
  plugin declined to wire up. The closest available action is manual: delete or edit
  `<target>/.harnesskit/workflow-dag.json` directly, which is out of contract (a filesystem
  workaround, not an API).

### 5. Inspect a workflow (read-only, without advancing it)

- **Exists:** partially. `inspect --target <path>` (`cmdInspect`) profiles a *repo* (stack, git
  state, CI, risk) and writes real evidence JSON -- it does not describe an in-flight *workflow's*
  stage-by-stage state. `status [--all]` (`cmdStatus`) lists runs by `run_id`/`state` from the
  run-id state machine, but does not describe a `--target`-based `.harnesskit/workflow-dag.json`'s
  stage detail without also trying to advance it (that's what `resume --target` does, and it is not
  read-only -- it re-invokes `executeWorkflow`).
- **Claude Code satisfies this via:** `commands/inspect.md` (repo profile) and `commands/status.md`
  (run-id list), each a direct wrap of the corresponding verb.
- **Not yet implemented:** a genuinely read-only "describe this paused `--target` workflow's
  stages without executing anything further" verb. Today the only way to see per-stage
  `workflow-dag.json` detail is to read the JSON file directly (a filesystem read outside this
  contract) or to call `resume --target`, which both reads and attempts to advance it.

### 6. Submit user intent

- **Exists:** yes, at exactly two points -- starting a new workflow (`run --instruction "<text>"`)
  and resolving one specific paused stage (`resume --target ... --resolve-stage discover-task
  --resolve-outputs '{"selected_task": "...", "resolution_reason": "..."}'`).
- **Claude Code satisfies this via:** `commands/run.md` and `commands/resume.md`.
- **Not yet implemented:** a general "inject new intent into an already-running workflow at an
  arbitrary point" verb. `--resolve-outputs` is real but narrowly scoped to whichever stage type
  the workflow engine defines resolution semantics for today (`discover-task`'s `selected_task` is
  the one concretely wired in `cmdResumeTarget`); other stage types accept a status/outputs object
  but the engine may not interpret its contents the same way.

### 7. Submit approval

- **Exists in the codebase, but not through the six-verb CLI.** `scripts/check-approval-needed.js`,
  `scripts/grant-approval.js`, and `scripts/validate-approval-token.js` are real, migrated scripts
  that implement approval-token semantics -- but `bin/harnesskit.js` does not expose an `approve`
  verb that calls them. They are lower-level machinery the CLI's `run`/`resume` verbs do not
  currently surface.
- **Claude Code satisfies this via:** nothing in this plugin -- there is no command wired to these
  scripts, because doing so would mean inventing a seventh CLI verb, which this phase was
  explicitly told not to do.
- **Not yet implemented:** an `approve`-shaped verb on the public CLI. This is the single largest
  gap between "what the full harness's design implies exists" and "what the six-verb public CLI
  actually exposes" -- worth flagging for a future CLI-surface decision, not something this contract
  or plugin should paper over by inventing a command that doesn't call anything real.

### 8. Invoke a specific capability directly

- **Exists:** no, not as a direct RPC. `capabilities` (`cmdCapabilities`) only *reports* the
  declared `config/capability-matrix.json` -- it does not let a caller invoke one named capability
  in isolation. Capabilities are only ever exercised implicitly, inside `executeWorkflow`'s adapter
  selection during a `run`/`resume`.
- **Claude Code satisfies this via:** `commands/capabilities.md` (report-only).
- **Not yet implemented:** direct capability invocation as a standalone action.

### 9. Receive status / evidence

- **Exists:** yes. `status [--all]` reports run-id/state/task_type/confidence/ts per run.
  `run`/`resume` both return a `stages` array (`stage_id`, `status`, `selected_adapter`) and
  `workflow_dag_path`. `inspect` writes and returns real evidence (`repo-profile.json`,
  `repo-facts.json`, `repo-risk-report.json`, `repo-knowledge-index.json`).
- **Claude Code satisfies this via:** `commands/status.md`, `commands/run.md`,
  `commands/resume.md`, `commands/inspect.md` -- all relay the real JSON verbatim, per each command
  file's explicit instruction not to paraphrase or fabricate fields.

### 10. Receive questions (structured clarification requests)

- **Exists:** informally only. When a workflow pauses (e.g. a genuine `discover-task` tie), the
  `note` field is a prose explanation of why, not a structured question object (no `{question,
  options, expected_response_shape}` schema exists anywhere in `bin/harnesskit.js`'s output shapes).
  A human/host reading `paused_at` + `note` has to infer what's being asked.
- **Claude Code satisfies this via:** the same `run`/`resume` command output relay -- the prose
  `note` field is shown verbatim, which is the best available signal today.
- **Not yet implemented:** a structured question schema. This would need to be added to the CLI's
  own output shape before any adapter (Claude, Codex, or otherwise) could do better than relaying
  prose.

### 11. Identify host + adapter + model + version + permissions + network posture

- **Exists:** no. None of the six verbs report which host is calling them, which model is running,
  the plugin's own version, its effective tool permissions, or network posture. `bin/harnesskit.js`
  is host-blind by design -- it is a CLI, invoked the same way regardless of caller.
- **Claude Code satisfies this via:** nothing built in this phase. The *host* (Claude Code) knows
  its own model/version/permissions internally (e.g. `${CLAUDE_PLUGIN_ROOT}` resolves inside Claude
  Code sessions and is unresolved/absent otherwise -- see the resolution check pattern used in
  `compound-engineering`'s `ce-setup` skill for a real precedent of detecting "am I actually running
  inside Claude Code" this way), but nothing in this plugin surfaces that identity back through
  HarnessKit's own output today.
- **Not yet implemented:** a `harnesskit identify`-shaped verb (or equivalent) that a host process
  populates with its own host name, adapter name, model (if exposed), harness version, permission
  set, and network posture, so evidence/logs can be attributed. This is arguably the most important
  gap for a genuine multi-host future: without it, nothing in a run's evidence trail says *which*
  host/adapter/model actually drove a given action.

---

## Summary table

| Capability | In `bin/harnesskit.js`? | Claude Code command | Gap for future adapters |
|---|---|---|---|
| Start | yes (`run`) | `commands/run.md` | none |
| Pause | partial (self-pausing only) | -- | no client-initiated pause |
| Resume | yes (`resume`, 2 modes) | `commands/resume.md` | resolution semantics narrow (discover-task only, concretely) |
| Cancel | no | -- | no cancel verb at all |
| Inspect workflow (read-only) | partial (`inspect`=repo, `status`=run list) | `commands/inspect.md`, `commands/status.md` | no read-only per-stage `--target` view |
| Submit intent | yes, at 2 points | `commands/run.md`, `commands/resume.md` | no general mid-run intent injection |
| Submit approval | no (scripts exist, not CLI-wired) | -- | no `approve` verb |
| Invoke capability | no (report-only) | `commands/capabilities.md` | no direct invocation |
| Receive status/evidence | yes | all 6 commands | none |
| Receive questions | informal (prose `note`) | `commands/run.md`, `commands/resume.md` | no structured question schema |
| Identify host/adapter/model/version/permissions/network | no | -- | no identity verb anywhere |

## What a future Codex CLI (or other host) adapter would need to add

1. The same six shell-outs this Claude Code plugin does (trivial -- Codex CLI can run
   `node bin/harnesskit.js <verb> <args>` identically; nothing here is Claude-specific).
2. Its own equivalent of `${CLAUDE_PLUGIN_ROOT}`/`HARNESS_ROOT` wiring so `capabilities`/`doctor`/
   `status` resolve against the right root.
3. Everything marked "not yet implemented" above is a CLI-level gap, not a host-level one -- a
   Codex adapter gains nothing by being cleverer than this Claude adapter; the six verbs are the
   ceiling for any host until `bin/harnesskit.js` itself grows new verbs (`approve`, `cancel`, a
   read-only workflow-describe, an `identify`, a structured question schema).
