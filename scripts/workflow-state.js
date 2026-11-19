#!/usr/bin/env node
// workflow-state.js — Batch (ce_work). Minimal per-run workflow-state WRITER.
//
// Persists loop state to runs/<run_id>/workflow-state.json (the only mutable file — rewritten whole
// and ATOMICALLY via tmp+rename) plus an append-only runs/<run_id>/reviewer-verdicts.ndjson, matching
// docs/WORKFLOW_STATE_MODEL.md. It RECORDS state; it does NOT enforce budgets/kill-criteria, does NOT
// drive a loop, and is NOT wired into /harness-loop or /harness-run. Pure Node stdlib + _lib.js.
//
// Library: const ws = require('./workflow-state.js')
// CLI:     node workflow-state.js --self-test
//          node workflow-state.js --read --run-id <id>
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const { parseArgs, runDir, readJson, appendNdjson, nowIso, harnessRoot } = require('./_lib.js');

// State machine per docs/WORKFLOW_STATE_MODEL.md (terminal states map to []).
const ALLOWED = Object.freeze({
  initialized: ['classified'],
  classified: ['context_ready'],
  context_ready: ['planning'],
  planning: ['plan_review'],
  plan_review: ['waiting_for_human_gate', 'implementation', 'repair_loop'],
  waiting_for_human_gate: ['implementation', 'stopped'],
  implementation: ['verification'],
  verification: ['final_review', 'repair_loop'],
  repair_loop: ['planning', 'implementation', 'escalated', 'killed'],
  final_review: ['completed', 'repair_loop'],
  completed: [], stopped: [], escalated: [], killed: []
});

function wsPath(runId, root) { return path.join(runDir(runId, root), 'workflow-state.json'); }
function verdictLogPath(runId, root) { return path.join(runDir(runId, root), 'reviewer-verdicts.ndjson'); }

// Whole-file atomic write: tmp + rename, so a crash never leaves partial JSON state.
function writeStateAtomic(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, fp);
}

function initWorkflowState(opts = {}) {
  const { runId, workflowId, readiness, allowedActionLevel, budget, root } = opts;
  if (!runId) throw new Error('initWorkflowState: runId required');
  const now = nowIso();
  const state = {
    schema_version: 1,
    run_id: runId,
    workflow_id: workflowId || null,
    readiness_level: readiness || 'L1_REPORT_ONLY',
    allowed_action_level: allowedActionLevel || 'report_only',
    status: 'initialized',
    current_stage: null,
    stages_completed: [],
    pending_stage: null,
    attempt_counters: { repair_loops_used: 0, plan_rejects: 0, qa_failures: 0 },
    // W12 honest note: `budget.repair_loops_used` is LEGACY/DEAD — the single source of truth is
    // `attempt_counters.repair_loops_used` (read by checkMaxRepairLoops, incremented by
    // enterRepairLoop). Nothing reads or writes budget.repair_loops_used after init. Not deleted in
    // W12 (schema-drift removal is out of scope here) — kept for backward-compat with any existing
    // persisted run.json that may reference it; do not add new readers/writers of this field.
    budget: Object.assign({ max_repair_loops: 2, repair_loops_used: 0 }, budget || {}),
    gates: [],
    reviewer_verdicts: [],
    kill_criteria: [],
    memory_behavior: { facts_read_count: 0, active_facts_used: [], historical_facts_used: [], memory_warnings: [], capture_candidates: [], captured_fact_ids: [] },
    handoff_behavior: { handoff_required: false, handoff_packet_id: null, target_user_or_team: null, reviewer_visibility: 'summary_only', private_memory_shared: false },
    next_action: null,
    created_at: now,
    updated_at: now
  };
  writeStateAtomic(wsPath(runId, root), state);
  return state;
}

function readWorkflowState(runId, opts = {}) {
  return readJson(wsPath(runId, opts.root), null);
}

