# HarnessKit

HarnessKit is a local harness for AI coding agents. It sits between a task and the agent that does it, and adds the controls a bare agent lacks:

- **Task discovery and classification:** inspect a repository, find candidate tasks, and route each one by type and risk.
- **Workflow execution:** a composed, resumable workflow (a legacy engine and an opt-in LangGraph engine) that pauses for a human when it must.
- **Independent review:** reviewer-independence checks, so the actor that produced a change is not the one that approves it.
- **Verification:** deterministic checks and a classifier for failures that look new versus known.
- **Governance:** approval tokens, a tool-call guard hook, secret redaction, a prompt-injection scan, and a registry of skills and capabilities.
- **Evals:** 17 eval categories with frozen baselines that test the controls above.

The tests and evals run offline. The only command that fetches anything is `run --repo <url>`, which clones a remote repository.

> Status: pre-1.0. The version string in `VERSION` and `package.json` is still `0.2.0-internal`. See "Known gaps" below.

## Requirements

- Node.js 18 or newer
- git

## Install

```sh
git clone <this repository>
cd harnesskit
npm ci
```

`npm ci` installs exactly what `package-lock.json` pins (two packages: `@langchain/langgraph` and `@langchain/langgraph-checkpoint-sqlite`).

## Configure the root

HarnessKit finds its own config, evals and run state through one environment variable, `HARNESS_ROOT`. Point it at your checkout. If you leave it unset, it falls back to `~/.harnesskit`, which has no config in it, and most commands will report that.

```sh
# bash / zsh
export HARNESS_ROOT="$PWD"
```

```powershell
# PowerShell
$env:HARNESS_ROOT = (Get-Location).Path
```

Set `HARNESSKIT_DISABLED=1` (or create a `DISABLED` file in the root) to switch every workflow-affecting script and hook off. This kill switch outranks everything else.

## Usage

The CLI has six verbs:

```sh
node bin/harnesskit.js inspect --target <path>
node bin/harnesskit.js capabilities
node bin/harnesskit.js doctor
node bin/harnesskit.js status [--all]
node bin/harnesskit.js resume --run-id <id>
node bin/harnesskit.js run --repo <url-or-path> --instruction "<text>"
```

Add `--engine langgraph` to `run` or `resume` to use the LangGraph engine instead of the default one. The same verbs are exposed as Claude Code slash commands through `.claude-plugin/plugin.json` and `commands/`, and each one shells out to the same binary.

Most files under `scripts/` also run on their own and print their own usage. Each supports `--self-test`.

## Tests

```sh
npm test
```

This runs `scripts/run-evals.js`: every enabled category under `evals/core/`, scored against `evals/baselines/` and `evals/config.json`. It exits non-zero if a category misses its threshold. Results go to `evals/results/` (git-ignored).

Two more checks:

```sh
node scripts/local-ci.js            # composes every script's own --self-test plus validators into one gate
node scripts/validate-config.js     # validates config/ against its schemas
```

Tests use only synthetic data. Every secret-shaped string in a test or fixture is fake and carries a `FAKE` or `EXAMPLE` marker.

## Layout

| Path | What is in it |
| --- | --- |
| `bin/` | the `harnesskit` CLI |
| `scripts/` | workflow engine, guards, redaction, validators, brokers |
| `router/` | task classification and adapter, agent and workflow selection |
| `hooks/` | the pre-tool-use guard hook for Claude Code |
| `config/` | policies, registries, schemas and example project profiles |
| `evals/` | eval runners, fixtures and frozen baselines |
| `skills/` | the bundled governance and review skills |
| `commands/` | slash-command definitions |
| `docs/` | design notes and per-component contracts |
| `examples/` | example memory files and an example overlay lock |

## Known gaps

- A few design notes and code comments mention planning documents (for example under `docs/plans/`) that are not part of this repository.
- `config/capability-inventory.json` and related registries still list a few capabilities whose implementations are not bundled here.
- Memory-related scripts expect you to supply your own memory store; `memory/` holds empty stubs.

## AI-assisted development

Most of this code, its tests and its documentation were written with AI coding assistants under human direction and review. Read it and test it as you would any other third-party code.

## License

MIT. See `LICENSE`.
