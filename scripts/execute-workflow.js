#!/usr/bin/env node
// execute-workflow.js — HarnessKit Productization Phase 1: the real stage-dispatch engine.
// workflow-dag.json is not a report generated beside a fixed pipeline -- this file actually
// executes it, in dependency (topological) order, re-resolving each stage's capabilities at
// execution time (state can change between compose and execute), and writing real status back.
//
// Two honest stage types, not hidden:
//   - AUTOMATED: a real handler runs synchronously and produces a real result (inspect,
//     discover, classify, challenge, deterministic-verify, prepare-commit, final-report).
//   - ORCHESTRATOR: the handler sets the stage up (writes `inputs`, marks
//     'awaiting_orchestrator') and returns control -- a script cannot itself dispatch a Claude
//     Code subagent or do open-ended planning/implementation/review; only the orchestrating
//     agent can. This mirrors commands/harness-run.md's own existing, disclosed distinction between
//     script-enforced and host-model-followed stages -- not a new invented pattern.
//
// A stage whose required capabilities don't resolve gets status:'missing_capability' and every
// stage that depends on it (directly or transitively) gets 'blocked_by_dependency' -- execution
// stops there. Never skipped, never silently marked complete, never a false end-to-end claim.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseArgs, nowIso, tokenizeCommand } = require('./_lib.js');
const { resolveStage } = require('./capability-resolver.js');
const { discoverTasks } = require('./task-discovery.js');
// P5a shared-handler extraction: AUTOMATED_HANDLERS/completeStage/validateReviewIndependence/
// classifyTaskClass/the individual handleX functions used to be defined inline in this file --
// they now live in workflow-handlers.js, the one shared module both this (legacy) engine and
// scripts/langgraph-workflow.js depend on. This file re-exports the ones downstream consumers
// (bin/harnesskit.js) already imported from here, so nothing outside this file needs to change.
// The shared handlers live in workflow-handlers.js.
const {
  AUTOMATED_HANDLERS, completeStage, validateReviewIndependence,
  classifyTaskClass, handleChallengeTask, handleDeterministicVerify, handlePrepareCommit
} = require('./workflow-handlers.js');
// Engine/checkpoint identity (docs/ENGINE_CHECKPOINT_IDENTITY_REPORT.md): dag.engine's canonical
// shape ({ name, schema_version }) and version constant are owned by compose-workflow.js -- the one
// place that stamps a freshly composed dag. No cycle: compose-workflow.js never requires this file.
const { ENGINE_SCHEMA_VERSION } = require('./compose-workflow.js');
// Security Broker Architecture (docs/SECURITY_BROKER_ARCHITECTURE_REPORT.md): handlePrepareCommit's
// scan-before-commit call (imported above via workflow-handlers.js) is routed through this exact
// module object -- required here too, not for direct use, so the self-test below can monkey-patch
// commitBroker.scanBeforeCommit and have workflow-handlers.js's call site see the same patched
// function (both requires resolve to the same cached module.exports singleton).
const commitBroker = require('./security-brokers/commit-broker.js');

const ORCHESTRATOR_STAGES = new Set(['plan', 'execute', 'independent-review']);

// --- Topological order from `dependencies`, not array position (Kahn's algorithm) ---
function topologicalOrder(stages) {
  const byId = new Map(stages.map(s => [s.stage_id, s]));
  const inDegree = new Map(stages.map(s => [s.stage_id, 0]));
  for (const s of stages) for (const d of s.dependencies || []) {
    if (!byId.has(d)) continue; // dangling dependency reference -- ignored, not crashed on
    inDegree.set(s.stage_id, (inDegree.get(s.stage_id) || 0) + 1);
  }
  const queue = stages.filter(s => (inDegree.get(s.stage_id) || 0) === 0).map(s => s.stage_id);
  const order = [];
  const remaining = new Set(stages.map(s => s.stage_id));
  while (queue.length) {
    const id = queue.shift();
    if (!remaining.has(id)) continue;
    order.push(id);
    remaining.delete(id);
    for (const s of stages) {
      if ((s.dependencies || []).includes(id) && remaining.has(s.stage_id)) {
        const stillWaiting = (s.dependencies || []).some(d => remaining.has(d) && d !== id);
        if (!stillWaiting) queue.push(s.stage_id);
      }
    }
  }
  for (const id of remaining) order.push(id); // cycle fallback -- append remaining in original order rather than hang
  return order.map(id => byId.get(id));
}

function transitivelyBlockedBy(stages, failedId) {
  const blocked = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of stages) {
      if (blocked.has(s.stage_id) || s.stage_id === failedId) continue;
      const deps = s.dependencies || [];
      if (deps.includes(failedId) || deps.some(d => blocked.has(d))) { blocked.add(s.stage_id); changed = true; }
    }
  }
  return blocked;
}

// executeWorkflow(dag, ctx) -> mutates dag.stages in place, returns { dag, pausedAt }
// Runs automated stages; stops (pausedAt = stage_id) at the first orchestrator stage or the first
// unresolved/needs_user stage. Never marks a downstream stage complete past a stop point.
function executeWorkflow(dag, ctx) {
  // Engine/checkpoint identity (docs/ENGINE_CHECKPOINT_IDENTITY_REPORT.md): compose-workflow.js
  // stamps every freshly composed dag with dag.engine = { name, schema_version } already. This is
  // a fallback only, for a dag.json on disk from before that stamping existed -- stamped once,
  // never overwritten on a later resume of the SAME dag, so a dag genuinely produced by the OTHER
  // engine must keep saying so, not get silently relabeled 'legacy' the first time it passes
  // through this function.
  if (dag.engine === undefined) dag.engine = { name: 'legacy', schema_version: ENGINE_SCHEMA_VERSION };
  const ordered = topologicalOrder(dag.stages);
  let pausedAt = null;
  for (const stage of ordered) {
    if (stage.status === 'completed') continue; // resuming past already-done stages
    const deps = stage.dependencies || [];
    const blockedDep = deps.find(d => {
      const ds = dag.stages.find(s => s.stage_id === d);
      return !ds || (ds.status !== 'completed');
    });
    if (blockedDep) { stage.status = 'blocked_by_dependency'; continue; }

    // Reviewer-capability resolution is NOT vendor-pinned: the 'independent-review' stage resolves
    // the same 'review' capability every other stage would, through the same capability-resolver /
    // router/select-adapter.js machinery -- but using the router's existing independent_review
    // policy (accepts claimed-or-better/quarantined-or-better -- the point is a second opinion, not
    // the single strongest adapter) AND excluding whichever adapter the 'execute' stage actually
    // used. Today that means codex-cli is very often the one adapter left standing (claude-code is
    // usually both the strongest producer AND therefore excluded as reviewer) -- but that's an
    // outcome of evidence + exclusion, never a hardcoded "reviewer == codex" branch.
    let resolveOpts = { repoProfile: ctx.repoProfile, policy: 'highest_verified_quality' };
    if (stage.stage_id === 'independent-review') {
      const executeStage = dag.stages.find(s => s.stage_id === 'execute');
      const producerAdapterId = executeStage && executeStage.selected_adapter;
      resolveOpts = { repoProfile: ctx.repoProfile, policy: 'independent_review', excludeAdapter: producerAdapterId };
    }
    const resolution = resolveStage(stage, resolveOpts);
    if (!resolution.ok) {
      stage.status = 'missing_capability';
      stage.selection_reason = `unresolved at execution time: ${resolution.results.filter(r => !r.ok).map(r => r.detail).join('; ')}`;
      for (const id of transitivelyBlockedBy(dag.stages, stage.stage_id)) {
        const s = dag.stages.find(x => x.stage_id === id);
        if (s) s.status = 'blocked_by_dependency';
      }
      pausedAt = stage.stage_id;
      break;
    }
    stage.selected_adapter = resolution.selected_adapter;

    if (ORCHESTRATOR_STAGES.has(stage.stage_id)) {
      stage.status = 'awaiting_orchestrator';
      stage.inputs = ctx.orchestratorInputs ? (ctx.orchestratorInputs[stage.stage_id] || []) : [];
      pausedAt = stage.stage_id;
      break;
    }

    const handler = AUTOMATED_HANDLERS[stage.stage_id];
    if (!handler) {
      stage.status = 'missing_capability';
      stage.selection_reason = `no automated handler registered for stage_id '${stage.stage_id}'`;
      pausedAt = stage.stage_id;
      break;
    }
    const result = handler(stage, ctx, dag.stages);
    stage.status = result.status;
    stage.outputs = result.outputs;
    if (result.status !== 'completed') { pausedAt = stage.stage_id; break; }
  }
  return { dag, pausedAt };
}

