#!/usr/bin/env node
// evals/core/approval-registry/run.js — Phase 5 Batch 1.
// Iterates fixtures in evals/fixtures/approval-registry/tokens.json. Two arrays:
//   valid_tokens   — MUST validate recognized:true + correct entry id
//   invalid_tokens — MUST validate recognized:false
//
// Honors kill switch. Deterministic. Zero network.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');
const { validate } = require('../../../scripts/validate-approval-token.js');

function evalValid(fx) {
  const r = validate(fx.input);
  const recognizedOk = r.recognized === true;
  const idOk = recognizedOk && (!fx.expected_id || (r.entry && r.entry.id === fx.expected_id));
  const matchTypeOk = recognizedOk && (!fx.expected_match_type || r.match_type === fx.expected_match_type);
  let placeholdersOk = true;
  if (recognizedOk && fx.expected_placeholders) {
    placeholdersOk = !!r.placeholders;
    if (placeholdersOk) {
      for (const [k, v] of Object.entries(fx.expected_placeholders)) {
        if (r.placeholders[k] !== v) placeholdersOk = false;
      }
    }
  }
  const pass = recognizedOk && idOk && matchTypeOk && placeholdersOk;
  return {
    id: fx.id,
    kind: 'valid',
    input: fx.input,
    pass,
    actual_recognized: r.recognized,
    actual_entry_id: r.entry ? r.entry.id : null,
    actual_match_type: r.match_type || null,
    expected_id: fx.expected_id || null,
    fail_reason: pass ? null : (!recognizedOk ? 'not-recognized' : (!idOk ? 'wrong-entry-id' : (!matchTypeOk ? 'wrong-match-type' : 'wrong-placeholders')))
  };
}

function evalInvalid(fx) {
  const r = validate(fx.input);
  const pass = r.recognized === false;
  return {
    id: fx.id,
    kind: 'invalid',
    input: fx.input,
    pass,
    actual_recognized: r.recognized,
    actual_entry_id: r.entry ? r.entry.id : null,
    expected_reason_class: fx.reason_class || null,
    fail_reason: pass ? null : 'false-positive-recognized'
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'approval-registry');
  const corpusPath = path.join(fixturesDir, 'tokens.json');

  let corpus;
  try { corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')); }
  catch (e) {
    console.log(JSON.stringify({ category: 'approval-registry', pass: false, error: 'tokens.json unreadable: ' + e.message }, null, 2));
    process.exit(1);
  }

  const validFixtures = corpus.valid_tokens || [];
  const invalidFixtures = corpus.invalid_tokens || [];

  const validResults = validFixtures.map(evalValid);
  const invalidResults = invalidFixtures.map(evalInvalid);

  const all = validResults.concat(invalidResults);
  const total = all.length;
  const passed = all.filter(r => r.pass).length;
  const failures = all.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  const validPassed = validResults.filter(r => r.pass).length;
  const invalidPassed = invalidResults.filter(r => r.pass).length;

  const out = {
    category: 'approval-registry',
    pass: total > 0 && failures.length === 0,
    score,
    total,
    passed,
    failed: failures.length,
    by_kind: {
      valid:   { total: validResults.length,   passed: validPassed,   ratio: validResults.length ? validPassed / validResults.length : 0 },
      invalid: { total: invalidResults.length, passed: invalidPassed, ratio: invalidResults.length ? invalidPassed / invalidResults.length : 0 }
    },
    failures: failures.slice(0, 20)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module) main();
