#!/usr/bin/env node
// harness-loop.js — REPORT-ONLY loop entry. Takes a short goal, selects a workflow from
// config/workflows.example.json (committed authority), and prints a proposed next-stage plan.
// It STOPS there: it does NOT execute any stage, does NOT run CE/Codex/Ponytail, does NOT write
// memory or wire anything. Pure Node stdlib + _lib.js. Reads only the (committed) example config.
//
// Usage:
//   node harness-loop.js --goal "Build the workflow-state writer."
//   node harness-loop.js --goal "..." [--out <path>] [--json] [--self-test]
'use strict';
const fs = require('fs');
const path = require('path');
const { harnessRoot, parseArgs, readJson } = require('./_lib.js');
const { isDisabled } = require('./is-disabled.js');

// Keyword → workflow_id. First-match-by-score; default runtime_code_change. Bare "state" is
// intentionally NOT a memory trigger (a workflow-state writer is runtime code, not a facts-store change).
const RULES = [
  { wf: 'docs_only', kw: ['doc', 'docs', 'readme', 'documentation', 'comment', 'wording'] },
  { wf: 'ui_browser_change', kw: ['ui', 'browser', 'frontend', 'css', 'react', 'playwright', 'page', 'component', 'button'] },
  { wf: 'backend_server_debugging', kw: ['debug', 'crash', 'stack trace', 'traceback', 'server error', 'runtime error', 'failing test', 'reproduce'] },
  { wf: 'security_sensitive_change', kw: ['security', 'auth', 'secret', 'credential', 'token', 'hmac', 'permission', 'vulnerab', 'sandbox'] },
  { wf: 'memory_schema_change', kw: ['memory', 'facts.ndjson', 'fact store', 'facts schema', 'poisoning', 'capture-fact', 'read-facts'] },
  { wf: 'adapter_project_specific_change', kw: ['adapter', 'project profile', 'example-app', 'gbrain', 'project-specific', 'maps'] },
  { wf: 'open_source_transfer_package', kw: ['publish', 'open-source', 'open source', 'transfer', 'release', 'bundle', 'license'] },
  { wf: 'large_refactor', kw: ['refactor', 'rewrite', 'restructure', 'architecture', 'overhaul'] },
  { wf: 'small_code_change', kw: ['typo', 'small fix', 'tweak', 'one-line', 'rename var', 'minor'] },
  // Harness/internal implementation goals — match runtime_code_change EXPLICITLY (not via fallback).
  { wf: 'runtime_code_change', kw: ['workflow-state', 'state writer', 'runtime helper', 'helper module', 'local cli', 'harness command', 'writer', 'runtime', 'state machine', 'state model', 'state schema writer'] }
];
const DEFAULT_WF = 'runtime_code_change';

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Word-boundary match so "build" does not match the keyword "ui", etc. Handles hyphens/spaces/dots.
function wordMatch(haystack, kw) {
  try { return new RegExp('(^|[^a-z0-9])' + escapeRe(kw) + '([^a-z0-9]|$)', 'i').test(haystack); }
  catch { return haystack.includes(kw); }
}

function selectWorkflow(goal, config) {
  const g = String(goal || '').toLowerCase();
  let best = { wf: DEFAULT_WF, score: 0, matched: [] };
  for (const r of RULES) {
    const matched = r.kw.filter(k => wordMatch(g, k));
    if (matched.length > best.score && config.workflows && config.workflows[r.wf]) {
      best = { wf: r.wf, score: matched.length, matched };
    }
  }
  // Fall back to default only if it exists in config; else first available workflow.
  if (!config.workflows || !config.workflows[best.wf]) {
    const ids = Object.keys(config.workflows || {});
    best = { wf: ids[0] || null, score: 0, matched: [] };
  }
  return best;
}

