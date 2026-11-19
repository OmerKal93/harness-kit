#!/usr/bin/env node
// evals/core/agent-identity/run.js — Phase 5 Batch 2.
// Iterates fixtures in evals/fixtures/agent-identity/cases.json. Two arrays:
//   allowed_actions — MUST validate allowed:true
//   denied_actions  — MUST validate allowed:false; if expected_reason set, must match exactly;
//                     if expected_reason_class set, reason must start with that class token.
//
// Honors kill switch. Deterministic. Zero network.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');
const { validate } = require('../../../scripts/validate-agent-action.js');

function evalAllowed(fx) {
  const r = validate({ persona: fx.persona, action: fx.action });
  const pass = r.allowed === true;
  return {
    id: fx.id,
    kind: 'allowed',
    persona: fx.persona,
    pass,
    actual_allowed: r.allowed,
    actual_reason: r.reason || null,
    expected_reason_class: fx.expected_reason_class || null,
    fail_reason: pass ? null : ('unexpectedly-denied:' + (r.reason || 'none'))
  };
}

function evalDenied(fx) {
  const r = validate({ persona: fx.persona, action: fx.action });
  let pass = r.allowed === false;
  let fail_reason = pass ? null : 'unexpectedly-allowed';
  if (pass && fx.expected_reason && r.reason !== fx.expected_reason) {
    pass = false;
    fail_reason = 'wrong-reason: actual=' + (r.reason || 'none') + ' expected=' + fx.expected_reason;
  }
  if (pass && fx.expected_reason_class && !r.reason) {
    pass = false;
    fail_reason = 'missing-reason';
  }
  if (pass && fx.expected_reason_class && r.reason && !r.reason.startsWith(fx.expected_reason_class)) {
    pass = false;
    fail_reason = 'wrong-class: actual=' + r.reason + ' expected_class=' + fx.expected_reason_class;
  }
  return {
    id: fx.id,
    kind: 'denied',
    persona: fx.persona,
    pass,
    actual_allowed: r.allowed,
    actual_reason: r.reason || null,
    expected_reason_class: fx.expected_reason_class || null,
    expected_reason: fx.expected_reason || null,
    fail_reason
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'agent-identity');
  const corpusPath = path.join(fixturesDir, 'cases.json');

  let corpus;
  try { corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')); }
  catch (e) {
    console.log(JSON.stringify({ category: 'agent-identity', pass: false, error: 'cases.json unreadable: ' + e.message }, null, 2));
    process.exit(1);
  }

  const allowedFixtures = corpus.allowed_actions || [];
  const deniedFixtures = corpus.denied_actions || [];

  const allowedResults = allowedFixtures.map(evalAllowed);
  const deniedResults = deniedFixtures.map(evalDenied);

  const all = allowedResults.concat(deniedResults);
  const total = all.length;
  const passed = all.filter(r => r.pass).length;
  const failures = all.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  const allowedPassed = allowedResults.filter(r => r.pass).length;
  const deniedPassed = deniedResults.filter(r => r.pass).length;

  const out = {
    category: 'agent-identity',
    pass: total > 0 && failures.length === 0,
    score,
    total,
    passed,
    failed: failures.length,
    by_kind: {
      allowed: { total: allowedResults.length, passed: allowedPassed, ratio: allowedResults.length ? allowedPassed / allowedResults.length : 0 },
      denied:  { total: deniedResults.length,  passed: deniedPassed,  ratio: deniedResults.length  ? deniedPassed  / deniedResults.length  : 0 }
    },
    failures: failures.slice(0, 20)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module) main();
