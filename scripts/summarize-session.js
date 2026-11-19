#!/usr/bin/env node
// summarize-session.js — roll up a finished run into a learning candidate.
// Reads run folder, produces summary suitable for /harness-learn or /ce-compound capture.
//
// Usage: node summarize-session.js --run-id <id> [--write]   (--write appends to learning.md)
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const {
  parseArgs, nowIso, runDir, readJson, readNdjson, harnessRoot
} = require('./_lib.js');
const { redactString } = require('./redact.js');

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok:false, disabled:true, reason:dis.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args['run-id']) { console.error('summarize-session.js: --run-id required'); process.exit(1); }
  const rd = runDir(args['run-id']);
  const run = readJson(path.join(rd, 'run.json'), {});
  const route = readJson(path.join(rd, 'route.json'), {});
  const risk = readJson(path.join(rd, 'risk-report.json'), { triggers: [] });
  const verdict = readJson(path.join(rd, 'approval-verdict.json'), null);
  const decisions = readNdjson(path.join(rd, 'decision-log.ndjson'));
  const tools = readNdjson(path.join(rd, 'tool-log.ndjson'));

  const transitions = decisions.filter(d => d.from !== d.to).map(d => `${d.from} → ${d.to}: ${d.reason}`);
  const failures = decisions.filter(d => /fail|error|halt|block/i.test(d.reason || ''));
  const toolCounts = {};
  for (const t of tools) toolCounts[t.tool] = (toolCounts[t.tool] || 0) + 1;
  const filesTouched = Array.from(new Set(tools
    .map(t => t.tool_input?.file_path || t.tool_input?.path)
    .filter(Boolean)));

  // Phase 2: when the run is clean (no failures captured, reached DONE), replace
  // (fill in) placeholders with explicit n/a — avoids leakage into learning entries.
  const reachedDone = run.state === 'DONE';
  const cleanRun = failures.length === 0 && reachedDone;
  const ph = cleanRun ? 'n/a (clean run)' : '(fill in)';

  const tags = new Set();
  if (route.questions?.task_type?.value) tags.add(route.questions.task_type.value);
  for (const t of (route.questions?.risk_level?.triggers || [])) tags.add(t);

  const md = [
    `# Learning candidate — run_id ${run.run_id}`,
    `> Generated ${nowIso()} by summarize-session.js`,
    '',
    '## Symptoms',
    `- request: ${redactString(run.prompt || '')}`,
    `- task_type: ${route.questions?.task_type?.value || '?'} (confidence ${route.questions?.task_type?.confidence ?? '?'})`,
    `- risk_level: ${route.questions?.risk_level?.value || '?'}`,
    '',
    '## Root cause',
    `- ${ph}`,
    '',
    '## Failed attempts',
    failures.length ? failures.map(f => `- ${f.reason}`).join('\n') : '- (none captured in decision-log)',
    '',
    '## Final solution',
    `- ${ph}`,
    '',
    '## Prevention',
    cleanRun ? '- n/a (clean run — no preventive rule needed)' : '- (rule, atom, or hook to add)',
    '',
    '## Negative knowledge (do not retry)',
    `- ${ph}`,
    '',
    '## Related files',
    ...(filesTouched.length ? filesTouched.map(f => `- ${f}`) : ['- (none)']),
    '',
    '## Related decisions',
    '- (handbook/decisions.md refs)',
    '',
    '## Related runs',
    '- (use search-memory.js to find by tag)',
    '',
    '## Tags',
    `- ${Array.from(tags).join(', ')}`,
    '',
    '## Tool usage summary',
    ...Object.entries(toolCounts).map(([k,v]) => `- ${k}: ${v}`),
    '',
    '## State transitions',
    ...(transitions.length ? transitions.map(t => `- ${t}`) : ['- (none)']),
    ''
  ].join('\n');

  if (args.write) {
    fs.writeFileSync(path.join(rd, 'learning.md'), md);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({
      ok: true,
      run_id: run.run_id,
      tags: Array.from(tags),
      files_touched: filesTouched,
      tool_counts: toolCounts,
      transition_count: transitions.length,
      failure_count: failures.length,
      summary_path: args.write ? path.join(rd, 'learning.md') : null
    }, null, 2) + '\n');
  } else {
    process.stdout.write(md);
  }
}

main();
