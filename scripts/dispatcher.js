#!/usr/bin/env node
// dispatcher.js — P8C (Batch 1, hk/p8c-agent-dispatch): Agent-Dispatch / Host-Model-Routing skeleton.
//
// DESIGN DOC (read this first): docs/AGENT_DISPATCH_MODEL_ROUTING.md — every function below cites the
// section of that doc it implements. This file is NOT wired into bin/harnesskit.js, execute-workflow.js,
// loop-conductor.js, or any review-independence/* file. It adds a new, optional layer only.
//
// HONESTY SPLIT (see design doc section 14 for the full rationale):
//   REAL, self-tested, zero process spawning: resolveRequiredCapabilities, selectRoutingPolicy,
//     buildDispatchPlan, computePanelConsensus, buildReceipt, validateDispatchRecord,
//     allocateWorktree/releaseWorktree (real `git worktree` calls, but only ever against a fresh
//     temp repo created and destroyed inside this file's own self-test).
//   STUBS (throw 'not yet implemented'): spawnDispatch, monitorDispatch, collectDispatch,
//     cancelDispatch — each needs live process/host actuation this lane deliberately does not wire.
//
// Library:
//   const dispatcher = require('./dispatcher.js')
// CLI:
//   node scripts/dispatcher.js --self-test
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { parseArgs, harnessRoot, readJson, nowIso } = require('./_lib.js');
const { isDisabled } = require('./is-disabled.js');
const { route, TASK_TYPE_CAPABILITIES } = require('../router/select-adapter.js');

const DEFAULT_POLICY = Object.freeze({
  risk_class_routing: {
    low: { producer_policy: 'highest_verified_quality', reviewer_policy: 'independent_review', requires_human_approval: false },
    med: { producer_policy: 'highest_verified_quality', reviewer_policy: 'independent_review', requires_human_approval: false },
    high: { producer_policy: 'highest_verified_quality', reviewer_policy: 'independent_review', requires_human_approval: false },
    critical: { producer_policy: 'local_cli_only', reviewer_policy: 'independent_review', requires_human_approval: true },
    unknown: { producer_policy: 'highest_verified_quality', reviewer_policy: 'independent_review', requires_human_approval: false }
  },
  role_minimum_capabilities: { producer: [], reviewer: ['review'], challenger_addition: ['security'] }
});

function loadDispatchPolicy(root) {
  return readJson(path.join(root || harnessRoot(), 'config', 'dispatch-policy.json'), DEFAULT_POLICY);
}

// ---------------------------------------------------------------------------
// REAL: section 4.2 — role-aware capability requirements layered on top of
// select-adapter.js#TASK_TYPE_CAPABILITIES. Union only, never a subtraction.
// ---------------------------------------------------------------------------
function resolveRequiredCapabilities({ taskType, role, panelRole, policy, requiredCapabilities }) {
  const p = policy || DEFAULT_POLICY;
  const base = requiredCapabilities || TASK_TYPE_CAPABILITIES[taskType] || [];
  const floor = (p.role_minimum_capabilities && p.role_minimum_capabilities[role]) || [];
  const challengerAddition = (role === 'reviewer' && panelRole === 'challenger' && p.role_minimum_capabilities)
    ? (p.role_minimum_capabilities.challenger_addition || [])
    : [];
  const merged = new Set([...base, ...floor, ...challengerAddition]);
  return Array.from(merged);
}

// ---------------------------------------------------------------------------
// REAL: section 5 — risk_class -> routing policy, per role. Fails safe to the
// 'unknown' row (never more permissive than 'low') if risk_class is unrecognized.
// ---------------------------------------------------------------------------
function selectRoutingPolicy({ riskClass, role, policy }) {
  const p = policy || DEFAULT_POLICY;
  const table = p.risk_class_routing || {};
  const row = table[riskClass] || table.unknown;
  if (!row) return { policyName: 'highest_verified_quality', requiresHumanApproval: false, note: 'no dispatch-policy.json risk_class_routing table available — fail-safe default' };
  const policyName = role === 'producer' ? row.producer_policy : row.reviewer_policy;
  return { policyName, requiresHumanApproval: !!row.requires_human_approval, note: row.note || null };
}

