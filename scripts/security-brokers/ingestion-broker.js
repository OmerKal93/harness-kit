#!/usr/bin/env node
// ingestion-broker.js — the sole allowed caller of security-boundary.js#scanBeforeIngestion.
// Boundary (1): before content is ingested into any memory/knowledge system (capture-fact,
// structured-memory, GBrain import, learnings-index append).
//
// STATUS: real, working, self-tested wrapper -- but UNWIRED. This lane (hk/p4-security-brokers,
// "Security brokers — core") owns the broker module itself, not the call site: per
// evidence/WORKTREE_FILE_OWNERSHIP_MATRIX.md's "Security-brokers' does not own the other 4
// boundary call sites" note, GBrain runtime (hk/p7b-gbrain-runtime) wires this into
// scripts/capture-fact.js / scripts/structured-memory.js / scripts/propose-fact-candidates.js,
// because that lane already owns those files for other reasons. Calling this from those files is
// a one-line `const { scanBeforeIngestion } = require('../security-brokers/ingestion-broker.js')`
// swap once that lane is ready -- the wrapper contract (call with content+source, get back
// {clean, findings, token}) is already correct and tested.
//
// Library only. Zero network. Deterministic.
// Library: const { scanBeforeIngestion } = require('./security-brokers/ingestion-broker.js')
// CLI:     node scripts/security-brokers/ingestion-broker.js --self-test
'use strict';

const sb = require('../security-boundary.js');
const { mintToken, verifyToken } = require('./provenance-token.js');

// scanBeforeIngestion(content, source) -> { clean, findings, token }
function scanBeforeIngestion(content, source) {
  const result = sb.scanBeforeIngestion(content, source);
  const token = mintToken(content, result);
  return Object.assign({}, result, { token });
}

module.exports = { scanBeforeIngestion };

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  {
    const fake = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n'; // fake value for tests
    const raw = sb.scanBeforeIngestion(fake, 'test:source');
    const wrapped = scanBeforeIngestion(fake, 'test:source');
    push('wrapper_matches_raw_scan_verdict', wrapped.clean === raw.clean && wrapped.findings.length === raw.findings.length, JSON.stringify({ raw, wrapped }));
  }
  {
    const clean = 'an ordinary fact worth remembering, nothing sensitive';
    const wrapped = scanBeforeIngestion(clean, 'test:source');
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
  console.log('ingestion-broker.js — library, UNWIRED (owned by GBrain runtime lane for call-site wiring). node scripts/security-brokers/ingestion-broker.js --self-test');
  process.exit(0);
}
