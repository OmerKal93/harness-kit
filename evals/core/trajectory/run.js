#!/usr/bin/env node
// evals/core/trajectory/run.js — Phase 4 Batch 3.
// Iterates fixtures in evals/fixtures/trajectory/cases.json. For each case:
//   - optionally materializes a tmp run dir under evals/_tmp/trajectory/<id>/
//     with the named placeholder artifacts (non-empty)
//   - calls trajectory-risk-audit's auditLogs() with the case's logs + scoped_files + tmpDir
//   - merges default_expected + expected_overrides, asserts per-pattern detection
//
// Cleans up tmp dirs at end of run. Honors kill switch. Deterministic.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');
const { auditLogs } = require('../../../scripts/trajectory-risk-audit.js');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function rmRecursive(d) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) rmRecursive(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(d);
}

const ALL_SHAPES = [
  'retry_storm',
  'tool_target_oscillation',
  'scope_creep',
  'dead_end',
  'premature_done',
  'hook_bypass_attempt',
  'trace_incompleteness'
];

function evalCase(c, tmpRoot, defaultExpected) {
  const tmpDir = c.run_dir_artifacts ? path.join(tmpRoot, c.id) : null;
  if (tmpDir) {
    ensureDir(tmpDir);
    for (const name of c.run_dir_artifacts) {
      fs.writeFileSync(path.join(tmpDir, name), `placeholder for ${c.id}\n`, 'utf8');
    }
  }
  const result = auditLogs(
    c.tool_log || [],
    c.decision_log || [],
    { scopedFiles: c.scoped_files || [], runDirPath: tmpDir }
  );
  const expected = Object.assign({}, defaultExpected, c.expected_overrides || {});
  const checks = [];
  let pass = true;
  for (const shape of ALL_SHAPES) {
    const e = !!expected[shape];
    const a = !!(result.patterns[shape] && result.patterns[shape].detected);
    const ok = e === a;
    checks.push({ shape, expected: e, actual: a, pass: ok });
    if (!ok) pass = false;
  }
  return { id: c.id, shape: c.shape, label: c.label, pass, checks, detected_count: result.detected_count };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'trajectory');
  const corpusPath = path.join(fixturesDir, 'cases.json');

  let corpus;
  try { corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')); }
  catch (e) {
    console.log(JSON.stringify({ category: 'trajectory', pass: false, error: 'cases.json unreadable: ' + e.message }, null, 2));
    process.exit(1);
  }
  const cases = corpus.cases || [];
  const defaultExpected = corpus.default_expected || {};

  const tmpRoot = path.join(harnessRoot(), 'evals', '_tmp', 'trajectory');
  rmRecursive(tmpRoot);
  ensureDir(tmpRoot);

  let results;
  try {
    results = cases.map(c => evalCase(c, tmpRoot, defaultExpected));
  } finally {
    rmRecursive(tmpRoot);
  }

  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failures = results.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  // Per-shape breakdown (counting only cases whose shape matches).
  const byShape = {};
  for (const r of results) {
    const k = r.shape || 'unlabeled';
    if (!byShape[k]) byShape[k] = { total: 0, passed: 0 };
    byShape[k].total += 1;
    if (r.pass) byShape[k].passed += 1;
  }

  const out = {
    category: 'trajectory',
    pass: total > 0 && failures.length === 0,
    score,
    total,
    passed,
    failed: failures.length,
    by_shape: byShape,
    failures: failures.slice(0, 20)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module) main();
