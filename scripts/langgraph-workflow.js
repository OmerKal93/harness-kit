#!/usr/bin/env node
// langgraph-workflow.js — HarnessKit Phase 5: a real @langchain/langgraph StateGraph engine for
// the SAME 10-stage workflow scripts/execute-workflow.js already runs, wired to the SAME real
// handlers (AUTOMATED_HANDLERS), the SAME completeStage() (including its independent-review
// independence gate), and the SAME capability-resolver.js/router. This file does not reimplement
// any workflow logic -- it is an alternate orchestration/checkpoint runtime around the existing,
// tested engine, additive per this project's migration rules (the hand-rolled engine in
// execute-workflow.js/bin/harnesskit.js is untouched and still the default).
//
// Real, verified on this machine before writing this file (not assumed):
//   - @langchain/langgraph@1.4.7 + @langchain/langgraph-checkpoint-sqlite@1.0.3 install cleanly
//     inside THIS repo's own dependency tree (not just an isolated scratch project).
//   - better-sqlite3's native binary loads and works despite a skipped install script.
//   - interrupt()/Command({resume}) is real, narrow, and safe: resuming a checkpoint with no
//     pending interrupt() is a harmless no-op passthrough that continues real execution from
//     wherever `next` points -- it never skips a node's actual execution.
//   - updateState(config, values, asNode) is real but MORE dangerous than it looks: called with
//     asNode targeting a node other than the one a thread is genuinely interrupted at, it forces
//     that node's output and sets `next` to its static-graph successors, silently skipping the
//     real interrupted node's execution entirely (empirically confirmed -- see
//     docs/LANGGRAPH_IMPLEMENTATION_REPORT.md section 5). Because of this, this module does NOT
//     expose an "any named stage" resume verb the way bin/harnesskit.js's legacy
//     `resume --target --resolve-stage <any-id>` nominally allows -- only resuming the node a
//     thread is ACTUALLY interrupted at (via Command({resume})) is exposed. This is a deliberate,
//     disclosed narrowing, not a fake equivalence.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StateGraph, Annotation, START, END, interrupt, Command } = require('@langchain/langgraph');
const { SqliteSaver } = require('@langchain/langgraph-checkpoint-sqlite');

const { nowIso } = require('./_lib.js');
const { inspectRepo } = require('./inspect-repo.js');
const { composeWorkflow } = require('./compose-workflow.js');
const { resolveStage } = require('./capability-resolver.js');
const lease = require('./lease.js');
// P5a shared-handler extraction: this used to require('./execute-workflow.js') for these exact
// names -- meaning the legacy engine's file could never be retired while this file depended on it
// directly. AUTOMATED_HANDLERS/completeStage (the only two of the four original destructured names
// actually referenced anywhere in this file -- ORCHESTRATOR_STAGES and validateReviewIndependence
// were imported but unused here, confirmed by inspection: this file hardcodes plan/execute/
// independent-review as orchestrator nodes at graph-construction time via makeOrchestratorNode
// instead of consulting the Set, and applies the independence gate only indirectly through
// completeStage()) now come from workflow-handlers.js, the one shared module both engines depend
// on.
const { AUTOMATED_HANDLERS, completeStage } = require('./workflow-handlers.js');

class MissingCapabilityError extends Error {
  constructor(stageId, reason) {
    super(`missing_capability at stage '${stageId}': ${reason}`);
    this.name = 'MissingCapabilityError';
    this.stageId = stageId;
  }
}

// --- shared plumbing reused by every node -----------------------------------------------------

function cloneDag(dag) { return JSON.parse(JSON.stringify(dag)); }

function makeCtx(state) {
  return {
    targetPath: state.targetPath,
    artifactsDir: state.artifactsDir,
    runId: state.runId,
    instruction: state.instruction,
    repoProfile: state.repoProfile,
    taskDiscovery: state.taskDiscovery,
    taskClass: state.taskClass,
    commitMessage: state.commitMessage || undefined,
    verificationOverride: state.verificationOverride || undefined
  };
}

// Exactly the same per-stage capability resolution executeWorkflow() performs before dispatching
// a stage -- reused via the same resolveStage() import, not re-derived. Mutates `stage` in place
// (selected_adapter / missing_capability + selection_reason), same fields the legacy engine sets.
function resolveAndSetAdapter(stage, ctx, dag) {
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
    throw new MissingCapabilityError(stage.stage_id, stage.selection_reason);
  }
  stage.selected_adapter = resolution.selected_adapter;
}

function findStage(dag, id) {
  const s = dag.stages.find(x => x.stage_id === id);
  if (!s) throw new Error(`langgraph-workflow: stage '${id}' missing from dag -- compose-workflow.js drift?`);
  return s;
}

// --- state schema -------------------------------------------------------------------------------
// Every channel uses the default "last write wins" reducer (no custom reducer given) -- nodes
// always return the FULL new value for any field they touch (dag is deep-cloned then mutated),
// matching Annotation's documented default overwrite behavior (see design doc's own worked
// example: `sentiment: Annotation<string>` with no reducer overwrites on each write).
const WorkflowState = Annotation.Root({
  targetPath: Annotation(),
  artifactsDir: Annotation(),
  runId: Annotation(),
  instruction: Annotation(),
  repoProfile: Annotation(),
  taskDiscovery: Annotation(),
  taskClass: Annotation(),
  commitMessage: Annotation(),
  verificationOverride: Annotation(),
  dag: Annotation()
});

