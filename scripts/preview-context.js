#!/usr/bin/env node
// preview-context.js — STRICTLY READ-ONLY preview of what context-pack /harness-run
// would compose for a given prompt or run_id. NEVER creates a run, NEVER writes to
// runs/, memory/, learnings-index.json, vault, or settings.
//
// Usage:
//   node preview-context.js --prompt "..."     (classify + assemble preview)
//   node preview-context.js --run-id <id>      (print existing context-pack.md verbatim)
//
// Output: redacted Markdown on stdout. Header summary first, then context-pack body.
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const {
  parseArgs, runDir, readJson, harnessRoot,
  loadGlobalPolicy, loadProjectProfile, detectProjectProfile, gitDiffPaths
} = require('./_lib.js');
const { redactString } = require('./redact.js');

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function classifyInline(prompt, profile) {
  const hints = profile?.classifier_keyword_hints || {};
  const boosters = profile?.classifier_trigger_boosters || {};
  const scores = {};
  for (const [type, kws] of Object.entries(hints)) {
    if (!kws.length) continue;
    const re = new RegExp(`\\b(?:${kws.map(escapeRe).join('|')})\\b`, 'gi');
    const m = prompt.match(re);
    scores[type] = m ? m.length : 0;
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, n]) => s + n, 0);
  const top = sorted[0] || ['unknown', 0];
  const conf = top[1] === 0 ? 0.3 : Math.min(0.95, (top[1]/Math.max(total,1))*0.6 + Math.min(1, top[1]/3)*0.4);
  const triggers = [];
  for (const [t, kws] of Object.entries(boosters)) {
    if (!kws.length) continue;
    const re = new RegExp(`\\b(?:${kws.map(escapeRe).join('|')})\\b`, 'i');
    if (re.test(prompt)) triggers.push(t);
  }
  const alternates = sorted.slice(1, 4).filter(([, n]) => n > 0).map(([t]) => t);
  return { task_type: top[1] === 0 ? 'unknown' : top[0], confidence: conf, triggers, alternates };
}

function grepLines(file, terms, maxLines) {
  if (!fs.existsSync(file) || !terms.length) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const lower = terms.map(t => String(t).toLowerCase());
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const lc = lines[i].toLowerCase();
    if (lower.some(t => lc.includes(t))) {
      hits.push(`${path.basename(file)}:${i + 1}: ${lines[i].trim()}`);
      if (hits.length >= maxLines) break;
    }
  }
  return hits;
}

