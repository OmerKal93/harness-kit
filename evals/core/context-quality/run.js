#!/usr/bin/env node
// evals/core/context-quality/run.js — Phase 5 Batch 2.
// Iterates packs.json + drift.json under evals/fixtures/context-quality/.
//
// packs.json fixtures: assert tier_signal matches; optional min_total / max_total.
// drift.json fixtures: assert per-pattern detected map matches.
//   Fixtures with `_materialize: { "<rel>": "<content>", ... }` get materialized into a
//   per-run tmpdir before the drift detector runs; tmpdir is cleaned up after.
//
// Honors kill switch. Deterministic. Zero network.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');
const { scorePack } = require('../../../scripts/score-context-pack.js');
const { detectDrift } = require('../../../scripts/detect-context-drift.js');

function evalPack(fx) {
  const expected = fx.expected || {};
  const result = scorePack(fx.pack, {});
  const acceptedTiers = expected.accepted_tiers || (expected.tier_signal ? [expected.tier_signal] : []);
  const tierOk = acceptedTiers.length === 0 || acceptedTiers.includes(result.tier_signal);
  const minOk = typeof expected.min_total !== 'number' || result.total_weighted >= expected.min_total;
  const maxOk = typeof expected.max_total !== 'number' || result.total_weighted <= expected.max_total;
  const pass = tierOk && minOk && maxOk;
  let fail_reason = null;
  if (!tierOk) fail_reason = `tier-mismatch: actual=${result.tier_signal} accepted=${JSON.stringify(acceptedTiers)}`;
  else if (!minOk) fail_reason = `below-min: total=${result.total_weighted} min=${expected.min_total}`;
  else if (!maxOk) fail_reason = `above-max: total=${result.total_weighted} max=${expected.max_total}`;
  return {
    id: fx.id,
    kind: 'scoring',
    pass,
    actual_tier: result.tier_signal,
    actual_total: result.total_weighted,
    accepted_tiers: acceptedTiers,
    expected_min: expected.min_total || null,
    expected_max: expected.max_total || null,
    fail_reason
  };
}

function materialize(fx, tmpRoot) {
  if (!fx._materialize) return null;
  fs.mkdirSync(tmpRoot, { recursive: true });
  for (const [rel, content] of Object.entries(fx._materialize)) {
    const target = path.join(tmpRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return tmpRoot;
}

function cleanup(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function evalDrift(fx, tmpBase) {
  const expectedPatterns = (fx.expected && fx.expected.patterns) || {};
  let tmpDir = null;
  if (fx._materialize) {
    tmpDir = path.join(tmpBase, fx.id);
    materialize(fx, tmpDir);
  }
  const result = detectDrift(fx.pack, { repoRoot: tmpDir || undefined });
  const failures = [];
  for (const [name, expectedDetected] of Object.entries(expectedPatterns)) {
    const actual = result.patterns[name];
    if (!actual) {
      failures.push(`pattern-missing:${name}`);
      continue;
    }
    if (actual.detected !== expectedDetected) {
      failures.push(`${name}: actual=${actual.detected} expected=${expectedDetected}`);
    }
  }
  cleanup(tmpDir);
  const pass = failures.length === 0;
  return {
    id: fx.id,
    kind: 'drift',
    pass,
    actual_detected_count: result.drift_detected,
    actual_patterns: Object.fromEntries(Object.entries(result.patterns).map(([k, v]) => [k, v.detected])),
    expected_patterns: expectedPatterns,
    fail_reason: pass ? null : failures.join(' | ')
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'context-quality');
  const packsPath = path.join(fixturesDir, 'packs.json');
  const driftPath = path.join(fixturesDir, 'drift.json');

  let packs = { fixtures: [] };
  let drift = { fixtures: [] };
  try { packs = JSON.parse(fs.readFileSync(packsPath, 'utf8')); }
  catch (e) {
    console.log(JSON.stringify({ category: 'context-quality', pass: false, error: 'packs.json unreadable: ' + e.message }, null, 2));
    process.exit(1);
  }
  try { drift = JSON.parse(fs.readFileSync(driftPath, 'utf8')); }
  catch (e) {
    console.log(JSON.stringify({ category: 'context-quality', pass: false, error: 'drift.json unreadable: ' + e.message }, null, 2));
    process.exit(1);
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cq-'));

  const packResults = (packs.fixtures || []).map(evalPack);
  const driftResults = (drift.fixtures || []).map(fx => evalDrift(fx, tmpBase));

  cleanup(tmpBase);

  const all = packResults.concat(driftResults);
  const total = all.length;
  const passed = all.filter(r => r.pass).length;
  const failures = all.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  const packsPassed = packResults.filter(r => r.pass).length;
  const driftPassed = driftResults.filter(r => r.pass).length;

  const minRatio = 0.80;
  const passFlag = total > 0 && score >= minRatio;

  const out = {
    category: 'context-quality',
    pass: passFlag,
    score,
    total,
    passed,
    failed: failures.length,
    min_pass_ratio: minRatio,
    by_kind: {
      scoring: { total: packResults.length,  passed: packsPassed,  ratio: packResults.length  ? packsPassed  / packResults.length  : 0 },
      drift:   { total: driftResults.length, passed: driftPassed,  ratio: driftResults.length ? driftPassed  / driftResults.length : 0 }
    },
    failures: failures.slice(0, 30)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(passFlag ? 0 : 1);
}

if (require.main === module) main();
