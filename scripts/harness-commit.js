#!/usr/bin/env node
// harness-commit.js — RUN-LOCK-1: collision-safe local commit wrapper.
// Serializes commits across concurrent sessions and refuses to commit onto a moved
// HEAD. LOCAL-ONLY: never adds a remote, never pushes, never force-anything.
//
//   node scripts/harness-commit.js --run-id <id> --session <sid> \
//        --files "a.js,b.js" --message "type(scope): subject" [--base-head <sha>]
//
// Steps (all fail-closed; nothing committed on any refusal):
//   1. precommitCheck: live harnesskit HEAD must equal base-head (from --base-head or
//      run.json.base_head). HEAD moved -> STOP (exit 3), demand revalidation.
//   2. acquire commit lease (lease.js kind=commit); held by another session -> exit 4.
//   3. git add ONLY the explicitly-listed files; git commit -m message.
//   4. release lease.
// --check-only runs step 1 (+lease probe) and exits without touching git index.
// Exposes precommitCheck() for deterministic evals (no git needed).
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { parseArgs, harnessRoot, readJson, nowIso } = require('./_lib.js');
const lease = require('./lease.js');

// Pure: compare base vs current HEAD. Returns {ok, reason}.
function precommitCheck({ base_head, current_head }) {
  if (!base_head) return { ok: false, reason: 'no base_head recorded for run; cannot verify HEAD stability' };
  if (!current_head) return { ok: false, reason: 'could not read current HEAD' };
  if (String(base_head) !== String(current_head)) {
    return { ok: false, reason: `HEAD moved (base=${String(base_head).slice(0, 12)} current=${String(current_head).slice(0, 12)}); revalidate before committing` };
  }
  return { ok: true, reason: 'HEAD stable' };
}

function gitHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function out(obj, code) { console.log(JSON.stringify(obj, null, 2)); process.exit(code); }

function main() {
  const a = parseArgs(process.argv.slice(2));
  const root = a.root ? String(a.root) : harnessRoot();
  const runId = a['run-id'] ? String(a['run-id']) : null;
  const session = a.session ? String(a.session) : null;
  if (!runId) out({ ok: false, error: '--run-id required' }, 1);
  if (!session) out({ ok: false, error: '--session required' }, 1);

  const rj = readJson(path.join(root, 'runs', runId, 'run.json'), null);
  const baseHead = a['base-head'] ? String(a['base-head']) : (rj && rj.base_head) || null;
  const currentHead = gitHead(root);

  const check = precommitCheck({ base_head: baseHead, current_head: currentHead });
  if (!check.ok) out({ ok: false, stage: 'precommit-check', ...check, base_head: baseHead, current_head: currentHead }, 3);

  // Probe commit lease (does another session hold it?).
  const conflict = lease.findConflict({ root, kind: 'commit', owner_session: session });
  if (conflict) out({ ok: false, stage: 'commit-lease', error: 'commit lease held by another session', conflict }, 4);

  if (a['check-only']) out({ ok: true, stage: 'check-only', head_stable: true, lease_free: true, base_head: baseHead }, 0);

  const filesArg = a.files ? String(a.files) : '';
  const files = filesArg.split(',').map(s => s.trim()).filter(Boolean);
  if (!files.length) out({ ok: false, error: '--files required (explicit scoped file list; no blanket add)' }, 1);
  const message = a.message ? String(a.message) : null;
  if (!message) out({ ok: false, error: '--message required' }, 1);

  const acq = lease.acquireLease({ root, kind: 'commit', owner_session: session, run_id: runId, ttlHours: 1 });
  if (!acq.ok) out({ ok: false, stage: 'commit-lease', error: 'could not acquire commit lease', conflict: acq.conflict }, 4);

  try {
    execFileSync('git', ['-C', root, 'add', '--', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', root, 'commit', '-m', message], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const newHead = gitHead(root);
    lease.releaseLease({ root, lock_id: acq.lock.lock_id });
    out({ ok: true, committed: true, run_id: runId, session, files, base_head: baseHead, new_head: newHead, ts: nowIso() }, 0);
  } catch (e) {
    lease.releaseLease({ root, lock_id: acq.lock.lock_id });
    out({ ok: false, stage: 'git-commit', error: String(e && e.message).slice(0, 300) }, 5);
  }
}

if (require.main === module) main();
module.exports = { precommitCheck };