// --- nodes ----------------------------------------------------------------------------------
// Every AUTOMATED node below calls the REAL, existing handler from AUTOMATED_HANDLERS (imported
// from workflow-handlers.js -- see the P5a shared-handler extraction note near the top requires --
// never reimplemented) and writes back via the REAL completeStage() (same module) -- so
// security-boundary scanning (inside handleDeterministicVerify /
// handlePrepareCommit), the verification-classifier 7-state policy (inside
// handleDeterministicVerify), and the independent-review independence gate (inside
// completeStage()) all apply exactly as they do on the legacy path, because it is the same code.

async function inspectRepositoryNode(state) {
  const dag = cloneDag(state.dag);
  const stage = findStage(dag, 'inspect-repository');
  const ctx = makeCtx(state);
  resolveAndSetAdapter(stage, ctx, dag);
  const result = AUTOMATED_HANDLERS['inspect-repository'](stage, ctx, dag.stages);
  completeStage(dag, 'inspect-repository', result);
  return { dag, repoProfile: ctx.repoProfile };
}

async function discoverTaskNode(state) {
  const dag = cloneDag(state.dag);
  const stage = findStage(dag, 'discover-task');
  const ctx = makeCtx(state);
  resolveAndSetAdapter(stage, ctx, dag);
  const result = AUTOMATED_HANDLERS['discover-task'](stage, ctx, dag.stages);

  if (result.status === 'needs_user') {
    // Real mapping of task-discovery.js's genuine confidence-tie NEEDS_USER onto interrupt() --
    // the exact case named in the migration task (item 4).
    const resumeValue = interrupt({
      stage: 'discover-task',
      reason: result.outputs.reason,
      candidate_tasks: ctx.taskDiscovery.candidate_tasks
    });
    const resolvedDiscovery = Object.assign({}, ctx.taskDiscovery, {
      selected_task: resumeValue.selected_task,
      decision: 'ORCHESTRATOR_RESOLVED',
      resolved_by: 'orchestrator',
      resolution_reason: resumeValue.resolution_reason || null
    });
    completeStage(dag, 'discover-task', {
      status: 'completed',
      outputs: { task_discovery_path: result.outputs.task_discovery_path, selected_task: resumeValue.selected_task }
    });
    return { dag, taskDiscovery: resolvedDiscovery };
  }
  completeStage(dag, 'discover-task', result);
  return { dag, taskDiscovery: ctx.taskDiscovery };
}

async function classifyTaskNode(state) {
  const dag = cloneDag(state.dag);
  const stage = findStage(dag, 'classify-task');
  const ctx = makeCtx(state);
  resolveAndSetAdapter(stage, ctx, dag);
  const result = AUTOMATED_HANDLERS['classify-task'](stage, ctx, dag.stages);
  completeStage(dag, 'classify-task', result);
  return { dag, taskClass: ctx.taskClass };
}

async function challengeTaskNode(state) {
  const dag = cloneDag(state.dag);
  const stage = findStage(dag, 'challenge-task');
  const ctx = makeCtx(state);
  resolveAndSetAdapter(stage, ctx, dag);
  const result = AUTOMATED_HANDLERS['challenge-task'](stage, ctx, dag.stages);

  if (result.status === 'needs_user') {
    // Same interrupt()-inside-node pattern as discover-task (design doc S4 row 4). The orchestrator
    // resumes with a completeStage()-shaped resolution -- generic, since challenge-task's needs_user
    // path (staleness / tie-recheck) has no single specialized resolution shape the way
    // discover-task's does.
    const resumeValue = interrupt({ stage: 'challenge-task', reason: result.outputs.reason });
    completeStage(dag, 'challenge-task', resumeValue || { status: 'completed', outputs: result.outputs });
    return { dag };
  }
  completeStage(dag, 'challenge-task', result);
  return { dag };
}

// Orchestrator stages (plan/execute/independent-review): the script cannot do this work itself --
// same honest limitation as today. Capability resolution still runs (so stage.selected_adapter is
// set exactly like the legacy engine sets it, which matters: validateReviewIndependence reads
// execute's selected_adapter as the producer to exclude). Then interrupt() hands control to the
// orchestrating agent; resuming with {status, outputs} is applied via the REAL completeStage(),
// which for 'independent-review' specifically runs the REAL validateReviewIndependence gate.
function makeOrchestratorNode(stageId) {
  return async function orchestratorNode(state) {
    const dag = cloneDag(state.dag);
    const stage = findStage(dag, stageId);
    const ctx = makeCtx(state);
    resolveAndSetAdapter(stage, ctx, dag);
    stage.status = 'awaiting_orchestrator';
    stage.inputs = [];
    const resumeValue = interrupt({
      stage: stageId,
      selected_adapter: stage.selected_adapter,
      note: 'orchestrator performs the real work outside the graph, then resumes with {status, outputs}'
    });
    completeStage(dag, stageId, resumeValue);
    return { dag };
  };
}

