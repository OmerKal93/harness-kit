#!/usr/bin/env node
// remote-action-broker.js — the sole allowed caller of
// security-boundary.js#scanBeforeRemoteAction.
// Boundary (6): before push/PR/export/release/any remote action.
//
// STATUS: real, working, self-tested wrapper -- but UNWIRED, and per
// evidence/WORKTREE_FILE_OWNERSHIP_MATRIX.md this stays deferred to the release phase: no
// push/PR/export tooling exists in this repo yet, so there is no call site to wire it into today.
// This lane (hk/p4-security-brokers) owns only the broker module itself; whichever future lane
// builds real push/PR/export tooling should wire this in at that time.
//
// Library only. Zero network. Deterministic.
// Library: const { scanBeforeRemoteAction } = require('./security-brokers/remote-action-broker.js')
// CLI:     node scripts/security-brokers/remote-action-broker.js --self-test
'use strict';

const sb = require('../security-boundary.js');
const { mintToken, verifyToken } = require('./provenance-token.js');

// scanBeforeRemoteAction(payload) -> { clean, findings, token }
// Accepts the same shapes as security-boundary.js's version (a string, or a JSON-serializable
// payload object) -- the token is minted over the SAME payload value passed in, so verifyToken
// must be called with that identical value (not a re-stringified copy) to succeed.
function scanBeforeRemoteAction(payload) {
  const result = sb.scanBeforeRemoteAction(payload);
  const token = mintToken(payload, result);
  return Object.assign({}, result, { token });
}

module.exports = { scanBeforeRemoteAction };

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  {
    const payload = { title: 'Release notes', body: 'Contact us at leaker@example.com for access.', secrets: ['AKIAIOSFODNN7EXAMPLE'] }; // fake value for tests
    const raw = sb.scanBeforeRemoteAction(payload);
    const wrapped = scanBeforeRemoteAction(payload);
    push('wrapper_matches_raw_scan_verdict', wrapped.clean === raw.clean && wrapped.findings.length === raw.findings.length, JSON.stringify({ raw, wrapped }));
  }
  {
    const clean = 'Ordinary release notes, nothing sensitive.';
    const wrapped = scanBeforeRemoteAction(clean);
    const check = verifyToken(clean, wrapped.token);
    push('token_present_and_verifies_for_same_payload', !!wrapped.token && check.valid === true, JSON.stringify({ token: wrapped.token, check }));
  }
  {
    const payload = { a: 1 };
    const wrapped = scanBeforeRemoteAction(payload);
    const check = verifyToken(payload, wrapped.token);
    push('object_payload_shape_still_tokenized_and_verifies', check.valid === true, JSON.stringify(check));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('remote-action-broker.js — library, UNWIRED (deferred to release phase — no push/PR/export tooling exists yet). node scripts/security-brokers/remote-action-broker.js --self-test');
  process.exit(0);
}
