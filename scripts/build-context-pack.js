#!/usr/bin/env node
// build-context-pack.js — compose context-pack.md from run state + project profile + memory.
// Honors context-spec.json section toggles and caps. Applies redaction to all included text.
//
// Usage: node build-context-pack.js --run-id <id>
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const {
  parseArgs, nowIso, runDir, readJson, writeJson, appendNdjson, harnessRoot,
  loadProjectProfile, readNdjson, gitDiffPaths, indexRun
} = require('./_lib.js');
const { redactString } = require('./redact.js');
const searchMem = require('./search-memory.js');

function readTextSafe(p, maxLines = 200) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    return lines.slice(0, maxLines).join('\n');
  } catch { return null; }
}

function grepLines(p, terms, maxLines = 30) {
  if (!fs.existsSync(p) || !terms.length) return [];
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const lower = terms.map(t => String(t).toLowerCase());
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const lc = lines[i].toLowerCase();
    if (lower.some(t => lc.includes(t))) {
      hits.push(`${path.basename(p)}:${i + 1}: ${lines[i].trim()}`);
      if (hits.length >= maxLines) break;
    }
  }
  return hits;
}

function priorRunsForFiles(files, maxN = 8) {
  const idxPath = path.join(harnessRoot(), 'runs', '.index.ndjson');
  const all = readNdjson(idxPath);
  const seen = new Map();
  for (const e of all) seen.set(e.run_id, e);
  const recent = Array.from(seen.values()).sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, 40);
  const out = [];
  for (const e of recent) {
    const rd = path.join(harnessRoot(), 'runs', e.run_id);
    const tool = readNdjson(path.join(rd, 'tool-log.ndjson'));
    const touched = new Set();
    for (const t of tool) {
      const fp = t.tool_input?.file_path || t.tool_input?.path;
      if (fp) touched.add(String(fp).replace(/\\/g, '/'));
    }
    const hits = files.filter(f => touched.has(f.replace(/\\/g, '/')));
    if (hits.length) out.push({ run_id: e.run_id, state: e.state, files: hits });
    if (out.length >= maxN) break;
  }
  return out;
}

function searchLearnings(tags, maxN = 5) {
  const idxPath = path.join(harnessRoot(), 'memory', 'learnings-index.json');
  const idx = readJson(idxPath, { entries: [] });
  if (!idx.entries?.length) return [];
  const tagSet = new Set(tags);
  const scored = idx.entries.map(e => {
    const overlap = (e.tags || []).filter(t => tagSet.has(t)).length;
    const recency = e.created ? new Date(e.created).getTime() / 1e10 : 0;
    const refs = (e.reference_count || 0) * 0.1;
    return { entry: e, score: overlap * 2 + recency + refs };
  }).filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxN)
    .map(s => s.entry);
  return scored;
}

