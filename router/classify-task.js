#!/usr/bin/env node
// classify-task.js — rule-based task classifier. Reads prompt + project profile,
// scores task_type by keyword density, derives triggers from booster keywords,
// optionally runs risk-detect, writes route.json (draft) into the run folder.
//
// Usage:
//   node classify-task.js --run-id <id>
//   node classify-task.js --prompt "text" [--profile example-app] [--no-risk]
//
// Output (stdout):
//   { ok, run_id?, task_type, confidence, alternates, triggers, risk_level }
//
// Side effects (only with --run-id):
//   - writes route.json (draft)
//   - appends decision-log.ndjson INTAKE → CONTEXT_GATHERING
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isDisabled } = require('../scripts/is-disabled.js');
const {
  parseArgs, nowIso, runDir, readJson, writeJson, appendNdjson,
  loadGlobalPolicy, loadProjectProfile, detectProjectProfile, indexRun
} = require('../scripts/_lib.js');

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function scoreTaskTypes(prompt, hints) {
  const scores = {};
  for (const [type, kws] of Object.entries(hints || {})) {
    if (!kws.length) continue;
    const re = new RegExp(`\\b(?:${kws.map(escapeRe).join('|')})\\b`, 'gi');
    const m = prompt.match(re);
    scores[type] = m ? m.length : 0;
  }
  return scores;
}

function detectTriggers(prompt, boosters) {
  const found = [];
  for (const [trigger, kws] of Object.entries(boosters || {})) {
    if (!kws.length) continue;
    const re = new RegExp(`\\b(?:${kws.map(escapeRe).join('|')})\\b`, 'i');
    if (re.test(prompt)) found.push(trigger);
  }
  return found;
}

function pickTop(scores) {
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return { top: 'unknown', topScore: 0, alternates: [], total: 0 };
  const total = sorted.reduce((s, [, n]) => s + n, 0);
  const [top, topScore] = sorted[0];
  return {
    top: topScore === 0 ? 'unknown' : top,
    topScore,
    alternates: sorted.slice(1, 4).filter(([, n]) => n > 0).map(([t]) => t),
    total
  };
}

function confidenceOf(topScore, total) {
  if (total === 0) return 0.3;
  const ratio = topScore / total;
  const intensity = Math.min(1, topScore / 3);
  return Math.min(0.95, ratio * 0.6 + intensity * 0.4);
}

function pickWorkflow(taskType, triggers, policy) {
  const map = policy.task_type_to_workflow || {};
  const base = map[taskType] || map.unknown || { primary: '/ce-brainstorm', execution: null, gates: [] };
  const gates = new Set(base.gates || []);
  if (triggers.includes('prisma') || triggers.includes('auth_hmac_session')) {
    gates.add('verification-before-completion');
  }
  if (taskType === 'code-bug') gates.add('systematic-debugging');
  if (taskType === 'code-feature' && (triggers.includes('audit_tool_docs') || triggers.includes('prisma'))) {
    gates.add('test-driven-development');
  }
  return { primary: base.primary, execution: base.execution, gates: Array.from(gates) };
}

function pickAutonomous(taskType, riskLevel) {
  const safe = ['read', 'search', 'classify', 'draft plan.md', 'draft review.md'];
  if (riskLevel === 'low' && taskType !== 'ops') safe.push('edit non-sensitive files');
  return safe;
}

function pickRequiresOwner(triggers, riskLevel) {
  const out = new Set();
  if (riskLevel === 'critical') out.add('any write to flagged paths');
  if (triggers.includes('prisma')) out.add('run prisma migrate');
  if (triggers.includes('auth_hmac_session')) out.add('modify auth/HMAC/HKDF/session code');
  if (triggers.includes('legacy_service')) out.add('add new legacy-service code');
  if (triggers.includes('env_secrets')) out.add('read/write env or credential files');
  if (triggers.includes('outreach_pipeline')) out.add('reactivate cold outreach');
  if (triggers.includes('audit_tool_docs')) out.add('modify auditor core or audit-tool runtime');
  return Array.from(out);
}

function pickIrreversible(triggers) {
  if (triggers.includes('prisma')) return 'any prisma migration';
  if (triggers.includes('auth_hmac_session')) return 'auth/session change deployed';
  if (triggers.includes('env_secrets')) return 'env/credential modification';
  return 'commit + push (deferred per Push Control)';
}

function pickVerification(taskType, triggers) {
  if (taskType === 'code-bug') return 'reproduce failing case → run test → verify pass + no regressions';
  if (triggers.includes('prisma')) return 'run BIL pipeline against test fixture + verify Prisma Debug Spine rows';
  if (taskType === 'docs' || taskType === 'doc-review') return 'render + spot-check + cross-link verification';
  if (taskType === 'code-feature') return 'execute happy path + at least one edge case';
  return 'manual readback against acceptance criteria';
}

