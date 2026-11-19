#!/usr/bin/env node
'use strict';
// hooks/pre_tool_use_guard.js -- Claude Code PreToolUse hook adapter + host-neutral exit-code CLI
// entry point for HarnessKit's "guard" policy (careful + freeze, per gstack's own naming -- see
// docs/GSTACK_POLICY_CORE_REPORT.md for the full design).
//
// This is the exact file evals/core/guard-triggers/run.js already spawns (has since before this
// change existed): it reads one JSON event
// from stdin, shaped { tool_name, tool_input, cwd }, and communicates its decision via exit code:
//   0 = allow      2 = block      (anything else = non-blocking error; the eval treats it as neither)
//
// That two-value exit-code contract is not an invention of this change -- it was already fixed by
// the pre-existing eval fixtures (evals/fixtures/guard-triggers/cases.json, dated to the Phase 1A
// migration). It also happens to coincide exactly with Claude Code's own documented PreToolUse hook
// exit-code contract (exit 2 = blocking error, stderr fed back to the model as the block reason;
// exit 0 = success/allow) -- so this single file is usable BOTH as the eval's target AND, registered
// directly in .claude/settings.json via ${CLAUDE_PROJECT_DIR}, as a real Claude Code hook command.
// The two contracts were not designed together; they overlap by construction of Claude Code's own
// hook exit-code convention, not by coincidence of this file's authorship.
//
// For 'ask' (soft-warn, overridable) decisions -- gstack's original severity for everything except
// the four hard-blocked "discard uncommitted work" patterns -- this adapter additionally writes a
// Claude-Code-shaped hookSpecificOutput.permissionDecision:"ask" JSON object to stdout while still
// exiting 0. This half of the contract is a best-effort port of Claude Code's documented PreToolUse
// JSON output shape; it has NOT been independently fired against a live Claude Code session in this
// pass (no such harness was available) -- see docs/GSTACK_POLICY_CORE_REPORT.md, "Known limitations".
//
// Zero dependency on scripts/ at runtime by design: this file only requires ./policy/guard-policy.js,
// so hooks/ can be read/reasoned about (and, per config/project-profiles/*.json's self_guard trigger,
// change-controlled) as a self-contained unit.

const fs = require('fs');
const path = require('path');
const { evaluateBashCommand, evaluateFileWrite } = require('./policy/guard-policy.js');

function harnessRoot() {
  return process.env.HARNESS_ROOT || path.resolve(__dirname, '..');
}

// Overridable so self-tests (and, later, a real setup flow) can point freeze state at a disposable
// directory instead of mutating this worktree's real .claude/ state -- see runSelfTest() below.
function freezeStateDir() {
  return process.env.HARNESSKIT_GUARD_STATE_DIR || path.join(harnessRoot(), '.claude');
}

function freezeStatePath() {
  return path.join(freezeStateDir(), 'freeze-boundary.local.txt');
}

function readFreezeBoundary() {
  try {
    const raw = fs.readFileSync(freezeStatePath(), 'utf8').trim();
    return raw || null;
  } catch {
    return null; // not configured yet -- fail open, matches guard-policy.js's own default
  }
}

function writeFreezeBoundary(dir) {
  const abs = path.resolve(dir);
  const p = freezeStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, abs + '\n', 'utf8');
  return abs;
}

function clearFreezeBoundary() {
  try { fs.unlinkSync(freezeStatePath()); } catch { /* already absent */ }
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function decide(event) {
  const toolName = event && event.tool_name;
  const input = (event && event.tool_input) || {};
  if (toolName === 'Bash') {
    return evaluateBashCommand(input.command);
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    return evaluateFileWrite(input.file_path, readFreezeBoundary());
  }
  return { decision: 'allow', pattern: null, reason: null };
}

function emitAndExit(result) {
  if (result.decision === 'block') {
    process.stderr.write(`[guard] ${result.reason}\n`);
    process.exit(2);
  }
  if (result.decision === 'ask') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `[guard] ${result.reason}`
      }
    }) + '\n');
    process.exit(0);
  }
  process.exit(0);
}

