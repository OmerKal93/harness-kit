#!/usr/bin/env node
// check-review-independence.js — REVIEW-INDEPENDENCE-1: reads run.json + the run's project
// profile's review_independence config, evaluates via scripts/review-independence/core/evaluator.js,
// writes runs/<id>/review-independence-verdict.json, exits per check-approval-needed.js's exact
// verified contract (process.exit(approvalRequired ? 2 : 0), confirmed check-approval-needed.js:76).
//
// When enforced:false (the only shipped value in this batch -- RI-8 is not approved), this script
// still runs and still writes a real verdict, but always exits 0 -- report-only, never blocks.
//
//   node scripts/check-review-independence.js --run-id <id> [--json]
'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs, harnessRoot, runDir, readJson, writeJson, nowIso, loadProjectProfile } = require('./_lib.js');
const { isDisabled } = require('./is-disabled.js');
const { evaluateIndependence } = require('./review-independence/core/evaluator.js');

const DEFAULT_POLICY = Object.freeze({ enforced: false, minimum_level: 'isolated_actor' });

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok: false, disabled: true, reason: dis.reason })); process.exit(0); }
  const a = parseArgs(process.argv.slice(2));
  const runId = a['run-id'];
  if (!runId) { console.log(JSON.stringify({ ok: false, error: '--run-id required' })); process.exit(1); }

  const root = harnessRoot();
  const rd = runDir(runId, root);
  const runJsonPath = path.join(rd, 'run.json');
  const run = readJson(runJsonPath, null);
  if (!run) { console.log(JSON.stringify({ ok: false, error: 'run.json missing or unreadable' })); process.exit(1); }

  const profile = run.project_profile ? loadProjectProfile(run.project_profile) : null;
  const policy = (profile && profile.review_independence) || DEFAULT_POLICY;

  const evalResult = evaluateIndependence({
    producers: run.producers || [],
    reviewers: run.reviewers || [],
    minimum_level: policy.minimum_level || 'isolated_actor'
  });

  const verdict = {
    schema_version: 1,
    run_id: runId,
    ts: nowIso(),
    enforced: !!policy.enforced,
    minimum_level: evalResult.minimum_level,
    satisfied: evalResult.satisfied,
    reason: evalResult.reason,
    producers_count: (run.producers || []).length,
    reviewers_count: (run.reviewers || []).length,
    checked_pairs: evalResult.checked_pairs
  };
  writeJson(path.join(rd, 'review-independence-verdict.json'), verdict);

  const approvalRequired = policy.enforced && !evalResult.satisfied;
  if (a.json) console.log(JSON.stringify(verdict, null, 2));
  else console.log(`review-independence: ${evalResult.satisfied ? 'SATISFIED' : 'NOT SATISFIED'} (level=${evalResult.minimum_level}, enforced=${!!policy.enforced}, reason=${evalResult.reason || 'n/a'})`);
  process.exit(approvalRequired ? 2 : 0);
}

if (require.main === module) main();