// Shallow merge (patch overrides top-level keys wholesale). Bumps updated_at. Returns {ok,state}|{ok:false}.
// W12: a non-empty successful patch emits ONE `state_patched` decision-log event — top-level CHANGED
// KEY NAMES only (never values: no state dump, no plan text, no secrets, no memory payload). The
// decision-log append is best-effort (try/catch, non-fatal) — matches every other decision-log helper
// in this codebase (qa_self_test_run, ponytail_budget_check, max_repair_loops_check,
// repair_loop_entered, codex_timeout_retry_check, plan_lint_blocked_codex_review all follow this same
// convention). The state write itself is unaffected either way — atomicity (tmp+rename) is unchanged;
// logging failure NEVER blocks or partially-applies the state write.
function updateWorkflowState(runId, patch, opts = {}) {
  const cur = readWorkflowState(runId, opts);
  if (!cur) return { ok: false, error: 'no_state' };
  const next = Object.assign({}, cur, patch || {}, { updated_at: nowIso() });
  writeStateAtomic(wsPath(runId, opts.root), next);
  const changedKeys = Object.keys(patch || {});
  if (changedKeys.length) {
    try {
      appendNdjson(path.join(runDir(runId, opts.root), 'decision-log.ndjson'), {
        ts: nowIso(), run_id: runId, event_type: 'state_patched', changed_keys: changedKeys,
        source: opts.source || null, reason: opts.reason || null
      });
    } catch { /* decision-log is bookkeeping; non-fatal — state write already succeeded */ }
  }
  return { ok: true, state: next };
}

// Move to a new status (state-machine state). Validates against ALLOWED unless {force:true}.
// `stage` optionally names the workflow stage; the previous current_stage is recorded in
// stages_completed; a line is appended to the run's decision-log.ndjson. W12: the event now always
// carries `event_type:"transition"` and an explicit `forced` boolean (never omitted, per contract) so
// a force:true bypass of the ALLOWED map is never silently indistinguishable from a normal transition
// in the audit trail; `force_reason` (change.force_reason, optional) is carried when forced. Preserves
// existing behavior exactly — force is NOT blocked or validated further in W12 (see transition_model's
// own N2 gap), only made visible.
function transitionStage(runId, change, opts = {}) {
  const cur = readWorkflowState(runId, opts);
  if (!cur) return { ok: false, error: 'no_state' };
  const to = change && change.to;
  if (!to) return { ok: false, error: 'transition: `to` required' };
  const from = cur.status;
  if (!change.force && !(ALLOWED[from] || []).includes(to)) {
    return { ok: false, error: `illegal transition ${from} -> ${to}` };
  }
  const stages_completed = (cur.stages_completed || []).slice();
  if (cur.current_stage && !stages_completed.includes(cur.current_stage)) stages_completed.push(cur.current_stage);
  const next = Object.assign({}, cur, {
    status: to,
    current_stage: change.stage || to,
    pending_stage: change.pending_stage !== undefined ? change.pending_stage : cur.pending_stage,
    stages_completed,
    updated_at: nowIso()
  });
  writeStateAtomic(wsPath(runId, opts.root), next);
  appendNdjson(path.join(runDir(runId, opts.root), 'decision-log.ndjson'), {
    ts: nowIso(), run_id: runId, event_type: 'transition', from, to, reason: change.reason || `transition ${from}->${to}`,
    forced: !!change.force, force_reason: change.force ? (change.force_reason || null) : null,
    artifact: 'workflow-state.json'
  });
  return { ok: true, state: next };
}