// deterministic-verify: AUTOMATED, but unlike the legacy engine (which just halts the whole
// executeWorkflow loop on anything short of 'completed', requiring a fresh CLI `resume --target
// --verification-override` call), this node uses a real interrupt() loop so a paused thread can be
// resumed in-place with an override -- an honest IMPROVEMENT enabled by LangGraph's checkpointing,
// not a bypass: the override is still validated by the exact same isValidOverride/classification
// logic inside handleDeterministicVerify on every re-run (called again for real, including a real
// subprocess re-execution of the verify command when relevant).
async function deterministicVerifyNode(state) {
  const dag = cloneDag(state.dag);
  const stage = findStage(dag, 'deterministic-verify');
  let ctx = makeCtx(state);
  resolveAndSetAdapter(stage, ctx, dag);

  let result = AUTOMATED_HANDLERS['deterministic-verify'](stage, ctx, dag.stages);
  while (result.status !== 'completed') {
    const resumeValue = interrupt({
      stage: 'deterministic-verify',
      verification_status: result.outputs.verification_status,
      reason: result.outputs.reason || null,
      results: result.outputs.results
    }) || {};
    if (resumeValue.verificationOverride) ctx = Object.assign({}, ctx, { verificationOverride: resumeValue.verificationOverride });
    result = AUTOMATED_HANDLERS['deterministic-verify'](stage, ctx, dag.stages);
  }
  completeStage(dag, 'deterministic-verify', result);
  return { dag, verificationOverride: ctx.verificationOverride || null };
}

async function prepareCommitNode(state) {
  const dag = cloneDag(state.dag);
  const stage = findStage(dag, 'prepare-commit');
  const ctx = makeCtx(state);
  resolveAndSetAdapter(stage, ctx, dag);
  const result = AUTOMATED_HANDLERS['prepare-commit'](stage, ctx, dag.stages);
  completeStage(dag, 'prepare-commit', result);
  return { dag };
}

async function finalReportNode(state) {
  const dag = cloneDag(state.dag);
  const stage = findStage(dag, 'final-report');
  const ctx = makeCtx(state);
  resolveAndSetAdapter(stage, ctx, dag);
  const result = AUTOMATED_HANDLERS['final-report'](stage, ctx, dag.stages);
  completeStage(dag, 'final-report', result);
  return { dag };
}

// --- graph construction --------------------------------------------------------------------
// Linear chain -- confirmed, not assumed, by reading compose-workflow.js's STAGE_TEMPLATE /
// defaultDependencies() (each stage depends only on the one immediately before it) and
// execute-workflow.js's topologicalOrder(), which -- despite implementing a fully general Kahn's-
// algorithm sort -- is never fed anything but this same linear chain today. Every edge below is a
// plain addEdge, matching that reality; no addConditionalEdges is used because nothing in the real
// template branches.
function buildGraph() {
  const graph = new StateGraph(WorkflowState)
    .addNode('inspect-repository', inspectRepositoryNode)
    .addNode('discover-task', discoverTaskNode)
    .addNode('classify-task', classifyTaskNode)
    .addNode('challenge-task', challengeTaskNode)
    .addNode('plan', makeOrchestratorNode('plan'))
    .addNode('execute', makeOrchestratorNode('execute'))
    .addNode('deterministic-verify', deterministicVerifyNode)
    .addNode('independent-review', makeOrchestratorNode('independent-review'))
    .addNode('prepare-commit', prepareCommitNode)
    .addNode('final-report', finalReportNode)
    .addEdge(START, 'inspect-repository')
    .addEdge('inspect-repository', 'discover-task')
    .addEdge('discover-task', 'classify-task')
    .addEdge('classify-task', 'challenge-task')
    .addEdge('challenge-task', 'plan')
    .addEdge('plan', 'execute')
    .addEdge('execute', 'deterministic-verify')
    .addEdge('deterministic-verify', 'independent-review')
    .addEdge('independent-review', 'prepare-commit')
    .addEdge('prepare-commit', 'final-report')
    .addEdge('final-report', END);
  return graph;
}

// --- checkpoint / thread-id conventions -----------------------------------------------------
// One SQLite file per target repo, inside that repo's own .harnesskit/ dir -- mirroring today's
// "one workflow per target directory" isolation (design doc S5), not one shared file (sidesteps
// the design doc's disclosed, UNVERIFIED concurrent-writer-safety question entirely for the
// common case of one run per target at a time).
function checkpointPathForTarget(targetPath) {
  return path.join(path.resolve(targetPath), '.harnesskit', 'langgraph-checkpoints.sqlite');
}

// thread_id: stable hash of the resolved absolute target path (design doc S5's own proposed
// convention), not the raw path itself, so it's a safe SQLite key regardless of path characters.
function threadIdForTarget(targetPath) {
  return crypto.createHash('sha256').update(path.resolve(targetPath)).digest('hex').slice(0, 24);
}

// Returns `checkpointer` too (not just the compiled graph) so callers can close its underlying
// better-sqlite3 handle when done -- each call opens a fresh connection (no pooling across CLI
// invocations, since each real `node bin/harnesskit.js ...` call is itself a fresh process), and on
// Windows an unclosed handle blocks the file (and its parent directory) from being removed/renamed,
// which matters for tests that clean up their own temp fixtures.
function compileGraph(targetPath) {
  const ckptPath = checkpointPathForTarget(targetPath);
  fs.mkdirSync(path.dirname(ckptPath), { recursive: true });
  const checkpointer = SqliteSaver.fromConnString(ckptPath);
  return { compiled: buildGraph().compile({ checkpointer }), ckptPath, threadId: threadIdForTarget(targetPath), checkpointer };
}

