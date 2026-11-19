#!/usr/bin/env node
// evals/core/goal-drift/run.js — Eval Integrity batch.
// Drives scripts/goal-drift-check.js with synthetic {goal, toolLog} fixtures.
// Asserts recommendation enum and optional similarity range.
// Contract: prints {category,pass,score,total,passed,failed,...} envelope, exit 0/1.
// Honors kill switch. Deterministic. Zero network.
'use strict';

const path = require('path');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs, readJson } = require('../../../scripts/_lib.js');
const { check } = require('../../../scripts/goal-drift-check.js');

const VALID_RECS = new Set([
  'within_goal_acceptable',
  'soft_drift_review_suggested',
  'drift_likely_NEEDS_USER',
  'severe_drift_halt_NEEDS_USER'
]);

function evalCase(fx) {
  const goal = fx.goal || '';
  const toolLog = fx.tool_log || [];
  const recentN = fx.recent_n || 20;

  let result;
  try { result = check({ goal, toolLog, recentN }); }
  catch (e) {
    return { id: fx.id, label: fx.label || 'positive', pass: false,
             fail_reason: 'check-threw: ' + String(e.message).slice(0, 120) };
  }

  const exp = fx.expected || {};
  const fails = [];

  if (typeof exp.recommendation === 'string' && result.recommendation !== exp.recommendation) {
    fails.push('recommendation:actual=' + result.recommendation + '/expected=' + exp.recommendation);
  }
  if (typeof exp.similarity_gte === 'number' && result.similarity < exp.similarity_gte) {
    fails.push('similarity_gte:actual=' + result.similarity + '/expected>=' + exp.similarity_gte);
  }
  if (typeof exp.similarity_lt === 'number' && result.similarity >= exp.similarity_lt) {
    fails.push('similarity_lt:actual=' + result.similarity + '/expected<' + exp.similarity_lt);
  }

  return {
    id: fx.id,
    label: fx.label || 'positive',
    pass: fails.length === 0,
    fail_reason: fails.length === 0 ? null : fails.join('|'),
    actual_recommendation: result.recommendation,
    actual_similarity: result.similarity,
    actual_drift_score: result.drift_score
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] ||
    path.join(harnessRoot(), 'evals', 'fixtures', 'goal-drift');

  const data = readJson(path.join(fixturesDir, 'cases.json'), { fixtures: [] });
  const cases = data.fixtures || [];

  const cfg = readJson(path.join(harnessRoot(), 'evals', 'config.json'), { categories: {} });
  const minRatio = (cfg.categories['goal-drift'] &&
    typeof cfg.categories['goal-drift'].min_pass_ratio === 'number')
    ? cfg.categories['goal-drift'].min_pass_ratio : 1.0;

  const results = cases.map(evalCase);
  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failures = results.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  const byLabel = {};
  for (const r of results) {
    byLabel[r.label] = byLabel[r.label] || { total: 0, passed: 0 };
    byLabel[r.label].total++;
    if (r.pass) byLabel[r.label].passed++;
  }

  const out = {
    category: 'goal-drift',
    pass: total > 0 && score >= minRatio,
    score,
    total,
    passed,
    failed: failures.length,
    min_pass_ratio: minRatio,
    by_label: byLabel,
    failures: failures.slice(0, 30)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module) main();
