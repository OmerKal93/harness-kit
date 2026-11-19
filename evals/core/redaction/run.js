#!/usr/bin/env node
// evals/core/redaction/run.js — Phase 4 Batch 1 redaction-effectiveness eval.
// Iterates over JSON fixtures under evals/fixtures/redaction/.
// Applies scripts/redact.js redactString to each fixture.input.
// Asserts per-fixture expected outcome. Prints aggregate JSON to stdout.
//
// Honors kill switch. Deterministic. Zero network. Read-only on fixtures.
//
// Usage:
//   node evals/core/redaction/run.js --fixtures-dir <dir>
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');
const { redactString } = require('../../../scripts/redact.js');

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

function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function evalFixture(fx) {
  const input = String(fx.input == null ? '' : fx.input);
  const out = redactString(input);
  const expected = fx.expected || {};
  const checks = [];
  let pass = true;

  if (expected.unchanged === true) {
    const ok = (out === input);
    checks.push({ check: 'unchanged', pass: ok });
    if (!ok) pass = false;
  }
  for (const needle of asArray(expected.redacted_contains)) {
    const ok = out.includes(needle);
    checks.push({ check: 'redacted_contains', needle, pass: ok });
    if (!ok) pass = false;
  }
  for (const needle of asArray(expected.redacted_not_contains)) {
    const ok = !out.includes(needle);
    checks.push({ check: 'redacted_not_contains', needle, pass: ok });
    if (!ok) pass = false;
  }
  if (expected.idempotent === true) {
    const out2 = redactString(out);
    const ok = (out2 === out);
    checks.push({ check: 'idempotent', pass: ok });
    if (!ok) pass = false;
  }
  return { id: fx.id, label: fx.label, pass, checks };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'redaction');

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
    if (fx.category !== 'redaction') continue;
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
    category: 'redaction',
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
