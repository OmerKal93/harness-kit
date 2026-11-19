#!/usr/bin/env node
// evals/core/tool-risk/run.js — Phase 4 Batch 3.
// Iterates fixtures under evals/fixtures/tool-risk/calls.json.
// For each, invokes scripts/tool-risk-classifier.js::classify() in-process and
// asserts the returned class matches expected.
//
// Honors kill switch. Deterministic. Zero network.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');
const { classify } = require('../../../scripts/tool-risk-classifier.js');

function evalFixture(fx) {
  // Pass raw fixture so alias keys (tool, name, recipient_name) survive into classify().
  const r = classify(fx);
  const displayName = fx.tool_name || fx.tool || fx.name || fx.recipient_name || '';
  const pass = r.class === fx.expected;
  return {
    id: fx.id,
    tool_name: displayName,
    expected: fx.expected,
    actual: r.class,
    reasons: r.reasons,
    pass
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'tool-risk');
  const corpusPath = path.join(fixturesDir, 'calls.json');

  let corpus;
  try { corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')); }
  catch (e) {
    console.log(JSON.stringify({ category: 'tool-risk', pass: false, error: 'calls.json unreadable: ' + e.message }, null, 2));
    process.exit(1);
  }
  const fixtures = corpus.fixtures || [];
  const results = fixtures.map(evalFixture);

  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failures = results.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  // Per-class breakdown.
  const byClass = {};
  for (const r of results) {
    const k = r.expected;
    if (!byClass[k]) byClass[k] = { total: 0, passed: 0 };
    byClass[k].total += 1;
    if (r.pass) byClass[k].passed += 1;
  }

  const out = {
    category: 'tool-risk',
    pass: total > 0 && failures.length === 0,
    score,
    total,
    passed,
    failed: failures.length,
    by_class: byClass,
    failures: failures.slice(0, 20)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module) main();
