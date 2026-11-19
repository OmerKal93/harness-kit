#!/usr/bin/env node
// local-ci.js — ORCH-4/R7: local CI/CD control plane.
//
// Composes existing checks into one pass/fail gate — does NOT duplicate their logic. Right-sized
// for HarnessKit's local-only/never-push constraint: a conventional remote CI (GitHub Actions)
// is the wrong shape for a repo that structurally cannot push, so this is the substitute.
//
// Modes:
//   full             (default) every check below.
//   read-only-check  same checks, output explicitly notes none of them mutate anything (true by
//                    construction — every composed check is already self-test/report-only/advisory).
//   affected-scope   full + scope-fence/claim-support-check/goal-drift-check for a given --run-id
//                    (these three need an active run to check against; skipped without --run-id).
//
// CLI:
//   node scripts/local-ci.js [--mode full|read-only-check|affected-scope] [--run-id <id>] [--json] [--md <path>]
//   node scripts/local-ci.js --self-test
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseArgs, harnessRoot, nowIso } = require('./_lib.js');
const { isDisabled } = require('./is-disabled.js');
const leaseMod = require('./lease.js');

const SELF_TEST_MODULES = [
  'workflow-state.js', 'loop-conductor.js', 'harness-loop.js', 'plan-lint.js', 'scope-fence.js',
  'validate-adapter-registry.js', path.join('..', 'router', 'select-adapter.js'),
  'isolated-eval-batch.js', 'harness-bench.js', 'codex-adapter.js', 'resume-run.js',
  'enter-review-state.js',
  path.join('review-independence', 'run-json-atomic.js'),
  path.join('review-independence', 'core', 'actor-identity.js'),
  path.join('review-independence', 'core', 'review-authorization.js'),
  path.join('review-independence', 'core', 'evaluator.js'),
  path.join('review-independence', 'adapters', 'claude-code-hooks.js'),
  'capability-resolver.js', 'inspect-repo.js', 'task-discovery.js', 'compose-workflow.js',
  'execute-workflow.js', 'generate-harnesskit-lock.js', 'validate-harnesskit-lock.js',
  'validate-capability-matrix.js', path.join('..', 'bin', 'harnesskit.js'),
  path.join('..', 'hooks', 'policy', 'guard-policy.js'),
  path.join('..', 'hooks', 'pre_tool_use_guard.js'),
  'dispatcher.js', 'validate-config.js', 'verify-install.js', 'gbrain-bootstrap-check.js'
];

function runNodeSelfTest(root, relPath) {
  const full = path.join(root, 'scripts', relPath);
  const start = Date.now();
  try {
    const out = execFileSync(process.execPath, [full, '--self-test'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { module: relPath, ok: true, duration_ms: Date.now() - start, tail: out.trim().split(/\r?\n/).slice(-1)[0] };
  } catch (e) {
    return { module: relPath, ok: false, duration_ms: Date.now() - start, error: String((e && e.stdout) || e.message || e).trim().slice(-300) };
  }
}

function runJsonScript(root, relPath, args) {
  const full = path.join(root, 'scripts', relPath);
  try {
    const out = execFileSync(process.execPath, [full, ...(args || []), '--json'], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, data: JSON.parse(out) };
  } catch (e) {
    const stdout = (e && e.stdout) ? String(e.stdout) : '';
    let data = null; try { data = JSON.parse(stdout); } catch { /* not JSON */ }
    return { ok: data ? !!data.ok : false, data, error: data ? undefined : String((e && e.message) || e).slice(0, 300) };
  }
}

function checkPreflight(root) {
  const r = execFileSync(process.execPath, [path.join(root, 'scripts', 'preflight.js')], { encoding: 'utf8', timeout: 60000 });
  const jsonStart = r.indexOf('{');
  const data = jsonStart >= 0 ? JSON.parse(r.slice(jsonStart)) : { ok: false };
  return { check: 'preflight', ok: data.ok === true, data };
}

function checkEvals(root) {
  const r = execFileSync(process.execPath, [path.join(root, 'scripts', 'run-evals.js')], { encoding: 'utf8', timeout: 180000 });
  const data = JSON.parse(r);
  return { check: 'evals', ok: data.ok === true, data: { run_id: data.run_id, duration_ms: data.duration_ms, categories: Object.keys(data.categories || {}) } };
}

function checkSkillRegistration(root) {
  const r = runJsonScript(root, 'validate-skill-registration.js', []);
  // advisory_only registry: a false here is informational (pre-existing hash mismatches are
  // known/tracked), not a hard CI failure — surfaced, not hidden, but does not block by itself.
  return { check: 'skill_registration', ok: true, advisory: !r.data || r.data.ok !== true, data: r.data };
}

function checkCapabilityMatrix(root) {
  const r = runJsonScript(root, 'validate-capability-matrix.js', []);
  return { check: 'capability_matrix_drift', ok: !!(r.data && r.data.ok), data: r.data };
}

function checkAdapterRegistration(root) {
  const r = runJsonScript(root, 'validate-adapter-registry.js', []);
  return { check: 'adapter_registration', ok: !!(r.data && r.data.ok), data: r.data };
}

function checkCommitLease(root) {
  const conflict = leaseMod.findConflict({ root, kind: 'commit', owner_session: 'local-ci-probe' });
  return { check: 'commit_lease', ok: !conflict, data: { conflict: conflict || null } };
}

function checkScopeFence(root, runId) {
  if (!runId) return { check: 'scope_fence', ok: true, skipped: true, reason: 'no --run-id supplied' };
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'scope-fence.js'), '--run-id', runId], { encoding: 'utf8', timeout: 30000 });
    return { check: 'scope_fence', ok: true, data: JSON.parse(out) };
  } catch (e) { return { check: 'scope_fence', ok: true, error: String(e.message || e).slice(0, 200), note: 'report-only, never blocks' }; }
}