function buildLoopPlan(goal, config) {
  const sel = selectWorkflow(goal, config);
  const wf = (config.workflows || {})[sel.wf] || null;
  if (!wf) return { ok: false, error: 'no_workflow_available', goal };
  const stages = wf.stages || [];
  const nextStages = stages.slice(0, 3);
  return {
    ok: true,
    goal: String(goal || ''),
    selected_workflow: sel.wf,
    selection_reason: sel.score > 0 ? `matched keywords: ${sel.matched.join(', ')}` : 'no keyword match → default (runtime_code_change)',
    readiness_level: wf.readiness_level,
    allowed_action_level: wf.allowed_action_level,
    next_stages: nextStages,
    full_stages: stages,
    required_reviewers: wf.required_reviewers || [],
    optional_reviewers: wf.optional_reviewers || [],
    human_gates: wf.human_gates || [],
    budget: wf.budget || {},
    kill_criteria: wf.kill_criteria || [],
    max_repair_loops: wf.max_repair_loops,
    proposed_next_action: `Start at stage "${nextStages[0] || stages[0] || '(none)'}" — report-only. Nothing has been executed.`,
    report_only_note: 'REPORT-ONLY: no stage executed; no CE/Codex/Ponytail run; no writes; no hooks. Run stages manually or in a later batch.'
  };
}

function toMarkdown(p) {
  if (!p.ok) return `# /harness-loop\n\n- error: ${p.error}\n- goal: ${p.goal || ''}\n`;
  const L = [];
  L.push('# /harness-loop — proposed next-stage plan (report-only)', '');
  L.push(`**Goal:** ${p.goal}`, '');
  L.push(`**Selected workflow:** \`${p.selected_workflow}\`  _(${p.selection_reason})_`);
  L.push(`**Readiness:** ${p.readiness_level} · **action level:** ${p.allowed_action_level} · **max_repair_loops:** ${p.max_repair_loops}`, '');
  L.push('**Proposed next stages:**');
  for (const s of p.next_stages) L.push(`- ${s}`);
  L.push('');
  L.push(`**Required reviewers:** ${p.required_reviewers.join(', ') || '—'}`);
  L.push(`**Optional reviewers:** ${p.optional_reviewers.join(', ') || '—'}`);
  L.push(`**Human gates:** ${p.human_gates.join(', ') || '—'}`);
  L.push(`**Budget:** ${Object.entries(p.budget).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`);
  L.push(`**Kill criteria:** ${p.kill_criteria.join(', ') || '—'}`, '');
  L.push(`**Full stage path:** ${p.full_stages.join(' → ')}`, '');
  L.push(`➡️ ${p.proposed_next_action}`);
  L.push('', `_${p.report_only_note}_`);
  return L.join('\n');
}

function loadConfig(root) {
  return readJson(path.join(root || harnessRoot(), 'config', 'workflows.example.json'), null);
}

