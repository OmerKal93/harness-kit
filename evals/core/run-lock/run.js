#!/usr/bin/env node
// evals/core/run-lock/run.js — RUN-LOCK-1 concurrency-safety eval.
// Exercises scripts/session.js (resolveProtectedWriteRun, matchSessionGrant,
// recentlyActiveRuns), scripts/lease.js (acquire/conflict/stale), and
// scripts/harness-commit.js (precommitCheck) against synthetic harnesskit roots under
// .tmp/ with injected clocks — the real runs/ registry is never touched.
// Contract: prints {category,pass,score,total,passed,failed,...} envelope, exit 0/1.
// Honors kill switch. Zero network, zero writes outside .tmp/.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled } = require('../../../scripts/is-disabled.js');
const { parseArgs, writeJson, readJson } = require('../../../scripts/_lib.js');
const session = require('../../../scripts/session.js');
const lease = require('../../../scripts/lease.js');
const { precommitCheck } = require('../../../scripts/harness-commit.js');

const TMP = path.join(__dirname, '.tmp');
const NOW = '2026-06-13T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function freshRoot(name) {
  const root = path.join(TMP, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  return root;
}
function isoAgo(hours) { return new Date(NOW_MS - hours * 3600000).toISOString(); }

// Make a run dir; ageHours sets last_state_change; toolLogAgeMin sets tool-log mtime
// (omit => no tool-log file). approvals optional.
function mkRun(root, id, { state = 'EXECUTION', ageHours = 0.1, owner = null, toolLogAgeMin = 1, approvals = null, base_head = null } = {}) {
  const rd = path.join(root, 'runs', id);
  fs.mkdirSync(rd, { recursive: true });
  writeJson(path.join(rd, 'run.json'), {
    schema_version: 1, run_id: id, created: isoAgo(ageHours), last_state_change: isoAgo(ageHours),
    state, owner_session: owner, base_head, approvals: approvals || []
  });
  if (toolLogAgeMin != null) {
    const tl = path.join(rd, 'tool-log.ndjson');
    fs.writeFileSync(tl, '{"ts":"' + isoAgo(toolLogAgeMin / 60) + '"}\n');
    const t = (NOW_MS - toolLogAgeMin * 60000) / 1000;
    fs.utimesSync(tl, t, t);
  }
  return rd;
}
function ptr(root, id) { writeJson(path.join(root, 'runs', '.current-run'), { run_id: id, ts: NOW }); }
function ownerApproval(extra) {
  return Object.assign({ action: 'harness_self', scope: 'x', granted_by: 'owner', granted_ts: isoAgo(0.1), expires_ts: new Date(NOW_MS + 3600000).toISOString(), consumed: false }, extra || {});
}

const TESTS = [];
const T = (id, fn) => TESTS.push({ id, fn });

// 1. two readers parallel: no runs => not ambiguous, no active context.
T('two-readers-no-ambiguity', () => {
  const root = freshRoot('t1');
  const amb = session.multipleActiveRuns({ root, now: NOW });
  const res = session.resolveProtectedWriteRun({ root, now: NOW, env: {} });
  return (!amb && res.ok === false && res.ambiguous === false) || `amb=${amb} res=${JSON.stringify(res)}`;
});

// 2. writer + reader: writer bound via env resolves ok.
T('writer-bound-ok', () => {
  const root = freshRoot('t2');
  mkRun(root, 'runW', { owner: 'S1' });
  const res = session.resolveProtectedWriteRun({ root, now: NOW, env: { HARNESSKIT_RUN_ID: 'runW', HARNESSKIT_SESSION_ID: 'S1' } });
  return (res.ok && res.bound && res.run_id === 'runW') || JSON.stringify(res);
});

// 3. two writers, different scopes: both acquire.
T('two-writers-different-scopes', () => {
  const root = freshRoot('t3');
  const a = lease.acquireLease({ root, now: NOW, scopes: ['config/**'], owner_session: 'S1', run_id: 'r1' });
  const b = lease.acquireLease({ root, now: NOW, scopes: ['router/**'], owner_session: 'S2', run_id: 'r2' });
  return (a.ok && b.ok) || `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`;
});

// 4. two writers, same protected scope: second blocks.
T('two-writers-same-scope-blocks', () => {
  const root = freshRoot('t4');
  const a = lease.acquireLease({ root, now: NOW, scopes: ['config/**'], owner_session: 'S1', run_id: 'r1' });
  const b = lease.acquireLease({ root, now: NOW, scopes: ['config/**'], owner_session: 'S2', run_id: 'r2' });
  return (a.ok && !b.ok && b.conflict && b.conflict.owner_session === 'S1') || `a=${a.ok} b=${JSON.stringify(b)}`;
});

// 5. grant cannot be consumed by another session.
T('grant-session-bound', () => {
  const approvals = [ownerApproval({ owner_session: 'S1', run_id: 'r1' })];
  const other = session.matchSessionGrant(approvals, 'harness_self', [], { sessionId: 'S2', runId: 'r1', now: NOW });
  const owner = session.matchSessionGrant(approvals, 'harness_self', [], { sessionId: 'S1', runId: 'r1', now: NOW });
  return (other.length === 0 && owner.length === 1) || `other=${other.length} owner=${owner.length}`;
});

