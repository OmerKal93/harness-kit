#!/usr/bin/env node
// new-run.js — create a fresh run folder under runs/<run_id>/.
// Args:
//   --prompt "text"          (required unless --run-id given to re-init)
//   --profile <name>         (override auto-detect; default = auto from cwd)
//   --cwd <path>             (override process.cwd())
//   --task-type <type>       (skip classifier hint; used by /harness-run if known)
//
// Output (stdout, single JSON line):
//   { "ok": true, "run_id": "...", "run_dir": "...", "profile": "..." }
//
// Side effects:
//   - mkdir run dir
//   - write run.json with metadata
//   - append .index.ndjson with state=INTAKE
//   - exit 0 cleanly if DISABLED kill switch is on (prints reason; no side effects)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isDisabled } = require('./is-disabled.js');
const {
  parseArgs, nowIso, genRunId, ensureRunDir, writeJson, indexRun,
  detectProjectProfile, loadProjectProfile, harnessRoot, readJson,
  writeCurrentRunPointer
} = require('./_lib.js');
// RUN-LOCK-1: session ownership + multi-session pointer-clobber avoidance.
const { multipleActiveRuns } = require('./session.js');

function gitInfo(cwd) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
    const head   = execFileSync('git', ['rev-parse', 'HEAD'],                 { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
    const dirty  = execFileSync('git', ['status', '--porcelain'],             { cwd, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim().length > 0;
    return { branch, head, dirty };
  } catch { return null; }
}

// RUN-LOCK-1: harnesskit repo HEAD (DISTINCT from run.git which tracks the project/cwd
// repo, e.g. a downstream project). Used by harness-commit.js as the commit base-HEAD guard.
function harnessHead() {
  try {
    return execFileSync('git', ['-C', harnessRoot(), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  } catch { return null; }
}

function main() {
  const dis = isDisabled();
  if (dis.disabled) {
    process.stdout.write(JSON.stringify({ ok: false, disabled: true, reason: dis.reason }) + '\n');
    process.exit(0);
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt && !args['run-id']) {
    process.stderr.write('new-run.js: --prompt is required (or --run-id to re-init)\n');
    process.exit(1);
  }
  const cwd = args.cwd || process.cwd();
  let profile = null;
  if (args.profile) {
    const data = loadProjectProfile(args.profile);
    if (data) profile = { name: args.profile, data, matched: 'explicit' };
  }
  if (!profile) profile = detectProjectProfile(cwd);
  const profileName = profile ? profile.name : 'default';

  const runId = args['run-id'] || genRunId(args.prompt);
  const runDirPath = ensureRunDir(runId);

  // RUN-LOCK-1: additive session-ownership metadata (back-compat: omitted-field-safe).
  const ownerSession = process.env.HARNESSKIT_SESSION_ID || args.session || null;
  const writeScopes = args['write-scopes']
    ? String(args['write-scopes']).split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const runJson = {
    schema_version: 1,
    run_id: runId,
    created: nowIso(),
    last_state_change: nowIso(),
    state: 'INTAKE',
    prompt: String(args.prompt || ''),
    task_type_hint: args['task-type'] || null,
    cwd,
    project_profile: profileName,
    project_root: profile?.data?.project_root || null,
    git: gitInfo(cwd),
    owner_session: ownerSession,        // RUN-LOCK-1
    write_scopes: writeScopes,          // RUN-LOCK-1
    base_head: harnessHead(),            // RUN-LOCK-1: harnesskit HEAD at run start
    lease_ids: [],                      // RUN-LOCK-1
    approvals: [],
    artifacts: {},
    notes: [],
    // REVIEW-INDEPENDENCE-1: additive, back-compat (omitted-field-safe on pre-existing runs).
    active_execution_id: null,
    active_execution_id_state: null,   // which state active_execution_id was minted for -- lets
                                        // enter-review-state.js tell a retry-within-the-same-visit
                                        // apart from a genuine re-entry without rescanning history
    pending_dispatches: [],
    pending_review_requests: [],
    producers: [],
    reviewers: []
  };
  writeJson(path.join(runDirPath, 'run.json'), runJson);

  // Seed empty log files
  fs.writeFileSync(path.join(runDirPath, 'decision-log.ndjson'), '');
  fs.writeFileSync(path.join(runDirPath, 'tool-log.ndjson'),     '');

  indexRun(runId, 'INTAKE', args['task-type'] || null, null);

  // RUN-LOCK-1: .current-run is now a UI hint / legacy single-session fallback — NOT
  // the authority for protected writes (session.js#resolveProtectedWriteRun is). To
  // avoid hijacking a concurrent session's pointer, only (re)write it when no other
  // session is recently active, unless --no-pointer forces a skip. Session-bound
  // callers set HARNESSKIT_RUN_ID and never depend on the pointer.
  let pointerWritten = false;
  if (!args['no-pointer'] && !multipleActiveRuns({})) {
    writeCurrentRunPointer(runId);
    pointerWritten = true;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    run_id: runId,
    run_dir: runDirPath,
    profile: profileName,
    owner_session: ownerSession,
    write_scopes: writeScopes,
    base_head: runJson.base_head,
    pointer_written: pointerWritten,
    pointer: pointerWritten ? 'runs/.current-run' : 'skipped (multi-session or --no-pointer)',
    bind_hint: `export HARNESSKIT_RUN_ID=${runId}` + (ownerSession ? ` HARNESSKIT_SESSION_ID=${ownerSession}` : '')
  }) + '\n');
}

main();