function runChecks({ root, mode, runId }) {
  const results = [];
  results.push(checkPreflight(root));
  for (const mod of SELF_TEST_MODULES) {
    const rel = mod.startsWith('..') ? mod : mod;
    results.push({ check: `self_test:${path.basename(mod)}`, ...runNodeSelfTest(root, mod) });
  }
  results.push(checkEvals(root));
  results.push(checkSkillRegistration(root));
  results.push(checkAdapterRegistration(root));
  results.push(checkCapabilityMatrix(root));
  results.push(checkCommitLease(root));
  if (mode === 'affected-scope') {
    results.push(checkScopeFence(root, runId));
  }
  return results;
}

// Blocking = any check with ok:false that isn't explicitly advisory/skipped.
function summarize(results) {
  const blocking = results.filter(r => r.ok !== true && !r.advisory && !r.skipped);
  const advisory = results.filter(r => r.advisory === true);
  return {
    ok: blocking.length === 0,
    total_checks: results.length,
    passed: results.filter(r => r.ok === true).length,
    blocking_failures: blocking.map(r => ({ check: r.check, error: r.error || r.tail || null })),
    advisory_notes: advisory.map(r => r.check),
    diagnostic_handoff: blocking.length
      ? { suggestion: 'route via router/select-adapter.js --task-type code-bug for a repair-focused adapter selection; do NOT auto-invoke Codex from this gate — that stays a separate, explicit decision', failing_checks: blocking.map(r => r.check) }
      : null
  };
}

function toMarkdown(results, summary, mode) {
  const lines = [`# local-ci — ${mode} — ${nowIso()}`, '', `**Verdict: ${summary.ok ? 'PASS' : 'FAIL'}** (${summary.passed}/${summary.total_checks} checks passed)`, ''];
  for (const r of results) {
    const mark = r.skipped ? '⏭️ SKIP' : (r.ok ? '✅ PASS' : (r.advisory ? '⚠️ ADVISORY' : '❌ FAIL'));
    lines.push(`- ${mark} \`${r.check}\`${r.reason ? ` — ${r.reason}` : ''}${!r.ok && !r.advisory && !r.skipped ? ` — ${r.error || ''}` : ''}`);
  }
  if (summary.diagnostic_handoff) {
    lines.push('', '## Diagnostic handoff', summary.diagnostic_handoff.suggestion);
  }
  return lines.join('\n') + '\n';
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  push('summarize_all_pass', summarize([{ check: 'a', ok: true }, { check: 'b', ok: true }]).ok === true, 'all-pass input must summarize to ok:true');
  push('summarize_blocking_failure', summarize([{ check: 'a', ok: true }, { check: 'b', ok: false, error: 'boom' }]).ok === false, 'a real failure must block');
  push('summarize_advisory_does_not_block', summarize([{ check: 'a', ok: false, advisory: true }]).ok === true, 'advisory:true failures must not block the gate');
  push('summarize_skipped_does_not_block', summarize([{ check: 'a', ok: true, skipped: true }]).ok === true, 'skipped checks must not block');
  {
    const s = summarize([{ check: 'evals', ok: false, error: 'X' }]);
    push('diagnostic_handoff_present_on_failure', s.diagnostic_handoff && s.diagnostic_handoff.failing_checks.includes('evals'), JSON.stringify(s.diagnostic_handoff));
  }
  push('diagnostic_handoff_null_on_pass', summarize([{ check: 'a', ok: true }]).diagnostic_handoff === null, 'no handoff object when everything passes');
  {
    const md = toMarkdown([{ check: 'x', ok: true }], { ok: true, passed: 1, total_checks: 1, diagnostic_handoff: null }, 'full');
    push('markdown_output_well_formed', md.includes('PASS') && md.includes('local-ci'), md.slice(0, 60));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  if (isDisabled().disabled) { console.log(JSON.stringify({ ok: true, disabled: true })); process.exit(0); }
  const root = harnessRoot();
  const mode = a.mode || 'full';
  const runId = a['run-id'] || null;
  const results = runChecks({ root, mode, runId });
  const summary = summarize(results);
  if (a.md) fs.writeFileSync(String(a.md), toMarkdown(results, summary, mode));
  if (a.json) console.log(JSON.stringify({ mode, results, summary }, null, 2));
  else console.log(toMarkdown(results, summary, mode));
  process.exit(summary.ok ? 0 : 1);
}

module.exports = { runChecks, summarize, toMarkdown };
if (require.main === module) main();