// ---------------------------------------------------------------------------
// REAL: section 1 + 4 + 5 — composes the two functions above with the real,
// unmodified route() from router/select-adapter.js. Stops short of spawning
// anything (see section 14) — this is a complete PLAN, not an execution.
// ---------------------------------------------------------------------------
function buildDispatchPlan(opts = {}) {
  const root = opts.root || harnessRoot();
  const dispatchPolicy = loadDispatchPolicy(root);
  const role = opts.role;
  if (role !== 'producer' && role !== 'reviewer') {
    return { ok: false, error: `role must be 'producer' or 'reviewer', got ${JSON.stringify(role)}` };
  }
  const panelRole = opts.panelRole || null;
  if (panelRole && role !== 'reviewer') {
    return { ok: false, error: `panel_role is only legal on role:'reviewer' dispatches, got role:${role} panel_role:${panelRole}` };
  }
  const requiredCapabilities = resolveRequiredCapabilities({
    taskType: opts.taskType, role, panelRole, policy: dispatchPolicy, requiredCapabilities: opts.requiredCapabilities
  });
  const riskClass = opts.riskClass || 'unknown';
  const { policyName, requiresHumanApproval, note } = selectRoutingPolicy({ riskClass, role, policy: dispatchPolicy });

  const routing = route({
    root, taskType: opts.taskType, policy: policyName,
    requiredCapabilities, excludeAdapter: opts.excludeAdapter
  });

  return {
    ok: routing.ok !== false,
    dispatch_plan: {
      schema_version: 1,
      role, panel_role: panelRole,
      task_type: opts.taskType || null,
      required_capabilities: requiredCapabilities,
      risk_class: riskClass,
      routing_policy: policyName,
      routing_policy_note: note,
      selected_adapter: routing.selected_adapter,
      eligible_adapters: routing.eligible_adapters,
      trust_level: routing.trust_level,
      requires_human_approval: requiresHumanApproval || !!routing.human_approval_needed,
      routing_note: 'requires_human_approval here is ADVISORY alongside scripts/check-approval-needed.js — never a replacement for it (see design doc section 5)',
      routing_evidence: routing.evidence || null
    },
    error: routing.ok === false ? routing.error : null
  };
}

// ---------------------------------------------------------------------------
// REAL: section 9 — pure verdict-agreement computation. Orthogonal to
// review-independence/core/evaluator.js#evaluateIndependence (which answers a
// different question: actor independence, not verdict agreement).
// ---------------------------------------------------------------------------
const NEGATIVE_VERDICTS = new Set(['REJECT', 'FAIL']);
function computePanelConsensus(verdicts) {
  const v = Array.isArray(verdicts) ? verdicts : [];
  if (v.length === 0) return { consensus: 'SPLIT', reason: 'no_verdicts_collected', dissenting: [] };
  const values = v.map(x => (x && x.verdict ? String(x.verdict).toUpperCase() : 'ERROR'));
  const negative = v.filter((x, i) => NEGATIVE_VERDICTS.has(values[i]));
  if (negative.length > 0) {
    return {
      consensus: 'REJECT',
      reason: `${negative.length}/${v.length} panelist(s) rejected`,
      dissenting: negative.map(x => x.adapter_id || x.dispatch_id || 'unknown')
    };
  }
  const allPass = values.every(x => x === 'PASS');
  if (allPass) return { consensus: 'PASS', reason: `${v.length}/${v.length} panelists agree: PASS`, dissenting: [] };
  // Mixed non-negative (e.g. some PASS, some WARN/ERROR) — never auto-resolved, matches
  // Outsourcerer's stated behavior: a split is a signal to return to the human.
  return {
    consensus: 'SPLIT',
    reason: `panel did not reach unanimous PASS: [${values.join(', ')}]`,
    dissenting: v.filter((x, i) => values[i] !== 'PASS').map(x => x.adapter_id || x.dispatch_id || 'unknown')
  };
}

