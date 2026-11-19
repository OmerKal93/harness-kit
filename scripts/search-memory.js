#!/usr/bin/env node
// search-memory.js — search learnings-index.json + memory markdown tiers.
//
// Usage:
//   node search-memory.js --tags "prisma,migration" [--limit 10] [--json]
//   node search-memory.js --topic "auth session" [--limit 10]
//   node search-memory.js --file-path "src/services/auth/session.ts"
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const { parseArgs, harnessRoot, readJson } = require('./_lib.js');
const { redactString } = require('./redact.js');
const sm = require('./structured-memory.js');

function loadIndex() {
  return readJson(path.join(harnessRoot(), 'memory', 'learnings-index.json'), { entries: [] });
}

function scoreEntry(e, { tagSet, topicWords, filePath }) {
  let score = 0;
  if (tagSet?.size) {
    const overlap = (e.tags || []).filter(t => tagSet.has(t)).length;
    score += overlap * 3;
  }
  if (topicWords?.length) {
    const hay = ((e.title || '') + ' ' + (e.summary || '')).toLowerCase();
    for (const w of topicWords) if (hay.includes(w)) score += 1;
  }
  if (filePath && (e.related_files || []).includes(filePath)) score += 5;
  if (e.created) {
    const ageDays = (Date.now() - new Date(e.created).getTime()) / 86400000;
    score += Math.max(0, 1 - ageDays / 90);
  }
  score += (e.reference_count || 0) * 0.1;
  return score;
}

function grepMd(file, terms, maxLines = 12) {
  if (!fs.existsSync(file) || !terms.length) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const lc = terms.map(t => t.toLowerCase());
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lc.some(t => lines[i].toLowerCase().includes(t))) {
      hits.push({ file: path.basename(file), line: i + 1, text: redactString(lines[i].trim()) });
      if (hits.length >= maxLines) break;
    }
  }
  return hits;
}

// Batch 5d: OPT-IN structured-fact search. Returns null when not enabled, so default output is
// byte-unchanged. Read-only; reuses scripts/structured-memory.js. Active facts only by default.
function structuredEnabled(args) {
  return !!args['include-structured'] || process.env.HK_STRUCTURED_MEMORY === '1';
}

function factMatches(fact, lcTerms) {
  if (!lcTerms.length) return true;
  const hay = `${fact.claim || ''} ${fact.source_path || ''} ${fact.trust_tier || ''}`.toLowerCase();
  const mentions = Array.isArray(fact.mentions) ? fact.mentions.map(m => String(m).toLowerCase()) : [];
  return lcTerms.some(t => hay.includes(t) || mentions.some(m => m.includes(t)));
}

// Match query terms against claim/mentions/source_path/trust_tier (simple substring; no embeddings).
// Provenance retained (source_path, source_sha256, trust_tier, captured_run_id). Does NOT verify
// source hashes (this is search, not verification — that lives in read-facts.js). claim/source_path
// pass through redactString; source file contents are never read or printed.
function searchStructuredFacts(args, terms, limit) {
  if (!structuredEnabled(args)) return null;
  const root = (args.root && args.root !== true) ? String(args.root) : harnessRoot();
  const records = sm.readFactRecords({ root }); // [] when facts.ndjson absent — no crash
  const pool = args['include-historical-structured'] ? records : sm.filterActiveFacts(records);
  const lcTerms = (terms || []).map(t => String(t).toLowerCase());
  return pool
    .filter(f => factMatches(f, lcTerms))
    .slice(0, limit)
    .map(f => ({
      id: f.id,
      claim: redactString(f.claim || ''),
      mentions: Array.isArray(f.mentions) ? f.mentions : [],
      trust_tier: f.trust_tier,
      source_path: redactString(f.source_path || ''),
      source_sha256: f.source_sha256,
      captured_run_id: f.captured_run_id,
      confidence: f.confidence,
      state: f.state
    }));
}

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok:false, disabled:true, reason:dis.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const tagSet = new Set((args.tags || '').split(',').map(s => s.trim()).filter(Boolean));
  const topicWords = (args.topic || '').toLowerCase().split(/\s+/).filter(Boolean);
  const filePath = args['file-path'] || null;
  const limit = Number(args.limit) || 10;

  const idx = loadIndex();
  const scored = (idx.entries || [])
    .map(e => ({ entry: e, score: scoreEntry(e, { tagSet, topicWords, filePath }) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const terms = [...tagSet, ...topicWords].filter(Boolean);
  const memDir = path.join(harnessRoot(), 'memory');
  const md = ['personal-patterns.md','rejected-patterns.md','recurring-failures.md','routing-lessons.md']
    .flatMap(f => grepMd(path.join(memDir, f), terms, Math.ceil(limit / 2)));

  const out = {
    ok: true,
    query: { tags: Array.from(tagSet), topic: args.topic || null, file_path: filePath },
    learnings: scored.map(s => ({ ...s.entry, _score: Number(s.score.toFixed(2)) })),
    memory_hits: md
  };

  const structured = searchStructuredFacts(args, terms, limit);
  if (structured !== null) out.structured_facts = structured;

  if (args.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else {
    process.stdout.write(`Learnings (${out.learnings.length}):\n`);
    for (const l of out.learnings) process.stdout.write(`  • ${l.title || l.id} [${(l.tags||[]).join(',')}] — score=${l._score}\n`);
    process.stdout.write(`Memory hits (${out.memory_hits.length}):\n`);
    for (const h of out.memory_hits) process.stdout.write(`  • ${h.file}:${h.line}: ${h.text}\n`);
    if (out.structured_facts) {
      process.stdout.write(`Structured facts (${out.structured_facts.length}):\n`);
      for (const f of out.structured_facts) process.stdout.write(`  • [${f.state}] ${f.id} — ${f.claim} (tier=${f.trust_tier}, run=${f.captured_run_id})\n`);
    }
  }
}

module.exports = { searchStructuredFacts, factMatches, structuredEnabled };

if (require.main === module) main();