async function selfTest() {
  const os = require('os');
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // 0. Tokenizer (now shared via _lib.js) handles quoted arguments correctly.
  {
    const tokens = tokenizeCommand('node -e "process.exit(1)"');
    push('tokenizer_handles_quoted_arguments', JSON.stringify(tokens) === JSON.stringify(['node', '-e', 'process.exit(1)']), JSON.stringify(tokens));
  }
  // 1. Topological order respects real dependencies, not array position (reversed input array).
  {
    const stages = [
      { stage_id: 'c', dependencies: ['b'] }, { stage_id: 'b', dependencies: ['a'] }, { stage_id: 'a', dependencies: [] }
    ];
    const order = topologicalOrder(stages).map(s => s.stage_id);
    push('topological_order_respects_dependencies_not_array_position', JSON.stringify(order) === JSON.stringify(['a', 'b', 'c']), JSON.stringify(order));
  }
  // 2. A missing_capability stage halts execution and blocks all transitive dependents; nothing past it runs or claims completion.
  {
    const dag = {
      stages: [
        { stage_id: 'inspect-repository', required_capabilities: ['terminal'], dependencies: [], status: 'pending' },
        { stage_id: 'discover-task', required_capabilities: ['nonexistent-capability-xyz'], dependencies: ['inspect-repository'], status: 'pending' },
        { stage_id: 'classify-task', required_capabilities: ['planning'], dependencies: ['discover-task'], status: 'pending' }
      ]
    };
    const os2 = require('os');
    const tmp = fs.mkdtempSync(path.join(os2.tmpdir(), 'hk-exec-wf-selftest-'));
    fs.mkdirSync(tmp, { recursive: true });
    const ctx = { targetPath: tmp, artifactsDir: path.join(tmp, '.harnesskit'), runId: 'r1' };
    const { pausedAt } = executeWorkflow(dag, ctx);
    const discoverStage = dag.stages.find(s => s.stage_id === 'discover-task');
    const classifyStage = dag.stages.find(s => s.stage_id === 'classify-task');
    push('missing_capability_halts_and_blocks_dependents',
      pausedAt === 'discover-task' && discoverStage.status === 'missing_capability' && classifyStage.status === 'blocked_by_dependency',
      JSON.stringify({ pausedAt, discoverStage, classifyStage }));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 3. Orchestrator stage pauses execution honestly (awaiting_orchestrator), does not fabricate completion.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest2-'));
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]\nname="x"\n[tool.pytest.ini_options]\ntestpaths=["t"]\n');
    const dag = {
      stages: [
        { stage_id: 'inspect-repository', required_capabilities: ['terminal'], dependencies: [], status: 'pending' },
        { stage_id: 'plan', required_capabilities: ['planning'], dependencies: ['inspect-repository'], status: 'pending' },
        { stage_id: 'execute', required_capabilities: ['implementation'], dependencies: ['plan'], status: 'pending' }
      ]
    };
    const ctx = { targetPath: tmp, artifactsDir: path.join(tmp, '.harnesskit'), runId: 'r2' };
    const { pausedAt } = executeWorkflow(dag, ctx);
    const planStage = dag.stages.find(s => s.stage_id === 'plan');
    const executeStage = dag.stages.find(s => s.stage_id === 'execute');
    push('orchestrator_stage_pauses_honestly', pausedAt === 'plan' && planStage.status === 'awaiting_orchestrator' && executeStage.status === 'pending',
      JSON.stringify({ pausedAt, planStage, executeStage }));

    // 4. completeStage + re-invoking executeWorkflow resumes past the completed orchestrator stage.
    completeStage(dag, 'plan', { status: 'completed', outputs: { plan_summary: 'test plan' } });
    const { pausedAt: pausedAt2 } = executeWorkflow(dag, ctx);
    push('resume_after_completeStage_advances_past_completed_stage', pausedAt2 === 'execute' && dag.stages.find(s => s.stage_id === 'execute').status === 'awaiting_orchestrator',
      JSON.stringify({ pausedAt2, planStage: dag.stages.find(s => s.stage_id === 'plan') }));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 5. deterministic-verify actually RUNS the detected command for real (not simulated), reports a
  //    real exit code, AND now classifies it as VERIFIED_PASS (the 7-state status, not just true/false).
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest3-'));
    const stage = { stage_id: 'deterministic-verify', required_capabilities: ['repo.test'] };
    const ctx = { targetPath: tmp, repoProfile: { package_root: null, commands: { test: { command: process.platform === 'win32' ? 'cmd /c exit 0' : 'true' } } } };
    // Windows: 'cmd /c exit 0' as a single command.split(' ') would mis-split -- use a simpler always-succeeding real binary instead for portability.
    const realCmd = process.platform === 'win32' ? { command: 'node -e "process.exit(0)"' } : { command: 'true' };
    ctx.repoProfile.commands.test = realCmd;
    const result = handleDeterministicVerify(stage, ctx);
    push('deterministic_verify_runs_real_command',
      result.status === 'completed' && result.outputs.results[0].ran === true && result.outputs.results[0].exit_code === 0 &&
      result.outputs.verification_status === 'VERIFIED_PASS' && result.outputs.results[0].classification.status === 'VERIFIED_PASS',
      JSON.stringify(result));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 6. deterministic-verify reports a real FAILURE honestly (non-zero exit) and, with no baseline/
  //    diff-overlap explanation, classifies it as FAILED -- a hard block, no override possible.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest4-'));
    const stage = { stage_id: 'deterministic-verify', required_capabilities: ['repo.test'] };
    const ctx = { targetPath: tmp, repoProfile: { package_root: null, commands: { test: { command: 'node -e "process.exit(1)"' } } } };
    const result = handleDeterministicVerify(stage, ctx);
    push('deterministic_verify_reports_real_failure',
      result.status === 'failed' && result.outputs.results[0].exit_code === 1 &&
      result.outputs.verification_status === 'FAILED' && result.outputs.blocking === true && result.outputs.override === null,
      JSON.stringify(result));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 6a. deterministic-verify: KNOWN_PREEXISTING_FAILURES is overridable -- blocked without an
  //     override, completes WITH a well-shaped override, and the override is recorded in outputs
  //     (visible in the persisted state / final report), never applied silently.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest-override-'));
    const stage = { stage_id: 'deterministic-verify', required_capabilities: ['repo.test'] };
    const cmd = `node -e "console.log('FAILED tests/test_x.py::test_flaky_legacy'); process.exit(1)"`;
    const ctxNoOverride = { targetPath: tmp, repoProfile: { package_root: null, commands: { test: { command: cmd } } }, verificationBaselines: { test: ['tests/test_x.py::test_flaky_legacy'] } };
    const blocked = handleDeterministicVerify(stage, ctxNoOverride);
    push('overridable_status_blocks_without_override',
      blocked.status === 'blocked_pending_override' && blocked.outputs.verification_status === 'KNOWN_PREEXISTING_FAILURES',
      JSON.stringify(blocked));

    const override = { overridden_by: 'owner', reason: 'known flaky legacy test, tracked separately', overridden_at: nowIso() };
    const ctxWithOverride = Object.assign({}, ctxNoOverride, { verificationOverride: override });
    const allowed = handleDeterministicVerify(stage, ctxWithOverride);
    push('overridable_status_proceeds_with_explicit_recorded_override',
      allowed.status === 'completed' && allowed.outputs.override && allowed.outputs.override.overridden_by === 'owner' && allowed.outputs.override.applied_to_status === 'KNOWN_PREEXISTING_FAILURES',
      JSON.stringify(allowed));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 6a2. FINDING 3 FIX: REGRESSION_DETECTED driven end-to-end through handleDeterministicVerify.
  //      A STRONG (distinctive-name) regression correlation remains an unconditional hard block --
  //      even a well-shaped override (including one that says the magic 'heuristic-only' phrase)
  //      must NOT unblock it, because it was never heuristic-only to begin with. A WEAK
  //      (generic-filename-token-only) regression correlation is blocked without an override,
  //      blocked by a plain override that doesn't acknowledge the heuristic-only nature, and only
  //      proceeds with an override whose reason explicitly says so.
  {
    // Strong: diffed file is 'widget.py' (distinctive name) and the failing test genuinely
    // references it -- must hard-block regardless of any override.
    const tmpStrong = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest-regression-strong-'));
    const stageStrong = { stage_id: 'deterministic-verify', required_capabilities: ['repo.test'] };
    const cmdStrong = `node -e "console.log('FAILED tests/test_widget.py::test_widget_renders'); process.exit(1)"`;
    const ctxStrongNoOverride = { targetPath: tmpStrong, repoProfile: { package_root: null, commands: { test: { command: cmdStrong } } }, diffFiles: ['src/widget.py'] };
    const strongBlocked = handleDeterministicVerify(stageStrong, ctxStrongNoOverride);
    push('strong_regression_hard_blocks_without_override',
      strongBlocked.status === 'failed' && strongBlocked.outputs.verification_status === 'REGRESSION_DETECTED' && strongBlocked.outputs.blocking === true,
      JSON.stringify(strongBlocked));

    const heuristicSoundingOverride = { overridden_by: 'owner', reason: 'heuristic-only overlap, not a real regression', overridden_at: nowIso() };
    const ctxStrongWithOverride = Object.assign({}, ctxStrongNoOverride, { verificationOverride: heuristicSoundingOverride });
    const strongStillBlocked = handleDeterministicVerify(stageStrong, ctxStrongWithOverride);
    push('strong_regression_never_overridable_even_with_heuristic_only_sounding_reason',
      strongStillBlocked.status === 'failed' && strongStillBlocked.outputs.blocking === true,
      JSON.stringify(strongStillBlocked));
    fs.rmSync(tmpStrong, { recursive: true, force: true });

    // Weak: diffed file is 'utils.py' (generic name) and the failing test's own name is genuinely
    // unrelated (string formatting), colliding only on the shared 'utils' naming-convention token.
    const tmpWeak = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest-regression-weak-'));
    const stageWeak = { stage_id: 'deterministic-verify', required_capabilities: ['repo.test'] };
    const cmdWeak = `node -e "console.log('FAILED tests/test_string_utils_formatting.py::test_format_currency'); process.exit(1)"`;
    const ctxWeakNoOverride = { targetPath: tmpWeak, repoProfile: { package_root: null, commands: { test: { command: cmdWeak } } }, diffFiles: ['src/utils.py'] };
    const weakBlocked = handleDeterministicVerify(stageWeak, ctxWeakNoOverride);
    push('heuristic_only_regression_blocks_without_override',
      weakBlocked.status === 'blocked_pending_override' && weakBlocked.outputs.verification_status === 'REGRESSION_DETECTED',
      JSON.stringify(weakBlocked));

    const plainOverride = { overridden_by: 'owner', reason: 'looks fine to me, ship it', overridden_at: nowIso() };
    const ctxWeakPlainOverride = Object.assign({}, ctxWeakNoOverride, { verificationOverride: plainOverride });
    const weakStillBlockedOnPlainReason = handleDeterministicVerify(stageWeak, ctxWeakPlainOverride);
    push('heuristic_only_regression_rejects_override_that_does_not_acknowledge_heuristic_only',
      weakStillBlockedOnPlainReason.status === 'blocked_pending_override',
      JSON.stringify(weakStillBlockedOnPlainReason));

    // FINDING 3 FIX: a free-text reason that merely SAYS "heuristic-only overlap" -- the exact
    // shape that used to satisfy the old `/heuristic-only/i.test(reason)` regex -- must NO LONGER
    // be sufficient on its own. This is the precise, previously-exploitable shape: an orchestrating
    // agent echoing the guard's own vocabulary back into a self-authored `reason` string with zero
    // real proof anyone but the agent itself made the determination.
    const oldWeakShapeOverride = { overridden_by: 'owner', reason: 'confirmed heuristic-only overlap on a generic filename token, unrelated to this diff', overridden_at: nowIso() };
    const ctxWeakOldShapeOverride = Object.assign({}, ctxWeakNoOverride, { verificationOverride: oldWeakShapeOverride });
    const weakStillBlockedOnOldShape = handleDeterministicVerify(stageWeak, ctxWeakOldShapeOverride);
    push('heuristic_only_regression_rejects_bare_freetext_reason_even_if_it_says_the_magic_phrase',
      weakStillBlockedOnOldShape.status === 'blocked_pending_override',
      JSON.stringify(weakStillBlockedOnOldShape));

    const acknowledgingOverride = { overridden_by: 'owner', reason: 'confirmed heuristic-only overlap on a generic filename token, unrelated to this diff', overridden_at: nowIso(), classification_basis: 'heuristic_only_acknowledged' };
    const ctxWeakGoodOverride = Object.assign({}, ctxWeakNoOverride, { verificationOverride: acknowledgingOverride });
    const weakProceedsWithAcknowledgment = handleDeterministicVerify(stageWeak, ctxWeakGoodOverride);
    push('heuristic_only_regression_proceeds_with_acknowledging_override',
      weakProceedsWithAcknowledgment.status === 'completed' && weakProceedsWithAcknowledgment.outputs.override && weakProceedsWithAcknowledgment.outputs.override.heuristic_only_override === true,
      JSON.stringify(weakProceedsWithAcknowledgment));
    fs.rmSync(tmpWeak, { recursive: true, force: true });
  }
  // 6b. security-boundary trust boundary (3): deterministic-verify redacts a real secret that
  // leaks into command output before it's ever written into results/artifacts.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest-secretout-'));
    const leakedKey = 'AKIAIOSFODNN7EXAMPLE'; // fake value for tests
    const stage = { stage_id: 'deterministic-verify', required_capabilities: ['repo.test'] };
    const ctx = { targetPath: tmp, repoProfile: { package_root: null, commands: { test: { command: `node -e "console.log('AWS_ACCESS_KEY_ID=${leakedKey}')"` } } } };
    const result = handleDeterministicVerify(stage, ctx);
    const r0 = result.outputs.results[0];
    // Note: redact.js applies its patterns sequentially, and the generic dotenv_assign pattern can
    // re-match and relabel an already-redacted aws_access_key value as the more generic
    // env_value marker -- the SECURITY property (raw secret never appears) still holds either way,
    // this only asserts that property, not which specific marker label wins the chain.
    push('tool_output_secret_leak_redacted_not_raw', r0.ran === true && !r0.output_tail.includes(leakedKey) && /\[REDACTED:/.test(r0.output_tail), JSON.stringify(r0));
    push('tool_output_scan_reports_not_clean', r0.output_scan && r0.output_scan.clean === false && r0.output_scan.finding_count > 0, JSON.stringify(r0.output_scan));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 6c. security-boundary trust boundary (5): prepare-commit refuses to commit a real secret in
  // the staged diff -- the specific commit action is blocked, the repo is unstaged, no commit is
  // created. Then a clean follow-up commit on the SAME repo succeeds normally (non-blocking proof:
  // the gate stops the one bad commit, not all future commits).
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest-commitscan-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'README.md'), '# seed\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: tmp });
    const shaBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(tmp, 'config.env'), 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n'); // fake value for tests
    const allStages = [
      { stage_id: 'plan', status: 'completed' }, { stage_id: 'execute', status: 'completed' },
      { stage_id: 'deterministic-verify', status: 'completed' }, { stage_id: 'independent-review', status: 'completed' }
    ];
    const ctx = { targetPath: tmp, commitMessage: 'feat: add config (contains a leaked secret)' };
    const result = handlePrepareCommit({}, ctx, allStages);
    const shaAfterBlocked = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
    push('commit_with_secret_blocked_not_committed', result.status === 'blocked' && result.outputs.findings.some(f => f.type === 'aws_access_key') && shaAfterBlocked === shaBefore, JSON.stringify({ status: result.status, findingTypes: (result.outputs.findings || []).map(f => f.type), shaBefore, shaAfterBlocked }));

    fs.rmSync(path.join(tmp, 'config.env'));
    fs.writeFileSync(path.join(tmp, 'README.md'), '# seed\n\nupdated, no secrets here.\n');
    const ctx2 = { targetPath: tmp, commitMessage: 'docs: update readme' };
    const result2 = handlePrepareCommit({}, ctx2, allStages);
    push('clean_commit_after_blocked_one_still_succeeds', result2.status === 'completed' && !!result2.outputs.commit_sha && result2.outputs.commit_sha !== shaBefore, JSON.stringify(result2));

    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 6c1. Security Broker Architecture Mechanism 2 (provenance tokens): handlePrepareCommit must
  //      reject a commit whose scan result carries a token that does not verify against the actual
  //      staged diff -- the "downstream gate rejects unscanned/mismatched content" half of the
  //      round-trip (the "accepts genuinely scanned content" half is exhaustively covered above by
  //      every other prepare-commit test in this file, all of which pass through the real,
  //      unmodified commitBroker.scanBeforeCommit -> verifyToken path). Simulated here by
  //      temporarily monkey-patching commitBroker.scanBeforeCommit to return a token minted for
  //      DIFFERENT content than the diff actually being committed -- the exact shape a bypassed or
  //      refactored-out-from-under-us broker call would produce -- and restoring the real
  //      implementation immediately after, so no other test in this file is affected.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest-tokengate-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'README.md'), '# seed\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: tmp });
    const shaBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(tmp, 'clean.md'), 'a perfectly clean, ordinary change\n');
    const allStages = [
      { stage_id: 'plan', status: 'completed' }, { stage_id: 'execute', status: 'completed' },
      { stage_id: 'deterministic-verify', status: 'completed' }, { stage_id: 'independent-review', status: 'completed' }
    ];
    const ctx = { targetPath: tmp, commitMessage: 'feat: clean change, but token check will be forged' };

    const realScanBeforeCommit = commitBroker.scanBeforeCommit;
    commitBroker.scanBeforeCommit = function forgedScan(diffOrFiles) {
      const real = realScanBeforeCommit(diffOrFiles);
      // Token minted for unrelated content -- mimics a broker call whose result got substituted,
      // reused from a stale scan, or never actually ran against THIS diff.
      const { mintToken } = require('./security-brokers/provenance-token.js');
      const forgedToken = mintToken('completely unrelated content, never the real diff', { clean: true, findings: [] });
      return Object.assign({}, real, { token: forgedToken });
    };
    let result;
    try {
      result = handlePrepareCommit({}, ctx, allStages);
    } finally {
      commitBroker.scanBeforeCommit = realScanBeforeCommit; // always restore, even if the assertion below throws
    }
    const shaAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
    push('forged_or_mismatched_token_blocks_commit_even_though_content_is_clean',
      result.status === 'blocked' && result.outputs.token_check && result.outputs.token_check.valid === false &&
      result.outputs.token_check.reason === 'content_mismatch' && shaAfter === shaBefore,
      JSON.stringify({ result, shaBefore, shaAfter }));

    // Sanity: with the real (restored) broker, the SAME clean content now commits normally --
    // proves the forged-token block above was specific to the forged token, not a side effect that
    // broke the repo or left commitBroker permanently patched.
    const resultReal = handlePrepareCommit({}, ctx, allStages);
    push('restoring_the_real_broker_lets_the_same_clean_content_commit_normally',
      resultReal.status === 'completed' && !!resultReal.outputs.commit_sha,
      JSON.stringify(resultReal));

    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 6c2. FINDING 2 FIX: `git diff --cached` throwing (e.g. a real diff bigger than maxBuffer) must
  //      BLOCK the commit, not silently default to an empty-string scan that trivially reports
  //      clean. Reproduces the review's repro shape: stage a large (~21MB) file containing a
  //      realistic-but-fake secret pattern, forcing the real `git diff --cached` call to exceed the
  //      (deliberately tiny, for this test) maxBuffer and throw -- confirm handlePrepareCommit
  //      BLOCKS rather than committing, and that no commit is produced.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest-largediff-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'README.md'), '# seed\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: tmp });
    const shaBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();

    // ~21MB fixture: unique-per-line content (so it diffs as real added lines, not a single blob
    // git can shortcut) with a fake AWS-access-key-shaped secret embedded partway through.
    const LINE = 'x'.repeat(199);
    const totalLines = Math.ceil((21 * 1024 * 1024) / 200);
    const lines = new Array(totalLines);
    for (let i = 0; i < totalLines; i++) lines[i] = `${LINE}${i % 10}`;
    lines[Math.floor(totalLines / 2)] = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'; // fake value for tests
    fs.writeFileSync(path.join(tmp, 'large-fixture.txt'), lines.join('\n') + '\n');

    const allStagesLarge = [
      { stage_id: 'plan', status: 'completed' }, { stage_id: 'execute', status: 'completed' },
      { stage_id: 'deterministic-verify', status: 'completed' }, { stage_id: 'independent-review', status: 'completed' }
    ];
    const ctxLarge = { targetPath: tmp, commitMessage: 'feat: add large fixture (must not silently pass unscanned)' };
    const resultLarge = handlePrepareCommit({}, ctxLarge, allStagesLarge);
    const shaAfterLarge = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
    push('large_diff_that_fails_to_read_blocks_commit_not_silently_clean',
      resultLarge.status === 'blocked' && shaAfterLarge === shaBefore,
      JSON.stringify({ status: resultLarge.status, reason: resultLarge.outputs && resultLarge.outputs.reason, shaBefore, shaAfterLarge }));

    // Cleanup: remove the ~21MB fixture file so it never lingers in the repo.
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 6d. completeStage rejects an independent-review completion that doesn't declare an independent
  //     reviewer -- generalized (checked by adapter_id/dispatch_id equality, not a vendor name):
  //     same adapter as the producer is rejected, a genuinely different adapter is accepted, and a
  //     declaration naming NO reviewer at all is rejected (an orchestrator can't just skip it).
  {
    const dag = { stages: [
      { stage_id: 'execute', status: 'completed', selected_adapter: 'claude-code' },
      { stage_id: 'independent-review', status: 'awaiting_orchestrator' }
    ] };

    completeStage(dag, 'independent-review', { status: 'completed', outputs: { reviewer_adapter_id: 'claude-code', verdict: 'PASS' } });
    push('same_adapter_as_producer_rejected_as_reviewer',
      dag.stages.find(s => s.stage_id === 'independent-review').status === 'rejected_not_independent',
      JSON.stringify(dag.stages.find(s => s.stage_id === 'independent-review')));

    const dag2 = { stages: [
      { stage_id: 'execute', status: 'completed', selected_adapter: 'claude-code' },
      { stage_id: 'independent-review', status: 'awaiting_orchestrator' }
    ] };
    completeStage(dag2, 'independent-review', { status: 'completed', outputs: { reviewer_adapter_id: 'codex-cli', verdict: 'REJECT' } });
    push('genuinely_different_adapter_accepted_as_reviewer',
      dag2.stages.find(s => s.stage_id === 'independent-review').status === 'completed',
      JSON.stringify(dag2.stages.find(s => s.stage_id === 'independent-review')));

    const dag3 = { stages: [
      { stage_id: 'execute', status: 'completed', selected_adapter: 'claude-code' },
      { stage_id: 'independent-review', status: 'awaiting_orchestrator' }
    ] };
    completeStage(dag3, 'independent-review', { status: 'completed', outputs: { verdict: 'PASS' } });
    push('missing_reviewer_declaration_rejected',
      dag3.stages.find(s => s.stage_id === 'independent-review').status === 'rejected_not_independent',
      JSON.stringify(dag3.stages.find(s => s.stage_id === 'independent-review')));

    // A rejected review must never satisfy prepare-commit's gate.
    const gateStagesAfterReject = [
      { stage_id: 'plan', status: 'completed' }, { stage_id: 'execute', status: 'completed' },
      { stage_id: 'deterministic-verify', status: 'completed' }, dag.stages.find(s => s.stage_id === 'independent-review')
    ];
    const commitAttempt = handlePrepareCommit({}, { targetPath: os.tmpdir(), commitMessage: 'x' }, gateStagesAfterReject);
    push('rejected_review_never_satisfies_prepare_commit_gate', commitAttempt.status === 'blocked', JSON.stringify(commitAttempt));
  }
  // 6e. Reviewer-capability resolution is generalized, not vendor-pinned: the independent-review
  //     stage resolves via the SAME resolveStage/route() machinery every other stage uses, with the
  //     router's existing 'independent_review' policy and excludeAdapter set to whatever the
  //     'execute' stage actually selected -- proven here with injected fixture adapters (not the
  //     live registry, which this self-test must not depend on) where a weaker-but-real adapter
  //     wins specifically BECAUSE the stronger one is the producer, not because of any adapter name.
  {
    const fixtureAdapters = [
      { adapter_id: 'strong-cli', trust_tier: 'trusted-local', capabilities: { implementation: { state: 'verified' }, review: { state: 'verified' } } },
      { adapter_id: 'second-cli', trust_tier: 'quarantined', capabilities: { implementation: { state: 'claimed' }, review: { state: 'verified' } } }
    ];
    const dag = { stages: [
      { stage_id: 'execute', required_capabilities: ['implementation'], dependencies: [], status: 'pending' },
      { stage_id: 'independent-review', required_capabilities: ['review'], dependencies: ['execute'], status: 'pending' }
    ] };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest-reviewer-cap-'));
    const ctx = { targetPath: tmp, artifactsDir: path.join(tmp, '.harnesskit'), runId: 'r-reviewer' };
    // resolveStage/route() read the live registry by default; inject fixture adapters via a
    // monkey-patched capability-resolver call is out of reach from here without a wider refactor,
    // so this assertion drives resolveStage directly with the same excludeAdapter contract
    // executeWorkflow's independent-review branch uses, against the fixture adapters, to prove the
    // POLICY (not the live registry's current contents) is what generalizes reviewer selection.
    const { resolveStage } = require('./capability-resolver.js');
    const executeResolution = resolveStage(dag.stages[0], { adapters: fixtureAdapters, policy: 'highest_verified_quality' });
    const reviewResolution = resolveStage(dag.stages[1], { adapters: fixtureAdapters, policy: 'independent_review', excludeAdapter: executeResolution.selected_adapter });
    push('independent_review_excludes_the_producer_adapter',
      executeResolution.selected_adapter === 'strong-cli' && reviewResolution.selected_adapter === 'second-cli',
      JSON.stringify({ producer: executeResolution.selected_adapter, reviewer: reviewResolution.selected_adapter }));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 6f. FINDING 1 FIX: a fabricated, never-registered reviewer_adapter_id must be rejected even
  //     though it's non-empty and textually different from the producer -- it has to be a REAL,
  //     registered, review-capable adapter (config/adapter-registry.json), not just any string.
  //     Driven against the LIVE registry (claude-code/codex-cli/agy/provider-api) on purpose, and
  //     then all the way through to handlePrepareCommit to prove the fabrication never produces a
  //     real commit, not just a rejected status string.
  {
    const dag = { stages: [
      { stage_id: 'execute', status: 'completed', selected_adapter: 'claude-code' },
      { stage_id: 'independent-review', status: 'awaiting_orchestrator' }
    ] };
    completeStage(dag, 'independent-review', { status: 'completed', outputs: { reviewer_adapter_id: 'ghost-adapter-never-registered-anywhere', verdict: 'PASS' } });
    const reviewStage = dag.stages.find(s => s.stage_id === 'independent-review');
    push('fabricated_nonexistent_reviewer_adapter_rejected',
      reviewStage.status === 'rejected_not_independent' &&
      typeof reviewStage.outputs.independence_check_failed === 'string' &&
      reviewStage.outputs.independence_check_failed.includes('not a real, registered, review-capable adapter'),
      JSON.stringify(reviewStage));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest-ghost-reviewer-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'README.md'), '# seed\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: tmp });
    const shaBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(tmp, 'feature.txt'), 'shipped without a real independent review\n');
    const gateStages = [
      { stage_id: 'plan', status: 'completed' }, { stage_id: 'execute', status: 'completed', selected_adapter: 'claude-code' },
      { stage_id: 'deterministic-verify', status: 'completed' }, reviewStage
    ];
    const commitAttempt = handlePrepareCommit({}, { targetPath: tmp, commitMessage: 'feat: ship without a real reviewer' }, gateStages);
    const shaAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
    push('ghost_adapter_review_never_produces_a_commit',
      commitAttempt.status === 'blocked' && shaAfter === shaBefore,
      JSON.stringify({ status: commitAttempt.status, reason: commitAttempt.outputs && commitAttempt.outputs.reason, shaBefore, shaAfter }));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 6g. FINDING 1 FIX (part 1): handlePrepareCommit is idempotent against a crash between the real
  //     `git commit` landing and the caller's checkpoint/dag-write recording 'prepare-commit' as
  //     complete. Simulated here by calling handlePrepareCommit directly TWICE in a row against the
  //     SAME fixture repo state with the SAME ctx.runId -- exactly the shape a resume takes after a
  //     crash in that window. The second call must detect the already-landed commit (via HEAD's own
  //     run-id trailer) and refuse to re-run `git add -A` / `git commit`, even though the working
  //     tree has since been "re-dirtied" (the literal risk named in the finding) by a NEW untracked
  //     file appearing between the two calls.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest-idempotent-commit-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'README.md'), '# seed\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: tmp });

    fs.writeFileSync(path.join(tmp, 'feature.txt'), 'the real change this run is supposed to ship\n');
    const allStages = [
      { stage_id: 'plan', status: 'completed' }, { stage_id: 'execute', status: 'completed' },
      { stage_id: 'deterministic-verify', status: 'completed' }, { stage_id: 'independent-review', status: 'completed' }
    ];
    const ctx = { targetPath: tmp, commitMessage: 'feat: ship the real change', runId: 'idempotency-selftest-run-1' };

    const first = handlePrepareCommit({}, ctx, allStages);
    push('idempotent_first_call_creates_a_real_commit', first.status === 'completed' && !!first.outputs.commit_sha && !first.outputs.idempotent_replay, JSON.stringify(first));
    const shaAfterFirst = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();

    // Simulate exactly the risk named in the finding: something re-dirties the tree in the window
    // between the crash and the resume (a stray new file appearing, e.g. a partially-written
    // artifact). The second call, same runId, same ctx, must NOT stage or commit this.
    fs.writeFileSync(path.join(tmp, 'unexpected-post-crash-dirt.txt'), 'this must never end up in a duplicate commit\n');

    const second = handlePrepareCommit({}, ctx, allStages);
    const shaAfterSecond = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
    push('idempotent_second_call_detects_already_landed_commit_not_a_duplicate',
      second.status === 'completed' && second.outputs.idempotent_replay === true && second.outputs.commit_sha === shaAfterFirst && shaAfterSecond === shaAfterFirst,
      JSON.stringify({ first, second, shaAfterFirst, shaAfterSecond }));

    const logAfter = execFileSync('git', ['log', '--oneline'], { cwd: tmp, encoding: 'utf8' }).trim().split('\n');
    push('idempotent_replay_creates_no_new_commit_object', logAfter.length === 2, JSON.stringify(logAfter)); // seed + the one real commit, never a third

    // The re-dirtying file must still be sitting there untouched (uncommitted), proving the second
    // call genuinely never ran `git add -A` -- it did not silently absorb the post-crash dirt either.
    const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: tmp, encoding: 'utf8' });
    push('idempotent_replay_never_touches_the_index', /unexpected-post-crash-dirt\.txt/.test(statusAfter), statusAfter);

    // A DIFFERENT run against the same repo (different runId) must NOT be treated as a replay --
    // proves the guard is genuinely scoped per-run, not just "HEAD has any trailer at all".
    fs.writeFileSync(path.join(tmp, 'second-feature.txt'), 'a second, unrelated real change\n');
    const ctxDifferentRun = { targetPath: tmp, commitMessage: 'feat: a second unrelated change', runId: 'idempotency-selftest-run-2' };
    const thirdDifferentRun = handlePrepareCommit({}, ctxDifferentRun, allStages);
    push('different_run_id_is_never_treated_as_a_replay_of_the_first',
      thirdDifferentRun.status === 'completed' && !thirdDifferentRun.outputs.idempotent_replay && thirdDifferentRun.outputs.commit_sha !== shaAfterFirst,
      JSON.stringify(thirdDifferentRun));

    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 7. classify-task keyword classifier picks a real, distinct class per context, defaults sanely.
  {
    push('classify_bug_context', classifyTaskClass('this is a bug fix for broken timeout handling') === 'bug', '');
    push('classify_docs_context', classifyTaskClass('update the README documentation') === 'docs', '');
    push('classify_default_feature', classifyTaskClass('random unrelated text with no keyword') === 'feature', '');
  }
  // 8. challenge-task tolerates an orchestrator-resolved genuine tie (auto-discovery re-running
  // will tie again by construction -- this is the exact real shape hit against the ART repo,
  // where AR003/AR014/E05 all scored 0.80), but still catches real staleness: a fresh scan
  // showing the orchestrator's pick has since been completed must still pause the run.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-exec-wf-selftest5-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'STATUS.md'), 'Active task: TASKA100.\n\nAlso the active task right now: TASKB200.\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', 'chore: seed status doc'], { cwd: tmp });

    const docPrecedence = ['STATUS.md'];
    const fresh0 = discoverTasks({ targetPath: tmp, docPrecedence });
    const isRealTie = fresh0.decision === 'NEEDS_USER' && fresh0.candidate_tasks.length === 2 &&
      Math.abs(fresh0.candidate_tasks[0].confidence - fresh0.candidate_tasks[1].confidence) < 0.001;
    push('fixture_reproduces_a_genuine_tie', isRealTie, JSON.stringify(fresh0.candidate_tasks.map(c => ({ id: c.id, confidence: c.confidence }))));

    const chosen = fresh0.candidate_tasks[0].id;
    const ctx = { targetPath: tmp, repoProfile: { doc_precedence: docPrecedence }, taskDiscovery: { selected_task: chosen, decision: 'ORCHESTRATOR_RESOLVED', resolved_by: 'orchestrator' } };
    const result = handleChallengeTask({ stage_id: 'challenge-task' }, ctx);
    push('orchestrator_tie_resolution_survives_challenge', result.status === 'completed' && result.outputs.reconfirmed_via === 'orchestrator_tie_still_viable', JSON.stringify(result));

    // Now make the chosen candidate look completed (real completion-shaped commit) and re-challenge --
    // the exact staleness case this stage exists to catch must still fire, tie-resolution or not.
    fs.writeFileSync(path.join(tmp, `${chosen.toLowerCase()}.py`), '# done\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', `feat: implement ${chosen} completely`], { cwd: tmp });
    const resultAfterCompletion = handleChallengeTask({ stage_id: 'challenge-task' }, ctx);
    push('challenge_still_catches_real_staleness_after_orchestrator_resolution', resultAfterCompletion.status === 'needs_user', JSON.stringify(resultAfterCompletion));

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 9. P5a shared-handler-extraction import-boundary test: proves neither engine file reaches into
  // the OTHER engine's internals anymore for the extracted pieces (AUTOMATED_HANDLERS,
  // completeStage, validateReviewIndependence, the handleX functions) -- the exact problem this
  // extraction exists to fix. Driven via two
  // genuinely separate, fresh `node -e` child processes (fresh require.cache each), rather than
  // in-process require.cache surgery on the CURRENTLY-loaded copy of this very file -- that would
  // be both self-referential (this code is executing inside execute-workflow.js) and order-
  // -sensitive against test 10 below, which lazily requires langgraph-workflow.js from inside this
  // same process for the parity comparison. A fresh child process sidesteps both hazards entirely.
  {
    const checkScript = (entryRelPath, forbiddenRelPath) => `
      const path = require('path');
      const entry = path.join(${JSON.stringify(__dirname)}, ${JSON.stringify(entryRelPath)});
      require(entry);
      const forbidden = path.join(${JSON.stringify(__dirname)}, ${JSON.stringify(forbiddenRelPath)});
      const seen = new Set();
      const stack = [entry];
      while (stack.length) {
        const p = stack.pop();
        if (seen.has(p)) continue;
        seen.add(p);
        const mod = require.cache[p];
        if (!mod) continue;
        for (const c of (mod.children || [])) stack.push(c.id);
      }
      process.stdout.write(JSON.stringify({ forbidden_present: seen.has(forbidden), all: [...seen] }));
    `;
    const lgResult = JSON.parse(execFileSync(process.execPath, ['-e', checkScript('langgraph-workflow.js', 'execute-workflow.js')], { encoding: 'utf8', cwd: __dirname }));
    push('langgraph_engine_never_requires_legacy_engine_file_at_module_load_time',
      lgResult.forbidden_present === false,
      JSON.stringify(lgResult.all.filter(p => /execute-workflow|langgraph-workflow|workflow-handlers/.test(p))));

    const execResult = JSON.parse(execFileSync(process.execPath, ['-e', checkScript('execute-workflow.js', 'langgraph-workflow.js')], { encoding: 'utf8', cwd: __dirname }));
    push('legacy_engine_never_requires_langgraph_engine_file_at_module_load_time',
      execResult.forbidden_present === false,
      JSON.stringify(execResult.all.filter(p => /execute-workflow|langgraph-workflow|workflow-handlers/.test(p))));

    const lgHasHandlers = lgResult.all.some(p => p.includes('workflow-handlers.js'));
    const execHasHandlers = execResult.all.some(p => p.includes('workflow-handlers.js'));
    push('both_engines_depend_on_the_shared_workflow_handlers_module_instead',
      lgHasHandlers && execHasHandlers,
      JSON.stringify({ langgraph_requires_workflow_handlers: lgHasHandlers, legacy_requires_workflow_handlers: execHasHandlers }));
  }

  // 10. Dual-engine parity smoke test: after the P5a extraction, the legacy dispatch loop
  // (executeWorkflow, this file) and the LangGraph graph (langgraph-workflow.js) both call the
  // SAME extracted handler functions (workflow-handlers.js) for every automated stage. Proven here
  // end-to-end, not just by reference equality: two structurally identical fixture repos, one
  // driven through each engine, must reach the same paused_at stage and produce matching
  // status/semantic outputs on every automated stage (inspect-repository, discover-task,
  // classify-task, challenge-task) before the first orchestrator pause ('plan'). Lazily requires
  // langgraph-workflow.js (heavy @langchain/langgraph + better-sqlite3 deps) only inside this test
  // block -- not a module-load-time dependency of this file (proven separately by test 9 above,
  // which is immune to this in-process require via its own fresh-child-process design).
  {
    const seedFixture = (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
      // A single, unambiguous "Active task: X." sentence and nothing else -- exactly the fixture
      // shape langgraph-workflow.js's own self-test 3 (independence-gate test) uses to reach a
      // no-tie discover-task outcome. task-discovery.js's ROADMAP_ID regex is
      // /\b([A-Z]{1,5}-?\d{2,4})\b/ -- 1-5 uppercase letters then 2-4 digits, no more (empirically
      // confirmed here, first run: a 10-letter id like 'TASKPARITY777' matches NOTHING, since there
      // is no word boundary partway through a run of letters, and the fixture ties on zero
      // candidates instead of one) -- so 'TASKP777' (exactly 5 letters + 3 digits) is used instead.
      fs.writeFileSync(path.join(dir, 'README.md'), '# parity fixture\n\nActive task: TASKP777.\n');
      fs.writeFileSync(path.join(dir, '.gitignore'), '.harnesskit/\n');
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'chore: seed parity fixture'], { cwd: dir });
    };

    const tmpLegacy = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-parity-legacy-'));
    const tmpLg = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-parity-langgraph-'));
    try {
      seedFixture(tmpLegacy);
      seedFixture(tmpLg);

      // Legacy engine, in-process: the same compose+run shape bin/harnesskit.js's own cmdRun uses.
      const { composeWorkflow } = require('./compose-workflow.js');
      const { inspectRepo } = require('./inspect-repo.js');
      const legacyProfile = inspectRepo(tmpLegacy).profile;
      const legacyDag = composeWorkflow({ taskClass: null, repoProfile: legacyProfile });
      const legacyCtx = { targetPath: tmpLegacy, artifactsDir: path.join(tmpLegacy, '.harnesskit'), runId: 'parity-legacy' };
      const { pausedAt: legacyPausedAt } = executeWorkflow(legacyDag, legacyCtx);

      // LangGraph engine, in-process: identical fixture content, real graph run via the real
      // public startWorkflow() API (same one bin/harnesskit.js's --engine langgraph uses).
      const { startWorkflow, getWorkflowState } = require('./langgraph-workflow.js');
      const lgSummary = await startWorkflow({ targetPath: tmpLg, instruction: 'dual-engine parity smoke test' });
      const lgState = await getWorkflowState({ targetPath: tmpLg });
      const lgDag = lgState.dag;

      push('both_engines_pause_at_plan_after_the_same_automated_stages',
        legacyPausedAt === 'plan' && lgSummary.paused_at === 'plan',
        JSON.stringify({ legacyPausedAt, lgPausedAt: lgSummary.paused_at }));

      const find = (dag, id) => dag.stages.find(s => s.stage_id === id);
      const stageParity = ['inspect-repository', 'discover-task', 'classify-task', 'challenge-task'].map(id => {
        const l = find(legacyDag, id), g = find(lgDag, id);
        return { stage_id: id, legacy_status: l && l.status, lg_status: g && g.status, match: !!l && !!g && l.status === g.status };
      });
      push('automated_stage_statuses_match_across_both_engines',
        stageParity.every(s => s.match), JSON.stringify(stageParity));

      const legacyInspect = find(legacyDag, 'inspect-repository'), lgInspect = find(lgDag, 'inspect-repository');
      push('inspect_repository_stack_detection_matches_across_engines',
        legacyInspect.outputs.stack === lgInspect.outputs.stack, JSON.stringify({ legacy: legacyInspect.outputs.stack, lg: lgInspect.outputs.stack }));

      const legacyDiscover = find(legacyDag, 'discover-task'), lgDiscover = find(lgDag, 'discover-task');
      push('discover_task_selected_task_matches_across_engines',
        legacyDiscover.outputs.selected_task === lgDiscover.outputs.selected_task, JSON.stringify({ legacy: legacyDiscover.outputs.selected_task, lg: lgDiscover.outputs.selected_task }));

      const legacyClassify = find(legacyDag, 'classify-task'), lgClassify = find(lgDag, 'classify-task');
      push('classify_task_class_matches_across_engines',
        legacyClassify.outputs.task_class === lgClassify.outputs.task_class, JSON.stringify({ legacy: legacyClassify.outputs.task_class, lg: lgClassify.outputs.task_class }));

      const legacyChallenge = find(legacyDag, 'challenge-task'), lgChallenge = find(lgDag, 'challenge-task');
      push('challenge_task_outcome_matches_across_engines',
        legacyChallenge.outputs.challenged_task === lgChallenge.outputs.challenged_task && legacyChallenge.outputs.reconfirmed === lgChallenge.outputs.reconfirmed,
        JSON.stringify({ legacy: legacyChallenge.outputs, lg: lgChallenge.outputs }));

      // Engine/checkpoint identity metadata (docs/ENGINE_CHECKPOINT_IDENTITY_REPORT.md): each engine
      // stamps its own dag with which engine produced it (object shape, both agree on the same
      // shared schema-version constant), via compose-workflow.js's composeWorkflow().
      push('legacy_dag_is_stamped_with_its_own_engine_identity',
        !!legacyDag.engine && legacyDag.engine.name === 'legacy' && legacyDag.engine.schema_version === ENGINE_SCHEMA_VERSION,
        JSON.stringify({ engine: legacyDag.engine }));
      push('langgraph_dag_is_stamped_with_its_own_engine_identity',
        !!lgDag.engine && lgDag.engine.name === 'langgraph' && lgDag.engine.schema_version === ENGINE_SCHEMA_VERSION,
        JSON.stringify({ engine: lgDag.engine }));
    } finally {
      fs.rmSync(tmpLegacy, { recursive: true, force: true });
      fs.rmSync(tmpLg, { recursive: true, force: true });
    }
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = {
  executeWorkflow, completeStage, topologicalOrder, classifyTaskClass, tokenizeCommand,
  AUTOMATED_HANDLERS, ORCHESTRATOR_STAGES, validateReviewIndependence
};

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) selfTest().then(ok => process.exit(ok ? 0 : 1));
  else {
    console.log('execute-workflow.js — library, invoked by bin/harnesskit.js. node scripts/execute-workflow.js --self-test');
    process.exit(0);
  }
}
