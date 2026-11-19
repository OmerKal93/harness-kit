#!/usr/bin/env node
// session.js — RUN-LOCK-1: session-bound run resolution for protected writes.
// Replaces "the global runs/.current-run pointer IS authority" with explicit
// per-session run binding via env HARNESSKIT_SESSION_ID + HARNESSKIT_RUN_ID.
//
// Pure/injectable: every function takes {root, now, env} so evals run against
// synthetic roots with deterministic clocks. Zero network, zero deps beyond _lib.
// The hooks (pre_tool_use_guard, post_tool_use_ledger) import resolveProtectedWriteRun
// and matchSessionGrant from here so _lib.js stays UNCHANGED — minimal protected edits.
//
// Authority order for a PROTECTED write:
//   1. HARNESSKIT_RUN_ID set + that run valid (non-terminal, within TTL) -> BOUND (authoritative).
//      The global pointer is IGNORED in this path (defeats .current-run hijack).
//   2. No binding, but >1 recently-active run -> AMBIGUOUS -> caller fails closed.
//   3. No binding, single active context -> legacy resolveCurrentRun() (back-compat).
'use strict';

const fs = require('fs');
const path = require('path');
const {
  harnessRoot, readJson, nowIso, writeJson,
  resolveCurrentRun, runLifecyclePolicy, matchingApprovalIndexes
} = require('./_lib.js');

function getEnv(opts) { return (opts && opts.env) || process.env; }
function getRoot(opts) { return (opts && opts.root) || harnessRoot(); }
function getNowMs(opts) {
  const n = opts && opts.now !== undefined ? new Date(opts.now).getTime() : Date.now();
  return Number.isFinite(n) ? n : Date.now();
}

