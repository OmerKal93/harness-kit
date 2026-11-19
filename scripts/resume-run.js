#!/usr/bin/env node
// resume-run.js — given a run_id (or auto-pick latest non-terminal run), report the
// last valid state, computed safe next state, blockers, and approval requirements.
// Read-only on the run. /harness-resume command consumes the JSON and decides whether to
// transition or stop.
//
// Usage: node resume-run.js --run-id <id>
//        node resume-run.js                  (auto: most-recent non-{DONE,BLOCKED,NEEDS_USER})
//
// Output (stdout, single JSON object):
//   {
//     ok, run_id, current_state, safe_next_state, terminal,
//     approval_needed: [...], blockers: [...],
//     artifacts_present: { plan, review, verification, learning, next_action },
//     advice: "...one-line guidance..."
//   }
// Exit codes: 0 ok; 2 if approval_needed.length > 0 OR run terminal (DONE/BLOCKED) and caller must not transition.
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const {
  parseArgs, nowIso, runDir, readJson, readNdjson, listRuns,
  resolveCurrentRun, readCurrentRunPointer
} = require('./_lib.js');

const TERMINAL = new Set(['DONE', 'BLOCKED', 'EXPIRED']);
const HOLD     = new Set(['NEEDS_USER', 'SUSPEND']);

// Per global-policy.json state_machine.allowed transitions, the safe re-entry
// state after a given prior state. Conservative: never skip VERIFICATION when
// EXECUTION ran.
function pickSafeNext(state, artifacts) {
  if (TERMINAL.has(state)) return null;
  if (state === 'EXECUTION' && !artifacts.verification) return 'VERIFICATION';
  if (state === 'EXECUTION' && artifacts.verification && !artifacts.learning) return 'LEARNING';
  if (state === 'VERIFICATION' && !artifacts.verification) return 'VERIFICATION';
  if (state === 'VERIFICATION' && artifacts.verification && !artifacts.learning) return 'LEARNING';
  if (state === 'LEARNING' && !artifacts.next_action) return 'LEARNING';
  if (state === 'LEARNING' && artifacts.next_action) return 'DONE';
  if (state === 'REVIEW' && !artifacts.review) return 'REVIEW';
  if (state === 'REVIEW' && artifacts.review) return 'VERIFICATION';
  if (state === 'PLANNING_OR_DEBUGGING' && !artifacts.plan) return 'PLANNING_OR_DEBUGGING';
  if (state === 'PLANNING_OR_DEBUGGING' && artifacts.plan) return 'EXECUTION';
  if (state === 'ROUTING')             return 'PLANNING_OR_DEBUGGING';
  if (state === 'CONTEXT_GATHERING')   return 'ROUTING';
  if (state === 'INTAKE')              return 'CONTEXT_GATHERING';
  if (state === 'SUSPEND')             return 'CONTEXT_GATHERING'; // re-enter from context refresh
  if (state === 'NEEDS_USER')          return 'ROUTING';           // approval line consumed, return to routing
  return null;
}

// E2: auto-pick = the pointer-resolved current run only (same resolver as the
// hooks). No fallback guessing — if the pointer is absent/terminal/expired the
// caller must pass --run-id explicitly or start a new run.
function autoPickRunId() {
  const cur = resolveCurrentRun();
  return cur ? cur.run_id : null;
}

const ALL_STATES = [
  'INTAKE', 'CONTEXT_GATHERING', 'ROUTING', 'PLANNING_OR_DEBUGGING', 'EXECUTION',
  'REVIEW', 'VERIFICATION', 'LEARNING', 'DONE', 'BLOCKED', 'EXPIRED', 'NEEDS_USER', 'SUSPEND'
];
const ARTIFACT_KEYS = ['plan', 'review', 'verification', 'learning', 'next_action'];

