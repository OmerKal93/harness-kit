#!/usr/bin/env node
// structured-memory.js — Batch 5a. Minimal append-only NDJSON fact store + validation.
//
// STATUS (2026-06-26): SCHEMA + LOCAL HELPERS ONLY. NOT wired into capture, retrieval, or the
// context pack — those are future batches:
//   5b → capture-time poisoning/content checks    5c → retrieval active-state filtering
//   5d → context-pack provenance
// Pure Node stdlib + scripts/_lib.js. No LLM, no network, no DB/graph/vector, no auto-capture.
// Does NOT read or modify markdown memory (memory/*.md). Append-only: a record is never
// rewritten in place — supersede/retract/archive is expressed by a record's `state` field and
// (future) a new record, never by mutating an existing line.
'use strict';
const fs = require('fs');
const path = require('path');
const { harnessRoot, readNdjson, nowIso } = require('./_lib.js');

const SCHEMA_VERSION = 1;
const ALLOWED_STATES = Object.freeze(['active', 'superseded', 'retracted', 'archived']);
// Trust tiers mirror scripts/detect-context-drift.js staleness tiers (single vocabulary).
const ALLOWED_TRUST_TIERS = Object.freeze([
  'source_of_truth', 'curated_memory', 'run_artifact', 'curated_external', 'untrusted_external'
]);
const REQUIRED_FIELDS = Object.freeze([
  'id', 'kind', 'claim', 'mentions', 'source_path', 'source_sha256',
  'trust_tier', 'captured_run_id', 'confidence', 'state', 'created_at'
]);

// Default fact store path. Honors HARNESS_ROOT via harnessRoot() (unset → legacy <harness-root>).
function factsPath(root = harnessRoot()) {
  return path.join(root, 'memory', 'facts.ndjson');
}

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

// Pure validation. Returns { ok, errors[] }. Never throws, never writes.
function validateFactRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: ['record must be a non-array object'] };
  }
  for (const f of REQUIRED_FIELDS) {
    if (record[f] === undefined || record[f] === null) errors.push(`missing required field: ${f}`);
  }
  if (record.kind !== undefined && record.kind !== 'fact') errors.push(`kind must be "fact" (got ${JSON.stringify(record.kind)})`);
  if (record.id !== undefined && !isNonEmptyString(record.id)) errors.push('id must be a non-empty string');
  if (record.claim !== undefined && !isNonEmptyString(record.claim)) errors.push('claim must be a non-empty string');
  if (record.source_path !== undefined && !isNonEmptyString(record.source_path)) errors.push('source_path must be a non-empty string');
  if (record.captured_run_id !== undefined && !isNonEmptyString(record.captured_run_id)) errors.push('captured_run_id must be a non-empty string');
  if (record.mentions !== undefined && !Array.isArray(record.mentions)) errors.push('mentions must be an array');
  if (record.state !== undefined && !ALLOWED_STATES.includes(record.state)) errors.push(`state must be one of ${ALLOWED_STATES.join('|')}`);
  if (record.trust_tier !== undefined && !ALLOWED_TRUST_TIERS.includes(record.trust_tier)) errors.push(`trust_tier must be one of ${ALLOWED_TRUST_TIERS.join('|')}`);
  if (record.confidence !== undefined && (typeof record.confidence !== 'number' || Number.isNaN(record.confidence) || record.confidence < 0 || record.confidence > 1)) errors.push('confidence must be a number in [0,1]');
  if (record.source_sha256 !== undefined && record.source_sha256 !== null && !/^[a-f0-9]{64}$/i.test(String(record.source_sha256))) errors.push('source_sha256 must be a 64-char hex string');
  if (record.created_at !== undefined && record.created_at !== null && Number.isNaN(Date.parse(record.created_at))) errors.push('created_at must be an ISO-8601 timestamp');
  return { ok: errors.length === 0, errors };
}

// Fill safe defaults + trim. Does NOT fabricate the substantive required fields (claim,
// source_path, source_sha256, trust_tier, captured_run_id, confidence, id) — a record missing
// those still fails validation. Returns a NEW object; never mutates input.
function normalizeFactRecord(record) {
  const r = (record && typeof record === 'object' && !Array.isArray(record)) ? record : {};
  const out = {
    schema_version: SCHEMA_VERSION,
    id: r.id,
    kind: r.kind === undefined ? 'fact' : r.kind,
    claim: typeof r.claim === 'string' ? r.claim.trim() : r.claim,
    mentions: Array.isArray(r.mentions) ? r.mentions.slice() : (r.mentions === undefined ? [] : r.mentions),
    source_path: r.source_path,
    source_sha256: typeof r.source_sha256 === 'string' ? r.source_sha256.toLowerCase() : r.source_sha256,
    trust_tier: r.trust_tier,
    captured_run_id: r.captured_run_id,
    confidence: r.confidence,
    state: r.state === undefined ? 'active' : r.state,
    supersedes: r.supersedes === undefined ? null : r.supersedes,
    created_at: r.created_at || nowIso()
  };
  // Preserve any extra caller-provided fields without overriding normalized ones.
  for (const k of Object.keys(r)) { if (!(k in out)) out[k] = r[k]; }
  return out;
}

