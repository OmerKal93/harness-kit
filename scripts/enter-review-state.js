#!/usr/bin/env node
// enter-review-state.js — REVIEW-INDEPENDENCE-1 Layer 4: executable (not prose) execution-identity
// minting. Called by trusted orchestration at EXECUTION/REVIEW state entry -- NOT something a
// model can invoke with a caller-supplied execution_id, since there is no flag for one.
//
//   node scripts/enter-review-state.js --run-id <id> --state EXECUTION|REVIEW
//
// Behavior: reads the CURRENT run.json.state (assumed already updated by the real state-machine
// transition, e.g. update-run-ledger.js -- this script does not itself drive state transitions,
// it only reacts to one that already happened) and active_execution_id_state (which state the
// currently-persisted active_execution_id was minted for). If they match, this is a retry within
// the same state visit -- the persisted execution_id is reused untouched. If they differ (a real
// transition happened) or no execution_id exists yet, a fresh one is minted and persisted.
// Concurrency-safe via run-json-atomic.js (real cross-process lock, not lease.js -- see that
// file's header for why).
'use strict';

const crypto = require('crypto');
const path = require('path');
const { parseArgs, harnessRoot, runDir, nowIso } = require('./_lib.js');
const { isDisabled } = require('./is-disabled.js');
const { withRunJsonLock } = require('./review-independence/run-json-atomic.js');

const ELIGIBLE_STATES = Object.freeze(['EXECUTION', 'REVIEW']);

// Pure: given the current run.json and the state being entered, decide execution_id reuse-vs-mint.
// Exported separately from the fs-touching CLI so it's directly unit-testable.
function computeExecutionIdForStateEntry(current, state, mintId, now) {
  const isRetryWithinSameVisit = current.state === state && current.active_execution_id_state === state && current.active_execution_id;
  if (isRetryWithinSameVisit) {
    return { execution_id: current.active_execution_id, minted: false };
  }
  return { execution_id: mintId(), minted: true };
}

function mainMintId() { return `exec-${crypto.randomUUID()}`; }

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok: false, disabled: true, reason: dis.reason })); process.exit(0); }
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  const runId = a['run-id'];
  const state = a.state;
  if (!runId) { console.log(JSON.stringify({ ok: false, error: '--run-id required' })); process.exit(1); }
  if (!ELIGIBLE_STATES.includes(state)) { console.log(JSON.stringify({ ok: false, error: `--state must be one of ${ELIGIBLE_STATES.join('|')}` })); process.exit(1); }

  const root = harnessRoot();
  const rd = runDir(runId, root);
  let result;
  try {
    result = withRunJsonLock(rd, (current) => {
      if (!current) throw new Error(`run.json not found for ${runId}`);
      const { execution_id } = computeExecutionIdForStateEntry(current, state, mainMintId, nowIso());
      return Object.assign({}, current, { active_execution_id: execution_id, active_execution_id_state: state });
    });
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, run_id: runId, state, active_execution_id: result.active_execution_id }, null, 2));
  process.exit(0);
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });
  let counter = 0;
  const mintId = () => `exec-test-${++counter}`;

  // 1. Fresh entry (no prior execution_id) mints one.
  {
    const current = { state: 'EXECUTION', active_execution_id: null, active_execution_id_state: null };
    const r = computeExecutionIdForStateEntry(current, 'EXECUTION', mintId, '2026-01-01T00:00:00.000Z');
    push('fresh_entry_mints_new_execution_id', r.minted === true && !!r.execution_id, JSON.stringify(r));
  }
  // 2. Retry within the same state visit reuses the persisted execution_id.
  {
    const current = { state: 'EXECUTION', active_execution_id: 'exec-existing-1', active_execution_id_state: 'EXECUTION' };
    const r = computeExecutionIdForStateEntry(current, 'EXECUTION', mintId, '2026-01-01T00:00:00.000Z');
    push('retry_within_same_visit_reuses_execution_id', r.minted === false && r.execution_id === 'exec-existing-1', JSON.stringify(r));
  }
  // 3. A genuine state re-entry (state changed since the last mint) mints a new one.
  {
    const current = { state: 'EXECUTION', active_execution_id: 'exec-old-1', active_execution_id_state: 'REVIEW' };
    const r = computeExecutionIdForStateEntry(current, 'EXECUTION', mintId, '2026-01-01T00:00:00.000Z');
    push('state_reentry_mints_new_execution_id', r.minted === true && r.execution_id !== 'exec-old-1', JSON.stringify(r));
  }
  // 4. Real end-to-end via withRunJsonLock: two calls with no state change in between reuse the id.
  {
    const os = require('os'), fs = require('fs');
    const runDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-enter-review-state-selftest-'));
    fs.writeFileSync(path.join(runDirPath, 'run.json'), JSON.stringify({ state: 'EXECUTION', active_execution_id: null, active_execution_id_state: null }));
    const first = withRunJsonLock(runDirPath, (current) => {
      const { execution_id } = computeExecutionIdForStateEntry(current, 'EXECUTION', mintId, nowIso());
      return Object.assign({}, current, { active_execution_id: execution_id, active_execution_id_state: 'EXECUTION' });
    });
    const second = withRunJsonLock(runDirPath, (current) => {
      const { execution_id } = computeExecutionIdForStateEntry(current, 'EXECUTION', mintId, nowIso());
      return Object.assign({}, current, { active_execution_id: execution_id, active_execution_id_state: 'EXECUTION' });
    });
    push('end_to_end_retry_reuses_persisted_id', first.active_execution_id === second.active_execution_id, JSON.stringify({ first: first.active_execution_id, second: second.active_execution_id }));
    fs.rmSync(runDirPath, { recursive: true, force: true });
  }
  // 5. A caller-supplied execution_id has zero effect -- computeExecutionIdForStateEntry's
  //    signature has no parameter for one, so even a maliciously crafted `current` object claiming
  //    an attacker-chosen id in an unrelated field can't influence the mint/reuse decision.
  {
    const injected = { state: 'EXECUTION', active_execution_id: null, active_execution_id_state: null, 'execution-id': 'ATTACKER-CHOSEN-ID', execution_id: 'ATTACKER-CHOSEN-ID-2' };
    const r = computeExecutionIdForStateEntry(injected, 'EXECUTION', mintId, '2026-01-01T00:00:00.000Z');
    push('caller_supplied_execution_id_fields_ignored', r.execution_id !== 'ATTACKER-CHOSEN-ID' && r.execution_id !== 'ATTACKER-CHOSEN-ID-2' && r.execution_id === `exec-test-${counter}`, JSON.stringify(r));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { computeExecutionIdForStateEntry, ELIGIBLE_STATES };
if (require.main === module) main();