function runRiskDetectInline(runId, prompt, profile) {
  // detect-risk exits 2 when critical halt conditions are present; that is a valid
  // outcome, not a failure. Parse stdout regardless of exit code.
  const script = path.join(__dirname, '..', 'scripts', 'detect-risk.js');
  const argv = [script];
  if (runId) argv.push('--run-id', runId);
  else if (profile) argv.push('--profile', profile.name);
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (!out) return { riskLevel: 'low', triggers: [], haltConditions: [], paths: [] };
  try { return JSON.parse(out); }
  catch { return { riskLevel: 'low', triggers: [], haltConditions: [], paths: [] }; }
}

function main() {
  const dis = isDisabled();
  if (dis.disabled) {
    process.stdout.write(JSON.stringify({ ok: false, disabled: true, reason: dis.reason }) + '\n');
    process.exit(0);
  }
  const args = parseArgs(process.argv.slice(2));

  let runJson = null;
  let runId = args['run-id'] || null;
  let prompt = args.prompt || null;
  let profile = null;

  if (runId) {
    const rd = runDir(runId);
    runJson = readJson(path.join(rd, 'run.json'), null);
    if (!runJson) {
      process.stderr.write(`classify-task.js: run not found: ${runId}\n`);
      process.exit(1);
    }
    prompt = prompt || runJson.prompt || '';
    const data = loadProjectProfile(runJson.project_profile);
    if (data) profile = { name: runJson.project_profile, data };
  } else {
    if (!prompt) {
      process.stderr.write('classify-task.js: --prompt or --run-id required\n');
      process.exit(1);
    }
    if (args.profile) {
      const data = loadProjectProfile(args.profile);
      if (data) profile = { name: args.profile, data };
    }
    if (!profile) profile = detectProjectProfile(args.cwd || process.cwd());
  }

  const policy = loadGlobalPolicy();
  const hints = (profile?.data?.classifier_keyword_hints) || {};
  const boosters = (profile?.data?.classifier_trigger_boosters) || {};

  const scores = scoreTaskTypes(prompt, hints);
  const { top, topScore, alternates, total } = pickTop(scores);
  let taskType = runJson?.task_type_hint || top;
  const confidence = confidenceOf(topScore, total);

  const triggers = detectTriggers(prompt, boosters);

  let risk = { riskLevel: 'low', triggers: [], haltConditions: [], paths: [] };
  if (!args['no-risk']) {
    risk = runRiskDetectInline(runId, prompt, profile);
    for (const t of risk.triggers || []) {
      if (!triggers.includes(t.trigger)) triggers.push(t.trigger);
    }
  }

  const workflow = pickWorkflow(taskType, triggers, policy);
  const autonomous = pickAutonomous(taskType, risk.riskLevel);
  const requiresOwner = pickRequiresOwner(triggers, risk.riskLevel);
  const next = pickIrreversible(triggers);
  const verification = pickVerification(taskType, triggers);

  const route = {
    schema_version: 1,
    run_id: runId,
    ts: nowIso(),
    profile: profile ? profile.name : null,
    prompt_excerpt: prompt.slice(0, 240),
    questions: {
      task_type:           { value: taskType, confidence: Number(confidence.toFixed(3)), alternates },
      workflow_owner:      { primary: workflow.primary, execution: workflow.execution, gates: workflow.gates },
      context_sufficient:  { value: false, missing: [], note: 'refined in CONTEXT_GATHERING state' },
      risk_level:          { value: risk.riskLevel, triggers, halt_conditions: risk.haltConditions || [] },
      agents_needed:       { value: [], note: 'filled by select-agents.js in ROUTING state' },
      autonomous_actions:  { value: autonomous },
      requires_owner:       { value: requiresOwner },
      should_log:          { value: 'all_tool_calls_and_state_transitions' },
      next_irreversible:   { value: next, approval_required: requiresOwner.length > 0 || (risk.haltConditions || []).length > 0 },
      verification_method: { value: verification },
      learning_to_capture: { value: '<derived after EXECUTION>' }
    }
  };

  if (runId) {
    const rd = runDir(runId);
    writeJson(path.join(rd, 'route.json'), route);
    appendNdjson(path.join(rd, 'decision-log.ndjson'), {
      ts: nowIso(),
      run_id: runId,
      from: 'INTAKE',
      to: 'CONTEXT_GATHERING',
      reason: `classifier picked ${taskType} @ ${confidence.toFixed(2)} (scores: ${JSON.stringify(scores)})`,
      artifact: 'route.json'
    });
    // bump index
    runJson.state = 'CONTEXT_GATHERING';
    runJson.last_state_change = nowIso();
    runJson.task_type = taskType;
    runJson.confidence = Number(confidence.toFixed(3));
    writeJson(path.join(rd, 'run.json'), runJson);
    indexRun(runId, 'CONTEXT_GATHERING', taskType, confidence);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    run_id: runId,
    task_type: taskType,
    confidence: Number(confidence.toFixed(3)),
    alternates,
    triggers,
    risk_level: risk.riskLevel,
    halt_conditions: risk.haltConditions || []
  }, null, 2) + '\n');
}

main();