// 6. .current-run hijack fails when env-bound run exists.
T('pointer-hijack-defeated', () => {
  const root = freshRoot('t6');
  mkRun(root, 'runMine', { owner: 'S1' });
  mkRun(root, 'runAttacker', { owner: 'SX' });
  ptr(root, 'runAttacker'); // attacker repoints the global pointer
  const res = session.resolveProtectedWriteRun({ root, now: NOW, env: { HARNESSKIT_RUN_ID: 'runMine', HARNESSKIT_SESSION_ID: 'S1' } });
  return (res.ok && res.bound && res.run_id === 'runMine') || JSON.stringify(res);
});

// 7. stale lease expires and is reclaimable by another session.
T('stale-lease-expires', () => {
  const root = freshRoot('t7');
  // write an already-expired lock directly
  writeJson(path.join(lease.locksDir(root), 'old.json'), {
    lock_id: 'old', kind: 'path', scopes: ['config/**'], owner_session: 'S1', run_id: 'r1',
    acquired_ts: isoAgo(48), lease_until: isoAgo(24)
  });
  const removed = lease.cleanupStale({ root, now: NOW });
  const b = lease.acquireLease({ root, now: NOW, scopes: ['config/**'], owner_session: 'S2', run_id: 'r2' });
  return (removed.includes('old') && b.ok) || `removed=${JSON.stringify(removed)} b=${b.ok}`;
});

// 8. HEAD moved before commit => wrapper stops; stable HEAD => ok.
T('precommit-head-moved-stops', () => {
  const moved = precommitCheck({ base_head: 'aaaaaaa', current_head: 'bbbbbbb' });
  const stable = precommitCheck({ base_head: 'aaaaaaa', current_head: 'aaaaaaa' });
  const noBase = precommitCheck({ base_head: null, current_head: 'aaaaaaa' });
  return (!moved.ok && stable.ok && !noBase.ok) || `moved=${moved.ok} stable=${stable.ok} noBase=${noBase.ok}`;
});

// 9. legacy single-session grant (no owner/run) still matches => back-compat.
T('legacy-grant-backcompat', () => {
  const approvals = [ownerApproval()]; // no owner_session, no run_id
  const m = session.matchSessionGrant(approvals, 'harness_self', [], { sessionId: null, runId: null, now: NOW });
  const m2 = session.matchSessionGrant(approvals, 'harness_self', [], { sessionId: 'Sanything', runId: 'rany', now: NOW });
  return (m.length === 1 && m2.length === 1) || `m=${m.length} m2=${m2.length}`;
});

// 10. CAP-0 scenario: unrelated concurrent writer does NOT block a session-bound write
//     when scopes don't overlap — even though >1 run is active.
T('cap0-unrelated-writer-nonblocking', () => {
  const root = freshRoot('t10');
  mkRun(root, 'runOther', { owner: 'SO' });   // unrelated active writer
  mkRun(root, 'runCap', { owner: 'SCAP' });    // CAP-0 session run
  // ambiguity exists (2 active runs) but CAP-0 is env-bound => authoritative
  const res = session.resolveProtectedWriteRun({ root, now: NOW, env: { HARNESSKIT_RUN_ID: 'runCap', HARNESSKIT_SESSION_ID: 'SCAP' } });
  lease.acquireLease({ root, now: NOW, scopes: ['apps/**'], owner_session: 'SO', run_id: 'runOther' });
  const capLease = lease.acquireLease({ root, now: NOW, scopes: ['config/**'], owner_session: 'SCAP', run_id: 'runCap' });
  const amb = session.multipleActiveRuns({ root, now: NOW });
  return (amb && res.ok && res.bound && capLease.ok) || `amb=${amb} res=${JSON.stringify(res)} cap=${capLease.ok}`;
});

// 11. ambiguous multi-session writer WITHOUT binding fails closed (the core fix).
T('ambiguous-without-binding-fails-closed', () => {
  const root = freshRoot('t11');
  mkRun(root, 'runA', { owner: 'SA' });
  mkRun(root, 'runB', { owner: 'SB' });
  ptr(root, 'runA');
  const res = session.resolveProtectedWriteRun({ root, now: NOW, env: {} }); // no HARNESSKIT_RUN_ID
  return (res.ok === false && res.ambiguous === true) || JSON.stringify(res);
});

// 12. scopesOverlap correctness.
T('scope-overlap-logic', () => {
  const ok = lease.scopesOverlap(['config/**'], ['config/**']) === true
    && lease.scopesOverlap(['config/**'], ['router/**']) === false
    && lease.scopesOverlap(['config/a/**'], ['config/**']) === true
    && lease.scopesOverlap(['config/x.json'], ['config/**']) === true;
  return ok || 'scope overlap mismatch';
});

function main() {
  const ks = isDisabled();
  if (ks.disabled) process.exit(0);
  parseArgs(process.argv.slice(2)); // --fixtures-dir accepted/ignored (logic-driven eval)

  const results = TESTS.map(t => {
    let pass = false, reason = null;
    try { const r = t.fn(); if (r === true) pass = true; else reason = String(r); }
    catch (e) { reason = 'THREW ' + String(e && e.message).slice(0, 160); }
    return { id: t.id, pass, fail_reason: pass ? null : reason };
  });
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }

  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failures = results.filter(r => !r.pass);
  const cfg = readJson(path.join(__dirname, '..', '..', 'config.json'), { categories: {} });
  const minRatio = (cfg.categories['run-lock'] && typeof cfg.categories['run-lock'].min_pass_ratio === 'number')
    ? cfg.categories['run-lock'].min_pass_ratio : 1.0;
  const score = total > 0 ? passed / total : 0;
  const out = {
    category: 'run-lock',
    pass: total > 0 && score >= minRatio,
    score, total, passed, failed: failures.length,
    min_pass_ratio: minRatio,
    failures: failures.slice(0, 30)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module) main();