// ---------------------------------------------------------------------------
// verdict_log schema + provenance (W9). Provenance = HOW the record reached the log (write path),
// orthogonal to reviewer_kind (the reviewer's nature). 'unknown_legacy' is a READ-side
// interpretation for pre-W9 records with no provenance — REJECTED on any new write.
// ---------------------------------------------------------------------------
const VERDICT_REVIEWER_ALLOW = Object.freeze(['codex_cli', 'qa_self_tests', 'ponytail_budget', 'qa_evals', 'ponytail_review']);
const VERDICT_VALUE_ALLOW = Object.freeze(['PASS', 'REJECT', 'FAIL', 'WARN', 'ERROR', 'SKIPPED']);
const VERDICT_PROVENANCE_ALLOW = Object.freeze(['live_codex', 'cli_human', 'deterministic_internal', 'fixture']);
const VERDICT_SEVERITY_ALLOW = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);
const VERDICT_SENDS_BACK_ALLOW = Object.freeze(['ce_plan', 'ce_work', 'repair_loop']);

// Pure copy-and-overwrite: forces `provenance` on a COPY, never mutates the input. This is the
// spoof fix's core — a caller-controlled provenance claim (e.g. typed JSON saying "live_codex")
// is overwritten by the write path that actually carried it.
function stampProvenance(verdict, provenance) {
  return Object.assign({}, verdict || {}, { provenance });
}

// validateVerdict(verdict) -> violations[] (empty = valid). Write-time schema for NEW records only;
// never applied to old ndjson/mirror reads (those interpret missing provenance as unknown_legacy).
function validateVerdict(verdict) {
  const v = verdict || {};
  const violations = [];
  if (!VERDICT_REVIEWER_ALLOW.includes(v.reviewer)) violations.push(`reviewer must be one of [${VERDICT_REVIEWER_ALLOW.join('|')}], got ${JSON.stringify(v.reviewer)}`);
  if (!VERDICT_VALUE_ALLOW.includes(v.verdict)) violations.push(`verdict must be one of [${VERDICT_VALUE_ALLOW.join('|')}], got ${JSON.stringify(v.verdict)}`);
  if (!VERDICT_PROVENANCE_ALLOW.includes(v.provenance)) violations.push(`provenance must be one of [${VERDICT_PROVENANCE_ALLOW.join('|')}] (unknown_legacy is read-side only), got ${JSON.stringify(v.provenance)}`);
  if (typeof v.target !== 'string' || !v.target) violations.push(`target must be a non-empty string, got ${JSON.stringify(v.target)}`);
  if (v.severity != null && !VERDICT_SEVERITY_ALLOW.includes(v.severity)) violations.push(`severity (optional) must be one of [${VERDICT_SEVERITY_ALLOW.join('|')}], got ${JSON.stringify(v.severity)}`);
  if (v.reasons != null && !(Array.isArray(v.reasons) && v.reasons.every(r => typeof r === 'string'))) violations.push('reasons (optional) must be an array of strings');
  if (v.sends_back_to != null && !VERDICT_SENDS_BACK_ALLOW.includes(v.sends_back_to)) violations.push(`sends_back_to (optional) must be one of [${VERDICT_SENDS_BACK_ALLOW.join('|')}] or null, got ${JSON.stringify(v.sends_back_to)}`);
  return violations;
}

// Append one reviewer verdict to reviewer-verdicts.ndjson (append-only) and mirror into state.
// W9: validates BEFORE any write — a malformed verdict returns { ok:false, error:'invalid_verdict',
// violations } with NO ndjson line, NO mirror update, no throw, no ERROR-verdict write. On success
// returns the normalized appended record as `verdict_record` (`verdict` kept as an alias for
// pre-W9 callers). verdict_id / created_at are auto-filled, never rejection grounds.
function appendVerdict(runId, verdict, opts = {}) {
  const violations = validateVerdict(verdict);
  if (violations.length) return { ok: false, error: 'invalid_verdict', violations };
  const v = verdict || {};
  const rec = Object.assign({
    verdict_id: null, reviewer: null, reviewer_kind: null, target: null,
    verdict: null, severity: null, reasons: [], required_repairs: [], sends_back_to: null,
    provenance: null,
    created_at: nowIso()
  }, v);
  if (!rec.verdict_id) rec.verdict_id = `${rec.reviewer}-${nowIso()}`;
  if (!rec.created_at) rec.created_at = nowIso();
  const rd = runDir(runId, opts.root);
  fs.mkdirSync(rd, { recursive: true });
  appendNdjson(verdictLogPath(runId, opts.root), rec);
  const cur = readWorkflowState(runId, opts);
  if (cur) {
    cur.reviewer_verdicts = (cur.reviewer_verdicts || []).concat([rec]);
    cur.updated_at = nowIso();
    writeStateAtomic(wsPath(runId, opts.root), cur);
  }
  return { ok: true, verdict: rec, verdict_record: rec };
}

