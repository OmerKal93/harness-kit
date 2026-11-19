#!/usr/bin/env node
// grant-approval.js — Harness v1 G2: the ONLY sanctioned way to record an owner-typed
// approval token. Replaces hand-appending to run.json approvals[] (deprecated).
//
//   node scripts/grant-approval.js --action <trigger> --scope "<reason>" \
//        [--files <glob>] [--expires-hours H=24, max 72]
//
// Behavior (all fail-closed, nothing written on any refusal, always prints JSON):
//   - kill switch on            → exit 1 (a silent no-op grant would mislead)
//   - no pointer-resolved run   → exit 1 (never guesses a target run)
//   - unknown --action          → exit 1 (vocabulary read LIVE from project-profile
//     sensitive_paths triggers — no hardcoded list; approval-registry vocabulary is
//     an advisory cross-check only, never blocks)
//   - --expires-hours invalid / <= 0 / > 72 → exit 1
// Stamps granted_by:"owner", granted_via, granted_ts, expires_ts (default now+24h),
// optional files glob; appends a decision-log grant audit entry. Single-use only in
// v1 — no `uses` field (multi-use = deferred future decision).
// RUN-LOCK-1: target run prefers HARNESSKIT_RUN_ID (session-bound) over the global
// .current-run pointer; stamps owner_session (HARNESSKIT_SESSION_ID) + run_id so the
// guard/ledger can bind the grant to the owning session (no cross-session use).
// --root / --now exist for eval fixtures only (determinism, synthetic roots).
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const {
  parseArgs, readJson, writeJson, harnessRoot, resolveCurrentRun, runLifecyclePolicy
} = require('./_lib.js');

const EXPIRES_HOURS_DEFAULT = 24;
const EXPIRES_HOURS_MAX = 72;

function fail(msg, extra) {
  console.log(JSON.stringify({ ok: false, error: msg, ...(extra || {}) }, null, 2));
  process.exit(1);
}

// Live trigger vocabulary: union of sensitive_paths[].trigger across ALL project
// profiles under <root>/config/project-profiles/. No hardcoded list — when G3 adds
// triggers, this script honors them automatically.
function liveTriggerVocabulary(root) {
  const vocab = new Set();
  try {
    const dir = path.join(root, 'config', 'project-profiles');
    if (!fs.existsSync(dir)) return vocab;
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
      const data = readJson(path.join(dir, f), null);
      for (const sp of (data && data.sensitive_paths) || []) {
        if (sp && sp.trigger) vocab.add(String(sp.trigger));
      }
    }
  } catch { /* empty vocab → every action refused (fail closed) */ }
  return vocab;
}

// Advisory only — substring presence in approval-registry.json. Never blocks.
function registryAdvisory(root, action) {
  try {
    const reg = readJson(path.join(root, 'config', 'approval-registry.json'), null);
    if (!reg) return 'registry not found (advisory only)';
    return JSON.stringify(reg).toLowerCase().includes(action.toLowerCase())
      ? 'action seen in approval-registry history'
      : 'action NOT in approval-registry history (advisory only, not blocking)';
  } catch { return 'registry unreadable (advisory only)'; }
}

// RUN-LOCK-1: resolve the grant's target run. Prefer an explicit HARNESSKIT_RUN_ID binding
// (validated non-terminal + within TTL) over the global pointer — so a grant lands in
// THIS session's run, not whatever the shared pointer currently names. Falls back to
// resolveCurrentRun() for legacy single-session use. Never guesses beyond these two.
function resolveTargetRun(root, nowMs) {
  const envRid = process.env.HARNESSKIT_RUN_ID;
  if (envRid && typeof envRid === 'string' && envRid.trim()) {
    const rid = envRid.trim();
    const rj = readJson(path.join(root, 'runs', rid, 'run.json'), null);
    if (rj && typeof rj.state === 'string') {
      const policy = runLifecyclePolicy(root);
      const ts = Date.parse(rj.last_state_change || rj.created || '');
      const active = !policy.inactive_states.includes(rj.state) && Number.isFinite(ts) && (nowMs - ts) / 3600000 <= policy.ttl_hours;
      if (active) return { run_id: rid, run: rj, bound: true };
    }
  }
  const cur = resolveCurrentRun({ root, now: nowMs });
  return cur ? { run_id: cur.run_id, run: cur.run, bound: false } : null;
}

function main() {
  const dis = isDisabled();
  if (dis.disabled) fail('harnesskit disabled (kill switch) — grant refused, nothing written', { disabled: true });

  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? String(args.root) : harnessRoot();
  const nowMs = args.now ? new Date(String(args.now)).getTime() : Date.now();
  if (!Number.isFinite(nowMs)) fail('--now is not a valid timestamp');

  const action = typeof args.action === 'string' ? args.action.trim() : '';
  const scope = typeof args.scope === 'string' ? args.scope.trim() : '';
  if (!action) fail('--action <trigger> is required');
  if (!scope) fail('--scope "<reason>" is required');

  let hours = EXPIRES_HOURS_DEFAULT;
  if (args['expires-hours'] !== undefined) {
    hours = Number(args['expires-hours']);
    if (!Number.isFinite(hours) || hours <= 0) fail('--expires-hours must be a positive number');
    if (hours > EXPIRES_HOURS_MAX) fail(`--expires-hours capped at ${EXPIRES_HOURS_MAX}`);
  }

  const vocab = liveTriggerVocabulary(root);
  if (!vocab.has(action)) {
    fail(`unknown --action "${action}" — not a sensitive-path trigger in any project profile`, {
      known_actions: Array.from(vocab).sort()
    });
  }

  const active = resolveTargetRun(root, nowMs);
  if (!active) fail('no active run (HARNESSKIT_RUN_ID or pointer) — start one first: /harness-run <describe>; grants never guess a target run');

  const rjPath = path.join(root, 'runs', active.run_id, 'run.json');
  const rj = readJson(rjPath, null);
  if (!rj) fail(`run.json unreadable for ${active.run_id}`);

  // RUN-LOCK-1: session binding — owner_session from env or the run's recorded owner.
  const ownerSession = process.env.HARNESSKIT_SESSION_ID || rj.owner_session || null;

  const grantedTs = new Date(nowMs).toISOString();
  const approval = {
    action,
    scope,
    granted_by: 'owner',
    granted_via: 'owner typed token; recorded by grant-approval.js',
    granted_ts: grantedTs,
    expires_ts: new Date(nowMs + hours * 3600000).toISOString(),
    run_id: active.run_id,        // RUN-LOCK-1: bind grant to its run
    owner_session: ownerSession,  // RUN-LOCK-1: bind grant to its session (null = legacy/unbound)
    consumed: false
  };
  if (args.files) approval.files = String(args.files);

  if (!Array.isArray(rj.approvals)) rj.approvals = [];
  rj.approvals.push(approval);
  writeJson(rjPath, rj);

  // Grant audit — decision-log entry (no state transition). Swallowed: the grant
  // itself already succeeded; a log failure must not orphan it.
  try {
    const { append } = require('./update-run-ledger.js');
    append(active.run_id, 'decision', {
      event: 'approval_granted', action, scope,
      files: approval.files || null, expires_ts: approval.expires_ts,
      run_id: active.run_id, owner_session: ownerSession, via: 'grant-approval.js'
    }, { root });
  } catch { /* audit best-effort */ }

  console.log(JSON.stringify({
    ok: true, run_id: active.run_id, bound: active.bound, owner_session: ownerSession, approval,
    vocabulary_source: 'project-profile sensitive_paths triggers (live)',
    registry_advisory: registryAdvisory(root, action)
  }, null, 2));
}

main();
