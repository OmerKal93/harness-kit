#!/usr/bin/env node
// evals/core/gbrain-ab/run.js — Phase 4 Batch 2.
// Drives the 10-query A/B between scripts/gbrain-query-memory.js and scripts/search-memory.js.
// Computes per-query verdict ∈ {win, tie, loss, unsafe, irrelevant}. Aggregates.
//
// Pass criterion (Batch 2 per user approval): zero `unsafe` verdicts. Win count is
// reported as informational evidence; not a gate for Batch 2.
//
// Honors kill switch. No `gbrain import` invocation. Read-only against the current
// PGLite store and memory/.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');
const { redactString } = require('../../../scripts/redact.js');
const { scanContent } = require('../../../scripts/memory-poisoning-scan.js');

const QUERY_TIMEOUT_MS = 20000;

function runScript(args, opts = {}) {
  try {
    const stdout = execFileSync('node', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      cwd: harnessRoot(),
      timeout: opts.timeout || QUERY_TIMEOUT_MS
    });
    return { ok: true, stdout, exitCode: 0 };
  } catch (e) {
    return {
      ok: false,
      stdout: (e.stdout && e.stdout.toString()) || '',
      exitCode: typeof e.status === 'number' ? e.status : 1,
      error: String(e.message || e).slice(0, 240)
    };
  }
}

function gbrainQuery(query) {
  const script = path.join(harnessRoot(), 'scripts', 'gbrain-query-memory.js');
  return runScript([script, '--q', query]);
}

function searchMemoryQuery(topic) {
  const script = path.join(harnessRoot(), 'scripts', 'search-memory.js');
  return runScript([script, '--topic', topic, '--json']);
}

function parseSearchMemory(stdout) {
  try { return JSON.parse(stdout); }
  catch { return { ok: false, learnings: [], memory_hits: [] }; }
}

function citationsMatch(text, mustCiteOneOf) {
  const hay = text.toLowerCase();
  for (const c of mustCiteOneOf || []) {
    if (hay.includes(String(c).toLowerCase())) return c;
  }
  return null;
}

function searchMemoryCites(parsed, mustCiteOneOf) {
  // search-memory.js returns { learnings: [{ id, title, tags, related_files, ...}], memory_hits: [{ file, line, text }] }.
  // We declare a "citation match" when any of mustCiteOneOf — derived from a path like memory/personal-patterns.md →
  // page-id memory_personal-patterns — corresponds to a memory_hit basename of personal-patterns.md.
  const wanted = new Set();
  for (const c of mustCiteOneOf || []) {
    // page-id form: top_basename → split on first '_'
    const idx = String(c).indexOf('_');
    if (idx <= 0) { wanted.add(String(c).toLowerCase()); continue; }
    const base = String(c).slice(idx + 1).toLowerCase();
    wanted.add(base + '.md');
    wanted.add(base);
  }
  for (const h of parsed.memory_hits || []) {
    const f = String(h.file || '').toLowerCase();
    if (wanted.has(f)) return h.file;
    for (const w of wanted) { if (w.length >= 6 && f.includes(w)) return h.file; }
  }
  for (const l of parsed.learnings || []) {
    const blob = [(l.title || ''), (l.summary || ''), ...((l.related_files || []))].join(' ').toLowerCase();
    for (const c of mustCiteOneOf || []) { if (blob.includes(String(c).toLowerCase())) return l.id || l.title; }
  }
  return null;
}

function mustMentionAllPresent(text, mustMention) {
  const hay = text.toLowerCase();
  for (const m of mustMention || []) {
    if (!hay.includes(String(m).toLowerCase())) return false;
  }
  return true;
}

function safetyScan(gbrainStdout) {
  const flags = [];
  const redacted = redactString(gbrainStdout);
  if (redacted !== gbrainStdout) flags.push('post-redact-divergence');
  const syntheticPath = path.join(harnessRoot(), 'evals', 'fixtures', 'gbrain-ab', 'synthetic-query-output.md');
  try {
    const scan = scanContent(gbrainStdout, syntheticPath);
    if (scan && scan.instruction_hits > 0) flags.push('poisoning-instruction-survived');
  } catch (e) { flags.push('scan-error:' + String(e.message).slice(0, 80)); }
  return { unsafe: flags.length > 0, flags };
}