// Batch 5e: build the OPT-IN "## Structured Memory Facts" section. Returns null when not enabled
// (so the section is OMITTED and default context-pack output is unchanged). Active-only unless the
// historical flag is set. Read-only: reuses search-memory.searchStructuredFacts for matching +
// redaction + provenance; never reads source file contents. cap limits the number of facts.
function buildStructuredFactsSection(args, spec, route, cap) {
  const enabled = !!args['include-structured-memory'] || process.env.HK_STRUCTURED_MEMORY === '1';
  if (!enabled) return null;
  const includeHistorical = !!args['include-historical-structured'];
  const terms = (spec && spec.memory_tags && spec.memory_tags.length)
    ? spec.memory_tags
    : (route && route.questions
        ? [route.questions.task_type && route.questions.task_type.value]
            .concat((route.questions.risk_level && route.questions.risk_level.triggers) || [])
            .filter(Boolean)
        : []);
  const root = (args.root && args.root !== true) ? String(args.root) : harnessRoot();
  const facts = searchMem.searchStructuredFacts(
    { 'include-structured': true, root, 'include-historical-structured': includeHistorical },
    terms, cap
  ) || [];
  const lines = ['## Structured Memory Facts'];
  if (includeHistorical) lines.push('_(historical states included; marked [HISTORICAL:<state>])_');
  if (!facts.length) { lines.push('- (none found)', ''); return lines; }
  for (const f of facts) {
    const hist = f.state !== 'active' ? ` [HISTORICAL:${f.state}]` : '';
    lines.push(`- **${f.id}**${hist} — ${f.claim}`);
    lines.push(`  - mentions: ${(f.mentions || []).join(', ') || '—'} · trust_tier: ${f.trust_tier} · confidence: ${f.confidence} · state: ${f.state}`);
    lines.push(`  - provenance: source=${f.source_path} · source_sha256=${f.source_sha256} · captured_run_id=${f.captured_run_id}`);
  }
  lines.push('');
  return lines;
}

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok:false, disabled:true, reason:dis.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args['run-id']) { console.error('build-context-pack.js: --run-id required'); process.exit(1); }
  const runId = args['run-id'];
  const rd = runDir(runId);
  const run = readJson(path.join(rd, 'run.json'), null);
  const route = readJson(path.join(rd, 'route.json'), null);
  let spec = readJson(path.join(rd, 'context-spec.json'), null);
  if (!run || !route) { console.error('build-context-pack.js: run.json or route.json missing'); process.exit(1); }
  if (!spec) {
    // Default spec if select-context.js wasn't run
    spec = { sections: { request:true, classification:true, environment:true, project_policy:true,
      relevant_decisions:true, relevant_files:true, previous_sessions:true,
      relevant_learnings:true, rejected_patterns:true, open_questions:true, approval_requirements:true },
      caps: {}, memory_tags: [route.questions.task_type.value, ...(route.questions.risk_level.triggers || [])] };
  }
  const profile = loadProjectProfile(run.project_profile) || {};
  const sections = spec.sections;
  const caps = spec.caps || {};
  const lines = [];

  lines.push(`# Context Pack — run_id ${runId}`, '');

  if (sections.request) {
    lines.push('## 0. Request', '', '```', redactString(run.prompt || ''), '```', '');
  }

  if (sections.classification) {
    const q = route.questions;
    lines.push('## 1. Inferred classification');
    lines.push(`- task_type: **${q.task_type.value}** (confidence ${q.task_type.confidence})`);
    lines.push(`- alternates: ${(q.task_type.alternates || []).join(', ') || '—'}`);
    lines.push(`- workflow_owner: ${q.workflow_owner.primary}${q.workflow_owner.execution ? ' → ' + q.workflow_owner.execution : ''}`);
    lines.push(`- gates: ${(q.workflow_owner.gates || []).join(', ') || '—'}`);
    lines.push(`- risk_level: ${q.risk_level.value}`);
    lines.push(`- triggers: ${(q.risk_level.triggers || []).join(', ') || '—'}`);
    lines.push('');
  }

  if (sections.environment) {
    lines.push('## 2. Environment');
    lines.push(`- cwd: ${run.cwd}`);
    lines.push(`- project_profile: ${run.project_profile}`);
    if (run.project_root) lines.push(`- project_root: ${run.project_root}`);
    if (run.git) lines.push(`- git: branch=${run.git.branch} head=${(run.git.head || '').slice(0,12)} dirty=${run.git.dirty}`);
    lines.push('');
  }

  if (sections.project_policy) {
    lines.push('## 3. Project policy (read-only mirror)');
    for (const r of (profile.hard_rules_mirror || [])) lines.push(`- ${r}`);
    if ((profile.stop_conditions || []).length) {
      lines.push('', '**Stop conditions:**');
      for (const sc of profile.stop_conditions) lines.push(`- ${sc}`);
    }
    lines.push('');
  }

  if (sections.relevant_decisions && profile.decisions_source) {
    const cap = caps.relevant_decisions || 40;
    const terms = [route.questions.task_type.value, ...(route.questions.risk_level.triggers || [])];
    const hits = grepLines(profile.decisions_source, terms, cap);
    lines.push('## 4. Relevant decisions');
    if (hits.length) for (const h of hits) lines.push(`- ${redactString(h)}`);
    else lines.push('- (no hits)');
    lines.push('');
  }

  if (sections.relevant_files) {
    lines.push('## 5. Relevant files');
    const risk = readJson(path.join(rd, 'risk-report.json'), { paths: [], triggers: [] });
    const files = risk.paths || [];
    if (files.length) {
      lines.push(`- changed files (${files.length}):`);
      for (const f of files.slice(0, caps.relevant_files || 60)) lines.push(`  - ${f}`);
    } else if (run.project_root) {
      const gitFiles = gitDiffPaths(run.project_root, 'HEAD');
      if (gitFiles.length) {
        lines.push(`- git diff vs HEAD (${gitFiles.length}):`);
        for (const f of gitFiles.slice(0, caps.relevant_files || 60)) lines.push(`  - ${f}`);
      } else {
        lines.push('- (no diff)');
      }
    } else {
      lines.push('- (no project_root; skipping diff)');
    }
    if ((risk.triggers || []).length) {
      lines.push('- triggers:');
      for (const t of risk.triggers) lines.push(`  - ${t.path} → ${t.trigger}${t.note ? ' (' + t.note + ')' : ''}`);
    }
    lines.push('');
  }

  if (sections.previous_sessions) {
    const risk = readJson(path.join(rd, 'risk-report.json'), { paths: [] });
    const prior = priorRunsForFiles(risk.paths || [], caps.previous_sessions || 25);
    lines.push('## 6. Previous sessions touching same files');
    if (prior.length) for (const p of prior) lines.push(`- ${p.run_id} (state=${p.state}) — files: ${p.files.slice(0,3).join(', ')}${p.files.length>3?', …':''}`);
    else lines.push('- (none)');
    lines.push('');
  }

  if (sections.relevant_learnings) {
    const found = searchLearnings(spec.memory_tags || [], caps.relevant_learnings || 5);
    lines.push('## 7. Relevant learnings (memory index)');
    if (found.length) for (const f of found) lines.push(`- ${f.title || f.id} — tags: ${(f.tags||[]).join(', ')} — path: ${f.path}`);
    else lines.push('- (none yet — memory empty)');
    lines.push('');
  }

  // Batch 5e: OPT-IN structured facts section (omitted entirely unless enabled → default unchanged).
  {
    const structuredLines = buildStructuredFactsSection(args, spec, route, (caps.structured_memory || 10));
    if (structuredLines) lines.push(...structuredLines);
  }

  if (sections.rejected_patterns) {
    const rp = path.join(harnessRoot(), 'memory', 'rejected-patterns.md');
    const txt = readTextSafe(rp, caps.rejected_patterns || 20);
    lines.push('## 8. What was tried before (do not retry)');
    if (txt && txt.trim()) lines.push('', txt, '');
    else lines.push('- (none recorded)', '');
  }

  if (sections.open_questions) {
    lines.push('## 9. Open questions', '- (to be filled by user / discovery during PLANNING)', '');
  }

  if (sections.approval_requirements) {
    const verdict = readJson(path.join(rd, 'approval-verdict.json'), null);
    lines.push('## 10. Approval requirements');
    if (verdict) {
      lines.push(`- approval_required: **${verdict.approval_required}**`);
      if (verdict.reasons?.length) {
        lines.push('- reasons:');
        for (const r of verdict.reasons) lines.push(`  - ${r}`);
      }
      if (verdict.required_for?.length) lines.push(`- required for: ${verdict.required_for.join(', ')}`);
    } else {
      lines.push('- (not yet computed — run check-approval-needed.js)');
    }
    lines.push('');
  }

  const out = lines.join('\n');
  fs.writeFileSync(path.join(rd, 'context-pack.md'), out);

  appendNdjson(path.join(rd, 'decision-log.ndjson'), {
    ts: nowIso(),
    run_id: runId,
    from: 'CONTEXT_GATHERING',
    to: 'CONTEXT_GATHERING',
    reason: `context-pack composed (${out.split('\n').length} lines)`,
    artifact: 'context-pack.md'
  });

  console.log(JSON.stringify({ ok: true, run_id: runId, bytes: out.length, lines: out.split('\n').length }, null, 2));
}

module.exports = { buildStructuredFactsSection };

if (require.main === module) main();
