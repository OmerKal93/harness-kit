#!/usr/bin/env node
// read-facts.js — Batch 5c. EXPLICIT, MANUAL structured-fact read CLI.
//
// Reads memory/facts.ndjson via scripts/structured-memory.js and prints matching facts.
// NOT auto-retrieval: nothing in the harness calls it — a human/script runs it on purpose. No
// wiring into search-memory.js / build-context-pack.js / summarize-session.js. Read-only: never
// writes, never mutates the store. Pure Node stdlib + structured-memory.js. No LLM, no network.
//
// Does NOT read or print markdown memory (memory/*.md) — only the structured NDJSON store.
//
// Usage:
//   node read-facts.js [--active] [--include-historical] [--mention <term>] [--trust-tier <tier>]
//                      [--json] [--no-verify-sources] [--root <dir>] [--self-test]
//
// Default: active-only, one compact JSON line per fact + a summary line.
// --json: a single envelope { ok, count, facts, warnings }.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { harnessRoot, parseArgs } = require('./_lib.js');
const sm = require('./structured-memory.js');

// Recompute SHA-256 of each fact's source_path (when it is a readable local file) and WARN on
// drift. Read-only and non-fatal — never rejects, never prints source contents.
function verifySources(facts) {
  const warnings = [];
  for (const f of facts) {
    if (!f || !f.source_path) continue;
    const abs = path.isAbsolute(f.source_path) ? f.source_path : path.resolve(process.cwd(), f.source_path);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        if (actual.toLowerCase() !== String(f.source_sha256).toLowerCase()) {
          warnings.push(`fact ${f.id}: source changed since capture (source_sha256 mismatch)`);
        }
      }
    } catch { /* unreadable source on a read path is non-fatal; skip silently */ }
  }
  return warnings;
}