function verdictFor(q, gbrainOut, smParsed) {
  const safety = safetyScan(gbrainOut);
  if (safety.unsafe) return { verdict: 'unsafe', evidence: { safety_flags: safety.flags } };

  const gt = q.expected_ground_truth || {};
  const gbCite = citationsMatch(gbrainOut, gt.must_cite_one_of);
  // Mention check is advisory only — GBrain's CLI prints brief excerpts of each hit,
  // so the must_mention token often does not appear in stdout even when the right page
  // is surfaced. A citation match means the right page reached top-k; mention check is
  // a confirmatory annotation, not a gate. Per Batch 2 plan KTD: "citation match alone
  // is win-eligible."
  const gbMention = mustMentionAllPresent(gbrainOut, gt.must_mention);
  const gbHit = !!gbCite;

  const smCite = searchMemoryCites(smParsed, gt.must_cite_one_of);
  const smHit = !!smCite;

  if (gbHit && !smHit) return { verdict: 'win', evidence: { gbrain_cite: gbCite, gbrain_mention_in_excerpt: gbMention } };
  if (!gbHit && smHit) return { verdict: 'loss', evidence: { search_memory_cite: smCite } };
  if (gbHit && smHit)  return { verdict: 'tie', evidence: { gbrain_cite: gbCite, search_memory_cite: smCite, gbrain_mention_in_excerpt: gbMention } };
  return { verdict: 'irrelevant', evidence: { gbrain_cite: gbCite || null, gbrain_mention_in_excerpt: gbMention, search_memory_cite: smCite || null } };
}

function runOneQuery(q) {
  const t0 = Date.now();
  const gb = gbrainQuery(q.query);
  const gbDur = Date.now() - t0;
  const t1 = Date.now();
  const sm = searchMemoryQuery(q.topic || q.query);
  const smDur = Date.now() - t1;
  const smParsed = parseSearchMemory(sm.stdout);
  const gbOutForScoring = gb.ok ? gb.stdout : '';
  const v = verdictFor(q, gbOutForScoring, smParsed);
  return {
    id: q.id,
    query: q.query,
    gbrain_ok: gb.ok,
    gbrain_error: gb.error || null,
    gbrain_duration_ms: gbDur,
    gbrain_output_excerpt: redactString((gbOutForScoring || '').slice(0, 240)),
    search_memory_ok: sm.ok,
    search_memory_error: sm.error || null,
    search_memory_duration_ms: smDur,
    search_memory_hits: (smParsed.memory_hits || []).length,
    verdict: v.verdict,
    evidence: v.evidence
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'gbrain-ab');
  const queriesPath = path.join(fixturesDir, 'queries.json');

  let corpus;
  try { corpus = JSON.parse(fs.readFileSync(queriesPath, 'utf8')); }
  catch (e) {
    console.log(JSON.stringify({ category: 'gbrain-ab', pass: false, error: 'queries.json unreadable: ' + e.message }, null, 2));
    process.exit(1);
  }
  const queries = corpus.queries || [];

  const t0 = Date.now();
  const rows = [];
  for (const q of queries) {
    rows.push(runOneQuery(q));
  }
  const duration_ms = Date.now() - t0;

  const counts = { win: 0, tie: 0, loss: 0, unsafe: 0, irrelevant: 0 };
  for (const r of rows) { counts[r.verdict] = (counts[r.verdict] || 0) + 1; }

  // Batch 2 pass criterion (per user approval): zero unsafe. Win threshold reported.
  const pass = counts.unsafe === 0 && rows.length > 0;

  const meetsWin = counts.win >= 7;
  // display_state surfaces the advisory miss clearly without inventing a numeric score.
  const display_state = !pass
    ? 'FAIL(unsafe=' + counts.unsafe + ')'
    : meetsWin
      ? 'PASS(safety+win)'
      : 'PASS(safety) · ADVISORY_MISS win ' + counts.win + '/' + 7;

  const out = {
    category: 'gbrain-ab',
    pass,
    display_state,
    total: rows.length,
    counts,
    win_threshold_advisory: 7,
    meets_win_threshold: meetsWin,
    duration_ms,
    rows
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(pass ? 0 : 1);
}

if (require.main === module) main();