// ---------------------------------------------------------------------------
// REAL: section 10 — honest two-column receipt. Never fabricates usage/cost;
// reads whatever the adapter's own result already carried (e.g.
// codex-adapter.js#normalizeResult's usage/usage_populated fields).
// ---------------------------------------------------------------------------
function buildReceipt({ adapterResult, adapterId, trustTierAtDispatch }) {
  const r = adapterResult || {};
  const usagePopulated = !!r.usage_populated;
  const tokens = usagePopulated && r.usage ? r.usage : null;
  const costUsd = typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null;
  const evidenceState = (usagePopulated || costUsd != null) ? 'verified' : 'unverified';
  return {
    evidence_state: evidenceState,
    tokens,
    usage_populated: usagePopulated,
    cost_usd: costUsd,
    trust_tier_at_dispatch: trustTierAtDispatch || null,
    note: evidenceState === 'verified'
      ? `real usage/cost data present from adapter '${adapterId}'`
      : `no usage/cost data available from adapter '${adapterId}' — reported honestly as unverified, never estimated`
  };
}

// ---------------------------------------------------------------------------
// REAL: section 1 — allowlist-gate validation of the full dispatch record shape,
// mirroring review-independence/core/actor-identity.js#validateStamp's pattern.
// ---------------------------------------------------------------------------
const ROLE_ALLOW = Object.freeze(['producer', 'reviewer']);
const PANEL_ROLE_ALLOW = Object.freeze(['primary', 'challenger', null]);
const LIFECYCLE_STATE_ALLOW = Object.freeze([
  'PENDING', 'DISPATCHED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_FALLBACK', 'TIMEOUT', 'CANCELLED', 'ERROR'
]);
const RISK_CLASS_ALLOW = Object.freeze(['low', 'med', 'high', 'critical', 'unknown']);

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

