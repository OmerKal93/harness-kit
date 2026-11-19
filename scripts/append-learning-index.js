#!/usr/bin/env node
// append-learning-index.js — idempotent push to memory/learnings-index.json.
// Dedupes by id (run_id). Applies redaction to every string field before persist.
//
// Usage:
//   node append-learning-index.js --run-id <id> --learning-path <abs-or-rel-path>
//
// Output: { ok, action: "appended" | "updated" | "skipped", entry_id, total_entries }
// Exit:   0 ok; 1 missing args; 2 learning file missing or unreadable.
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const {
  parseArgs, nowIso, harnessRoot, runDir, readJson, writeJson
} = require('./_lib.js');
const { redactString } = require('./redact.js');

function extractTagsFromLearning(md) {
  const m = md.match(/^##\s*Tags\s*\n([\s\S]*?)(?:\n##|\n*$)/m);
  if (!m) return [];
  return m[1].split(/\n/).flatMap(l => l.replace(/^[-*]\s*/, '').split(/[,;]/).map(s => s.trim()).filter(Boolean));
}

function extractTitle(md, runId) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].slice(0, 200) : `learning ${runId}`;
}

function extractSummary(md) {
  const m = md.match(/##\s*Symptoms\s*\n([\s\S]*?)(?:\n##|\n*$)/m);
  if (!m) return '';
  return m[1].trim().slice(0, 500);
}

function relatedFiles(md) {
  const m = md.match(/##\s*Related files\s*\n([\s\S]*?)(?:\n##|\n*$)/m);
  if (!m) return [];
  return m[1].split(/\n/).map(l => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 50);
}

function main() {
  const dis = isDisabled();
  if (dis.disabled) {
    process.stdout.write(JSON.stringify({ ok: false, disabled: true, reason: dis.reason }) + '\n');
    process.exit(0);
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args['run-id'] || !args['learning-path']) {
    process.stderr.write('append-learning-index.js: --run-id and --learning-path required\n');
    process.exit(1);
  }
  const runId = args['run-id'];
  const learningPath = path.isAbsolute(args['learning-path'])
    ? args['learning-path']
    : path.resolve(runDir(runId), args['learning-path']);
  if (!fs.existsSync(learningPath)) {
    process.stdout.write(JSON.stringify({ ok: false, reason: `learning file not found: ${learningPath}` }) + '\n');
    process.exit(2);
  }
  const md = fs.readFileSync(learningPath, 'utf8');
  if (md.trim().length < 40) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'learning file too short (<40 chars) — refusing to index' }) + '\n');
    process.exit(2);
  }
  const idxPath = path.join(harnessRoot(), 'memory', 'learnings-index.json');
  const idx = readJson(idxPath, { schema_version: 1, entries: [] });
  if (!Array.isArray(idx.entries)) idx.entries = [];

  const entry = {
    id: runId,
    title: redactString(extractTitle(md, runId)),
    summary: redactString(extractSummary(md)),
    tags: extractTagsFromLearning(md).map(t => redactString(t)),
    related_files: relatedFiles(md).map(f => redactString(f)),
    path: learningPath,
    created: nowIso(),
    reference_count: 0
  };

  let action = 'appended';
  const existingI = idx.entries.findIndex(e => e && e.id === runId);
  if (existingI >= 0) {
    const prev = idx.entries[existingI];
    // preserve reference_count + created from prior entry
    entry.created = prev.created || entry.created;
    entry.reference_count = prev.reference_count || 0;
    // idempotency: skip if path + summary + tags unchanged
    const same = prev.path === entry.path
      && prev.summary === entry.summary
      && JSON.stringify(prev.tags || []) === JSON.stringify(entry.tags || []);
    if (same) {
      process.stdout.write(JSON.stringify({ ok: true, action: 'skipped', entry_id: runId, total_entries: idx.entries.length, reason: 'identical to existing entry' }) + '\n');
      process.exit(0);
    }
    idx.entries[existingI] = entry;
    action = 'updated';
  } else {
    idx.entries.push(entry);
  }
  writeJson(idxPath, idx);
  process.stdout.write(JSON.stringify({ ok: true, action, entry_id: runId, total_entries: idx.entries.length }) + '\n');
  process.exit(0);
}

main();