// Exercises pickSafeNext() against synthetic interrupted-run scenarios -- until this test existed,
// resume-run.js had zero coverage (confirmed by direct repo audit: no --self-test flag, no fixture
// under evals/fixtures/, not in local-ci.js's SELF_TEST_MODULES list). Pure function, no filesystem
// needed, so every scenario here is a real assertion, not a mock.
function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });
  const art = (over) => Object.assign({ plan: false, review: false, verification: false, learning: false, next_action: false }, over);

  // Interrupted mid-EXECUTION, crashed before verification.md was ever written -- must re-enter at
  // VERIFICATION, never skip straight to LEARNING/DONE. This is the invariant the file's own
  // comment claims ("Conservative: never skip VERIFICATION when EXECUTION ran") but never tested.
  push('execution_no_verification_reenters_verification',
    pickSafeNext('EXECUTION', art({})) === 'VERIFICATION', 'crash before verification.md written');

  push('execution_with_verification_no_learning_advances_to_learning',
    pickSafeNext('EXECUTION', art({ verification: true })) === 'LEARNING', 'verification.md present, learning.md absent');

  // State says VERIFICATION but the artifact was never actually written (interrupted exactly at
  // the transition) -- must re-enter VERIFICATION again, not silently treat the transition as done.
  push('verification_state_without_artifact_reenters_verification',
    pickSafeNext('VERIFICATION', art({})) === 'VERIFICATION', 'state=VERIFICATION but verification.md missing');

  push('verification_with_artifact_no_learning_advances_to_learning',
    pickSafeNext('VERIFICATION', art({ verification: true })) === 'LEARNING', 'verification.md present, learning.md absent');

  push('learning_without_next_action_retries_learning',
    pickSafeNext('LEARNING', art({})) === 'LEARNING', 'next-action.md not yet written');

  push('learning_with_next_action_completes_to_done',
    pickSafeNext('LEARNING', art({ next_action: true })) === 'DONE', 'next-action.md present');

  push('review_without_artifact_reenters_review',
    pickSafeNext('REVIEW', art({})) === 'REVIEW', 'interrupted before review.md written');

  push('review_with_artifact_advances_to_verification',
    pickSafeNext('REVIEW', art({ review: true })) === 'VERIFICATION', 'review.md present');

  push('planning_without_plan_reenters_planning',
    pickSafeNext('PLANNING_OR_DEBUGGING', art({})) === 'PLANNING_OR_DEBUGGING', 'interrupted before plan.md written');

  push('planning_with_plan_advances_to_execution',
    pickSafeNext('PLANNING_OR_DEBUGGING', art({ plan: true })) === 'EXECUTION', 'plan.md present');

  push('routing_advances_to_planning', pickSafeNext('ROUTING', art({})) === 'PLANNING_OR_DEBUGGING', '');
  push('context_gathering_advances_to_routing', pickSafeNext('CONTEXT_GATHERING', art({})) === 'ROUTING', '');
  push('intake_advances_to_context_gathering', pickSafeNext('INTAKE', art({})) === 'CONTEXT_GATHERING', '');
  push('suspend_reenters_context_gathering', pickSafeNext('SUSPEND', art({})) === 'CONTEXT_GATHERING', '');
  push('needs_user_reenters_routing', pickSafeNext('NEEDS_USER', art({})) === 'ROUTING', '');

  // Terminal states never resume, regardless of artifact combination -- a crashed process must not
  // be able to reopen a DONE/BLOCKED/EXPIRED run by racing a resume call against artifact writes.
  for (const state of ['DONE', 'BLOCKED', 'EXPIRED']) {
    push(`terminal_${state.toLowerCase()}_never_resumes_even_with_all_artifacts`,
      pickSafeNext(state, art({ plan: true, review: true, verification: true, learning: true, next_action: true })) === null,
      `state=${state}, all artifacts present`);
  }

  // Property check: across every known state x every artifact-presence combination, pickSafeNext
  // must (a) never throw, (b) only ever return a known state or null, and (c) never let a run whose
  // EXECUTION/VERIFICATION already happened skip straight to LEARNING/DONE without verification.md
  // present -- the general form of the two hardcoded checks above, run over the full state space so
  // an unanticipated real-world artifact combination can't silently violate the invariant.
  {
    let allSafe = true;
    let violation = null;
    for (const state of ALL_STATES) {
      for (let mask = 0; mask < (1 << ARTIFACT_KEYS.length); mask++) {
        const artifacts = {};
        ARTIFACT_KEYS.forEach((k, i) => { artifacts[k] = !!(mask & (1 << i)); });
        let next;
        try { next = pickSafeNext(state, artifacts); } catch (e) {
          allSafe = false; violation = `threw for state=${state} artifacts=${JSON.stringify(artifacts)}: ${e.message}`; break;
        }
        if (next !== null && !ALL_STATES.includes(next)) {
          allSafe = false; violation = `returned unknown state "${next}" for state=${state}`; break;
        }
        if ((state === 'EXECUTION' || state === 'VERIFICATION') && !artifacts.verification &&
            (next === 'LEARNING' || next === 'DONE')) {
          allSafe = false; violation = `skipped VERIFICATION: state=${state} artifacts=${JSON.stringify(artifacts)} -> ${next}`; break;
        }
      }
      if (!allSafe) break;
    }
    push('full_state_space_never_throws_never_skips_verification', allSafe, violation || 'all states x all artifact combinations checked');
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) process.exit(selfTest() ? 0 : 1);
  const dis = isDisabled();
  if (dis.disabled) {
    process.stdout.write(JSON.stringify({ ok: false, disabled: true, reason: dis.reason }) + '\n');
    process.exit(0);
  }
  let runId = args['run-id'];
  let pointerMismatch = false;
  if (!runId) {
    runId = autoPickRunId();
    if (!runId) {
      process.stdout.write(JSON.stringify({ ok: false, reason: 'no current run (pointer absent, terminal, or past TTL); pass --run-id explicitly or start a new run' }) + '\n');
      process.exit(1);
    }
  } else {
    const ptr = readCurrentRunPointer();
    pointerMismatch = !!(ptr && ptr.run_id !== runId);
  }
  const rd = runDir(runId);
  if (!fs.existsSync(rd)) {
    process.stdout.write(JSON.stringify({ ok: false, reason: `run dir not found: ${runId}` }) + '\n');
    process.exit(1);
  }
  const run = readJson(path.join(rd, 'run.json'), null);
  if (!run) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'run.json missing or unreadable' }) + '\n');
    process.exit(1);
  }
  const verdict = readJson(path.join(rd, 'approval-verdict.json'), { approval_required: false, reasons: [], required_for: [] });

  const artifacts = {
    plan:         fs.existsSync(path.join(rd, 'plan.md')),
    review:       fs.existsSync(path.join(rd, 'review.md')),
    verification: fs.existsSync(path.join(rd, 'verification.md')),
    learning:     fs.existsSync(path.join(rd, 'learning.md')),
    next_action:  fs.existsSync(path.join(rd, 'next-action.md'))
  };

  // Unconsumed approvals
  const approvalsGiven = (run.approvals || []).filter(a => !a.consumed).map(a => String(a.action || '').toLowerCase());
  const stillNeeded = (verdict.required_for || []).filter(req => {
    const r = String(req).toLowerCase();
    return !approvalsGiven.some(a => a.includes(r) || r.includes(a));
  });

  const decisions = readNdjson(path.join(rd, 'decision-log.ndjson'));
  const lastDecision = decisions[decisions.length - 1] || null;

  const terminal = TERMINAL.has(run.state);
  let safeNext = null;
  let advice = '';

  if (terminal) {
    advice = `run is ${run.state}; resume not allowed — use /harness-trace ${runId} or start a new /harness-run`;
  } else if (stillNeeded.length) {
    advice = `approval required before resume — type each line: ${stillNeeded.map(r => `harness-run approve ${r}`).join(' ; ')}`;
  } else {
    safeNext = pickSafeNext(run.state, artifacts);
    if (run.state === 'EXECUTION' && !artifacts.verification) {
      advice = 'EXECUTION ran without verification — re-enter at VERIFICATION (never skipped)';
    } else if (HOLD.has(run.state)) {
      advice = `run is ${run.state}; satisfy outstanding ask, then re-enter at ${safeNext}`;
    } else {
      advice = `safe to resume at ${safeNext || run.state}`;
    }
  }
  if (pointerMismatch) {
    advice += ` [NOTE: ${runId} is not the .current-run pointer target — read-only inspection fine; sensitive writes will gate against the pointer run]`;
  }

  const out = {
    ok: true,
    run_id: runId,
    current_state: run.state,
    safe_next_state: safeNext,
    terminal,
    approval_needed: stillNeeded,
    blockers: (verdict.reasons || []).filter(r => stillNeeded.some(n => r.toLowerCase().includes(n.toLowerCase()))),
    artifacts_present: artifacts,
    last_decision_ts: lastDecision?.ts || null,
    advice
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(terminal || stillNeeded.length ? 2 : 0);
}

module.exports = { pickSafeNext };
if (require.main === module) main();
