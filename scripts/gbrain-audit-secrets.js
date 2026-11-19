#!/usr/bin/env node
// gbrain-audit-secrets.js — Phase 3B helper.
// Runs every redaction regex against ~/.gbrain/pages/ and the staging dir.
// Writes runs/<run-id>/gbrain-secret-audit.md.
// Exit 0 = zero hits (clean). Exit 2 = at least one hit (HALT and rollback).
//
// Usage:
//   node gbrain-audit-secrets.js --run-id <id>
//   node gbrain-audit-secrets.js --run-id <id> --staging <staging-dir>
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, nowIso, ensureRunDir, readJson } = require('./_lib.js');

const RULES_PATH = path.join(harnessRoot(), 'config', 'redaction-rules.json');
const POLICY_PATH = path.join(harnessRoot(), 'config', 'gbrain-import-policy.json');

function loadPatterns() {
  const rules = readJson(RULES_PATH, { patterns: [] });
  const policy = readJson(POLICY_PATH, { content_blocklist: [] });
  const out = [];
  for (const p of rules.patterns || []) {
    try { out.push({ id: p.id || p.name || 'rule', re: new RegExp(p.regex, (p.flags || 'g').replace('g', 'g')), source: 'redaction-rules' }); }
    catch {}
  }
  for (const p of policy.content_blocklist || []) {
    try { out.push({ id: 'content_blocklist:' + p.id, re: new RegExp(p.pattern, 'g'), source: 'gbrain-import-policy' }); }
    catch {}
  }
  return out;
}

function walkMarkdown(dir) {
  const out = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && (full.endsWith('.md') || full.endsWith('.json') || full.endsWith('.txt'))) out.push(full);
    }
  }
  walk(dir);
  return out;
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const runId = args['run-id'];
  if (!runId) { console.error('error: --run-id <id> required'); process.exit(2); }

  const patterns = loadPatterns();
  const targets = [];

  const brainPages = path.join(os.homedir(), '.gbrain', 'pages');
  if (fs.existsSync(brainPages)) targets.push(...walkMarkdown(brainPages));

  if (args.staging) {
    const stagingDir = String(args.staging);
    if (fs.existsSync(stagingDir)) targets.push(...walkMarkdown(stagingDir));
  } else {
    const defaultStaging = path.join(os.tmpdir(), 'gbrain-staging', runId);
    if (fs.existsSync(defaultStaging)) targets.push(...walkMarkdown(defaultStaging));
  }

  // Strip already-redacted placeholders before scanning. Phase 4 Batch 1 fix
  // for G2 audit FP: the url_with_creds replacement [REDACTED:url_creds]@host
  // re-matches its own regex on a second pass, producing a false HALT verdict
  // on a clean brain. Replacement convention in config/redaction-rules.json v2
  // guarantees every placeholder begins with [REDACTED: and ends with ].
  const PLACEHOLDER_RE = /\[REDACTED:[^\]]+\]/g;

  const hits = [];
  for (const f of targets) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const content = raw.replace(PLACEHOLDER_RE, '');
    for (const pat of patterns) {
      pat.re.lastIndex = 0;
      let m;
      let count = 0;
      while ((m = pat.re.exec(content)) !== null && count < 5) {
        hits.push({
          file: f,
          pattern_id: pat.id,
          source: pat.source,
          match_excerpt: m[0].slice(0, 40)
        });
        count++;
        if (!pat.re.global) break;
      }
    }
  }

  const runDirPath = ensureRunDir(runId);
  const reportPath = path.join(runDirPath, 'gbrain-secret-audit.md');

  const md = [];
  md.push('# GBrain Secret Audit');
  md.push('');
  md.push(`- **Generated:** ${nowIso()}`);
  md.push(`- **Run ID:** ${runId}`);
  md.push(`- **Patterns checked:** ${patterns.length}`);
  md.push(`- **Files scanned:** ${targets.length}`);
  md.push(`- **Targets:** ${[brainPages, args.staging || path.join(os.tmpdir(), 'gbrain-staging', runId)].join('; ')}`);
  md.push(`- **Hits:** ${hits.length}`);
  md.push(`- **Verdict:** ${hits.length === 0 ? 'CLEAN' : 'HALT — rollback required'}`);
  md.push('');
  if (hits.length) {
    md.push('## Hits');
    md.push('');
    md.push('| File | Pattern | Source | Match excerpt (first 40 chars) |');
    md.push('|---|---|---|---|');
    for (const h of hits) {
      md.push(`| ${h.file} | ${h.pattern_id} | ${h.source} | \`${h.match_excerpt.replace(/`/g, "'")}\` |`);
    }
  } else {
    md.push('No matches across any redaction pattern or content blocklist. Brain + staging are clean.');
  }
  md.push('');

  fs.writeFileSync(reportPath, md.join('\n'), 'utf8');

  console.log(JSON.stringify({
    ok: hits.length === 0,
    run_id: runId,
    audit_report: reportPath,
    patterns_checked: patterns.length,
    files_scanned: targets.length,
    hits: hits.length,
    verdict: hits.length === 0 ? 'CLEAN' : 'HALT'
  }, null, 2));

  process.exit(hits.length === 0 ? 0 : 2);
}

if (require.main === module) main();
