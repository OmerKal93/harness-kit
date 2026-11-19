#!/usr/bin/env node
// close-run.js — close or expire runs (run-lifecycle-hygiene-v1 E2).
// Args only (no stdin — PS 5.1 piping mangles JSON encoding).
//
// Mode A (single close):
//   node close-run.js --run-id <id> --to DONE|BLOCKED|EXPIRED --reason "..." [--root <dir>]
// Mode B (TTL sweep):
//   node close-run.js --expire-stale [--ttl-hours N] [--dry-run] [--root <dir>]
//
// Behavior: ensures next-action.md closure artifact exists (hard_states_require_artifact),
// appends a decision entry via update-run-ledger.append() (redaction + run.json state +
// index append), clears runs/.current-run when it references the closed run.
// Always prints a JSON summary. Honors kill switch. --root is for eval fixtures only.
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const {
  parseArgs, nowIso, runDir, readJson, readNdjson, harnessRoot,
  runLifecyclePolicy, clearCurrentRunPointer, readCurrentRunPointer
} = require('./_lib.js');
const { append } = require('./update-run-ledger.js');

const ALLOWED_TO = new Set(['DONE', 'BLOCKED', 'EXPIRED']);

function ensureClosureArtifact(runId, to, reason, root) {
  const p = path.join(runDir(runId, root), 'next-action.md');
  if (fs.existsSync(p)) return { path: p, created: false };
  const body = [
    `# next-action — ${runId}`,
    '',
    `Closed as **${to}** by close-run.js on ${nowIso()}.`,
    '',
    `Reason: ${reason}`,
    '',
    'Next action: none — run is terminal. Start a fresh run via new-run.js for new work.',
    ''
  ].join('\n');
  fs.writeFileSync(p, body);
  return { path: p, created: true };
}

function closeOne(runId, to, reason, root) {
  const rj = readJson(path.join(runDir(runId, root), 'run.json'), null);
  if (!rj) return { run_id: runId, ok: false, error: 'run.json missing or unreadable' };
  const from = rj.state;
  const policy = runLifecyclePolicy(root);
  if (policy.inactive_states.includes(from)) {
    return { run_id: runId, ok: false, error: `already terminal (${from})` };
  }
  const artifact = ensureClosureArtifact(runId, to, reason, root);
  const ptrBefore = readCurrentRunPointer(root);
  const pointedHere = !!(ptrBefore && ptrBefore.run_id === runId);
  // append() itself clears the pointer on terminal transitions (update-run-ledger);
  // this extra clear is belt-and-braces for runs whose state was already `to`.
  append(runId, 'decision', { from, to, reason, via: 'close-run.js' }, { root });
  clearCurrentRunPointer(runId, root);
  const ptrAfter = readCurrentRunPointer(root);
  const pointerCleared = pointedHere && (!ptrAfter || ptrAfter.run_id !== runId);
  return { run_id: runId, ok: true, from, to, artifact: artifact.path, artifact_created: artifact.created, pointer_cleared: pointerCleared };
}

function expireStale(ttlHours, dryRun, root) {
  const base = root || harnessRoot();
  const policy = runLifecyclePolicy(root);
  const ttl = Number.isFinite(Number(ttlHours)) && Number(ttlHours) > 0 ? Number(ttlHours) : policy.ttl_hours;
  const idx = readNdjson(path.join(base, 'runs', '.index.ndjson'));
  const byId = new Map();
  for (const e of idx) byId.set(e.run_id, e);
  const nowMs = Date.now();
  const stale = [];
  for (const e of byId.values()) {
    if (policy.inactive_states.includes(e.state)) continue;
    const rj = readJson(path.join(runDir(e.run_id, root), 'run.json'), null);
    const ts = Date.parse((rj && rj.last_state_change) || '');
    const ageHours = Number.isFinite(ts) ? (nowMs - ts) / 3600000 : Infinity;
    if (ageHours > ttl) stale.push({ run_id: e.run_id, state: (rj && rj.state) || e.state, age_hours: Number.isFinite(ts) ? Number(ageHours.toFixed(1)) : null });
  }
  if (dryRun) return { mode: 'expire-stale', dry_run: true, ttl_hours: ttl, would_close: stale };
  const results = stale.map(s => closeOne(s.run_id, 'EXPIRED', `expired by TTL sweep (age ${s.age_hours}h > ttl ${ttl}h)`, root));
  return { mode: 'expire-stale', dry_run: false, ttl_hours: ttl, closed: results };
}

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok: false, disabled: true, reason: dis.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? String(args.root) : undefined;

  if (args['expire-stale']) {
    const out = expireStale(args['ttl-hours'], !!args['dry-run'], root);
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  if (!args['run-id'] || !args.to) {
    console.error('close-run.js: --run-id and --to (DONE|BLOCKED|EXPIRED) required, or --expire-stale');
    process.exit(1);
  }
  const to = String(args.to).toUpperCase();
  if (!ALLOWED_TO.has(to)) {
    console.error(`close-run.js: --to must be one of ${[...ALLOWED_TO].join('|')}`);
    process.exit(1);
  }
  const reason = String(args.reason || 'closed via close-run.js (no reason given)');
  const out = closeOne(String(args['run-id']), to, reason, root);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

module.exports = { closeOne, expireStale };

if (require.main === module) main();