// --- run-lock (FINDING 1 FIX) ----------------------------------------------------------------
// Two genuinely concurrent `harnesskit run/resume --engine langgraph --repo|--target X`
// invocations against the SAME target produce the identical thread_id (sha256 of the resolved
// path -- see threadIdForTarget) and could otherwise both drive `git`/the checkpoint file in that
// target at once. Reuses scripts/lease.js (already real and tested -- see evals/core/run-lock),
// scoped by the resolved target path so different targets never contend with each other.
// `lockRoot` is an internal-only test hook (mirrors lease.js's own injectable `opts.root`) so
// self-tests never depend on or pollute the real shared lock directory.
function acquireRunLock(targetPath, lockRoot) {
  const opts = { scopes: [targetPath], owner_session: String(process.pid), kind: 'path', ttlHours: 2 };
  if (lockRoot) opts.root = lockRoot;
  const acq = lease.acquireLease(opts);
  if (!acq.ok) {
    return {
      ok: false,
      error: `another harnesskit run/resume (--engine langgraph) is already in progress against ${targetPath} (run-lock held by session ${acq.conflict.owner_session}, acquired ${acq.conflict.acquired_ts}) -- refusing to start a second concurrent run/resume against the same target`,
      conflict: acq.conflict
    };
  }
  return { ok: true, lockOpts: opts, lockId: acq.lock.lock_id };
}
function releaseRunLock(lockAcq) {
  if (lockAcq && lockAcq.ok) lease.releaseLease(Object.assign({}, lockAcq.lockOpts, { lock_id: lockAcq.lockId }));
}

// --- public run/resume/inspect API, used by bin/harnesskit.js's --engine langgraph verbs -------

async function startWorkflow({ targetPath, instruction, runId, lockRoot }) {
  targetPath = path.resolve(targetPath);
  const lockAcq = acquireRunLock(targetPath, lockRoot);
  if (!lockAcq.ok) return { ok: false, error: lockAcq.error, conflict: lockAcq.conflict };
  try {
    const artifactsDir = path.join(targetPath, '.harnesskit');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const { profile } = inspectRepo(targetPath); // seeds compose-workflow's dynamic verify capabilities, same as bin/harnesskit.js's cmdRun does today
    // engine: 'langgraph' (see docs/ENGINE_CHECKPOINT_IDENTITY_REPORT.md) -- this dag becomes the
    // graph's own `dag` state channel, so this stamp is what bin/harnesskit.js's resume-command
    // engine-ownership detection reads back out of the LangGraph checkpoint via getWorkflowState().
    const dag = composeWorkflow({ taskClass: null, repoProfile: profile, engine: 'langgraph' });
    dag.instruction = instruction;

    const { compiled, ckptPath, threadId, checkpointer } = compileGraph(targetPath);
    const config = { configurable: { thread_id: threadId } };
    const initialState = {
      targetPath, artifactsDir, runId: runId || `hklg-${Date.now()}`, instruction,
      repoProfile: profile, taskDiscovery: null, taskClass: null, commitMessage: null, verificationOverride: null,
      dag
    };
    try {
      const result = await compiled.invoke(initialState, config);
      return summarize(result, ckptPath, threadId, targetPath);
    } finally { checkpointer.db.close(); }
  } finally {
    releaseRunLock(lockAcq);
  }
}

// stateUpdate (optional): merged into graph state alongside the resume value, via LangGraph's real
// Command({resume, update}) shape (verified real and working -- both fields apply together, `update`
// visible to nodes reached after this resume). This is how ctx.commitMessage (needed by the
// AUTOMATED, non-interrupting prepare-commit node) and a fresh ctx.verificationOverride reach the
// graph -- there is no other seam to inject extra ctx fields mid-run, since only the interrupted
// node itself receives `resume` directly.
async function resumeWorkflow({ targetPath, resumeValue, stateUpdate, lockRoot }) {
  targetPath = path.resolve(targetPath);
  const lockAcq = acquireRunLock(targetPath, lockRoot);
  if (!lockAcq.ok) return { ok: false, error: lockAcq.error, conflict: lockAcq.conflict };
  try {
    const { compiled, ckptPath, threadId, checkpointer } = compileGraph(targetPath);
    const config = { configurable: { thread_id: threadId } };
    try {
      const before = await compiled.getState(config);
      if (!before || !before.next || before.next.length === 0) {
        return { ok: false, error: `no paused/resumable LangGraph thread found for ${targetPath} (thread_id ${threadId}) -- did 'run --engine langgraph' start one?`, ckpt_path: ckptPath };
      }
      const command = stateUpdate ? new Command({ resume: resumeValue, update: stateUpdate }) : new Command({ resume: resumeValue });
      const result = await compiled.invoke(command, config);
      return summarize(result, ckptPath, threadId, targetPath);
    } finally { checkpointer.db.close(); }
  } finally {
    releaseRunLock(lockAcq);
  }
}