module.exports = { ALLOWED, wsPath, initWorkflowState, readWorkflowState, updateWorkflowState, transitionStage, appendVerdict, validateVerdict, stampProvenance, VERDICT_REVIEWER_ALLOW, VERDICT_VALUE_ALLOW, VERDICT_PROVENANCE_ALLOW, VERDICT_SEVERITY_ALLOW, VERDICT_SENDS_BACK_ALLOW };

// ---------------------------------------------------------------------------
// Self-test: temp root + synthetic run id only. Never writes the real runs/ tree. Not gated by the
// kill switch (synthetic, temp-scoped), so it runs for verification even while DISABLED is active.
// ---------------------------------------------------------------------------
function selfTest() {
  const os = require('os');
  const root = path.join(os.tmpdir(), 'hk-wfstate-selftest-' + process.pid);
  const runId = 'wf-selftest';
  const results = [];
  const A = (n, c) => results.push([n, !!c]);
  try {
    const st = initWorkflowState({ runId, workflowId: 'runtime_code_change', readiness: 'L1_REPORT_ONLY', allowedActionLevel: 'report_only', root });
    const fp = wsPath(runId, root);
    A('init writes workflow-state.json under temp runs/', fs.existsSync(fp) && fp.startsWith(os.tmpdir()) && fp.includes(path.join('runs', runId)));
    A('init status=initialized + schema fields', st.status === 'initialized' && st.schema_version === 1 && !!st.created_at && Array.isArray(st.reviewer_verdicts));
    A('atomic write leaves no .tmp', !fs.existsSync(fp + '.tmp'));

    const back = readWorkflowState(runId, { root });
    A('read round-trips', back && back.run_id === runId && back.status === 'initialized');

    A('legal transition initialized->classified', transitionStage(runId, { to: 'classified', stage: 'classify' }, { root }).ok === true);
    A('normal transition logs event_type:transition, forced:false', (function () { const t = fs.readFileSync(path.join(runDir(runId, root), 'decision-log.ndjson'), 'utf8'); return /"event_type":"transition"[\s\S]*"from":"initialized"[\s\S]*"to":"classified"[\s\S]*"forced":false/.test(t); })());
    A('illegal transition classified->implementation rejected', transitionStage(runId, { to: 'implementation' }, { root }).ok === false);
    A('illegal transition still fails (unchanged behavior), no new decision-log line', (function () { const before = fs.readFileSync(path.join(runDir(runId, root), 'decision-log.ndjson'), 'utf8').split('\n').filter(Boolean).length; transitionStage(runId, { to: 'implementation' }, { root }); const after = fs.readFileSync(path.join(runDir(runId, root), 'decision-log.ndjson'), 'utf8').split('\n').filter(Boolean).length; return before === after; })());
    // W12: force:true is NOT blocked or validated further (preserves existing bypass behavior) but is
    // now explicitly visible in the audit trail — forced:true + force_reason when given.
    A('force overrides guard (unchanged behavior)', transitionStage(runId, { to: 'implementation', force: true, force_reason: 'test override' }, { root }).ok === true);
    A('forced transition logs forced:true + force_reason + from/to/run_id/event_type', (function () { const t = fs.readFileSync(path.join(runDir(runId, root), 'decision-log.ndjson'), 'utf8'); return /"run_id":"wf-selftest"[\s\S]*"event_type":"transition"[\s\S]*"from":"classified"[\s\S]*"to":"implementation"[\s\S]*"forced":true[\s\S]*"force_reason":"test override"/.test(t); })());

    // walk a legal path to plan_review for verdict
    initWorkflowState({ runId, workflowId: 'runtime_code_change', root });
    transitionStage(runId, { to: 'classified' }, { root });
    transitionStage(runId, { to: 'context_ready' }, { root });
    transitionStage(runId, { to: 'planning', stage: 'ce_plan' }, { root });
    const tp = transitionStage(runId, { to: 'plan_review' }, { root });
    A('walked to plan_review; stages_completed accumulated', tp.ok && tp.state.stages_completed.length >= 1);

    const v = appendVerdict(runId, { verdict_id: 'vd-1', reviewer: 'codex_cli', reviewer_kind: 'adversary_external', target: 'plan', verdict: 'REJECT', severity: 'high', reasons: ['x'], sends_back_to: 'ce_plan', provenance: 'fixture' }, { root });
    A('appendVerdict ok + returns normalized verdict_record', v.ok === true && v.verdict_record && v.verdict_record.verdict_id === 'vd-1' && v.verdict_record.provenance === 'fixture');
    const vlines = fs.readFileSync(verdictLogPath(runId, root), 'utf8').split(/\r?\n/).filter(Boolean);
    A('verdict log append-only (1 line, valid JSON)', vlines.length === 1 && JSON.parse(vlines[0]).verdict_id === 'vd-1');
    A('verdict mirrored into state', readWorkflowState(runId, { root }).reviewer_verdicts.length === 1);

    // W9: schema validation — malformed verdicts are REFUSED with zero writes (ndjson + mirror counts
    // asserted unchanged). unknown_legacy is read-side only, never writable.
    const vcount = () => fs.readFileSync(verdictLogPath(runId, root), 'utf8').split(/\r?\n/).filter(Boolean).length;
    const mcount = () => readWorkflowState(runId, { root }).reviewer_verdicts.length;
    const beforeV = vcount(), beforeM = mcount();
    const badCases = [
      ['unknown reviewer', { reviewer: 'evil_reviewer', verdict: 'PASS', target: 'plan', provenance: 'fixture' }],
      ['bad verdict enum', { reviewer: 'codex_cli', verdict: 'MAYBE', target: 'plan', provenance: 'fixture' }],
      ['missing provenance', { reviewer: 'codex_cli', verdict: 'PASS', target: 'plan' }],
      ['unknown_legacy on write', { reviewer: 'codex_cli', verdict: 'PASS', target: 'plan', provenance: 'unknown_legacy' }],
      ['bad severity', { reviewer: 'codex_cli', verdict: 'PASS', target: 'plan', provenance: 'fixture', severity: 'apocalyptic' }],
      ['bad sends_back_to', { reviewer: 'codex_cli', verdict: 'REJECT', target: 'plan', provenance: 'fixture', sends_back_to: '../../evil' }],
      ['empty target', { reviewer: 'codex_cli', verdict: 'PASS', target: '', provenance: 'fixture' }]
    ];
    for (const [name, bad] of badCases) {
      const r = appendVerdict(runId, bad, { root });
      A(`W9 malformed rejected (${name}): ok:false invalid_verdict, violations listed`, r.ok === false && r.error === 'invalid_verdict' && Array.isArray(r.violations) && r.violations.length > 0);
    }
    A('W9 rejected verdicts wrote NOTHING (ndjson + mirror counts unchanged)', vcount() === beforeV && mcount() === beforeM);

    // W9: auto-fill — verdict_id + created_at filled when omitted, never rejection grounds.
    const auto = appendVerdict(runId, { reviewer: 'qa_self_tests', verdict: 'PASS', target: 'implementation', provenance: 'fixture' }, { root });
    A('W9 verdict_id + created_at auto-filled when omitted', auto.ok && /^qa_self_tests-/.test(auto.verdict_record.verdict_id) && !!auto.verdict_record.created_at);

    // W9: stampProvenance — pure copy-and-overwrite; spoofed claim overwritten; original NOT mutated.
    const spoofed = { reviewer: 'codex_cli', verdict: 'PASS', target: 'plan', provenance: 'live_codex' };
    const stamped = stampProvenance(spoofed, 'cli_human');
    A('W9 stampProvenance overwrites spoofed provenance on a copy', stamped.provenance === 'cli_human' && stamped.reviewer === 'codex_cli');
    A('W9 stampProvenance does NOT mutate the original object', spoofed.provenance === 'live_codex');

    const beforeTs = readWorkflowState(runId, { root }).updated_at;
    const dlBeforePatch = fs.readFileSync(path.join(runDir(runId, root), 'decision-log.ndjson'), 'utf8').split('\n').filter(Boolean).length;
    const up = updateWorkflowState(runId, { next_action: { what: 'implement', blocking: false } }, { root, source: 'selftest', reason: 'w12 patch test' });
    A('updateWorkflowState patches + bumps updated_at', up.ok && up.state.next_action.what === 'implement' && up.state.updated_at >= beforeTs);
    A('W12: successful patch emits exactly ONE state_patched event with changed_keys + source/reason', (function () {
      const lines = fs.readFileSync(path.join(runDir(runId, root), 'decision-log.ndjson'), 'utf8').split('\n').filter(Boolean);
      const added = lines.length - dlBeforePatch;
      const last = JSON.parse(lines[lines.length - 1]);
      return added === 1 && last.event_type === 'state_patched' && last.run_id === runId &&
        Array.isArray(last.changed_keys) && last.changed_keys.includes('next_action') && last.changed_keys.length === 1 &&
        last.source === 'selftest' && last.reason === 'w12 patch test';
    })());
    A('W12: state_patched never logs the full state (no schema_version/attempt_counters keys leaked into the log line itself)', (function () {
      const lines = fs.readFileSync(path.join(runDir(runId, root), 'decision-log.ndjson'), 'utf8').split('\n').filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]);
      return !('schema_version' in last) && !('attempt_counters' in last) && !('reviewer_verdicts' in last) && Object.keys(last).length <= 6;
    })());
    const dlBeforeEmpty = fs.readFileSync(path.join(runDir(runId, root), 'decision-log.ndjson'), 'utf8').split('\n').filter(Boolean).length;
    updateWorkflowState(runId, {}, { root });
    A('W12: empty patch does NOT emit a state_patched event (no-op patch, no log noise)', fs.readFileSync(path.join(runDir(runId, root), 'decision-log.ndjson'), 'utf8').split('\n').filter(Boolean).length === dlBeforeEmpty);

    A('decision-log.ndjson written under temp run dir', fs.existsSync(path.join(runDir(runId, root), 'decision-log.ndjson')));
    A('default wsPath differs from temp (real runs/ untouched)', wsPath(runId) !== fp);
  } catch (e) {
    results.push(['exception: ' + (e && e.message), false]);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  let pass = true;
  for (const [n, ok] of results) { process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}\n`); if (!ok) pass = false; }
  process.stdout.write(pass ? 'self-test: ALL PASS\n' : 'self-test: FAILURES\n');
  return pass;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) process.exit(selfTest() ? 0 : 1);
  // Read is the only CLI op (read-only). Live writes go through the library, gated by callers.
  if (args.read && args['run-id'] && args['run-id'] !== true) {
    const st = readWorkflowState(String(args['run-id']), { root: (args.root && args.root !== true) ? String(args.root) : harnessRoot() });
    process.stdout.write(JSON.stringify(st, null, 2) + '\n');
    process.exit(0);
  }
  // Any other CLI invocation is a no-op that honors the kill switch (defensive; library is the surface).
  const dis = isDisabled();
  process.stdout.write(JSON.stringify({ ok: true, note: dis.disabled ? 'DISABLED' : 'library module — use --self-test or --read --run-id <id>' }) + '\n');
  process.exit(0);
}

if (require.main === module) main();