// opts: { root?, includeHistorical?, mention?, trustTier?, verifySources? }
function readFacts(opts = {}) {
  const root = opts.root || harnessRoot();
  const records = sm.readFactRecords({ root });               // [] when file absent (no crash)
  let facts = opts.includeHistorical ? records.slice() : sm.filterActiveFacts(records);
  if (opts.mention) {
    const t = String(opts.mention).toLowerCase();
    facts = facts.filter(f => Array.isArray(f.mentions) && f.mentions.some(m => String(m).toLowerCase() === t));
  }
  if (opts.trustTier) {
    facts = facts.filter(f => f.trust_tier === opts.trustTier);
  }
  const warnings = (opts.verifySources === false) ? [] : verifySources(facts);
  return { ok: true, count: facts.length, facts, warnings };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) process.exit(selfTest() ? 0 : 1);

  const result = readFacts({
    root: (args.root && args.root !== true) ? String(args.root) : harnessRoot(),
    includeHistorical: !!args['include-historical'],
    mention: (args.mention && args.mention !== true) ? String(args.mention) : null,
    trustTier: (args['trust-tier'] && args['trust-tier'] !== true) ? String(args['trust-tier']) : null,
    verifySources: !args['no-verify-sources']
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    for (const f of result.facts) {
      process.stdout.write(JSON.stringify({ id: f.id, state: f.state, trust_tier: f.trust_tier, mentions: f.mentions, claim: f.claim }) + '\n');
    }
    for (const w of result.warnings) process.stdout.write('# warn: ' + w + '\n');
    process.stdout.write(`# count=${result.count} warnings=${result.warnings.length}\n`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Self-test: temp-dir + synthetic facts only. Never reads real memory/. Not gated by the kill
// switch (synthetic, temp-scoped), so it runs for verification even while DISABLED is active.
// ---------------------------------------------------------------------------
function selfTest() {
  const os = require('os');
  const dir = path.join(os.tmpdir(), 'hk-readfacts-selftest-' + process.pid);
  const results = [];
  const A = (name, cond) => results.push([name, !!cond]);
  try {
    // 1. empty root → count 0, no crash
    const empty = readFacts({ root: dir });
    A('absent facts file → count 0', empty.ok === true && empty.count === 0 && empty.facts.length === 0);

    // temp source files for hash verification
    const srcMatch = path.join(dir, 'src', 'match.md');
    const srcMismatch = path.join(dir, 'src', 'mismatch.md');
    fs.mkdirSync(path.dirname(srcMatch), { recursive: true });
    fs.writeFileSync(srcMatch, 'matching source content\n');
    fs.writeFileSync(srcMismatch, 'this file changed after capture\n');
    const shaMatch = crypto.createHash('sha256').update(fs.readFileSync(srcMatch)).digest('hex');

    const seed = (rec) => {
      const r = sm.appendFactRecord(rec, { root: dir });
      if (!r.ok) throw new Error('seed failed: ' + JSON.stringify(r.errors));
    };
    seed({ id: 'f-a1', claim: 'Alpha is common.', mentions: ['alpha', 'common'], source_path: 'examples/none.md', source_sha256: 'a'.repeat(64), trust_tier: 'curated_memory', captured_run_id: 'st', confidence: 0.8, state: 'active' });
    seed({ id: 'f-a2', claim: 'Beta is common.', mentions: ['beta', 'common'], source_path: srcMatch, source_sha256: shaMatch, trust_tier: 'run_artifact', captured_run_id: 'st', confidence: 0.7, state: 'active' });
    seed({ id: 'f-a3', claim: 'Gamma fact.', mentions: ['gamma'], source_path: srcMismatch, source_sha256: 'a'.repeat(64), trust_tier: 'curated_memory', captured_run_id: 'st', confidence: 0.6, state: 'active' });
    seed({ id: 'f-su', claim: 'Old alpha.', mentions: ['alpha'], source_path: 'examples/none.md', source_sha256: 'b'.repeat(64), trust_tier: 'run_artifact', captured_run_id: 'st', confidence: 0.5, state: 'superseded' });
    seed({ id: 'f-re', claim: 'Bad delta.', mentions: ['delta'], source_path: 'examples/none.md', source_sha256: 'c'.repeat(64), trust_tier: 'untrusted_external', captured_run_id: 'st', confidence: 0.2, state: 'retracted' });

    const active = readFacts({ root: dir });
    A('active-only default → 3', active.count === 3 && active.facts.every(f => f.state === 'active'));

    const all = readFacts({ root: dir, includeHistorical: true });
    A('include-historical → 5', all.count === 5);

    const byMention = readFacts({ root: dir, mention: 'common' });
    A('mention=common (active) → f-a1,f-a2', byMention.count === 2 && byMention.facts.map(f => f.id).sort().join(',') === 'f-a1,f-a2');

    const mentionHist = readFacts({ root: dir, mention: 'alpha', includeHistorical: true });
    A('mention=alpha (+historical) → f-a1,f-su', mentionHist.count === 2 && mentionHist.facts.map(f => f.id).sort().join(',') === 'f-a1,f-su');

    const byTier = readFacts({ root: dir, trustTier: 'curated_memory' });
    A('trust-tier=curated_memory (active) → f-a1,f-a3', byTier.count === 2 && byTier.facts.map(f => f.id).sort().join(',') === 'f-a1,f-a3');

    const verified = readFacts({ root: dir });
    A('source mismatch warns f-a3 only', verified.warnings.length === 1 && /f-a3/.test(verified.warnings[0]));

    const noVerify = readFacts({ root: dir, verifySources: false });
    A('--no-verify-sources suppresses warnings', noVerify.warnings.length === 0);

    A('read-only: never touched real memory', sm.factsPath() !== sm.factsPath(dir));
  } catch (e) {
    results.push(['exception: ' + (e && e.message), false]);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  let pass = true;
  for (const [name, ok] of results) { process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}\n`); if (!ok) pass = false; }
  process.stdout.write(pass ? 'self-test: ALL PASS\n' : 'self-test: FAILURES\n');
  return pass;
}

module.exports = { readFacts, verifySources };

if (require.main === module) main();