async function getWorkflowState({ targetPath }) {
  targetPath = path.resolve(targetPath);
  const { compiled, ckptPath, threadId, checkpointer } = compileGraph(targetPath);
  const config = { configurable: { thread_id: threadId } };
  try {
    const snap = await compiled.getState(config);
    const interrupts = (snap.tasks || []).flatMap(t => t.interrupts || []);
    return {
      ok: true, target_path: targetPath, ckpt_path: ckptPath, thread_id: threadId,
      next: snap.next || [], paused: (snap.next || []).length > 0,
      interrupts, dag: snap.values ? snap.values.dag : null
    };
  } finally { checkpointer.db.close(); }
}

function summarize(finalOrPartialState, ckptPath, threadId, targetPath) {
  const dag = finalOrPartialState.dag;
  const interrupted = Array.isArray(finalOrPartialState.__interrupt__) && finalOrPartialState.__interrupt__.length > 0;
  // Every interrupt() call in this module's nodes includes `stage: <stage_id>` in its payload --
  // read paused_at straight from that, rather than re-deriving it from stage statuses.
  const pausedAt = interrupted ? (finalOrPartialState.__interrupt__[0].value || {}).stage || null : null;
  return {
    ok: true, engine: 'langgraph', target_path: targetPath, ckpt_path: ckptPath, thread_id: threadId,
    interrupted, paused_at: pausedAt,
    interrupt_payload: interrupted ? finalOrPartialState.__interrupt__[0].value : null,
    stages: dag.stages.map(s => ({ stage_id: s.stage_id, status: s.status, selected_adapter: s.selected_adapter, outputs: s.outputs || null })),
    note: interrupted ? `paused (interrupted) at '${pausedAt}'` : 'workflow completed with no pending interrupt'
  };
}

// --- self-test -------------------------------------------------------------------------------

// A bare git-init fixture has no detected repo.test command, so deterministic-verify's capability
// resolution would honestly fail (MissingCapabilityError -- see resolveAndSetAdapter). Rather than
// depend on a package.json/pyproject.toml manifest being auto-detected AND its declared command
// actually being invocable on whatever machine runs this self-test (real, pre-existing gap found
// during this work: inspect-repo.js's package.json detection always yields "npm run <script>",
// and plain execFileSync('npm', ...) genuinely fails with ENOENT on Windows without a shell --
// `npm` resolves to a .cmd shim there, not a directly-spawnable binary; this is a latent bug in
// the existing, already-tested legacy engine, unrelated to and out of scope for this migration,
// and is disclosed in the report rather than silently worked around here), these self-tests
// override repoProfile with a known-good, portable, non-shimmed command via the real
// Command({update}) mechanism -- exactly how execute-workflow.js's OWN self-tests hand-construct
// ctx.repoProfile.commands.test rather than relying on inspectRepo() detection.
const SAFE_TEST_REPO_PROFILE = { package_root: null, commands: { test: { command: 'node -e "process.exit(0)"' } } };

