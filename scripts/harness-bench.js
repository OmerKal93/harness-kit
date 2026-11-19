#!/usr/bin/env node
// harness-bench.js — ORCH-4/R6: HarnessBench. Executes an IDENTICAL engineering task through
// multiple CLI adapters via scripts/isolated-eval-batch.js and records objective, comparable
// metrics. This is the multi-adapter comparison layer; isolated-eval-batch.js is the single-call
// execution primitive it composes (not duplicates).
//
// Fairness contract: same fixture files, same task prompt (mode-specific prefix only), same time
// ceiling, same grading rule (does the final state/output match the known answer?) — no
// adapter-specific hints. Router/select-adapter.js's own eligibility rules are NOT consulted here
// on purpose: HarnessBench exists to CREATE the evidence the router later consumes (route()'s
// benchmark_all policy is the read side of this write side), so this script deliberately bypasses
// trust_tier gating to run untested/quarantined adapters too — that's the point.
//
// CLI:
//   node scripts/harness-bench.js --fixture-dir <dir> --task-file <f> --adapters claude-code,codex-cli --mode review [--json]
//   node scripts/harness-bench.js --self-test
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseArgs, nowIso, appendNdjson, harnessRoot } = require('./_lib.js');
const { runIsolated, createIsolatedDir } = require('./isolated-eval-batch.js');

const METRICS_SCHEMA_FIELDS = [
  'task_id', 'task_type', 'adapter', 'model', 'adapter_version', 'harnesskit_commit', 'fixture_commit',
  'prompt_hash', 'policy', 'effort_level', 'wall_clock_ms', 'usage', 'estimated_cost_usd', 'tool_calls',
  'files_read', 'files_changed', 'tests_executed', 'tests_passed', 'retries', 'human_corrections',
  'scope_violations', 'fabricated_claims', 'review_findings', 'grader_verdict', 'accepted', 'variance_note'
];

function promptHash(text) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

// Copies fixture_dir's tracked+untracked files (shallow, non-.git) into a fresh isolated dir per
// adapter, so every adapter starts from byte-identical input — the "identical repository snapshot"
// fairness requirement. Pure file-copy, no git needed (works even if fixture_dir isn't a repo).
function snapshotFixture(fixtureDir, destDir) {
  for (const entry of fs.readdirSync(fixtureDir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const src = path.join(fixtureDir, entry.name);
    const dst = path.join(destDir, entry.name);
    if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

// Grades a single run against a known-answer predicate function (task-specific — callers supply
// it; HarnessBench does not hardcode task semantics). Returns a metrics-schema-shaped record.
function gradeRun({ taskId, taskType, mode, adapter, run, gradeFn }) {
  const grader = gradeFn ? gradeFn(run) : { verdict: 'UNGRADED', accepted: null, note: 'no gradeFn supplied' };
  return {
    schema_version: 1,
    task_id: taskId, task_type: taskType || mode, adapter, mode,
    wall_clock_ms: run.duration_ms, ok: run.ok, outcome: run.outcome, exit_code: run.exit_code ?? null,
    grader_verdict: grader.verdict, accepted: grader.accepted, grader_note: grader.note || null,
    output_path: run.output_path || null, ts: nowIso()
  };
}

function runCanary({ fixtureDir, taskFile, adapters, mode, timeoutMs, gradeFn, taskId, taskType }) {
  const prompt = fs.readFileSync(taskFile, 'utf8');
  const results = [];
  // Sequential, foreground — matches Gate-1's proven no-concurrency-corruption lesson.
  for (const adapter of adapters) {
    const dir = createIsolatedDir(`bench-${adapter}`);
    snapshotFixture(fixtureDir, dir);
    const run = runIsolated({ adapter, mode, prompt, cwd: dir, timeoutMs, tag: `bench-${adapter}` });
    results.push(gradeRun({ taskId, taskType, mode, adapter, run, gradeFn }));
  }
  return { schema_version: 1, task_id: taskId, results, evidence: `${adapters.length} adapters, sequential foreground, isolated fresh dirs per adapter, snapshot of ${fixtureDir}` };
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  push('metrics_schema_has_required_fields', METRICS_SCHEMA_FIELDS.includes('wall_clock_ms') && METRICS_SCHEMA_FIELDS.includes('accepted') && METRICS_SCHEMA_FIELDS.includes('review_findings'), METRICS_SCHEMA_FIELDS.join(','));
  push('prompt_hash_deterministic', promptHash('same text') === promptHash('same text') && promptHash('a') !== promptHash('b'), 'hash must be stable and content-sensitive');

  // snapshotFixture copies files, skips .git, no crash on empty dir.
  {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-src-'));
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-dst-'));
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello');
    fs.mkdirSync(path.join(src, '.git'));
    fs.writeFileSync(path.join(src, '.git', 'HEAD'), 'ref: refs/heads/main');
    snapshotFixture(src, dst);
    const copiedA = fs.existsSync(path.join(dst, 'a.txt'));
    const skippedGit = !fs.existsSync(path.join(dst, '.git'));
    push('snapshot_copies_files_skips_git', copiedA && skippedGit, JSON.stringify({ copiedA, skippedGit }));
    fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true });
  }

  // gradeRun with a synthetic run + a known gradeFn -> correct verdict shape.
  {
    const fakeRun = { ok: true, outcome: 'completed', duration_ms: 123, exit_code: 0, raw_output: 'VERDICT: REJECT', output_path: '/tmp/x' };
    const rec = gradeRun({ taskId: 't1', taskType: 'review', mode: 'review', adapter: 'claude-code', run: fakeRun, gradeFn: r => ({ verdict: r.raw_output.includes('REJECT') ? 'CORRECT' : 'WRONG', accepted: r.raw_output.includes('REJECT') }) });
    push('grade_run_shape_correct', rec.grader_verdict === 'CORRECT' && rec.accepted === true && rec.wall_clock_ms === 123, JSON.stringify(rec));
  }
  // ungraded path when no gradeFn supplied — never silently claims a verdict.
  {
    const fakeRun = { ok: true, outcome: 'completed', duration_ms: 10 };
    const rec = gradeRun({ taskId: 't2', mode: 'review', adapter: 'codex-cli', run: fakeRun });
    push('ungraded_when_no_gradefn', rec.grader_verdict === 'UNGRADED' && rec.accepted === null, JSON.stringify(rec));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  const adapters = String(a.adapters || 'claude-code').split(',').map(s => s.trim()).filter(Boolean);
  const result = runCanary({
    fixtureDir: String(a['fixture-dir']), taskFile: String(a['task-file']), adapters,
    mode: String(a.mode || 'review'), timeoutMs: a['timeout-ms'] ? Number(a['timeout-ms']) : undefined,
    taskId: a['task-id'] || 'canary', taskType: a['task-type'] || 'review'
  });
  console.log(a.json ? JSON.stringify(result, null, 2) : `task=${result.task_id} results=${result.results.length}`);
}

module.exports = { runCanary, gradeRun, snapshotFixture, promptHash, METRICS_SCHEMA_FIELDS };
if (require.main === module) main();
