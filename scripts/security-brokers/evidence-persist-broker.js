#!/usr/bin/env node
// evidence-persist-broker.js — the sole allowed caller of
// security-boundary.js#scanBeforeEvidencePersist.
// Boundary (4): before evidence is persisted (research notes, claim-support logs, captured facts).
//
// STATUS: real, working, self-tested wrapper -- but UNWIRED. Per
// evidence/WORKTREE_FILE_OWNERSHIP_MATRIX.md, GBrain runtime (hk/p7b-gbrain-runtime) wires this
// into the evidence-write paths it owns (gbrain-export-curated.js and friends). This lane
// (hk/p4-security-brokers) owns only the broker module itself.
//
// Library only. Zero network. Deterministic.
// Library: const { scanBeforeEvidencePersist } = require('./security-brokers/evidence-persist-broker.js')
// CLI:     node scripts/security-brokers/evidence-persist-broker.js --self-test
'use strict';

const sb = require('../security-boundary.js');
const { mintToken, verifyToken } = require('./provenance-token.js');

// scanBeforeEvidencePersist(content) -> { clean, findings, token }
function scanBeforeEvidencePersist(content) {
  const result = sb.scanBeforeEvidencePersist(content);
  const token = mintToken(content, result);
  return Object.assign({}, result, { token });
}

module.exports = { scanBeforeEvidencePersist };

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  {
    const fake = '-----BEGIN RSA PRIVATE KEY-----\nFAKE_EXAMPLE_NOT_A_REAL_KEY_BODY\n-----END RSA PRIVATE KEY-----\n'; // fake value for tests
    const raw = sb.scanBeforeEvidencePersist(fake);
    const wrapped = scanBeforeEvidencePersist(fake);
    push('wrapper_matches_raw_scan_verdict', wrapped.clean === raw.clean && wrapped.findings.length === raw.findings.length, JSON.stringify({ raw, wrapped }));
  }
  {
    const clean = 'A clean, ordinary piece of research evidence with a citation.';
    const wrapped = scanBeforeEvidencePersist(clean);
    const check = verifyToken(clean, wrapped.token);
    push('token_present_and_verifies_for_same_content', !!wrapped.token && check.valid === true, JSON.stringify({ token: wrapped.token, check }));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('evidence-persist-broker.js — library, UNWIRED (owned by GBrain runtime lane for call-site wiring). node scripts/security-brokers/evidence-persist-broker.js --self-test');
  process.exit(0);
}
