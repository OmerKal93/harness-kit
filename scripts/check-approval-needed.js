#!/usr/bin/env node
// check-approval-needed.js — given a run, read route + risk-report, decide if explicit
// Owner approval is required before EXECUTION proceeds. Emits verdict + reasons.
//
// Usage: node check-approval-needed.js --run-id <id>
//
// Output: { ok, approval_required, reasons[], required_for[], confidence_check }
// Exit:   0 if no approval required, 2 if required
'use strict';
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const { parseArgs, nowIso, runDir, readJson, loadGlobalPolicy, writeJson } = require('./_lib.js');

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok:false, disabled:true, reason:dis.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args['run-id']) { console.error('check-approval-needed.js: --run-id required'); process.exit(1); }
  const rd = runDir(args['run-id']);
  const route = readJson(path.join(rd, 'route.json'), null);
  const risk  = readJson(path.join(rd, 'risk-report.json'), { riskLevel: 'low', haltConditions: [] });
  if (!route) { console.error('check-approval-needed.js: route.json missing'); process.exit(1); }
  const policy = loadGlobalPolicy();
  const threshold = policy.classifier_confidence_threshold_for_approval ?? 0.55;

  const reasons = [];
  const requiredFor = new Set();

  const halts = risk.haltConditions || [];
  if (halts.length) {
    reasons.push(`risk-report critical halt conditions: ${halts.join(', ')}`);
    halts.forEach(h => requiredFor.add(h));
  }
  if (route.questions.risk_level.value === 'critical') {
    reasons.push('risk_level=critical');
  }
  const triggers = route.questions.risk_level.triggers || [];
  for (const t of triggers) {
    if (t === 'prisma') { requiredFor.add('prisma_migration'); reasons.push('prisma path touched'); }
    if (t === 'auth_hmac_session') { requiredFor.add('auth_secret_hmac_hkdf_change'); reasons.push('auth/hmac/hkdf code'); }
    if (t === 'env_secrets') { requiredFor.add('env_secret_modification'); reasons.push('env/credential paths'); }
    if (t === 'legacy_service') { requiredFor.add('new_legacy_service_code'); reasons.push('legacy service naming'); }
    if (t === 'outreach_pipeline') { requiredFor.add('reactivate_cold_outreach'); reasons.push('outreach pipeline (cold outreach INACTIVE)'); }
    if (t === 'audit_tool_docs') { requiredFor.add('modify_auditor_or_audit_tool'); reasons.push('auditor/audit-tool core'); }
  }
  const reqOwner = route.questions.requires_owner?.value || [];
  for (const r of reqOwner) requiredFor.add(r);

  const conf = route.questions.task_type.confidence || 0;
  const lowConfidence = conf < threshold;
  if (lowConfidence) {
    reasons.push(`classifier confidence ${conf.toFixed(2)} < threshold ${threshold}`);
    requiredFor.add('confirm_task_type');
  }
  const overFive = risk.overFiveFileRule;
  if (overFive) {
    reasons.push(`change touches ${risk.fileCount} files (>5 outside scope rule)`);
    requiredFor.add('scope_expansion');
  }

  const approvalRequired = reasons.length > 0;
  const verdict = {
    schema_version: 1,
    run_id: args['run-id'],
    ts: nowIso(),
    approval_required: approvalRequired,
    reasons,
    required_for: Array.from(requiredFor),
    confidence: conf,
    threshold,
    risk_level: route.questions.risk_level.value
  };
  writeJson(path.join(rd, 'approval-verdict.json'), verdict);
  console.log(JSON.stringify(verdict, null, 2));
  process.exit(approvalRequired ? 2 : 0);
}

main();
