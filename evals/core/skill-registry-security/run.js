#!/usr/bin/env node
// evals/core/skill-registry-security/run.js — Skill Registry Security v1.
// Drives scripts/validate-skill-registration.js against synthetic fixtures.
// Hashes are computed from each fixture's stub files at eval time (same code path
// as the real validator) — never hand-typed. corrupt-runtime / corrupt-validation
// modes break exactly one hash domain to prove the asymmetric checks.
// Asserts: exact violation-code set equality + ok flag.
// Contract: prints {category,pass,score,total,passed,failed,...} envelope, exit 0/1.
// Honors kill switch. Deterministic. Zero network.
'use strict';

const path = require('path');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs, readJson } = require('../../../scripts/_lib.js');
const validator = require('../../../scripts/validate-skill-registration.js');

const CORRUPT_HASH = 'sha256:' + '0'.repeat(64);

function evalCase(fx) {
  const files = (fx.skill_stub && fx.skill_stub.files) || {};
  const record = JSON.parse(JSON.stringify(fx.record || {}));

  const computed = validator.computeHashes(files, {
    readmeExcluded: record.readme_excluded_from_runtime_hash === true
  });
  const mode = fx.hash_mode || 'computed';
  record.runtime_hash = mode === 'corrupt-runtime' ? CORRUPT_HASH : computed.runtime_hash;
  record.validation_hash = mode === 'corrupt-validation' ? CORRUPT_HASH : computed.validation_hash;

  let result;
  try { result = validator.validateRecord({ files }, record); }
  catch (e) {
    return { id: fx.id, label: fx.label || 'positive', pass: false,
             fail_reason: 'validator-threw: ' + String(e.message).slice(0, 160) };
  }

  const actualCodes = [...new Set(result.violations.map(v => v.code))].sort();
  const expectedCodes = [...new Set(fx.expected_violations || [])].sort();
  const fails = [];

  if (typeof fx.expected_ok === 'boolean' && result.ok !== fx.expected_ok) {
    fails.push('ok:actual=' + result.ok + '/expected=' + fx.expected_ok);
  }
  if (JSON.stringify(actualCodes) !== JSON.stringify(expectedCodes)) {
    fails.push('violations:actual=[' + actualCodes.join(',') + ']/expected=[' + expectedCodes.join(',') + ']');
  }

  return {
    id: fx.id,
    label: fx.label || 'positive',
    pass: fails.length === 0,
    fail_reason: fails.length === 0 ? null : fails.join('|'),
    actual_ok: result.ok,
    actual_violations: actualCodes
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] ||
    path.join(harnessRoot(), 'evals', 'fixtures', 'skill-registry-security');

  const data = readJson(path.join(fixturesDir, 'cases.json'), { fixtures: [] });
  const cases = data.fixtures || [];

  const cfg = readJson(path.join(harnessRoot(), 'evals', 'config.json'), { categories: {} });
  const minRatio = (cfg.categories['skill-registry-security'] &&
    typeof cfg.categories['skill-registry-security'].min_pass_ratio === 'number')
    ? cfg.categories['skill-registry-security'].min_pass_ratio : 1.0;

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
    category: 'skill-registry-security',
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
