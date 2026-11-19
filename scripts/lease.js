#!/usr/bin/env node
// lease.js — RUN-LOCK-1: minimal path/commit leases for concurrent writer safety.
// A writer acquires a lease over its write_scopes (path globs). A second writer
// requesting an OVERLAPPING scope while the lease is live is refused; non-overlapping
// scopes proceed in parallel. A singleton commit lease (kind="commit") serializes
// git commits. Leases carry lease_until and are reclaimed once stale.
//
// State: runs/locks/<lock_id>.json. Pure/injectable ({root, now}) for deterministic
// evals. Zero network, zero deps beyond _lib + node fs. Advisory by construction:
// nothing here writes outside runs/locks/; callers (harness-commit.js, future hook
// wiring) decide what to do with a conflict.
'use strict';

const fs = require('fs');
const path = require('path');
const { harnessRoot, readJson, writeJson, nowIso } = require('./_lib.js');

const DEFAULT_TTL_HOURS = 24;

function getRoot(opts) { return (opts && opts.root) || harnessRoot(); }
function getNowMs(opts) {
  const n = opts && opts.now !== undefined ? new Date(opts.now).getTime() : Date.now();
  return Number.isFinite(n) ? n : Date.now();
}
function locksDir(root) { return path.join(root, 'runs', 'locks'); }

// Scope prefix = the literal path before the first wildcard. Two scopes OVERLAP iff
// one prefix is a path-prefix of the other (covers equality, nesting, and dir cover).
// Deterministic, no regex backtracking. "config/**" vs "router/**" -> no overlap;
// "config/**" vs "config/x.json" -> overlap; "config/a/**" vs "config/**" -> overlap.
function scopePrefix(glob) {
  const norm = String(glob || '').replace(/\\/g, '/');
  const star = norm.search(/[*?]/);
  let pre = star === -1 ? norm : norm.slice(0, star);
  // trim back to last path segment boundary so "config" can't shadow "config-x"
  const slash = pre.lastIndexOf('/');
  if (star !== -1 && slash !== -1) pre = pre.slice(0, slash + 1);
  return pre.toLowerCase();
}
function prefixesOverlap(a, b) {
  if (a === b) return true;
  if (a === '' || b === '') return true; // a bare "**" covers everything
  return a.startsWith(b) || b.startsWith(a);
}
function scopesOverlap(scopesA, scopesB) {
  for (const a of scopesA || []) {
    for (const b of scopesB || []) {
      if (prefixesOverlap(scopePrefix(a), scopePrefix(b))) return true;
    }
  }
  return false;
}

function listLeases(opts) {
  const dir = locksDir(getRoot(opts));
  const out = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const data = readJson(path.join(dir, f), null);
      if (data && data.lock_id) out.push(data);
    }
  } catch { /* fail closed: empty */ }
  return out;
}

// Remove leases whose lease_until is at or before now. Returns removed lock_ids.
function cleanupStale(opts) {
  const dir = locksDir(getRoot(opts));
  const nowMs = getNowMs(opts);
  const removed = [];
  try {
    if (!fs.existsSync(dir)) return removed;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(dir, f);
      const data = readJson(p, null);
      const until = data && Date.parse(data.lease_until || '');
      if (!Number.isFinite(until) || until <= nowMs) {
        try { fs.unlinkSync(p); removed.push((data && data.lock_id) || f); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return removed;
}

// First live lease (after stale cleanup) that conflicts with `scopes` and is owned by
// a DIFFERENT session, or null. kind "commit" conflicts with any other live commit lease.
function findConflict(opts) {
  cleanupStale(opts);
  const kind = (opts && opts.kind) || 'path';
  const owner = opts && opts.owner_session != null ? String(opts.owner_session) : null;
  for (const lease of listLeases(opts)) {
    if ((lease.kind || 'path') !== kind) continue;
    if (owner != null && String(lease.owner_session) === owner) continue; // own lease never conflicts
    if (kind === 'commit') return lease;
    if (scopesOverlap(opts.scopes, lease.scopes)) return lease;
  }
  return null;
}

// acquireLease({root,now,scopes,owner_session,run_id,kind?,ttlHours?,lock_id?})
//   -> { ok:true, lock } | { ok:false, conflict }
function acquireLease(opts) {
  const root = getRoot(opts);
  const nowMs = getNowMs(opts);
  const kind = opts.kind || 'path';
  const conflict = findConflict(opts);
  if (conflict) return { ok: false, conflict };
  const ttlHours = Number.isFinite(opts.ttlHours) && opts.ttlHours > 0 ? opts.ttlHours : DEFAULT_TTL_HOURS;
  const lockId = opts.lock_id || `${kind}-${opts.owner_session || 'anon'}-${nowMs}`;
  const lock = {
    lock_id: lockId,
    kind,
    scopes: kind === 'commit' ? ['<repo-commit>'] : (opts.scopes || []),
    owner_session: opts.owner_session != null ? String(opts.owner_session) : null,
    run_id: opts.run_id != null ? String(opts.run_id) : null,
    acquired_ts: new Date(nowMs).toISOString(),
    lease_until: new Date(nowMs + ttlHours * 3600000).toISOString()
  };
  writeJson(path.join(locksDir(root), `${lockId}.json`), lock);
  return { ok: true, lock };
}

function releaseLease(opts) {
  const p = path.join(locksDir(getRoot(opts)), `${opts.lock_id}.json`);
  try { if (fs.existsSync(p)) { fs.unlinkSync(p); return true; } } catch { /* ignore */ }
  return false;
}

module.exports = {
  scopePrefix, prefixesOverlap, scopesOverlap,
  listLeases, cleanupStale, findConflict, acquireLease, releaseLease, locksDir
};

if (require.main === module) {
  const { parseArgs } = require('./_lib.js');
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === 'list') console.log(JSON.stringify(listLeases({}), null, 2));
  else if (cmd === 'cleanup') console.log(JSON.stringify({ removed: cleanupStale({}) }, null, 2));
  else console.log('usage: node scripts/lease.js [list|cleanup]');
}