// Normalize → validate → append one NDJSON line. Returns { ok, record?, path? } | { ok:false, errors }.
// Never rewrites existing lines. options: { root?, path? } (path overrides root).
function appendFactRecord(record, options = {}) {
  const normalized = normalizeFactRecord(record);
  const v = validateFactRecord(normalized);
  if (!v.ok) return { ok: false, errors: v.errors };
  const fp = options.path || factsPath(options.root || harnessRoot());
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify(normalized) + '\n');
  return { ok: true, record: normalized, path: fp };
}

// Read all parseable records (skips blank/corrupt lines, via _lib.readNdjson). Returns []
// when the file is absent. options: { root?, path? }.
function readFactRecords(options = {}) {
  const fp = options.path || factsPath(options.root || harnessRoot());
  return readNdjson(fp);
}

function filterActiveFacts(records) {
  return (Array.isArray(records) ? records : []).filter(r => r && r.state === 'active');
}

module.exports = {
  SCHEMA_VERSION, ALLOWED_STATES, ALLOWED_TRUST_TIERS, REQUIRED_FIELDS,
  factsPath, validateFactRecord, normalizeFactRecord, appendFactRecord, readFactRecords, filterActiveFacts
};

// ---------------------------------------------------------------------------
// Optional self-test. Uses a temp dir + synthetic facts only — NEVER touches real memory/.
// Intentionally NOT gated by the DISABLED kill switch (synthetic, temp-scoped, no side effects
// on the harness), so it can run for verification while the kill switch is active.
// ---------------------------------------------------------------------------
function selfTest() {
  const os = require('os');
  const dir = path.join(os.tmpdir(), 'hk-structmem-selftest-' + process.pid);
  const fp = path.join(dir, 'memory', 'facts.ndjson');
  const results = [];
  const assert = (name, cond) => results.push([name, !!cond]);
  try {
    assert('temp path under os.tmpdir()', fp.startsWith(os.tmpdir()));
    assert('default factsPath differs from temp (real memory untouched)', factsPath() !== fp);

    const good = {
      id: 'fact-0001',
      claim: 'The acme-billing service retries with exponential backoff.',
      mentions: ['acme-billing', 'backoff'],
      source_path: 'examples/acme/billing.md',
      source_sha256: 'a'.repeat(64),
      trust_tier: 'curated_memory',
      captured_run_id: 'selftest-run',
      confidence: 0.9,
      state: 'active'
      // created_at omitted → normalize stamps it
    };
    const r1 = appendFactRecord(good, { root: dir });
    assert('valid fact appended', r1.ok === true);
    assert('append wrote under temp root', r1.path === fp);
    assert('normalize stamped created_at', !!(r1.record && r1.record.created_at));

    const bad = { id: 'fact-bad', kind: 'fact', mentions: [] }; // missing claim/source_path/sha/tier/run/confidence
    const vb = validateFactRecord(normalizeFactRecord(bad));
    assert('invalid fact rejected by validate', vb.ok === false && vb.errors.length > 0);
    const r2 = appendFactRecord(bad, { root: dir });
    assert('invalid fact NOT appended', r2.ok === false);

    const superseded = Object.assign({}, good, { id: 'fact-0002', state: 'superseded', claim: 'Old acme-billing claim.' });
    appendFactRecord(superseded, { root: dir });

    const all = readFactRecords({ root: dir });
    assert('read back exactly 2 records (invalid one absent)', all.length === 2);
    const active = filterActiveFacts(all);
    assert('filterActiveFacts returns only active', active.length === 1 && active[0].id === 'fact-0001');
  } catch (e) {
    results.push(['exception: ' + (e && e.message), false]);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  let allPass = true;
  for (const [name, ok] of results) { process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`); if (!ok) allPass = false; }
  process.stdout.write(allPass ? 'self-test: ALL PASS\n' : 'self-test: FAILURES\n');
  return allPass;
}

if (require.main === module) {
  if (process.argv.slice(2).includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }
  process.stdout.write('structured-memory.js — library (Batch 5a). Run with --self-test for the synthetic smoke test.\n');
  process.exit(0);
}