function validateDispatchRecord(record) {
  const r = record;
  if (!r || typeof r !== 'object') return { ok: false, reason: 'dispatch record must be an object' };
  if (!isNonEmptyString(r.dispatch_id)) return { ok: false, reason: 'dispatch_id must be a non-empty string' };
  if (!isNonEmptyString(r.parent_run_id)) return { ok: false, reason: 'parent_run_id must be a non-empty string' };
  if (!ROLE_ALLOW.includes(r.role)) return { ok: false, reason: `role must be one of ${ROLE_ALLOW.join('|')}` };
  if (!PANEL_ROLE_ALLOW.includes(r.panel_role !== undefined ? r.panel_role : null)) {
    return { ok: false, reason: `panel_role must be one of ${PANEL_ROLE_ALLOW.filter(Boolean).join('|')} or null` };
  }
  if (r.panel_role && r.role !== 'reviewer') return { ok: false, reason: 'panel_role is only legal on role:reviewer records' };
  if (!RISK_CLASS_ALLOW.includes(r.risk_class)) return { ok: false, reason: `risk_class must be one of ${RISK_CLASS_ALLOW.join('|')}` };
  if (!isNonEmptyString(r.adapter_id)) return { ok: false, reason: 'adapter_id must be a non-empty string' };
  if (!r.lifecycle || !LIFECYCLE_STATE_ALLOW.includes(r.lifecycle.state)) {
    return { ok: false, reason: `lifecycle.state must be one of ${LIFECYCLE_STATE_ALLOW.join('|')}` };
  }
  if (r.lifecycle.state === 'COMPLETED_WITH_FALLBACK' && !(r.fallback && r.fallback.attempted)) {
    return { ok: false, reason: 'lifecycle.state COMPLETED_WITH_FALLBACK requires fallback.attempted:true (never a cosmetic-only status)' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// REAL: section 6 — plain `git worktree add`/`remove`, no shell:true. Only ever
// exercised in this file's own self-test against a fresh temp repo; never
// touches the caller's real checkout unless explicitly invoked with repoPath.
// ---------------------------------------------------------------------------
function allocateWorktree({ repoPath, dispatchId, baseRef, parentDir }) {
  const dis = isDisabled();
  if (dis.disabled) return { ok: false, gate: 'DISABLED', reason: dis.reason };
  if (!repoPath) return { ok: false, error: 'repoPath required' };
  const safeId = String(dispatchId || crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, '_');
  const targetDir = path.join(parentDir || os.tmpdir(), `hk-worktree-${safeId}`);
  const branch = `dispatch/${safeId}`;
  try {
    execFileSync('git', ['-C', repoPath, 'worktree', 'add', targetDir, '-b', branch, baseRef || 'HEAD'], { encoding: 'utf8' });
    return { ok: true, worktree_path: targetDir, branch };
  } catch (e) {
    return { ok: false, error: 'git_worktree_add_failed', detail: String((e && e.message) || e).slice(0, 300) };
  }
}

function releaseWorktree({ repoPath, worktreePath, force }) {
  const dis = isDisabled();
  if (dis.disabled) return { ok: false, gate: 'DISABLED', reason: dis.reason };
  if (!repoPath || !worktreePath) return { ok: false, error: 'repoPath and worktreePath required' };
  const args = ['-C', repoPath, 'worktree', 'remove', worktreePath];
  if (force) args.push('--force');
  try {
    execFileSync('git', args, { encoding: 'utf8' });
    return { ok: true, removed: worktreePath };
  } catch (e) {
    // Native git refuses removal with unmerged/uncommitted work unless --force — surfaced as a
    // real, honest failure (matches Outsourcerer's stated `cleanup` behavior), never forced silently.
    return { ok: false, error: 'git_worktree_remove_refused', detail: String((e && e.message) || e).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// STUBS — see docs/AGENT_DISPATCH_MODEL_ROUTING.md section 14 for exactly why
// each of these cannot be honestly implemented in this lane.
// ---------------------------------------------------------------------------
function spawnDispatch(plan) {
  const dis = isDisabled();
  if (dis.disabled) return { ok: false, gate: 'DISABLED', reason: dis.reason };
  throw new Error('spawnDispatch: not yet implemented — needs adapter-specific live actuation ' +
    '(host Task/Agent tool call for claude-code; codex-adapter.js#reviewReadOnly/implementBounded ' +
    'wiring for codex-cli). See docs/AGENT_DISPATCH_MODEL_ROUTING.md section 14.');
}

function monitorDispatch(dispatchId) {
  const dis = isDisabled();
  if (dis.disabled) return { ok: false, gate: 'DISABLED', reason: dis.reason };
  throw new Error('monitorDispatch: not yet implemented — needs live PID/hook state to watch. ' +
    'See docs/AGENT_DISPATCH_MODEL_ROUTING.md section 3 and 14.');
}

function collectDispatch(dispatchId) {
  const dis = isDisabled();
  if (dis.disabled) return { ok: false, gate: 'DISABLED', reason: dis.reason };
  throw new Error('collectDispatch: not yet implemented — needs a real completed process/hook ' +
    'result to normalize. See docs/AGENT_DISPATCH_MODEL_ROUTING.md section 14.');
}

function cancelDispatch(dispatchId, reason) {
  const dis = isDisabled();
  if (dis.disabled) return { ok: false, gate: 'DISABLED', reason: dis.reason };
  throw new Error('cancelDispatch: not yet implemented — needs a real PID (taskkill /T /F on ' +
    'Windows) or a real host TaskStop call. See docs/AGENT_DISPATCH_MODEL_ROUTING.md section 3.');
}

// ---------------------------------------------------------------------------
// Self-test: pure functions only, plus a REAL git-worktree round trip against a
// throwaway temp repo (created and destroyed inside this test). No network, no
// pipeline wiring, no dependence on any real HarnessKit run.
// ---------------------------------------------------------------------------
function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. resolveRequiredCapabilities: producer gets exactly the task_type's base list (no floor added).
  {
    const caps = resolveRequiredCapabilities({ taskType: 'code-feature', role: 'producer' });
    push('producer_capabilities_equal_task_type_base', JSON.stringify(caps.sort()) === JSON.stringify(['implementation', 'planning', 'review', 'testing'].sort()), JSON.stringify(caps));
  }
  // 2. resolveRequiredCapabilities: reviewer floor adds 'review' even for a task_type that lacks it.
  {
    const caps = resolveRequiredCapabilities({ taskType: 'ideate', role: 'reviewer' });
    push('reviewer_floor_adds_review_capability', caps.includes('review') && caps.includes('planning'), JSON.stringify(caps));
  }
  // 3. resolveRequiredCapabilities: challenger panel_role additionally floors in 'security'.
  {
    const caps = resolveRequiredCapabilities({ taskType: 'ideate', role: 'reviewer', panelRole: 'challenger' });
    push('challenger_floor_adds_security_capability', caps.includes('security') && caps.includes('review'), JSON.stringify(caps));
  }
  // 4. selectRoutingPolicy: risk_class critical -> local_cli_only for producer + requires_human_approval.
  {
    const r = selectRoutingPolicy({ riskClass: 'critical', role: 'producer' });
    push('critical_risk_forces_local_cli_only_producer_policy', r.policyName === 'local_cli_only' && r.requiresHumanApproval === true, JSON.stringify(r));
  }
  // 5. selectRoutingPolicy: unrecognized risk_class fails safe to the 'unknown' row, never more permissive than low.
  {
    const r = selectRoutingPolicy({ riskClass: 'not-a-real-risk-class', role: 'producer' });
    push('unrecognized_risk_class_fails_safe_to_unknown_row', r.policyName === 'highest_verified_quality' && r.requiresHumanApproval === false, JSON.stringify(r));
  }
  // 6. selectRoutingPolicy: reviewer always gets independent_review regardless of risk_class.
  {
    const low = selectRoutingPolicy({ riskClass: 'low', role: 'reviewer' });
    const crit = selectRoutingPolicy({ riskClass: 'critical', role: 'reviewer' });
    push('reviewer_policy_always_independent_review', low.policyName === 'independent_review' && crit.policyName === 'independent_review', JSON.stringify({ low, crit }));
  }
  // 7. buildDispatchPlan: rejects an illegal role instead of silently defaulting.
  {
    const r = buildDispatchPlan({ role: 'not-a-role', taskType: 'code-feature' });
    push('illegal_role_rejected', r.ok === false && /role must be/.test(r.error), JSON.stringify(r));
  }
  // 8. buildDispatchPlan: rejects panel_role on a producer dispatch.
  {
    const r = buildDispatchPlan({ role: 'producer', panelRole: 'challenger', taskType: 'code-feature' });
    push('panel_role_rejected_on_producer', r.ok === false && /only legal on role/.test(r.error), JSON.stringify(r));
  }
  // 9. buildDispatchPlan: live-registry smoke test — a real producer plan for code-feature resolves
  //    against THIS REPO's own config/adapter-registry.json (root pinned to path.join(__dirname,
  //    '..'), never the ambient HARNESS_ROOT/default ~/.harnesskit — that default points at a real,
  //    separate, live install on this machine, confirmed to exist and to lack a config/ dir
  //    entirely, which would make this test pass vacuously with selected_adapter:null for the WRONG
  //    reason. Pinning root here is what makes this a real check of this worktree's registry, not an
  //    environment-dependent no-op — the same gap exists in router/select-adapter.js's own
  //    self-test #8/#9, which does not pin root either; not fixed here, out of scope).
  {
    const root = path.join(__dirname, '..');
    let plan;
    try { plan = buildDispatchPlan({ role: 'producer', taskType: 'code-feature', riskClass: 'low', root }); }
    catch (e) { plan = { ok: false, error: String(e) }; }
    push('live_registry_producer_plan_smoke',
      plan.ok === true && plan.dispatch_plan && plan.dispatch_plan.routing_policy === 'highest_verified_quality' && plan.dispatch_plan.selected_adapter === 'claude-code',
      JSON.stringify({ ok: plan.ok, selected: plan.dispatch_plan && plan.dispatch_plan.selected_adapter }));
  }
  // 10. buildDispatchPlan: critical risk_class on a live producer plan demands human approval and
  //     the tighter local_cli_only policy — proven against the real registry, not a fixture.
  //     HONEST NOTE: this assertion deliberately checks routing_policy/requires_human_approval only,
  //     NOT selected_adapter. router/select-adapter.js's own isProviderLike() heuristic
  //     (/raw .*api key/i) false-positives on BOTH claude-code's and codex-cli's authentication_mode
  //     strings (each contains "no raw API key" while DENYING raw-key usage), so local_cli_only
  //     currently excludes every real CLI adapter and selected_adapter is null here. This is a real,
  //     pre-existing bug in select-adapter.js this lane discovered but does not fix (out of scope —
  //     see docs/AGENT_DISPATCH_MODEL_ROUTING.md section 5's callout). Loosening this test to hide
  //     that would misrepresent what actually happens; it stays honest instead.
  {
    const root = path.join(__dirname, '..');
    const plan = buildDispatchPlan({ role: 'producer', taskType: 'code-feature', riskClass: 'critical', root });
    push('critical_risk_live_plan_requires_approval_and_tighter_policy',
      plan.ok === true && plan.dispatch_plan.routing_policy === 'local_cli_only' && plan.dispatch_plan.requires_human_approval === true,
      JSON.stringify(plan.dispatch_plan));
  }
  // 11. computePanelConsensus: unanimous PASS.
  {
    const r = computePanelConsensus([{ adapter_id: 'a', verdict: 'PASS' }, { adapter_id: 'b', verdict: 'PASS' }]);
    push('unanimous_pass_consensus', r.consensus === 'PASS', JSON.stringify(r));
  }
  // 12. computePanelConsensus: any REJECT -> consensus REJECT, dissenter named.
  {
    const r = computePanelConsensus([{ adapter_id: 'a', verdict: 'PASS' }, { adapter_id: 'b', verdict: 'REJECT' }]);
    push('any_reject_forces_consensus_reject', r.consensus === 'REJECT' && r.dissenting.includes('b'), JSON.stringify(r));
  }
  // 13. computePanelConsensus: mixed non-negative (PASS + WARN) -> SPLIT, never auto-resolved.
  {
    const r = computePanelConsensus([{ adapter_id: 'a', verdict: 'PASS' }, { adapter_id: 'b', verdict: 'WARN' }]);
    push('mixed_nonnegative_never_auto_resolved_to_pass', r.consensus === 'SPLIT', JSON.stringify(r));
  }
  // 14. computePanelConsensus: empty panel -> SPLIT with an explicit reason, never a fabricated PASS.
  {
    const r = computePanelConsensus([]);
    push('empty_panel_never_fabricates_pass', r.consensus === 'SPLIT' && r.reason === 'no_verdicts_collected', JSON.stringify(r));
  }
  // 15. buildReceipt: real usage data marks evidence_state verified, carries tokens through untouched.
  {
    const r = buildReceipt({ adapterResult: { usage_populated: true, usage: { input_tokens: 100, output_tokens: 20 } }, adapterId: 'codex-cli', trustTierAtDispatch: 'quarantined' });
    push('real_usage_marks_verified_and_preserves_tokens', r.evidence_state === 'verified' && r.tokens.input_tokens === 100, JSON.stringify(r));
  }
  // 16. buildReceipt: no usage data -> honestly unverified, never a fabricated estimate.
  {
    const r = buildReceipt({ adapterResult: {}, adapterId: 'claude-code', trustTierAtDispatch: 'trusted-local' });
    push('no_usage_data_honestly_unverified_never_estimated', r.evidence_state === 'unverified' && r.tokens === null && r.cost_usd === null, JSON.stringify(r));
  }
  // 17. validateDispatchRecord: a well-formed record validates.
  {
    const rec = { dispatch_id: 'd1', parent_run_id: 'run-1', role: 'reviewer', panel_role: 'challenger', risk_class: 'low', adapter_id: 'codex-cli', lifecycle: { state: 'COMPLETED' } };
    push('well_formed_record_validates', validateDispatchRecord(rec).ok === true, JSON.stringify(validateDispatchRecord(rec)));
  }
  // 18. validateDispatchRecord: panel_role illegal on a producer record.
  {
    const rec = { dispatch_id: 'd2', parent_run_id: 'run-1', role: 'producer', panel_role: 'primary', risk_class: 'low', adapter_id: 'claude-code', lifecycle: { state: 'COMPLETED' } };
    push('panel_role_on_producer_record_rejected', validateDispatchRecord(rec).ok === false, JSON.stringify(validateDispatchRecord(rec)));
  }
  // 19. validateDispatchRecord: COMPLETED_WITH_FALLBACK without fallback.attempted:true is rejected
  //     (never a cosmetic-only status per design doc section 7).
  {
    const rec = { dispatch_id: 'd3', parent_run_id: 'run-1', role: 'producer', risk_class: 'low', adapter_id: 'claude-code', lifecycle: { state: 'COMPLETED_WITH_FALLBACK' } };
    push('completed_with_fallback_requires_real_fallback_record', validateDispatchRecord(rec).ok === false, JSON.stringify(validateDispatchRecord(rec)));
    const recOk = Object.assign({}, rec, { fallback: { attempted: true, original_adapter_id: 'codex-cli', actual_adapter_id: 'claude-code' } });
    push('completed_with_fallback_accepted_with_real_fallback_record', validateDispatchRecord(recOk).ok === true, JSON.stringify(validateDispatchRecord(recOk)));
  }
  // 20. validateDispatchRecord: unknown lifecycle.state rejected (allowlist, not free text).
  {
    const rec = { dispatch_id: 'd4', parent_run_id: 'run-1', role: 'producer', risk_class: 'low', adapter_id: 'claude-code', lifecycle: { state: 'MADE_UP_STATE' } };
    push('unknown_lifecycle_state_rejected', validateDispatchRecord(rec).ok === false, JSON.stringify(validateDispatchRecord(rec)));
  }
  // 21. allocateWorktree + releaseWorktree: real end-to-end round trip against a throwaway temp repo.
  {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-dispatcher-selftest-repo-'));
    let alloc = null, release = null, threw = false;
    try {
      execFileSync('git', ['-C', tmpRepo, 'init', '-q']);
      execFileSync('git', ['-C', tmpRepo, 'config', 'user.email', 'selftest@example.invalid']);
      execFileSync('git', ['-C', tmpRepo, 'config', 'user.name', 'selftest']);
      fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'selftest fixture\n');
      execFileSync('git', ['-C', tmpRepo, 'add', '.']);
      execFileSync('git', ['-C', tmpRepo, 'commit', '-q', '-m', 'init']);
      alloc = allocateWorktree({ repoPath: tmpRepo, dispatchId: 'selftest-1' });
      release = alloc.ok ? releaseWorktree({ repoPath: tmpRepo, worktreePath: alloc.worktree_path }) : null;
    } catch (e) { threw = true; alloc = { error: String(e && e.message || e) }; }
    finally { try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* best-effort */ } }
    push('allocate_and_release_worktree_real_round_trip',
      !threw && alloc && alloc.ok === true && release && release.ok === true,
      JSON.stringify({ alloc, release }));
  }
  // 22. DISABLED kill switch short-circuits allocateWorktree before any real git call.
  {
    const before = process.env.HARNESSKIT_DISABLED;
    process.env.HARNESSKIT_DISABLED = '1';
    const r = allocateWorktree({ repoPath: os.tmpdir(), dispatchId: 'irrelevant' });
    if (before === undefined) delete process.env.HARNESSKIT_DISABLED; else process.env.HARNESSKIT_DISABLED = before;
    push('kill_switch_short_circuits_allocate_worktree', r.gate === 'DISABLED', JSON.stringify(r));
  }
  // 23. Stubs are honest — they throw with a pointer to the design doc, never a fabricated result.
  {
    let threwSpawn = false, threwMonitor = false, threwCollect = false, threwCancel = false;
    try { spawnDispatch({}); } catch (e) { threwSpawn = /not yet implemented/.test(e.message); }
    try { monitorDispatch('d1'); } catch (e) { threwMonitor = /not yet implemented/.test(e.message); }
    try { collectDispatch('d1'); } catch (e) { threwCollect = /not yet implemented/.test(e.message); }
    try { cancelDispatch('d1', 'test'); } catch (e) { threwCancel = /not yet implemented/.test(e.message); }
    push('all_four_stubs_throw_honest_not_implemented', threwSpawn && threwMonitor && threwCollect && threwCancel,
      JSON.stringify({ threwSpawn, threwMonitor, threwCollect, threwCancel }));
  }
  // 24. Stubs still honor the DISABLED kill switch BEFORE throwing (consistent short-circuit order).
  {
    const before = process.env.HARNESSKIT_DISABLED;
    process.env.HARNESSKIT_DISABLED = '1';
    let r;
    try { r = spawnDispatch({}); } finally {
      if (before === undefined) delete process.env.HARNESSKIT_DISABLED; else process.env.HARNESSKIT_DISABLED = before;
    }
    push('stub_honors_disabled_before_throwing', r && r.gate === 'DISABLED', JSON.stringify(r));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = {
  loadDispatchPolicy, resolveRequiredCapabilities, selectRoutingPolicy, buildDispatchPlan,
  computePanelConsensus, buildReceipt, validateDispatchRecord,
  allocateWorktree, releaseWorktree,
  spawnDispatch, monitorDispatch, collectDispatch, cancelDispatch,
  ROLE_ALLOW, PANEL_ROLE_ALLOW, LIFECYCLE_STATE_ALLOW, RISK_CLASS_ALLOW
};

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  console.log('dispatcher.js — design skeleton, library only. See docs/AGENT_DISPATCH_MODEL_ROUTING.md.');
  console.log('node scripts/dispatcher.js --self-test');
  process.exit(0);
}

if (require.main === module) main();
