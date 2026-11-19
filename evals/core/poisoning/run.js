#!/usr/bin/env node
// evals/core/poisoning/run.js — Phase 4 Batch 1 memory-poisoning eval.
// Iterates over JSON fixtures under evals/fixtures/poisoning/.
// Calls scanContent from scripts/memory-poisoning-scan.js with each fixture's
// content + simulated_path. Asserts the resulting classification/action.
//
// Honors kill switch. Deterministic. Zero network. Read-only on fixtures.
//
// Usage:
//   node evals/core/poisoning/run.js --fixtures-dir <dir>
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');
const { scanContent } = require('../../../scripts/memory-poisoning-scan.js');

function walkJson(dir) {
  const out = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && full.endsWith('.json')) out.push(full);
    }
  }
  walk(dir);
  return out;
}

function expandHome(p) {
  if (!p) return p;
  const home = os.homedir().replace(/\\/g, '/');
  return String(p).replace(/^~\//, home + '/').replace(/^~\\/, home + '/');
}

function evalFixture(fx) {
  const input = String(fx.input == null ? '' : fx.input);
  const simulatedPath = expandHome(fx.simulated_path || (os.homedir() + '/.harnesskit/evals/fixtures/poisoning/synthetic.md'));
  const r = scanContent(input, simulatedPath);
  const expected = fx.expected || {};
  const checks = [];
  let pass = true;

  if (expected.file_class !== undefined) {
    const ok = r.file_class === expected.file_class;
    checks.push({ check: 'file_class', expected: expected.file_class, actual: r.file_class, pass: ok });
    if (!ok) pass = false;
  }
  if (expected.action !== undefined) {
    const ok = r.action === expected.action;
    checks.push({ check: 'action', expected: expected.action, actual: r.action, pass: ok });
    if (!ok) pass = false;
  }
  if (expected.any_instruction_hit !== undefined) {
    const has = (r.instruction_hits || 0) > 0;
    const ok = has === !!expected.any_instruction_hit;
    checks.push({ check: 'any_instruction_hit', expected: !!expected.any_instruction_hit, actual: has, pass: ok });
    if (!ok) pass = false;
  }
  if (expected.any_example_hit !== undefined) {
    const has = (r.example_hits || 0) > 0;
    const ok = has === !!expected.any_example_hit;
    checks.push({ check: 'any_example_hit', expected: !!expected.any_example_hit, actual: has, pass: ok });
    if (!ok) pass = false;
  }
  if (expected.security_marker_present !== undefined) {
    const ok = r.security_marker_present === !!expected.security_marker_present;
    checks.push({ check: 'security_marker_present', expected: !!expected.security_marker_present, actual: r.security_marker_present, pass: ok });
    if (!ok) pass = false;
  }
  if (expected.hits_count !== undefined) {
    const ok = (r.hits || []).length === expected.hits_count;
    checks.push({ check: 'hits_count', expected: expected.hits_count, actual: (r.hits || []).length, pass: ok });
    if (!ok) pass = false;
  }
  return { id: fx.id, label: fx.label, pass, checks };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'poisoning');

  const files = walkJson(fixturesDir);
  const fixtures = [];
  const parseErrors = [];
  for (const f of files) {
    let fx;
    try { fx = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) {
      parseErrors.push({ file: path.relative(fixturesDir, f), error: String(e.message).slice(0, 200) });
      continue;
    }
    if (fx.category !== 'poisoning') continue;
    fx._file = path.relative(fixturesDir, f);
    fixtures.push(fx);
  }

  const results = [];
  for (const fx of fixtures) {
    const r = evalFixture(fx);
    r.file = fx._file;
    results.push(r);
    if (results.length > 5000) break;
  }

  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  const out = {
    category: 'poisoning',
    pass: total > 0 && failed.length === 0 && parseErrors.length === 0,
    score,
    total,
    passed,
    failed: failed.length,
    parse_errors: parseErrors.length,
    failures: failed.slice(0, 20),
    parse_error_files: parseErrors.slice(0, 10),
    by_label: countBy(results)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

function countBy(results) {
  const out = {};
  for (const r of results) {
    const key = r.label || 'unlabeled';
    if (!out[key]) out[key] = { total: 0, passed: 0 };
    out[key].total += 1;
    if (r.pass) out[key].passed += 1;
  }
  return out;
}

if (require.main === module) main();