function main() {
  // Extract mode flags FIRST so parseArgs does not consume the goal as a flag value.
  const MODES = ['--run', '--plan', '--dream', '--check-plugins'];
  const argv = process.argv.slice(2);
  const mode = MODES.find(m => argv.includes(m)) || '--plan';
  const args = parseArgs(argv.filter(a => !MODES.includes(a)));
  if (args['self-test']) process.exit(selfTest() ? 0 : 1);

  if (mode === '--check-plugins') { process.stdout.write(JSON.stringify(require('./loop-conductor.js').checkPlugins({}), null, 2) + '\n'); process.exit(0); }
  if (mode === '--dream') { process.stdout.write(JSON.stringify(require('./loop-conductor.js').dreamFromRecentRuns({}), null, 2) + '\n'); process.exit(0); }

  const goal = (args.goal && args.goal !== true) ? String(args.goal) : (args._ || []).join(' ');

  if (mode === '--run') {
    const conductor = require('./loop-conductor.js');
    // --continue: feed a reviewer verdict into an existing run; drives ONE real transition
    // (codex_cli PASS@plan_review → implementation, REJECT → repair_loop) via recordVerdict.
    if (args.continue) {
      const runId = (args['run-id'] && args['run-id'] !== true) ? String(args['run-id']) : null;
      const rv = (args['record-verdict'] && args['record-verdict'] !== true) ? String(args['record-verdict']) : null;
      if (!runId || !rv) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --run-id <id> and --record-verdict <json>' }) + '\n'); process.exit(2); }
      const disc = isDisabled();
      if (disc.disabled) { process.stdout.write(JSON.stringify({ ok: false, disabled: true, reason: disc.reason, note: 'recording a verdict writes run state; kill switch active' }) + '\n'); process.exit(0); }
      let verdict; try { verdict = JSON.parse(rv); } catch { process.stdout.write(JSON.stringify({ ok: false, error: 'record-verdict must be valid JSON' }) + '\n'); process.exit(2); }
      // W9: UNCONDITIONAL provenance stamp — anything typed through --continue is 'cli_human', no
      // matter what the JSON claims. A typed "provenance":"live_codex" is stored as cli_human.
      // This is the verdict-spoofing fix: only runCodexReview (past both gates) writes live_codex.
      verdict = require('./workflow-state.js').stampProvenance(verdict, 'cli_human');
      const res = conductor.recordVerdict(runId, verdict, {});
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res && res.ok ? 0 : 1);
    }
    // --run-codex: THE wired live driver for codex_review (W8; docs/contracts/codex_review.md §15). DOUBLE-GATED:
    // requires an explicit human --allow-codex on THIS invocation AND a separately-cleared DISABLED kill switch —
    // this CLI NEVER clears DISABLED itself (that is a separate, out-of-band human action). Only when BOTH gates
    // are open does it (1) call runCodexReview(runId,{allowExternal:true}) — the ONLY place in the whole loop that
    // spawns the real `codex` CLI — which appends the reviewer verdict itself; then (2) route THAT SAME appended
    // record via routeVerdict (NOT recordVerdict — the verdict is already written, so recordVerdict would
    // double-append): PASS→implementation, REJECT/FAIL→repair_loop via the guarded enterRepairLoop admission
    // (never a raw transition, per W6). A safety-gate refusal is the gate WORKING: exit 0, ok:true,
    // decision:"blocked_by_gate", codex_invoked:false. exit 1 only for a real runtime failure; exit 2 for CLI
    // misuse (missing --run-id). NEVER auto-invoked — a human must type --run-codex --allow-codex explicitly.
    if (args['run-codex']) {
      const runId = (args['run-id'] && args['run-id'] !== true) ? String(args['run-id']) : null;
      if (!runId) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --run-id <id> (an existing run at plan_review)' }) + '\n'); process.exit(2); }
      if (!args['allow-codex']) { process.stdout.write(JSON.stringify({ ok: true, decision: 'blocked_by_gate', gate: 'ASK_BEFORE_EXTERNAL', codex_invoked: false, verdict_written: false, state_transition: false, note: 'Codex is an external model/cost call; re-run with --allow-codex (and a separately cleared DISABLED) to approve' }, null, 2) + '\n'); process.exit(0); }
      const disc = isDisabled();
      if (disc.disabled) { process.stdout.write(JSON.stringify({ ok: true, decision: 'blocked_by_gate', gate: 'DISABLED', codex_invoked: false, verdict_written: false, state_transition: false, reason: disc.reason, note: 'kill switch active — clear it (separate, human, out-of-band) before Codex can be spawned' }, null, 2) + '\n'); process.exit(0); }
      const rootArg = (args.root && args.root !== true) ? String(args.root) : undefined;
      const timeoutMs = (args['timeout-ms'] && args['timeout-ms'] !== true) ? Number(args['timeout-ms']) : undefined;
      const review = conductor.runCodexReview(runId, { allowExternal: true, root: rootArg, timeoutMs });
      // W10: a plan-lint block is clean safety behavior, not a failure — print as-is (already carries
      // ok:true, decision:'blocked_by_plan_lint', codex_invoked:false, verdict_written:false,
      // state_transition:false) and stop BEFORE any verdict/routing, same exit-0-on-safe-gate spirit
      // as the ASK_BEFORE_EXTERNAL/DISABLED gates above.
      if (review.ok && review.decision === 'blocked_by_plan_lint') { process.stdout.write(JSON.stringify(review, null, 2) + '\n'); process.exit(0); }
      if (!review.ok) { process.stdout.write(JSON.stringify(Object.assign({ codex_invoked: true, verdict_written: false, state_transition: false }, review), null, 2) + '\n'); process.exit(1); }
      const routed = conductor.routeVerdict(runId, review.verdict_record, { root: rootArg });
      const transitioned = !!(routed && routed.ok && !/no auto-transition/.test(routed.note || ''));
      const res = { ok: review.ok && !!(routed && routed.ok), decision: 'codex_reviewed', gate: null, codex_invoked: true, verdict_written: true, state_transition: transitioned, verdict: review.verdict, review, routed };
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res.ok ? 0 : 1);
    }
    // --check-codex-timeout-retry: REPORT-ONLY exercise of the timeout/retry wrapper over a BUNDLED LOCAL
    // fixture (--fixture success|nonzero|sleep|malformed|missing). It spawns ONLY the named local fixture
    // (no arbitrary command, NO Codex, no model, no network). Prints the outcome; writes a report-only
    // codex_timeout_retry_check decision-log event if --run-id is given. NO transition / repair / verdict.
    if (args['check-codex-timeout-retry']) {
      const fixture = (args.fixture && args.fixture !== true) ? String(args.fixture) : null;
      const allowed = ['success', 'nonzero', 'sleep', 'malformed', 'missing'];
      if (!fixture || !allowed.includes(fixture)) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --fixture one of: ' + allowed.join('|') }) + '\n'); process.exit(2); }
      const rootArg = (args.root && args.root !== true) ? String(args.root) : harnessRoot();
      const dir = path.join(rootArg, 'evals', 'fixtures', 'codex-timeout');
      const command = fixture === 'missing' ? path.join(dir, '__no_such_fixture__.js') : process.execPath;
      const cargs = fixture === 'missing' ? [] : [path.join(dir, fixture + '.js')];
      const timeoutMs = (args['timeout-ms'] && args['timeout-ms'] !== true) ? Number(args['timeout-ms']) : (fixture === 'sleep' ? 200 : 5000);
      const maxRetries = (args['max-retries'] !== undefined && args['max-retries'] !== true) ? Number(args['max-retries']) : undefined;
      const runId = (args['run-id'] && args['run-id'] !== true) ? String(args['run-id']) : undefined;
      const res = conductor.runWithTimeoutRetry({ command, args: cargs, timeoutMs, maxRetries, runId, root: (args.root && args.root !== true) ? String(args.root) : undefined });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res && res.ok ? 0 : 1);
    }
    // --parse-codex-verdict: REPORT-ONLY pure parse of a SAVED Codex final-message file (--file <path>).
    // Prints the normalized verdict object. Does NOT invoke Codex, does NOT spawn anything, does NOT write
    // any verdict or touch run state — a local file read + deterministic parse only. Ungated (no side effects).
    if (args['parse-codex-verdict']) {
      const file = (args.file && args.file !== true) ? String(args.file) : null;
      if (!file) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --file <path> (a saved Codex final-message file)' }) + '\n'); process.exit(2); }
      let text; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: 'cannot read --file', detail: String(e.message || e).slice(0, 160) }) + '\n'); process.exit(2); }
      const parsed = conductor.parseCodexVerdict(text);
      process.stdout.write(JSON.stringify({ ok: true, report_only: true, file, parsed, note: 'report-only: pure parse; NO Codex, NO spawn, NO write, NO state change' }, null, 2) + '\n');
      process.exit(0);
    }
    // --enter-repair-loop: ADMISSION + COUNTER on an existing run. Checks the cap (W4 guard); if allowed AND
    // the source→repair_loop transition is legal, increments repair_loops_used once, writes a repair_loop_entered
    // decision-log event, and transitions to repair_loop. Runs NO repair, invokes NO reviewer. blocked (cap) /
    // error (illegal source or bad config) / skipped (DISABLED). NOT auto-called — conductor stays non-autonomous.
    if (args['enter-repair-loop']) {
      const runId = (args['run-id'] && args['run-id'] !== true) ? String(args['run-id']) : null;
      if (!runId) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --run-id <id> (an existing run)' }) + '\n'); process.exit(2); }
      const reason = (args.reason && args.reason !== true) ? String(args.reason) : undefined;
      const res = conductor.enterRepairLoop(runId, { reason });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res && res.ok ? 0 : 1);
    }
    // --check-max-repair-loops: deterministic SAFETY GUARD on an existing run. Reads the repair counter +
    // cap from workflow-state; returns allow (under cap) / block (at-or-over; enforces repair_loop->escalated
    // only when in repair_loop) / error (missing/malformed config — fail-closed, never allow) / skipped
    // (DISABLED). Writes a decision-log event on block/error. Runs NO repair, invokes NO reviewer/Codex/CE.
    if (args['check-max-repair-loops']) {
      const runId = (args['run-id'] && args['run-id'] !== true) ? String(args['run-id']) : null;
      if (!runId) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --run-id <id> (an existing run)' }) + '\n'); process.exit(2); }
      const res = conductor.checkMaxRepairLoops(runId, {});
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res && res.ok ? 0 : 1);
    }
    // --run-qa-self-tests: REPORT-ONLY deterministic QA on an existing run. Runs the module --self-tests,
    // records ONE qa_self_tests verdict (+ report-only decision-log event). NEVER transitions state,
    // NEVER triggers repair_loop, NEVER calls external tools/models. SKIPPED (no write) under DISABLED.
    if (args['run-qa-self-tests']) {
      const runId = (args['run-id'] && args['run-id'] !== true) ? String(args['run-id']) : null;
      if (!runId) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --run-id <id> (an existing run)' }) + '\n'); process.exit(2); }
      const res = conductor.runQaSelfTests(runId, {});
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res && res.ok ? 0 : 1);
    }
    // --run-ponytail-budget: REPORT-ONLY arithmetic compactness gauge on PROVIDED counts (--files/--lines).
    // Records ONE ponytail_budget verdict (+ report-only decision-log event). NO git-diff, NO write-time
    // enforcement, NO model, real /ponytail-review NOT invoked. NEVER transitions/repair. SKIPPED under DISABLED.
    if (args['run-ponytail-budget']) {
      const runId = (args['run-id'] && args['run-id'] !== true) ? String(args['run-id']) : null;
      if (!runId) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --run-id <id> (an existing run)' }) + '\n'); process.exit(2); }
      const res = conductor.runPonytailBudget(runId, { files: args.files, lines: args.lines });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res && res.ok ? 0 : 1);
    }
    // --run-qa-evals: gated LOCAL regression-eval driver (W11; docs/contracts/qa_evals.md). Runs the
    // existing scripts/run-evals.js suite (local Node child process, no network/model), records ONE
    // qa_evals verdict via the existing recordVerdict/routeVerdict (PASS@verification -> final_review;
    // FAIL/ERROR -> guarded enterRepairLoop when applicable) — NEVER a raw transitionStage. DISABLED is
    // checked HERE, before any eval execution, so a kill-switch skip can never be mistaken for a PASS:
    // returns the exact blocked_by_gate shape (ok:true, qa_evals_invoked:false, verdict_written:false,
    // state_transition:false), exit 0 — clean safety behavior, not a failure.
    if (args['run-qa-evals']) {
      const runId = (args['run-id'] && args['run-id'] !== true) ? String(args['run-id']) : null;
      if (!runId) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --run-id <id> (an existing run)' }) + '\n'); process.exit(2); }
      const disc = isDisabled();
      if (disc.disabled) { process.stdout.write(JSON.stringify({ ok: true, decision: 'blocked_by_gate', gate: 'DISABLED', qa_evals_invoked: false, verdict_written: false, state_transition: false, reason: disc.reason, note: 'kill switch active — no evals run, no verdict written' }, null, 2) + '\n'); process.exit(0); }
      const res = conductor.runQaEvals(runId, {});
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res && res.ok ? 0 : 1);
    }
    if (!goal) { process.stdout.write(JSON.stringify({ ok: false, error: 'no_goal', hint: '/harness-loop --run <goal>' }) + '\n'); process.exit(2); }
    const dis = isDisabled();
    if (dis.disabled) { process.stdout.write(JSON.stringify({ ok: false, mode: 'run', disabled: true, reason: dis.reason, note: '--run is workflow-affecting; DISABLED kill switch is active. Clearing it needs explicit approval.' }) + '\n'); process.exit(0); }
    const r = conductor.startRun(goal, {});
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.stdout.write('\nKICKOFF conductor: run created, memory read, advanced to planning — this is a KICKOFF, not a full loop.\nNEXT (host handoff): ' + (r.next ? r.next.action + ' [gate: ' + r.next.gate + ']' : '(none)') + '\nAfter Codex review, advance with:\n  harness-loop --run --continue --run-id ' + r.run_id + ' --record-verdict \'{"reviewer":"codex_cli","verdict":"PASS","target":"plan"}\'\n');
    process.exit(0);
  }
  if (!goal) { process.stdout.write(JSON.stringify({ ok: false, error: 'no_goal', hint: 'harness-loop.js --goal "<short goal>"' }) + '\n'); process.exit(2); }
  const config = loadConfig((args.root && args.root !== true) ? String(args.root) : harnessRoot());
  if (!config) { process.stdout.write(JSON.stringify({ ok: false, error: 'workflows.example.json not found/unreadable' }) + '\n'); process.exit(2); }
  const plan = buildLoopPlan(goal, config);
  const body = args.json ? JSON.stringify(plan, null, 2) : toMarkdown(plan);
  if (args.out && args.out !== true) {
    fs.mkdirSync(path.dirname(path.resolve(String(args.out))), { recursive: true });
    fs.writeFileSync(String(args.out), body + '\n');
    process.stdout.write(JSON.stringify({ ok: plan.ok, wrote: String(args.out), selected_workflow: plan.selected_workflow }) + '\n');
  } else {
    process.stdout.write(body + '\n');
  }
  process.exit(0);
}