function sessionId(opts) {
  const env = getEnv(opts);
  const v = env.HARNESSKIT_SESSION_ID;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function boundRunId(opts) {
  const env = getEnv(opts);
  const v = env.HARNESSKIT_RUN_ID;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Is a run.json non-terminal AND within TTL at `now`? Mirrors resolveCurrentRun's
// validity test (shares runLifecyclePolicy). Returns false on anything unreadable.
function runIsActive(rj, policy, nowMs) {
  if (!rj || typeof rj.state !== 'string' || !rj.state) return false;
  if (policy.inactive_states.includes(rj.state)) return false;
  const ts = Date.parse(rj.last_state_change || rj.created || '');
  if (!Number.isFinite(ts)) return false;
  return (nowMs - ts) / 3600000 <= policy.ttl_hours;
}

// Runs with a non-terminal state, within TTL, whose tool-log.ndjson was touched
// within windowMin minutes => "recently active". Catches LEGACY concurrent sessions
// that predate the session registry (they have no runs/sessions/* record but DO
// have a fresh tool-log). Never throws.
function recentlyActiveRuns(opts) {
  const root = getRoot(opts);
  const nowMs = getNowMs(opts);
  const windowMin = (opts && Number.isFinite(opts.windowMin)) ? opts.windowMin : 30;
  const out = [];
  try {
    const runsDir = path.join(root, 'runs');
    if (!fs.existsSync(runsDir)) return out;
    const policy = runLifecyclePolicy(root);
    for (const name of fs.readdirSync(runsDir)) {
      const rd = path.join(runsDir, name);
      let st;
      try { st = fs.statSync(rd); } catch { continue; }
      if (!st.isDirectory()) continue;
      const rj = readJson(path.join(rd, 'run.json'), null);
      if (!runIsActive(rj, policy, nowMs)) continue;
      let active = false;
      try {
        const tl = fs.statSync(path.join(rd, 'tool-log.ndjson'));
        active = (nowMs - tl.mtimeMs) / 60000 <= windowMin;
      } catch { active = false; }
      // A run that just started (no tool-log yet) but is non-terminal still counts.
      if (!active) {
        const created = Date.parse(rj.created || '');
        if (Number.isFinite(created) && (nowMs - created) / 60000 <= windowMin) active = true;
      }
      if (active) out.push(name);
    }
  } catch { /* fail closed: empty (caller treats as non-ambiguous, then legacy guard applies) */ }
  return out;
}

function multipleActiveRuns(opts) {
  return recentlyActiveRuns(opts).length >= 2;
}

// resolveProtectedWriteRun — THE protected-write authority resolver.
// Returns { ok, run_id?, run?, bound, ambiguous, legacy, reason }.
// ok:false => caller MUST block (fail closed).
function resolveProtectedWriteRun(opts) {
  const root = getRoot(opts);
  const nowMs = getNowMs(opts);
  const policy = runLifecyclePolicy(root);
  const rid = boundRunId(opts);

  if (rid) {
    // Explicit binding is authoritative — pointer ignored entirely.
    const rj = readJson(path.join(root, 'runs', rid, 'run.json'), null);
    if (runIsActive(rj, policy, nowMs)) {
      return { ok: true, run_id: rid, run: rj, bound: true, ambiguous: false, legacy: false, reason: 'env-bound run' };
    }
    return { ok: false, bound: true, ambiguous: false, legacy: false, reason: `HARNESSKIT_RUN_ID=${rid} set but run is missing/terminal/expired` };
  }

  // No explicit binding. If >1 session is concurrently active, refuse — the global
  // pointer cannot disambiguate which session owns this write.
  if (multipleActiveRuns(opts)) {
    return { ok: false, bound: false, ambiguous: true, legacy: false, reason: 'ambiguous multi-session writer context; set HARNESSKIT_RUN_ID to bind this session' };
  }

  // Single active context -> legacy pointer resolution (back-compat).
  const cur = resolveCurrentRun({ root, now: nowMs });
  if (cur) return { ok: true, run_id: cur.run_id, run: cur.run, bound: false, ambiguous: false, legacy: true, reason: 'legacy single-session pointer' };
  return { ok: false, bound: false, ambiguous: false, legacy: true, reason: 'no active run' };
}

// matchSessionGrant — wraps _lib.matchingApprovalIndexes then enforces session/run
// binding. Returns the surviving approval indexes.
//   - legacy grant (no owner_session AND no run_id) -> allowed (back-compat).
//   - bound grant -> run_id and owner_session must match the resolving context;
//     if the grant is bound but the context lacks that id -> fail closed (drop it).
// opts: { writtenPath?, now?, sessionId?, runId? }
function matchSessionGrant(approvals, trigger, requiresOwner, opts) {
  const sid = opts && opts.sessionId != null ? String(opts.sessionId) : null;
  const rid = opts && opts.runId != null ? String(opts.runId) : null;
  const base = matchingApprovalIndexes(approvals || [], trigger, requiresOwner, {
    writtenPath: opts && opts.writtenPath, now: opts && opts.now
  });
  return base.filter(i => {
    const a = approvals[i] || {};
    const hasOwner = a.owner_session != null;
    const hasRun = a.run_id != null;
    if (!hasOwner && !hasRun) return true; // legacy grant
    if (hasRun) { if (rid == null || String(a.run_id) !== rid) return false; }
    if (hasOwner) { if (sid == null || String(a.owner_session) !== sid) return false; }
    return true;
  });
}

function matchSessionApproval(approvals, trigger, requiresOwner, opts) {
  return matchSessionGrant(approvals, trigger, requiresOwner, opts).length > 0;
}

// --- session registry (optional bookkeeping; not required for guard authority) ---
function sessionRecordPath(root, sid) {
  return path.join(root, 'runs', 'sessions', `${sid}.json`);
}
function readSessionRecord(opts, sid) {
  return readJson(sessionRecordPath(getRoot(opts), sid), null);
}
function writeSessionRecord(opts, rec) {
  const root = getRoot(opts);
  const sid = rec.session_id;
  if (!sid) throw new Error('writeSessionRecord: session_id required');
  const p = sessionRecordPath(root, sid);
  const prev = readJson(p, null) || {};
  const merged = {
    session_id: sid,
    started_ts: prev.started_ts || rec.started_ts || nowIso(),
    last_seen_ts: rec.last_seen_ts || nowIso(),
    role: rec.role || prev.role || 'reader',
    owned_run_id: rec.owned_run_id !== undefined ? rec.owned_run_id : (prev.owned_run_id || null),
    lease_ids: rec.lease_ids || prev.lease_ids || []
  };
  writeJson(p, merged);
  return merged;
}

module.exports = {
  sessionId, boundRunId, runIsActive,
  recentlyActiveRuns, multipleActiveRuns,
  resolveProtectedWriteRun,
  matchSessionGrant, matchSessionApproval,
  readSessionRecord, writeSessionRecord, sessionRecordPath
};

// CLI: `node scripts/session.js resolve` prints the protected-write resolution for
// the current env (debug aid). Read-only.
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === 'resolve') {
    console.log(JSON.stringify(resolveProtectedWriteRun({}), null, 2));
  } else if (arg === 'active') {
    console.log(JSON.stringify({ recently_active: recentlyActiveRuns({}), ambiguous: multipleActiveRuns({}) }, null, 2));
  } else {
    console.log(JSON.stringify({
      session_id: sessionId({}), bound_run_id: boundRunId({}),
      usage: 'node scripts/session.js [resolve|active]'
    }, null, 2));
  }
}
