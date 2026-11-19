#!/usr/bin/env node
// provenance-token.js — Mechanism 2 of the Security Broker Architecture (see
// docs/SECURITY_BROKER_ARCHITECTURE_REPORT.md). Every broker wrapper in this directory stamps a
// token on the content it scans; a downstream gate (e.g. handlePrepareCommit) can then require a
// VALID token before accepting that content as "scanned" -- an artifact that never passed through
// a broker call has no token to present and gets rejected at the gate, instead of silently sliding
// through on a caller's bare say-so.
//
// Threat model this actually covers (disclosed, not oversold -- see Mechanism 3 in the report):
// this is cooperative-only. It proves "this exact content was hashed and signed by THIS process's
// broker calls", which catches accidental bypass (a refactor that stops calling the broker, a new
// code path that forgot to), and catches TOCTOU-style substitution (content changed between the
// scan and the gate). It is NOT a cross-process / cross-machine tamper-proof certificate -- the
// signing key is a fresh random secret generated once per process and never persisted or exported,
// so a token minted in one process run is meaningless (fails verification) in another. That's
// intentional: nothing in this codebase needs a token to outlive a single execute-workflow.js run.
//
// Library only. Zero network. Deterministic given the same in-process secret.
// Library: const { mintToken, verifyToken, contentHash } = require('./provenance-token.js')
// CLI:     node scripts/security-brokers/provenance-token.js --self-test
'use strict';

const crypto = require('crypto');

// One random secret per process, generated at module load and never exported. Only code running
// IN this process (i.e. only calls that go through mintToken in this same require-cache instance)
// can produce a signature that verifyToken will accept.
const PROCESS_SECRET = crypto.randomBytes(32);

// contentHash(content) -> hex sha256. Accepts a string (diff text, tool-output tail) or a
// JSON-serializable value (e.g. an array of file paths passed to scanBeforeCommit) so every broker
// can hash whatever shape its underlying security-boundary.js function accepts.
function contentHash(content) {
  const normalized = typeof content === 'string' ? content : JSON.stringify(content ?? null);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// mintToken(content, scanResult) -> { contentHash, scannedAt, clean, findingCount, sig }
// scanResult is the { clean, findings } shape every security-boundary.js scan function returns.
// The token binds all four fields (content hash + timestamp + clean flag + finding count) under
// one HMAC so tampering with any single field (e.g. flipping clean:false -> true) invalidates sig.
function mintToken(content, scanResult) {
  const hash = contentHash(content);
  const scannedAt = new Date().toISOString();
  const clean = !!(scanResult && scanResult.clean);
  const findingCount = (scanResult && Array.isArray(scanResult.findings)) ? scanResult.findings.length : 0;
  const payload = `${hash}:${scannedAt}:${clean}:${findingCount}`;
  const sig = crypto.createHmac('sha256', PROCESS_SECRET).update(payload).digest('hex');
  return { contentHash: hash, scannedAt, clean, findingCount, sig };
}

// verifyToken(content, token) -> { valid: boolean, reason: string|null }
// Fails CLOSED on every malformed-input shape (missing token, wrong type, tampered field) --
// never throws, always returns a decidable result so callers can gate on `.valid` directly.
function verifyToken(content, token) {
  if (!token || typeof token !== 'object') return { valid: false, reason: 'missing_token' };
  const { contentHash: tokenHash, scannedAt, clean, findingCount, sig } = token;
  if (typeof tokenHash !== 'string' || typeof scannedAt !== 'string' || typeof sig !== 'string') {
    return { valid: false, reason: 'malformed_token' };
  }
  const actualHash = contentHash(content);
  if (actualHash !== tokenHash) return { valid: false, reason: 'content_mismatch' }; // content changed since scan
  const payload = `${tokenHash}:${scannedAt}:${!!clean}:${findingCount || 0}`;
  const expectedSig = crypto.createHmac('sha256', PROCESS_SECRET).update(payload).digest('hex');
  const expected = Buffer.from(expectedSig, 'hex');
  const actual = Buffer.from(sig, 'hex');
  const sigOk = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!sigOk) return { valid: false, reason: 'invalid_signature' };
  return { valid: true, reason: null };
}

module.exports = { mintToken, verifyToken, contentHash };

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. Round trip: content scanned -> token stamped -> same content verifies valid.
  {
    const content = 'a completely ordinary diff, nothing sensitive';
    const scan = { clean: true, findings: [] };
    const token = mintToken(content, scan);
    const check = verifyToken(content, token);
    push('roundtrip_valid_for_unchanged_content', check.valid === true && check.reason === null, JSON.stringify({ token, check }));
  }
  // 2. Token correctly carries a dirty scan's clean:false + finding count (not silently normalized to clean).
  {
    const content = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'; // fake value for tests
    const scan = { clean: false, findings: [{ type: 'aws_access_key' }] };
    const token = mintToken(content, scan);
    push('token_preserves_dirty_scan_result', token.clean === false && token.findingCount === 1, JSON.stringify(token));
    const check = verifyToken(content, token);
    push('dirty_scan_token_still_verifies_as_a_valid_token', check.valid === true, JSON.stringify(check));
  }
  // 3. Content substituted AFTER minting (TOCTOU) -> verification fails with content_mismatch, not silently valid.
  {
    const original = 'clean content, scanned and approved';
    const token = mintToken(original, { clean: true, findings: [] });
    const swapped = 'clean content, scanned and approved but then a secret was appended: AKIAIOSFODNN7EXAMPLE'; // fake value for tests
    const check = verifyToken(swapped, token);
    push('content_substitution_after_mint_is_rejected', check.valid === false && check.reason === 'content_mismatch', JSON.stringify(check));
  }
  // 4. Tampered signature (e.g. an attacker flips clean:false -> true without re-signing) is rejected.
  {
    const content = 'dirty content';
    const token = mintToken(content, { clean: false, findings: [{ type: 'x' }] });
    const tampered = Object.assign({}, token, { clean: true, findingCount: 0 });
    const check = verifyToken(content, tampered);
    push('tampered_clean_flag_rejected_as_invalid_signature', check.valid === false && check.reason === 'invalid_signature', JSON.stringify(check));
  }
  // 5. Missing / malformed token is rejected, never treated as an implicit pass.
  {
    push('missing_token_rejected', verifyToken('x', null).valid === false && verifyToken('x', null).reason === 'missing_token', '');
    push('malformed_token_rejected', verifyToken('x', { contentHash: 123 }).valid === false && verifyToken('x', { contentHash: 123 }).reason === 'malformed_token', '');
    push('empty_object_token_rejected', verifyToken('x', {}).valid === false, '');
  }
  // 6. A token minted for one piece of content never verifies against a completely different one
  //    (guards against a caller passing the wrong token to the wrong gate).
  {
    const tokenA = mintToken('content A', { clean: true, findings: [] });
    const check = verifyToken('content B', tokenA);
    push('token_never_verifies_unrelated_content', check.valid === false && check.reason === 'content_mismatch', JSON.stringify(check));
  }
  // 7. contentHash is deterministic for the same input and accepts non-string (array of paths) input.
  {
    const arr = ['a.txt', 'b.env'];
    push('content_hash_deterministic', contentHash(arr) === contentHash(arr.slice()), '');
    push('content_hash_distinguishes_string_vs_object_shape', contentHash('x') !== contentHash({ x: 1 }), '');
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('provenance-token.js — library. node scripts/security-brokers/provenance-token.js --self-test');
  process.exit(0);
}
