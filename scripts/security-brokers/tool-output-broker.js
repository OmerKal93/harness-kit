#!/usr/bin/env node
// tool-output-broker.js — the sole allowed caller of security-boundary.js#scanAfterToolOutput.
// Boundary (3): after tool output/logs/generated artifacts are produced. Wraps, does not
// duplicate, the existing scan logic in ../security-boundary.js -- adds a provenance token
// (Mechanism 2) so any future gate that wants to require "this output was actually scanned" can
// check for one, same as commit-broker.js does for handlePrepareCommit today.
//
// Real wired call site: scripts/execute-workflow.js#handleDeterministicVerify (captured command
// stdout/stderr tail, scanned before being written into results[].output_tail).
//
// Library only. Zero network. Deterministic.
// Library: const { scanAfterToolOutput } = require('./security-brokers/tool-output-broker.js')
// CLI:     node scripts/security-brokers/tool-output-broker.js --self-test
'use strict';

const sb = require('../security-boundary.js');
const { mintToken, verifyToken } = require('./provenance-token.js');

// scanAfterToolOutput(content) -> { clean, findings, token }
function scanAfterToolOutput(content) {
  const result = sb.scanAfterToolOutput(content);
  const token = mintToken(content, result);
  return Object.assign({}, result, { token });
}

module.exports = { scanAfterToolOutput };

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. Wrapper matches the raw security-boundary.js verdict exactly.
  {
    const leaked = 'DATABASE_URL=postgres://user:FAKE_EXAMPLE_PASSWORD@db.example.invalid:5432/prod\n'; // fake value for tests
    const raw = sb.scanAfterToolOutput(leaked);
    const wrapped = scanAfterToolOutput(leaked);
    push('wrapper_matches_raw_scan_verdict', wrapped.clean === raw.clean && wrapped.findings.length === raw.findings.length, JSON.stringify({ raw, wrapped }));
  }
  // 2. Token round-trips for the same tool-output content.
  {
    const clean = 'ALL TESTS PASSED (42 passed, 0 failed)';
    const wrapped = scanAfterToolOutput(clean);
    const check = verifyToken(clean, wrapped.token);
    push('token_present_and_verifies_for_same_output', !!wrapped.token && check.valid === true, JSON.stringify({ token: wrapped.token, check }));
  }
  // 3. A leaked secret in real command output is still caught through the wrapper (regression
  //    guard: this exact fixture shape is what handleDeterministicVerify hits in production).
  {
    const wrapped = scanAfterToolOutput('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n'); // fake value for tests
    push('secret_shaped_output_flagged_not_clean', wrapped.clean === false && wrapped.findings.some(f => f.type === 'aws_access_key'), JSON.stringify(wrapped.findings));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('tool-output-broker.js — library. node scripts/security-brokers/tool-output-broker.js --self-test');
  process.exit(0);
}
