#!/usr/bin/env node
// evals/core/regression/run.js — Phase 4 Batch 4.
// Regression orchestrator. Two modes:
//
//   --establish-baseline --iters <N>
//      Runs scripts/run-evals.js N times back-to-back (default N=3).
//      For each category, computes {mean, min, max, variance_pct} across iters.
//      Persists evals/baselines/<category>.json (atomic write).
//
//   (default — delta mode)
//      Runs scripts/run-evals.js once. Loads evals/baselines/<category>.json if present.
//      Computes per-category delta. Flags variance > 5%.
//
// Honors kill switch. Deterministic ordering (config.json key order). No network.
// All writes under .
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs, nowIso, readJson, writeJson } = require('../../../scripts/_lib.js');
const { redactString } = require('../../../scripts/redact.js');

const RUN_EVALS = path.join(harnessRoot(), 'scripts', 'run-evals.js');
const BASELINES_DIR = path.join(harnessRoot(), 'evals', 'baselines');
const RESULTS_DIR = path.join(harnessRoot(), 'evals', 'results');

function tsId(suffix) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${suffix}`
  );
}

function invokeRunEvals(runId) {
  let stdout = '', stderr = '', exitCode = 0;
  try {
    stdout = execFileSync('node', [RUN_EVALS, '--run-id', runId], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
      cwd: harnessRoot()
    });
  } catch (e) {
    stdout = (e.stdout && e.stdout.toString()) || '';
    stderr = (e.stderr && e.stderr.toString()) || '';
    exitCode = typeof e.status === 'number' ? e.status : 1;
  }
  const resultsPath = path.join(RESULTS_DIR, runId, 'results.json');
  const results = readJson(resultsPath, null);
  return { runId, exitCode, results, resultsPath, stderr_excerpt: redactString(stderr.slice(0, 500)) };
}

function summarizeIter(iter) {
  if (!iter.results) return { run_id: iter.runId, error: 'results.json missing' };
  const cats = iter.results.categories || {};
  const out = { run_id: iter.runId, duration_ms: iter.results.duration_ms, categories: {} };
  for (const [name, c] of Object.entries(cats)) {
    if (c.skipped) { out.categories[name] = { skipped: true }; continue; }
    out.categories[name] = {
      pass: c.pass === true,
      score: typeof c.score === 'number' ? c.score : null,
      total: c.total || null,
      passed: c.passed || null,
      failed: c.failed || null,
      duration_ms: c.duration_ms || null
    };
  }
  return out;
}

function aggregate(iters) {
  const cats = {};
  for (const iter of iters) {
    if (!iter.results) continue;
    for (const [name, c] of Object.entries(iter.results.categories || {})) {
      if (c.skipped) continue;
      cats[name] = cats[name] || { scores: [], passes: 0, fails: 0, durations: [], totals: [] };
      if (typeof c.score === 'number') cats[name].scores.push(c.score);
      if (c.pass === true) cats[name].passes++; else cats[name].fails++;
      if (typeof c.duration_ms === 'number') cats[name].durations.push(c.duration_ms);
      if (typeof c.total === 'number') cats[name].totals.push(c.total);
    }
  }
  const agg = {};
  for (const [name, d] of Object.entries(cats)) {
    const mean = d.scores.length ? d.scores.reduce((a, b) => a + b, 0) / d.scores.length : null;
    const min = d.scores.length ? Math.min(...d.scores) : null;
    const max = d.scores.length ? Math.max(...d.scores) : null;
    const variance_abs = (min !== null && max !== null) ? (max - min) : null;
    const variance_pct = (mean && mean > 0 && variance_abs !== null) ? Math.round((variance_abs / mean) * 1000) / 10 : 0;
    const dmean = d.durations.length ? Math.round(d.durations.reduce((a, b) => a + b, 0) / d.durations.length) : null;
    agg[name] = {
      score_mean: mean === null ? null : Math.round(mean * 10000) / 10000,
      score_min: min,
      score_max: max,
      variance_pct,
      pass_count: d.passes,
      fail_count: d.fails,
      duration_mean_ms: dmean,
      total_cases: d.totals.length ? Math.max(...d.totals) : null
    };
  }
  return agg;
}

function persistBaselines(agg, sourceRunIds) {
  fs.mkdirSync(BASELINES_DIR, { recursive: true });
  const established = nowIso();
  for (const [name, b] of Object.entries(agg)) {
    const out = path.join(BASELINES_DIR, `${name}.json`);
    const payload = {
      schema_version: 1,
      category: name,
      established_at: established,
      source_runs: sourceRunIds,
      baseline: b
    };
    writeJson(out, payload);
  }
}

function deltaMode() {
  const runId = tsId('regression-delta');
  const iter = invokeRunEvals(runId);
  const summary = summarizeIter(iter);
  const deltas = {};
  for (const [name, c] of Object.entries(summary.categories || {})) {
    if (c.skipped) continue;
    const baselinePath = path.join(BASELINES_DIR, `${name}.json`);
    const baseline = readJson(baselinePath, null);
    if (!baseline) { deltas[name] = { baseline: null, current: c, delta_pct: null, note: 'no baseline yet' }; continue; }
    const b = baseline.baseline || {};
    const dScore = (typeof c.score === 'number' && typeof b.score_mean === 'number')
      ? Math.round((c.score - b.score_mean) * 10000) / 10000 : null;
    const dPct = (dScore !== null && b.score_mean) ? Math.round((dScore / b.score_mean) * 1000) / 10 : null;
    const regression = dScore !== null && Math.abs(dPct || 0) > 5;
    deltas[name] = {
      baseline_score_mean: b.score_mean,
      current_score: c.score,
      delta_abs: dScore,
      delta_pct: dPct,
      pass: c.pass,
      regression_flag: regression
    };
  }
  return {
    mode: 'delta',
    run_id: runId,
    started_at: nowIso(),
    deltas,
    iter_exit_code: iter.exitCode,
    results_path: iter.resultsPath
  };
}

function baselineMode(iters) {
  const sourceIds = [];
  const summaries = [];
  for (let i = 1; i <= iters; i++) {
    const runId = tsId(`regression-baseline-${String(i).padStart(2, '0')}`);
    sourceIds.push(runId);
    const iter = invokeRunEvals(runId);
    summaries.push({ ...summarizeIter(iter), exit_code: iter.exitCode });
  }
  const agg = aggregate(summaries.map(s => ({ results: { categories: Object.fromEntries(Object.entries(s.categories || {})) } })));
  persistBaselines(agg, sourceIds);
  // Compute high-variance flags.
  const highVariance = Object.entries(agg).filter(([_, b]) => b.variance_pct > 5).map(([name]) => name);
  return {
    mode: 'baseline',
    iters,
    source_runs: sourceIds,
    iter_summaries: summaries,
    aggregate: agg,
    high_variance_categories: highVariance,
    baseline_dir: BASELINES_DIR
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  let out;
  if (args['establish-baseline']) {
    const iters = Math.max(1, parseInt(args.iters || '3', 10));
    out = baselineMode(iters);
  } else {
    out = deltaMode();
  }
  console.log(JSON.stringify(out, null, 2));
  // Eval-driver contract: when invoked via run-evals.js with --fixtures-dir, emit a {pass} envelope.
  // But this is intentionally NOT in evals/config.json — orchestrator-style category, opt-in only.
  process.exit(0);
}

module.exports = { baselineMode, deltaMode, aggregate, persistBaselines };

if (require.main === module) main();
