#!/usr/bin/env node
// select-agents.js — choose compound personas/agents based on risk triggers + active phase.
// Writes selected-agents.json into the run folder.
//
// Usage: node select-agents.js --run-id <id> [--phase phase_1_now]
'use strict';
const path = require('path');
const { isDisabled } = require('../scripts/is-disabled.js');
const {
  parseArgs, nowIso, runDir, readJson, writeJson, appendNdjson,
  loadGlobalPolicy
} = require('../scripts/_lib.js');

function activeForPhase(policy, phaseName) {
  const pg = policy.agent_routing?.phase_gates || {};
  const order = ['phase_1_now', 'phase_2_before_first_client', 'phase_3_after_first_client'];
  const idx = order.indexOf(phaseName);
  if (idx === -1) return new Set(pg.phase_1_now?.active || []);
  const set = new Set();
  for (let i = 0; i <= idx; i++) {
    const p = pg[order[i]];
    if (!p) continue;
    (p.active || []).forEach(a => set.add(a));
    (p.active_additions || []).forEach(a => set.add(a));
  }
  return set;
}

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok:false, disabled:true, reason:dis.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args['run-id']) { console.error('select-agents.js: --run-id required'); process.exit(1); }
  const rd = runDir(args['run-id']);
  const route = readJson(path.join(rd, 'route.json'), null);
  if (!route) { console.error('select-agents.js: route.json missing'); process.exit(1); }
  const policy = loadGlobalPolicy();
  const phaseName = args.phase || policy.agent_routing?.active_phase || 'phase_1_now';
  const active = activeForPhase(policy, phaseName);
  const triggers = route.questions.risk_level.triggers || [];

  const always = policy.agent_routing?.always_on || [];
  const onTrigger = policy.agent_routing?.on_trigger || {};

  const picks = new Map(); // name → reason
  for (const a of always) {
    if (active.has(a)) picks.set(a, 'always_on');
  }
  for (const t of triggers) {
    const list = onTrigger[t] || [];
    for (const a of list) {
      if (active.has(a)) {
        const prev = picks.get(a);
        picks.set(a, prev ? `${prev}; trigger:${t}` : `trigger:${t}`);
      }
    }
  }
  // Special: new skill/agent proposed → enforce Research-Before-Build via learnings-researcher
  const taskType = route.questions.task_type.value;
  if (['memory-capture','memory-refresh','learning'].includes(taskType)) {
    if (active.has('ce-learnings-researcher')) picks.set('ce-learnings-researcher', (picks.get('ce-learnings-researcher') || '') + '; task=' + taskType);
  }

  const selected = Array.from(picks.entries()).map(([name, reason]) => ({ name, reason }));
  const deferred = [];
  for (const t of triggers) {
    for (const a of (onTrigger[t] || [])) {
      if (!active.has(a)) deferred.push({ agent: a, trigger: t, reason: `not active in ${phaseName}` });
    }
  }

  const out = {
    schema_version: 1,
    run_id: args['run-id'],
    ts: nowIso(),
    phase: phaseName,
    triggers,
    selected,
    deferred,
    notes: route.questions.risk_level.value === 'critical'
      ? ['risk=critical: invoke all selected adversarially']
      : []
  };
  writeJson(path.join(rd, 'selected-agents.json'), out);
  appendNdjson(path.join(rd, 'decision-log.ndjson'), {
    ts: nowIso(),
    run_id: args['run-id'],
    from: 'ROUTING',
    to: 'ROUTING',
    reason: `agents selected (n=${selected.length}): ${selected.map(s => s.name).join(', ')}`,
    artifact: 'selected-agents.json'
  });
  console.log(JSON.stringify(out, null, 2));
}

main();
