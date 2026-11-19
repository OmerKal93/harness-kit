#!/usr/bin/env node
// select-context.js — decide which sections of the context pack to include.
// Outputs a JSON spec consumed by build-context-pack.js. Stored on the run as
// context-spec.json so /harness-trace can inspect what was loaded vs skipped.
//
// Usage: node select-context.js --run-id <id>
'use strict';
const path = require('path');
const { isDisabled } = require('../scripts/is-disabled.js');
const {
  parseArgs, nowIso, runDir, readJson, writeJson
} = require('../scripts/_lib.js');

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok:false, disabled:true, reason:dis.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args['run-id']) { console.error('select-context.js: --run-id required'); process.exit(1); }
  const rd = runDir(args['run-id']);
  const route = readJson(path.join(rd, 'route.json'), null);
  if (!route) { console.error('select-context.js: route.json missing'); process.exit(1); }
  const runJson = readJson(path.join(rd, 'run.json'), {});

  const taskType = route.questions.task_type.value;
  const risk = route.questions.risk_level.value;
  const triggers = route.questions.risk_level.triggers || [];

  // Section toggles (defaults are conservative — include if relevant)
  const sections = {
    request:                true,
    classification:         true,
    environment:            true,
    project_policy:         true,
    relevant_decisions:     true,
    relevant_files:         taskType !== 'strategy' && taskType !== 'ideate' && taskType !== 'brainstorm',
    previous_sessions:      ['code-bug','review','learning','session-recover','memory-refresh'].includes(taskType),
    relevant_learnings:     true,
    rejected_patterns:      ['code-bug','code-feature','ops'].includes(taskType),
    open_questions:         true,
    approval_requirements:  true
  };

  // Caps per section (lines)
  const caps = {
    relevant_decisions:   risk === 'critical' ? 80 : 40,
    relevant_files:       60,
    previous_sessions:    25,
    relevant_learnings:   30,
    rejected_patterns:    20
  };

  // Memory tags to grep — derived from task_type + triggers
  const memoryTags = new Set();
  memoryTags.add(taskType);
  for (const t of triggers) memoryTags.add(t);

  const out = {
    schema_version: 1,
    run_id: args['run-id'],
    ts: nowIso(),
    sections,
    caps,
    memory_tags: Array.from(memoryTags),
    project_profile: runJson.project_profile
  };
  writeJson(path.join(rd, 'context-spec.json'), out);
  console.log(JSON.stringify(out, null, 2));
}

main();