function previewFromPrompt(prompt, args) {
  const cwd = args.cwd || process.cwd();
  let profile = null;
  if (args.profile) {
    const data = loadProjectProfile(args.profile);
    if (data) profile = { name: args.profile, data };
  }
  if (!profile) profile = detectProjectProfile(cwd);
  if (!profile) {
    return `# Preview\n\n_No project profile matched cwd \`${cwd}\` and none supplied with \`--profile\`. Nothing to preview._\n`;
  }

  const r = classifyInline(prompt, profile.data);
  const policy = loadGlobalPolicy();
  const workflow = (policy.task_type_to_workflow || {})[r.task_type] || policy.task_type_to_workflow?.unknown || { primary: '/ce-brainstorm', execution: null, gates: [] };

  const lines = [];
  lines.push('# Context Preview (READ-ONLY — no run created)');
  lines.push('');
  lines.push('## 1. Classification (preview)');
  lines.push(`- task_type: **${r.task_type}** (confidence ${r.confidence.toFixed(2)})`);
  lines.push(`- alternates: ${r.alternates.join(', ') || '—'}`);
  lines.push(`- triggers: ${r.triggers.join(', ') || '—'}`);
  lines.push(`- suggested workflow: ${workflow.primary}${workflow.execution ? ' → ' + workflow.execution : ''}`);
  lines.push(`- gates: ${(workflow.gates || []).join(', ') || '—'}`);
  lines.push('');

  lines.push('## 2. Profile loaded');
  lines.push(`- name: ${profile.name}`);
  if (profile.data.project_root) lines.push(`- project_root: ${profile.data.project_root}`);
  lines.push('');

  lines.push('## 3. Policy snapshot');
  lines.push(`- classifier_confidence_threshold_for_approval: ${policy.classifier_confidence_threshold_for_approval ?? '—'}`);
  lines.push(`- active_phase: ${policy.agent_routing?.active_phase ?? '—'}`);
  lines.push('');

  // Relevant decisions (preview only — read vault, never write)
  if (profile.data.decisions_source && fs.existsSync(profile.data.decisions_source)) {
    const terms = [r.task_type, ...r.triggers];
    const hits = grepLines(profile.data.decisions_source, terms, 20);
    lines.push('## 4. Relevant decisions (preview, capped 20)');
    if (hits.length) for (const h of hits) lines.push(`- ${h}`);
    else lines.push('- (no hits)');
    lines.push('');
  }

  // Relevant files via git diff (preview only)
  if (profile.data.project_root && fs.existsSync(profile.data.project_root)) {
    const files = gitDiffPaths(profile.data.project_root, 'HEAD').slice(0, 30);
    lines.push('## 5. Relevant files (git diff vs HEAD, preview capped 30)');
    if (files.length) for (const f of files) lines.push(`  - ${f}`);
    else lines.push('- (no diff)');
    lines.push('');
  }

  // Memory hits via learnings-index
  const idx = readJson(path.join(harnessRoot(), 'memory', 'learnings-index.json'), { entries: [] });
  const tagSet = new Set([r.task_type, ...r.triggers]);
  const memHits = (idx.entries || [])
    .map(e => ({ e, overlap: (e.tags || []).filter(t => tagSet.has(t)).length }))
    .filter(s => s.overlap > 0)
    .sort((a,b) => b.overlap - a.overlap)
    .slice(0, 5);
  lines.push('## 6. Memory hits (top 5 by tag overlap)');
  if (memHits.length) for (const m of memHits) lines.push(`- ${m.e.title || m.e.id} — tags: ${(m.e.tags||[]).join(', ')} — overlap=${m.overlap}`);
  else lines.push('- (none — memory empty or no tag overlap)');
  lines.push('');

  lines.push('## 7. Sections that would be capped or omitted in a real run');
  lines.push('- This preview omits: previous-sessions-touching-same-files, rejected-patterns dump, open-questions, approval-requirements (no run = no verdict yet).');
  lines.push('- These appear only in the full context-pack written by `/harness-run`.');
  lines.push('');

  lines.push('## 8. Note');
  lines.push('- This preview did NOT create a run. Nothing was written to `runs/`, `memory/`, `learnings-index.json`, or the project vault.');
  lines.push('- To actually start the harness: `/harness-run <your prompt>`.');
  lines.push('');

  return lines.join('\n');
}

function previewFromRunId(runId) {
  const rd = runDir(runId);
  if (!fs.existsSync(rd)) return `# Preview\n\n_No run found: ${runId}_\n`;
  const cp = path.join(rd, 'context-pack.md');
  const run = readJson(path.join(rd, 'run.json'), null);
  if (!run) return `# Preview\n\n_run.json missing for ${runId}_\n`;
  const header = [
    `# Context Preview — existing run ${runId} (state=${run.state})`,
    `> Prompt: ${redactString(run.prompt || '')}`,
    ''
  ].join('\n');
  if (!fs.existsSync(cp)) return header + '\n_context-pack.md not yet built for this run._\n';
  return header + '\n' + fs.readFileSync(cp, 'utf8');
}

function main() {
  const dis = isDisabled();
  if (dis.disabled) {
    process.stdout.write('# Preview\n\n_harnesskit disabled: ' + dis.reason + '_\n');
    process.exit(0);
  }
  const args = parseArgs(process.argv.slice(2));
  let out;
  if (args['run-id']) {
    out = previewFromRunId(args['run-id']);
  } else if (args.prompt) {
    out = previewFromPrompt(String(args.prompt), args);
  } else {
    process.stderr.write('preview-context.js: --prompt or --run-id required\n');
    process.exit(1);
  }
  process.stdout.write(redactString(out));
  process.exit(0);
}

main();
