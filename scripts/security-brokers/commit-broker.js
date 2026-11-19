#!/usr/bin/env node
// commit-broker.js — the sole allowed caller of security-boundary.js#scanBeforeCommit.
// Boundary (5): before commit. Wraps, does not duplicate, the existing scan logic in
// ../security-boundary.js -- this file's only job is to (a) be the one place that's allowed to
// call it directly (enforced by scripts/check-broker-conformance.js, Mechanism 1) and (b) stamp a
// provenance token on the result (Mechanism 2) so a downstream gate (handlePrepareCommit) can
// require proof the content actually went through this scan before accepting it as scanned.
//
// Real wired call site: scripts/execute-workflow.js#handlePrepareCommit.
//
// Library only. Zero network. Deterministic (same guarantee as security-boundary.js itself).
// Library: const { scanBeforeCommit } = require('./security-brokers/commit-broker.js')
// CLI:     node scripts/security-brokers/commit-broker.js --self-test
'use strict';

const sb = require('../security-boundary.js');
const { mintToken, verifyToken } = require('./provenance-token.js');

// scanBeforeCommit(diffOrFiles) -> { clean, findings, token }
// Same accepted shapes as security-boundary.js#scanBeforeCommit (a diff string, or an array of
// file paths) -- this is a transparent wrapper, not a re-implementation. `token` is new: mint it
// over the SAME `diffOrFiles` value the caller passed in, so a later `verifyToken(diffOrFiles, token)`
// against that same value succeeds, and against any other value (stale/substituted content) fails.
function scanBeforeCommit(diffOrFiles) {
  const result = sb.scanBeforeCommit(diffOrFiles);
  const token = mintToken(diffOrFiles, result);
  return Object.assign({}, result, { token });
}

module.exports = { scanBeforeCommit };

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. Wrapper produces the same clean/findings verdict as the raw security-boundary.js function
  //    (proves this is a wrap, not a reimplementation with drifted behavior).
  {
    const dirty = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n'; // fake value for tests
    const raw = sb.scanBeforeCommit(dirty);
    const wrapped = scanBeforeCommit(dirty);
    push('wrapper_matches_raw_scan_verdict', wrapped.clean === raw.clean && wrapped.findings.length === raw.findings.length, JSON.stringify({ raw, wrapped }));
  }
  // 2. Wrapper adds a token that verifies against the exact same input.
  {
    const clean = 'a perfectly ordinary diff with nothing sensitive in it';
    const wrapped = scanBeforeCommit(clean);
    const check = verifyToken(clean, wrapped.token);
    push('token_present_and_verifies_for_same_input', !!wrapped.token && check.valid === true, JSON.stringify({ token: wrapped.token, check }));
  }
  // 3. Token from a scan of ONE diff does not verify against a DIFFERENT diff (guards against a
  //    caller reusing a stale token from an earlier scan against new staged content).
  {
    const wrapped = scanBeforeCommit('diff one');
    const check = verifyToken('diff two, never scanned', wrapped.token);
    push('token_rejects_a_different_diff', check.valid === false && check.reason === 'content_mismatch', JSON.stringify(check));
  }
  // 4. A dirty result still carries a valid (non-forged) token -- the token proves "this was
  //    scanned", not "this was clean". The clean/findings fields, not the token's presence, are
  //    what the caller must still branch on.
  {
    const wrapped = scanBeforeCommit('token: ghp_FAKEEXAMPLEFAKEEXAMPLEFAKEEXAMPLE000\n'); // fake value for tests
    const check = verifyToken('token: ghp_FAKEEXAMPLEFAKEEXAMPLEFAKEEXAMPLE000\n', wrapped.token); // fake value for tests
    push('dirty_result_still_carries_a_valid_token', wrapped.clean === false && check.valid === true, JSON.stringify({ clean: wrapped.clean, check }));
  }
  // 5. Array-of-file-paths call shape (the other accepted input shape) still works end to end.
  {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-commit-broker-selftest-'));
    const clean = path.join(tmp, 'notes.md');
    fs.writeFileSync(clean, 'nothing sensitive here\n');
    const wrapped = scanBeforeCommit([clean]);
    const check = verifyToken([clean], wrapped.token);
    push('array_of_paths_shape_still_tokenized_and_verifies', wrapped.clean === true && check.valid === true, JSON.stringify({ wrapped, check }));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('commit-broker.js — library. node scripts/security-brokers/commit-broker.js --self-test');
  process.exit(0);
}