async function selfTest() {
  const os = require('os');
  const { execFileSync } = require('child_process');
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. Graph construction: builds, compiles (with a throwaway in-memory-style sqlite file), and
  // exposes exactly the 10 required stage nodes plus a strictly linear edge set (matches
  // compose-workflow.js's STAGE_TEMPLATE/defaultDependencies -- verified, not assumed).
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-lg-selftest-graph-'));
    const dbPath = path.join(tmp, 'ckpt.sqlite');
    const graph = buildGraph();
    const checkpointer = SqliteSaver.fromConnString(dbPath);
    const compiled = graph.compile({ checkpointer });
    const expected = ['inspect-repository', 'discover-task', 'classify-task', 'challenge-task', 'plan', 'execute', 'deterministic-verify', 'independent-review', 'prepare-commit', 'final-report'];
    const graphObj = await compiled.getGraphAsync({ configurable: { thread_id: 'graph-shape-check' } });
    const drawableNodeIds = graphObj.nodes ? Object.keys(graphObj.nodes) : [];
    const allPresent = expected.every(id => drawableNodeIds.includes(id));
    push('graph_has_all_10_required_stage_nodes', allPresent, JSON.stringify(drawableNodeIds));
    const edgeStrs = (graphObj.edges || []).map(e => `${e.source}->${e.target}`);
    const expectedEdges = ['__start__->inspect-repository', 'inspect-repository->discover-task', 'discover-task->classify-task', 'classify-task->challenge-task', 'challenge-task->plan', 'plan->execute', 'execute->deterministic-verify', 'deterministic-verify->independent-review', 'independent-review->prepare-commit', 'prepare-commit->final-report', 'final-report->__end__'];
    const allEdgesPresent = expectedEdges.every(e => edgeStrs.includes(e));
    push('graph_edges_are_the_confirmed_linear_chain', allEdgesPresent, JSON.stringify(edgeStrs));
    checkpointer.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 2. Real interrupt/resume round trip against a genuine discover-task confidence tie (the same
  // fixture shape execute-workflow.js's own self-test #8 uses), driven entirely in-process first --
  // confirms the mechanism before the heavier cross-process proof in test 4.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-lg-selftest-tie-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
    // AGENTS.md, not STATUS.md: inspect-repo.js's real detectDocPrecedence() only auto-detects doc
    // precedence from {AGENTS.md, CLAUDE.md, README.md, CONTRIBUTING.md} -- the SAME fixture shape
    // bin/harnesskit.js's own real end-to-end self-test uses (proven to reproduce a genuine tie
    // through the real auto-detection path, not an explicit docPrecedence override).
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'Active task: TASKA100.\n\nAlso the active task right now: TASKB200.\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', 'chore: seed status doc'], { cwd: tmp });

    const r1 = await startWorkflow({ targetPath: tmp, instruction: 'self-test: resolve a genuine tie' });
    push('inprocess_run_pauses_at_discover_task_tie', r1.interrupted === true && r1.paused_at === 'discover-task', JSON.stringify({ interrupted: r1.interrupted, paused_at: r1.paused_at }));
    push('inprocess_interrupt_payload_carries_real_candidates', Array.isArray(r1.interrupt_payload && r1.interrupt_payload.candidate_tasks) && r1.interrupt_payload.candidate_tasks.length === 2, JSON.stringify(r1.interrupt_payload));

    const stateWhilePaused = await getWorkflowState({ targetPath: tmp });
    push('getWorkflowState_reports_paused_before_resume', stateWhilePaused.paused === true && stateWhilePaused.next[0] === 'discover-task', JSON.stringify(stateWhilePaused.next));
    // Engine identity (docs/ENGINE_CHECKPOINT_IDENTITY_REPORT.md): the dag persisted inside this
    // LangGraph checkpoint must carry engine.name === 'langgraph' -- this is the exact field
    // bin/harnesskit.js's resume-command ownership guard reads back via getWorkflowState() to
    // refuse a bare (legacy-defaulting) `resume --target` against a langgraph-owned run.
    push('checkpoint_persisted_dag_carries_langgraph_engine_identity',
      !!(stateWhilePaused.dag && stateWhilePaused.dag.engine && stateWhilePaused.dag.engine.name === 'langgraph' && stateWhilePaused.dag.engine.schema_version === 1),
      JSON.stringify(stateWhilePaused.dag && stateWhilePaused.dag.engine));

    const r2 = await resumeWorkflow({ targetPath: tmp, resumeValue: { selected_task: 'TASKA100', resolution_reason: 'self-test orchestrator pick' } });
    push('inprocess_resume_advances_past_discover_task', r2.interrupted === true && r2.paused_at !== 'discover-task', JSON.stringify({ interrupted: r2.interrupted, paused_at: r2.paused_at }));
    // Should now be paused at 'plan' (the first real orchestrator stage after discover/classify/challenge).
    push('inprocess_resume_lands_at_plan_next', r2.paused_at === 'plan', JSON.stringify(r2.paused_at));

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 3. The independent-review independence gate (validateReviewIndependence, reused verbatim via
  // completeStage()) still applies through the LangGraph path: a reviewer declared identical to the
  // producer is rejected, not silently accepted, exactly like the legacy engine's self-test #6d.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-lg-selftest-independence-'));
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'README.md'), '# fixture\n\nActive task: TASKX999.\n');
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: tmp });

    const r1 = await startWorkflow({ targetPath: tmp, instruction: 'self-test: independence gate must survive the langgraph path' });
    // TASKX999 alone -> no tie -> should sail through discover/classify/challenge straight to 'plan'.
    push('independence_fixture_reaches_plan_without_a_tie', r1.interrupted === true && r1.paused_at === 'plan', JSON.stringify({ interrupted: r1.interrupted, paused_at: r1.paused_at }));

    const r2 = await resumeWorkflow({ targetPath: tmp, resumeValue: { status: 'completed', outputs: { plan_summary: 'do the thing' } } });
    push('resume_plan_lands_at_execute', r2.paused_at === 'execute', JSON.stringify(r2.paused_at));

    // Inject a known-good, portable repoProfile (SAFE_TEST_REPO_PROFILE) via the real
    // Command({update}) mechanism -- this bare fixture has no detected repo.test command, and the
    // point of this test is the independence gate, not verify-command detection.
    const r3 = await resumeWorkflow({ targetPath: tmp, resumeValue: { status: 'completed', outputs: { producer_adapter_id: 'claude-code' } }, stateUpdate: { repoProfile: SAFE_TEST_REPO_PROFILE } });
    let r = r3;
    push('reaches_independent_review', r.paused_at === 'independent-review', JSON.stringify(r.paused_at));

    // Same producer adapter as reviewer -- the real gate must reject this, not accept it.
    const executeAdapter = r.stages.find(s => s.stage_id === 'execute').selected_adapter;
    const r4 = await resumeWorkflow({ targetPath: tmp, resumeValue: { status: 'completed', outputs: { reviewer_adapter_id: executeAdapter, verdict: 'PASS' } }, stateUpdate: { commitMessage: 'feat: self-test commit that must never happen' } });
    const reviewStage = r4.stages.find(s => s.stage_id === 'independent-review');
    push('same_adapter_reviewer_rejected_through_langgraph_path', reviewStage.status === 'rejected_not_independent', JSON.stringify(reviewStage));
    // A rejected review must not let prepare-commit through -- run should now be stuck, not interrupted at prepare-commit successfully.
    push('rejected_review_never_reaches_a_real_commit', reviewStage.status === 'rejected_not_independent' && r4.stages.find(s => s.stage_id === 'prepare-commit').status !== 'completed', JSON.stringify(r4.stages.find(s => s.stage_id === 'prepare-commit')));

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 4. REAL cross-process interrupt/resume proof, end to end, through a genuine repo-changing
  // workflow: process A runs `node bin/harnesskit.js run --engine langgraph` against a fresh
  // synthetic fixture repo (no tie -- deterministic path to keep this test fast and unambiguous),
  // pausing at 'plan'; process A then exits completely. A SEPARATE, freshly-spawned process B
  // resumes via `node bin/harnesskit.js resume --engine langgraph`, repeatedly, driving the run all
  // the way to a REAL `git commit` in the fixture repo. Confirms: (a) the checkpoint survives
  // process exit (only the sqlite file on disk carries state across), (b) the final state shows
  // exactly one real commit (no duplicated side effect from re-running an already-completed
  // stage), (c) the independent-review gate still ran for real (reviewer != producer).
  {
    const cliPath = path.resolve(__dirname, '..', 'bin', 'harnesskit.js');
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-lg-selftest-e2e-'));
    execFileSync('git', ['init', '-q'], { cwd: fixture });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: fixture });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: fixture });
    fs.writeFileSync(path.join(fixture, 'README.md'), '# e2e fixture\n\nActive task: TASKE001.\n');
    // Real finding surfaced by this exact proof (not weakened here): prepare-commit's `git add -A`
    // stages the target repo's OWN .harnesskit/ artifacts dir (task-discovery.json's numeric
    // confidence values, e.g. 0.6000000000000001, real-world happen to pattern-match
    // security-boundary's credit-card regex) -- a genuine false positive that legitimately BLOCKED
    // a real commit the first time this repo's own self-tests ever drove a workflow all the way to
    // prepare-commit. The correct fix is what any real target repo should already do: exclude
    // HarnessKit's own per-target metadata directory from that repo's version control, exactly like
    // HarnessKit's own .gitignore excludes `runs/`. Not a workaround for the scanner -- the gate
    // stays exactly as strict as it is on the legacy path.
    fs.writeFileSync(path.join(fixture, '.gitignore'), '.harnesskit/\n');
    execFileSync('git', ['add', '-A'], { cwd: fixture });
    execFileSync('git', ['commit', '-q', '-m', 'chore: seed e2e fixture'], { cwd: fixture });
    const shaBeforeAny = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim();

    // Process A: real, separate `node` invocation. Exits normally once invoke() returns (an
    // interrupted graph run is not a hung process -- it returns to the caller, same as the design
    // doc's own real 2-process test).
    const runOut = JSON.parse(execFileSync(process.execPath, [cliPath, 'run', '--engine', 'langgraph', '--repo', fixture, '--instruction', 'e2e cross-process proof'], { encoding: 'utf8' }));
    push('process_a_pauses_at_plan_then_exits', runOut.ok === true && runOut.paused_at === 'plan', JSON.stringify({ ok: runOut.ok, paused_at: runOut.paused_at }));

    // Process B (genuinely separate `node` invocation #1): resolve 'plan'.
    const resumePlan = JSON.parse(execFileSync(process.execPath, [cliPath, 'resume', '--engine', 'langgraph', '--target', fixture, '--resume-value', JSON.stringify({ status: 'completed', outputs: { plan_summary: 'e2e plan' } })], { encoding: 'utf8' }));
    push('process_b_resumes_plan_lands_at_execute', resumePlan.paused_at === 'execute', JSON.stringify(resumePlan.paused_at));

    // Process C (genuinely separate `node` invocation #2): resolve 'execute'. Declares
    // producer_adapter_id explicitly so independent-review's real exclusion logic has something
    // concrete to exclude even if capability resolution alone were ambiguous, AND supplies
    // --state-update to inject a known-good, portable repo.test command (this bare fixture has no
    // detected command; see SAFE_TEST_REPO_PROFILE's comment above) via the real CLI surface.
    const cursor = JSON.parse(execFileSync(process.execPath, [cliPath, 'resume', '--engine', 'langgraph', '--target', fixture, '--resume-value', JSON.stringify({ status: 'completed', outputs: { producer_adapter_id: 'claude-code' } }), '--state-update', JSON.stringify({ repoProfile: SAFE_TEST_REPO_PROFILE })], { encoding: 'utf8' }));
    push('reaches_independent_review_across_processes', cursor.paused_at === 'independent-review', JSON.stringify(cursor.paused_at));

    // Make a real, benign change in the fixture so prepare-commit has something real to commit --
    // BEFORE resolving independent-review, because prepare-commit is an AUTOMATED node with no
    // interrupt of its own: once independent-review resumes to 'completed', the graph runs straight
    // through prepare-commit and final-report in this SAME process/invoke call (no further pause).
    fs.writeFileSync(path.join(fixture, 'feature.txt'), 'shipped via the real langgraph e2e proof\n');

    // Process D: resolve independent-review with a genuinely DIFFERENT reviewer than the declared
    // producer (the honest, non-rejected path) AND supply --commit-message via a real Command
    // update -- the only seam that gets ctx.commitMessage to the automated prepare-commit node,
    // since prepare-commit itself never calls interrupt(). Runs all the way to a REAL git commit
    // and final-report in this one process.
    const resumeReview = JSON.parse(execFileSync(process.execPath, [cliPath, 'resume', '--engine', 'langgraph', '--target', fixture, '--resume-value', JSON.stringify({ status: 'completed', outputs: { reviewer_adapter_id: 'codex-cli', verdict: 'PASS' } }), '--commit-message', 'feat: e2e proof commit via langgraph engine'], { encoding: 'utf8' }));
    const reviewStageE2e = resumeReview.stages.find(s => s.stage_id === 'independent-review');
    push('genuinely_different_reviewer_accepted_across_processes', reviewStageE2e.status === 'completed', JSON.stringify(reviewStageE2e));
    push('run_completes_with_no_further_interrupt', resumeReview.interrupted === false, JSON.stringify({ interrupted: resumeReview.interrupted, paused_at: resumeReview.paused_at }));

    const commitStage = resumeReview.stages.find(s => s.stage_id === 'prepare-commit');
    push('prepare_commit_completed_with_a_real_sha', commitStage.status === 'completed' && !!(commitStage.outputs && commitStage.outputs.commit_sha), JSON.stringify(commitStage));

    const finalReportStage = resumeReview.stages.find(s => s.stage_id === 'final-report');
    push('final_report_completed', finalReportStage.status === 'completed', JSON.stringify(finalReportStage));

    // Real git verification: exactly ONE new commit landed beyond the seed commit -- no duplicated
    // side effect from any stage re-running (proves the checkpoint genuinely skipped completed work
    // across every one of these separate process invocations, never re-executing prepare-commit).
    const logAfter = execFileSync('git', ['log', '--oneline', `${shaBeforeAny}..HEAD`], { cwd: fixture, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    push('exactly_one_new_commit_no_duplicate_side_effect', logAfter.length === 1, JSON.stringify(logAfter));
    push('commit_sha_matches_real_head', commitStage.outputs.commit_sha === execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).trim(), commitStage.outputs.commit_sha);

    // Process F: attempting to resume AGAIN after the thread is already fully done must not
    // silently re-run anything -- resumeWorkflow() itself must refuse (no pending interrupt).
    const resumeAfterDone = JSON.parse(execFileSync(process.execPath, [cliPath, 'resume', '--engine', 'langgraph', '--target', fixture, '--resume-value', JSON.stringify({ status: 'completed', outputs: {} })], { encoding: 'utf8' }));
    push('resume_after_completion_refuses_not_silently_reruns', resumeAfterDone.ok === false, JSON.stringify(resumeAfterDone));

    fs.rmSync(fixture, { recursive: true, force: true });
  }

  // 5. FINDING 1 FIX (run-lock): startWorkflow must refuse a target another session already holds
  //    a live lease over, rather than silently racing it. Simulated deterministically: pre-acquire
  //    a conflicting lease (a DIFFERENT owner_session than this process's own -- matching what a
  //    genuinely separate concurrent OS process would look like) against the same target path, in
  //    an isolated lockRoot so this never touches the real shared lock directory. Then confirm
  //    startWorkflow proceeds normally once that conflicting lease is released.
  {
    const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-lg-selftest-lockroot-'));
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-lg-selftest-lock-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: fixture });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: fixture });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: fixture });
      fs.writeFileSync(path.join(fixture, 'README.md'), '# lock fixture\n\nActive task: TASKLOCK002.\n');
      execFileSync('git', ['add', '-A'], { cwd: fixture });
      execFileSync('git', ['commit', '-q', '-m', 'chore: seed lock fixture'], { cwd: fixture });

      const conflicting = lease.acquireLease({
        scopes: [path.resolve(fixture)], owner_session: `simulated-other-process-${process.pid}`,
        kind: 'path', ttlHours: 1, root: lockRoot
      });
      push('lock_selftest_setup_conflicting_lease_acquired', conflicting.ok === true, JSON.stringify(conflicting));

      const rejected = await startWorkflow({ targetPath: fixture, instruction: 'must be rejected by the held lock', lockRoot });
      push('start_workflow_rejected_by_conflicting_run_lock',
        rejected.ok === false && /already in progress/.test(rejected.error) && rejected.conflict && rejected.conflict.owner_session === conflicting.lock.owner_session,
        JSON.stringify(rejected));
      push('start_workflow_rejected_by_lock_never_created_a_checkpoint_file',
        !fs.existsSync(checkpointPathForTarget(fixture)),
        'a rejected-by-lock startWorkflow call must never have opened/created the LangGraph sqlite checkpoint for this target');

      lease.releaseLease({ root: lockRoot, lock_id: conflicting.lock.lock_id });

      const proceeds = await startWorkflow({ targetPath: fixture, instruction: 'must succeed once the conflicting lease is released', lockRoot });
      push('start_workflow_proceeds_once_conflicting_lock_released', proceeds.ok === true, JSON.stringify({ ok: proceeds.ok, paused_at: proceeds.paused_at }));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
      fs.rmSync(lockRoot, { recursive: true, force: true });
    }
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = {
  buildGraph, compileGraph, checkpointPathForTarget, threadIdForTarget,
  startWorkflow, resumeWorkflow, getWorkflowState, MissingCapabilityError
};

if (require.main === module) {
  if (process.argv.includes('--self-test')) selfTest().then(ok => process.exit(ok ? 0 : 1));
  else { console.log('langgraph-workflow.js — library, invoked by bin/harnesskit.js --engine langgraph. node scripts/langgraph-workflow.js --self-test'); process.exit(0); }
}
