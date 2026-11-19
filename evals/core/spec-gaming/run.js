#!/usr/bin/env node
// evals/core/spec-gaming/run.js — Phase 5 Batch 1.
// Iterates fixtures in evals/fixtures/spec-gaming/cases.json. For each case:
//   - resolves diff text (inline `diff` field OR file referenced by `diff_path`)
//   - calls spec-gaming-check's analyzeDiff() with optional verificationText
//   - merges default_expected + expected_overrides
//   - asserts per-pattern detection match against expected
//
// Honors kill switch. Deterministic. Zero network.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');
const { analyzeDiff } = require('../../../scripts/spec-gaming-check.js');

const ALL_PATTERNS = [
  'test_weakened',
  'error_swallowed',
  'symptom_papering',
  'api_change_no_audit'
];

function resolveDiff(c, fixturesDir) {
  if (typeof c.diff === 'string' && c.diff.length > 0) return c.diff;
  if (typeof c.diff_path === 'string' && c.diff_path.length > 0) {
    const p = path.join(fixturesDir, c.diff_path);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return '';
}

function evalCase(c, defaultExpected, fixturesDir) {
  const diff = resolveDiff(c, fixturesDir);
  const result = analyzeDiff(diff, { verificationText: c.verification_md || null });
  const expected = Object.assign({}, defaultExpected, c.expected_overrides || {});
  const checks = [];
  let pass = true;
  for (const p of ALL_PATTERNS) {
    const e = !!expected[p];
    const a = !!(result.patterns[p] && result.patterns[p].detected);
    const ok = e === a;
    checks.push({ pattern: p, expected: e, actual: a, pass: ok });
    if (!ok) pass = false;
  }
  return {
    id: c.id,
    pattern: c.pattern,
    label: c.label,
    pass,
    checks,
    detected_count: result.detected_count
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'spec-gaming');
  const corpusPath = path.join(fixturesDir, 'cases.json');

  let corpus;
  try { corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')); }
  catch (e) {
    console.log(JSON.stringify({ category: 'spec-gaming', pass: false, error: 'cases.json unreadable: ' + e.message }, null, 2));
    process.exit(1);
  }
  const cases = corpus.cases || [];
  const defaultExpected = corpus.default_expected || {};

  const results = cases.map(c => evalCase(c, defaultExpected, fixturesDir));

  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failures = results.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  // Per-pattern accuracy (counting only cases whose pattern field matches).
  const byPattern = {};
  for (const r of results) {
    const k = r.pattern || 'unlabeled';
    if (!byPattern[k]) byPattern[k] = { total: 0, passed: 0 };
    byPattern[k].total += 1;
    if (r.pass) byPattern[k].passed += 1;
  }

  const out = {
    category: 'spec-gaming',
    pass: total > 0 && failures.length === 0,
    score,
    total,
    passed,
    failed: failures.length,
    by_pattern: byPattern,
    failures: failures.slice(0, 20)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module) main();
