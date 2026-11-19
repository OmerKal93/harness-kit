#!/usr/bin/env node
// select-workflow.js — finalize the workflow_owner block in route.json.
// Reads the draft route.json + global policy, applies overrides from CLI,
// re-asserts gates based on triggers + risk level.
//
// Usage:
//   node select-workflow.js --run-id <id> [--override-primary /ce-strategy] [--add-gate test-driven-development]
'use strict';
const path = require('path');
const { isDisabled } = require('../scripts/is-disabled.js');
const {
  parseArgs, nowIso, runDir, readJson, writeJson, appendNdjson,
  loadGlobalPolicy, indexRun
} = require('../scripts/_lib.js');

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok:false, disabled:true, reason:dis.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args['run-id']) { console.error('select-workflow.js: --run-id required'); process.exit(1); }
  const rd = runDir(args['run-id']);
  const route = readJson(path.join(rd, 'route.json'), null);
  if (!route) { console.error('select-workflow.js: route.json missing — run classify-task first'); process.exit(1); }
  const policy = loadGlobalPolicy();
  const taskType = route.questions.task_type.value;
  const triggers = route.questions.risk_level.triggers || [];
  const risk = route.questions.risk_level.value;

  // Start from policy mapping
  const map = policy.task_type_to_workflow || {};
  const base = map[taskType] || map.unknown || { primary: '/ce-brainstorm', execution: null, gates: [] };
  const gates = new Set(base.gates || []);

  // Risk-driven additions
  if (risk === 'high' || risk === 'critical') gates.add('verification-before-completion');
  if (triggers.includes('prisma') || triggers.includes('auth_hmac_session') || triggers.includes('env_secrets')) {
    gates.add('verification-before-completion');
  }
  if (taskType === 'code-bug') gates.add('systematic-debugging');
  if ((taskType === 'code-feature' || taskType === 'code-bug') && (triggers.includes('audit_tool_docs') || risk === 'critical')) {
    gates.add('subagent-driven-development');
  }

  const owner = {
    primary: args['override-primary'] || base.primary,
    execution: base.execution,
    gates: Array.from(new Set([...gates, ...(args['add-gate'] ? [args['add-gate']] : [])]))
  };
  route.questions.workflow_owner = owner;
  route.ts = nowIso();
  writeJson(path.join(rd, 'route.json'), route);
  appendNdjson(path.join(rd, 'decision-log.ndjson'), {
    ts: nowIso(),
    run_id: args['run-id'],
    from: 'CONTEXT_GATHERING',
    to: 'ROUTING',
    reason: `workflow=${owner.primary} exec=${owner.execution || 'none'} gates=[${owner.gates.join(',')}]`,
    artifact: 'route.json'
  });

  const runJson = readJson(path.join(rd, 'run.json'), {});
  runJson.state = 'ROUTING';
  runJson.last_state_change = nowIso();
  writeJson(path.join(rd, 'run.json'), runJson);
  indexRun(args['run-id'], 'ROUTING', taskType, route.questions.task_type.confidence);

  console.log(JSON.stringify({ ok: true, workflow_owner: owner }, null, 2));
}

main();