function runSelfTest() {
  // Subprocess-level integration self-test: spawns THIS file as a real child process with real
  // piped stdin, exactly as evals/core/guard-triggers/run.js's spawnGuard() does and exactly as
  // Claude Code itself would when firing the registered hook. Uses a disposable temp state dir for
  // freeze so this never touches the worktree's real .claude/freeze-boundary.local.txt.
  const { execFileSync } = require('child_process');
  const os = require('os');
  const self = __filename;
  const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-guard-selftest-'));

  function spawn(event, envOverride) {
    try {
      execFileSync(process.execPath, [self], {
        input: JSON.stringify(event),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { HARNESSKIT_GUARD_STATE_DIR: tmpStateDir }, envOverride || {})
      });
      return { status: 0 };
    } catch (e) {
      return { status: e.status == null ? 1 : e.status, stderr: (e.stderr || '').toString() };
    }
  }

  function spawnSetter(args) {
    execFileSync(process.execPath, [self, ...args], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { HARNESSKIT_GUARD_STATE_DIR: tmpStateDir })
    });
  }

  const bashCases = [
    ['git checkout .', 'block'],
    ['git checkout -- .', 'block'],
    ['git checkout main', 'allow'],
    ['git checkout file.txt', 'allow'],
    ['git restore .', 'block'],
    ['git restore --staged .', 'block'],
    ['git restore --help', 'allow'],
    ['git reset --hard HEAD~1', 'block'],
    ['rm -rf /tmp/whatever', 'ask'],   // ask -> exit 0, non-fatal
    ['echo hi', 'allow']
  ];

  const failures = [];
  let passed = 0;
  let total = 0;

  for (const [command, expected] of bashCases) {
    total++;
    const { status } = spawn({ tool_name: 'Bash', tool_input: { command }, cwd: harnessRoot() });
    const got = status === 2 ? 'block' : status === 0 ? 'allow' : `exit-${status}`;
    // 'ask' decisions exit 0 in this adapter (non-blocking) -- treat exit 0 as satisfying an
    // expected 'ask' or 'allow' for this subprocess-level check; only 'block' must be exit 2.
    const ok = expected === 'block' ? got === 'block' : got === 'allow';
    if (ok) passed++; else failures.push(`bash:"${command}" expected=${expected} actual_exit=${status}`);
  }

  // Freeze: no boundary configured yet -> allow
  total++;
  {
    const r = spawn({ tool_name: 'Edit', tool_input: { file_path: path.join(harnessRoot(), 'anything.js') } });
    if (r.status === 0) passed++; else failures.push(`freeze:unconfigured expected=allow actual_exit=${r.status}`);
  }

  // Freeze: set boundary, in-boundary write allowed
  spawnSetter(['--freeze-set', path.join(harnessRoot(), 'hooks')]);
  total++;
  {
    const r = spawn({ tool_name: 'Write', tool_input: { file_path: path.join(harnessRoot(), 'hooks', 'x.js') } });
    if (r.status === 0) passed++; else failures.push(`freeze:in-boundary expected=allow actual_exit=${r.status}`);
  }

  // Freeze: out-of-boundary write blocked
  total++;
  {
    const r = spawn({ tool_name: 'Edit', tool_input: { file_path: path.join(harnessRoot(), 'scripts', 'x.js') } });
    if (r.status === 2) passed++; else failures.push(`freeze:out-of-boundary expected=block actual_exit=${r.status}`);
  }

  // Freeze: clear boundary, writes allowed again
  spawnSetter(['--freeze-clear']);
  total++;
  {
    const r = spawn({ tool_name: 'Edit', tool_input: { file_path: path.join(harnessRoot(), 'scripts', 'x.js') } });
    if (r.status === 0) passed++; else failures.push(`freeze:cleared expected=allow actual_exit=${r.status}`);
  }

  fs.rmSync(tmpStateDir, { recursive: true, force: true });

  const out = { module: 'pre_tool_use_guard', pass: failures.length === 0, total, passed, failed: failures.length, failures };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) { runSelfTest(); return; }

  const setIdx = argv.indexOf('--freeze-set');
  if (setIdx !== -1 && argv[setIdx + 1]) {
    const abs = writeFreezeBoundary(argv[setIdx + 1]);
    console.log(JSON.stringify({ ok: true, freeze_boundary: abs }));
    process.exit(0);
  }
  if (argv.includes('--freeze-clear')) {
    clearFreezeBoundary();
    console.log(JSON.stringify({ ok: true, freeze_boundary: null }));
    process.exit(0);
  }

  const raw = readStdin();
  let event = {};
  try { event = JSON.parse(raw || '{}'); } catch { event = {}; }
  emitAndExit(decide(event));
}

module.exports = { decide, harnessRoot, freezeStatePath, readFreezeBoundary };

if (require.main === module) main();