function selfTest() {
  const results = [];
  const A = (n, c) => results.push([n, !!c]);
  try {
    const config = loadConfig();
    A('config loads (committed workflows.example.json)', !!(config && config.workflows));
    if (config && config.workflows) {
      const selWS = selectWorkflow('Build the workflow-state writer.', config);
      A('goal "Build the workflow-state writer." → runtime_code_change (EXPLICIT, not fallback)', selWS.wf === 'runtime_code_change' && selWS.score > 0);
      A('goal "update the README docs" → docs_only', selectWorkflow('update the README docs', config).wf === 'docs_only');
      A('goal "fix auth token leak" → security_sensitive_change', selectWorkflow('fix auth token leak', config).wf === 'security_sensitive_change');
      A('goal "tweak browser button css" → ui_browser_change', selectWorkflow('tweak browser button css', config).wf === 'ui_browser_change');
      const plan = buildLoopPlan('Build the workflow-state writer.', config);
      A('plan ok + has next_stages', plan.ok && plan.next_stages.length > 0);
      A('plan is report-only (note present)', /REPORT-ONLY/.test(plan.report_only_note));
      A('markdown renders goal + workflow', /harness-loop/.test(toMarkdown(plan)) && toMarkdown(plan).includes('runtime_code_change'));
    }
  } catch (e) { results.push(['exception: ' + (e && e.message), false]); }
  let pass = true;
  for (const [n, ok] of results) { process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}\n`); if (!ok) pass = false; }
  process.stdout.write(pass ? 'self-test: ALL PASS\n' : 'self-test: FAILURES\n');
  return pass;
}

module.exports = { selectWorkflow, buildLoopPlan, toMarkdown };

if (require.main === module) main();
