#!/usr/bin/env node
// bin/harnesskit.js — HarnessKit Productization Phase 1: the unified public CLI. Six real verbs,
// no stubs. Every verb delegates to existing, tested machinery -- this file is the convergence
// point, not a reimplementation.
//
//   harnesskit inspect --target <path>
//   harnesskit capabilities
//   harnesskit doctor
//   harnesskit status [--all]
//   harnesskit resume --run-id <id>                          (harnesskit run state)
//   harnesskit resume --target <path> [--resolve-stage <id> --resolve-status <s> --resolve-outputs '<json>']
//                     [--commit-message "<msg>"] [--verification-override '<json>']
//                                                              (continue a paused .harnesskit workflow)
//   harnesskit run --repo <url-or-path> [--workspace <path>] --instruction "<text>"
//
// Phase 5: --engine langgraph on `run`/`resume` routes the SAME target through
// scripts/langgraph-workflow.js's real @langchain/langgraph StateGraph engine instead of the
// hand-rolled executeWorkflow() loop -- additive, opt-in, the legacy engine (default, no flag) is
// unchanged. See docs/LANGGRAPH_IMPLEMENTATION_REPORT.md for what this does and does not preserve.
//   harnesskit run --engine langgraph --repo <url-or-path> --instruction "<text>"
//   harnesskit resume --engine langgraph --target <path> --resume-value '<json>' [--commit-message "<msg>"] [--state-update '<json>']
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { parseArgs, harnessRoot, resolveWorkspace, isUnderTempDir, listRuns, nowIso, runDir } = require('../scripts/_lib.js');
const { inspectRepo } = require('../scripts/inspect-repo.js');
const { discoverTasks } = require('../scripts/task-discovery.js');
const { composeWorkflow } = require('../scripts/compose-workflow.js');
const { executeWorkflow, completeStage } = require('../scripts/execute-workflow.js');
const lease = require('../scripts/lease.js');

function printJson(obj) { console.log(JSON.stringify(obj, null, 2)); }

// FINDING 1 FIX (run-id stability across the legacy run/resume split): handlePrepareCommit's
// idempotency guard (execute-workflow.js) needs a ctx.runId that is THE SAME value on the initial
// `run` call and on every later `resume --target` call against the same workflow -- a fresh
// Date.now()-based id per CLI invocation would never match itself across a resume, defeating the
// guard entirely. dag.composed_at is already a stable, persisted-to-disk value set exactly once
// per workflow (compose-workflow.js) and never touched again by executeWorkflow(), so it's a real,
// already-available anchor for a deterministic per-workflow token -- no new dag field needed.
function stableRunIdForWorkflow(targetPath, dag) {
  const key = `${path.resolve(targetPath)}|${dag.composed_at || ''}`;
  return `hkrun-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

// FINDING 1 FIX (missing run-lock): acquire an advisory path-scoped lease (scripts/lease.js,
// already real and tested -- see evals/core/run-lock) over the target repo before either the
// legacy `run` or `resume --target` path touches it. Two genuinely concurrent
// `harnesskit run/resume --repo|--target <same-X>` invocations would otherwise share the same
// target directory (LangGraph's thread_id convention has an equivalent problem -- see
// scripts/langgraph-workflow.js's own acquireRunLock) and could both drive `git` there at once.
// `--lock-root` is an internal-only test hook (mirrors lease.js's own injectable `opts.root`) so
// self-tests never depend on or pollute the real shared lock directory.
function acquireRunLock(targetPath, a) {
  const opts = { scopes: [path.resolve(targetPath)], owner_session: String(process.pid), kind: 'path', ttlHours: 2 };
  if (a && a['lock-root']) opts.root = String(a['lock-root']);
  const acq = lease.acquireLease(opts);
  if (!acq.ok) {
    return {
      ok: false,
      error: `another harnesskit run/resume is already in progress against ${path.resolve(targetPath)} (run-lock held by session ${acq.conflict.owner_session}, acquired ${acq.conflict.acquired_ts}) -- refusing to start a second concurrent run/resume against the same target`,
      conflict: acq.conflict
    };
  }
  return { ok: true, lockOpts: opts, lockId: acq.lock.lock_id };
}
function releaseRunLock(lockAcq) {
  if (lockAcq && lockAcq.ok) lease.releaseLease(Object.assign({}, lockAcq.lockOpts, { lock_id: lockAcq.lockId }));
}

// resolveWorkspace/isUnderTempDir now live in scripts/_lib.js (shared with scripts/doctor.js's
// workspace-location check, avoiding a circular require between the two). Precedence: --workspace
// flag > HARNESSKIT_WORKSPACE env var > a durable location under the harness root -- never
// os.tmpdir() by default (see _lib.js for why: a real ART clone was one Temp-cleanup away from
// permanently losing an unpushed commit + run evidence).

function isRemoteRepoSpec(spec) {
  return /^(https?:\/\/|git@)/.test(spec) || /^[\w.-]+\/[\w.-]+$/.test(spec);
}

// Windows-native `git clone` fails outright when a repo contains OS-hostile fixture paths --
// two distinct failure shapes observed against the real ART repo: reserved device names
// (pathspec rejected upfront, "invalid path '<p>'") and >260-char paths (rejected during the
// actual write, "unable to create file <p>: Filename too long"). The whole checkout aborts even
// though only a handful of paths are the actual problem. Recovery: re-fetch with --no-checkout
// (objects always land fine), then checkout everything except the paths git itself rejects.
// git fails fast (stops at the first bad path per invocation), so exclusion is iterative: parse
// every rejected path this attempt's stderr names, drop them, retry, until checkout succeeds.
const HOSTILE_PATH_PATTERNS = [
  /error: invalid path '([^']+)'/g,
  /error: unable to create file ([^:]+): /g,
];

function parseRejectedPaths(stderr) {
  const found = [];
  for (const re of HOSTILE_PATH_PATTERNS) {
    for (const m of stderr.matchAll(re)) if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

function recoverHostileFixtureClone(dest) {
  const raw = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD', '--name-only'], { cwd: dest, encoding: 'utf8' });
  let paths = raw.split('\0').filter(Boolean);
  const excludedPaths = [];
  const MAX_ATTEMPTS = 50;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (paths.length === 0) throw new Error('hostile-fixture recovery excluded every path -- nothing left to check out');
    try {
      execFileSync('git', ['checkout', 'HEAD', '--', ...paths], { cwd: dest, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      return { excludedPaths };
    } catch (e) {
      const stderr = String((e && e.stderr) || (e && e.message) || '');
      const rejected = parseRejectedPaths(stderr);
      if (!rejected.length) throw e; // not a recognized path-legality failure -- can't safely auto-recover
      for (const p of rejected) if (!excludedPaths.includes(p)) excludedPaths.push(p);
      paths = paths.filter(p => !rejected.includes(p));
    }
  }
  throw new Error(`hostile-fixture recovery exceeded ${MAX_ATTEMPTS} attempts`);
}

function resolveTargetPath(repoSpec, workspace) {
  if (!isRemoteRepoSpec(repoSpec)) return path.resolve(repoSpec); // already a local path
  const name = repoSpec.replace(/\.git$/, '').split('/').pop();
  const dest = path.join(workspace, name);
  if (fs.existsSync(path.join(dest, '.git'))) return dest; // already cloned
  const url = /^https?:\/\/|^git@/.test(repoSpec) ? repoSpec : `https://github.com/${repoSpec}.git`;
  fs.mkdirSync(workspace, { recursive: true });
  try {
    execFileSync('git', ['clone', url, dest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return dest;
  } catch (e) {
    if (!fs.existsSync(path.join(dest, '.git'))) throw e; // objects never landed -- not recoverable here
    const stderr = String((e && e.stderr) || (e && e.message) || '');
    if (!/invalid path|unable to checkout working tree/i.test(stderr)) throw e;
    const { excludedPaths } = recoverHostileFixtureClone(dest);
    const evidenceDir = path.join(dest, '.harnesskit');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'clone-recovery.json'), JSON.stringify({
      recovered: true,
      reason: 'native git clone failed checkout due to OS-hostile fixture paths (Windows)',
      excluded_paths: excludedPaths,
      excluded_count: excludedPaths.length,
      note: 'these paths were excluded from the working tree because git itself rejected them as invalid on this OS -- not a HarnessKit judgment call about their content'
    }, null, 2));
    return dest;
  }
}

function cmdInspect(a) {
  const target = a.target;
  if (!target) return printJson({ ok: false, error: '--target <path> required' });
  const { profile, facts, risk, knowledgeIndex } = inspectRepo(path.resolve(target));
  const outDir = path.join(path.resolve(target), '.harnesskit');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'repo-profile.json'), JSON.stringify(profile, null, 2));
  fs.writeFileSync(path.join(outDir, 'repo-facts.json'), JSON.stringify(facts, null, 2));
  fs.writeFileSync(path.join(outDir, 'repo-risk-report.json'), JSON.stringify(risk, null, 2));
  fs.writeFileSync(path.join(outDir, 'repo-knowledge-index.json'), JSON.stringify(knowledgeIndex, null, 2));
  printJson({ ok: true, out_dir: outDir, profile });
}

function cmdCapabilities() {
  // P2 capability-inventory supersession: capability-matrix.json is deprecated (still on disk,
  // _deprecated:true, for rollback safety) -- this real read now targets the superseding file.
  const p = path.join(harnessRoot(), 'config', 'capability-inventory.json');
  if (!fs.existsSync(p)) return printJson({ ok: false, error: 'config/capability-inventory.json not found -- run has not been built yet' });
  const inventory = JSON.parse(fs.readFileSync(p, 'utf8'));
  printJson(inventory);
}

function cmdDoctor() {
  const root = harnessRoot();
  let preflight = null, localCi = null;
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'preflight.js')], { encoding: 'utf8', timeout: 60000 });
    const idx = out.indexOf('{');
    preflight = idx >= 0 ? JSON.parse(out.slice(idx)) : { ok: false };
  } catch (e) { preflight = { ok: false, error: String(e.message || e).slice(0, 300) }; }
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'local-ci.js'), '--json'], { encoding: 'utf8', timeout: 180000 });
    localCi = JSON.parse(out);
  } catch (e) {
    const stdout = (e && e.stdout) ? String(e.stdout) : '';
    try { localCi = JSON.parse(stdout); } catch { localCi = { summary: { ok: false }, error: String(e.message || e).slice(0, 300) }; }
  }
  const ok = !!(preflight && preflight.ok) && !!(localCi && localCi.summary && localCi.summary.ok);
  printJson({ ok, preflight_ok: preflight ? preflight.ok : false, local_ci_ok: localCi && localCi.summary ? localCi.summary.ok : false, preflight, local_ci: localCi });
}

function cmdStatus(a) {
  const runs = listRuns(a.all ? 1000 : 25);
  printJson({ ok: true, count: runs.length, runs: runs.map(r => ({ run_id: r.run_id, state: r.state, task_type: r.task_type || null, confidence: r.confidence != null ? r.confidence : null, ts: r.ts })) });
}

// --- engine/checkpoint identity: resume-time ownership detection (docs/ENGINE_CHECKPOINT_IDENTITY_REPORT.md) ---
// Real, confirmed hazard this exists to close: `resume --target <path>` with no `--engine` flag
// silently defaults to the legacy engine (cmdResumeTarget below), while a target can genuinely
// have been started under `--engine langgraph` instead (which persists its state in a completely
// separate file, langgraph-checkpoints.sqlite, that the legacy path never looks at). Before this
// fix there was no mechanism at all detecting "this run/checkpoint was created by engine X" --
// this section is that mechanism, consulted by cmdResume before either engine-specific resume path
// runs.

// Reads whatever persisted identity exists for `targetPath` under EITHER engine, without ever
// silently fabricating state: a legacy workflow-dag.json is read directly (cheap, sync, no new
// dependency); a LangGraph checkpoint is only inspected if its sqlite file already exists on disk
// (checking via a fresh compileGraph()/getState() call unconditionally would itself CREATE that
// file as a side effect on first touch -- see langgraph-workflow.js's compileGraph -- which would
// corrupt this exact detection for every future call against a genuinely legacy-only target). Even
// when the file does already exist, an empty/never-invoked checkpoint (e.g. left behind by a prior
// misrouted attempt) must not be mistaken for a real langgraph-owned run -- getWorkflowState()'s
// `dag` comes back null in that case, and that absence is what's checked, not mere file presence.
async function detectOwningEngine(targetPath) {
  const artifactsDir = path.join(targetPath, '.harnesskit');
  const dagPath = path.join(artifactsDir, 'workflow-dag.json');
  const ckptPath = path.join(artifactsDir, 'langgraph-checkpoints.sqlite');

  let legacy = null;
  if (fs.existsSync(dagPath)) {
    try {
      const dag = JSON.parse(fs.readFileSync(dagPath, 'utf8'));
      // Pre-existing workflow-dag.json files (composed before this fix) have no `engine` field --
      // safe to default to 'legacy' since this file has only ever been written by the legacy engine.
      legacy = { path: dagPath, engine_name: (dag.engine && dag.engine.name) || 'legacy', schema_version: (dag.engine && dag.engine.schema_version) || null };
    } catch (e) {
      legacy = { path: dagPath, engine_name: 'legacy', schema_version: null, unreadable: String(e.message || e).slice(0, 200) };
    }
  }

  let langgraph = null;
  if (fs.existsSync(ckptPath)) {
    try {
      const { getWorkflowState } = require('../scripts/langgraph-workflow.js');
      const snap = await getWorkflowState({ targetPath });
      if (snap.dag) {
        langgraph = { path: ckptPath, engine_name: (snap.dag.engine && snap.dag.engine.name) || 'langgraph', schema_version: (snap.dag.engine && snap.dag.engine.schema_version) || null, paused: snap.paused, next: snap.next };
      }
      // else: file/tables exist but no checkpoint row for this thread_id -- not a real langgraph run.
    } catch (e) {
      langgraph = { path: ckptPath, engine_name: 'langgraph', schema_version: null, unreadable: String(e.message || e).slice(0, 200) };
    }
  }

  return { legacy, langgraph };
}

// Pure decision: given what was actually found on disk and which engine the caller asked for
// (explicit `--engine langgraph`, or the implicit legacy default when the flag is absent), decide
// whether resuming would cross engines. Returns null when it's safe to proceed with
// `requestedEngine` unchanged; otherwise returns the exact printJson payload to refuse with.
//
// Design decision (auto-route vs. refuse) -- REFUSE, not silently reroute, and here's why: the two
// engines' resume flag vocabularies are NOT interchangeable (legacy takes
// --resolve-stage/--resolve-status/--resolve-outputs; langgraph takes --resume-value/--state-update
// -- see cmdResumeTarget vs. cmdResumeLangGraph). If this guard silently routed a request to
// whichever engine it detected as the "real" owner, it would still be silently discarding whatever
// engine-specific flags the caller actually passed (built for the engine they THOUGHT they were
// resuming), producing a resume that "succeeds" while quietly ignoring the caller's actual
// resolution/override/commit-message intent -- arguably worse than today's plain failure, because
// it would look like success. Refusing with an actionable, engine-and-path-specific message (the
// exact retry command to run) is strictly safer and costs the caller one extra CLI invocation.
function guardEngineMismatch(targetPath, requestedEngine, owning) {
  const { legacy, langgraph } = owning;
  if (legacy && langgraph) {
    return {
      ok: false,
      error: `refusing to resume ${targetPath}: BOTH a legacy workflow-dag.json (${legacy.path}) AND a real LangGraph checkpoint (${langgraph.path}) exist for this target -- ambiguous ownership, most likely from 'run' having been invoked against the same target under both engines. Inspect both artifacts and resume the one you intend explicitly (bare 'resume --target ${targetPath}' for the legacy workflow, 'resume --engine langgraph --target ${targetPath} --resume-value <json>' for the langgraph one); consider moving the other engine's artifact aside so this target has one unambiguous owner going forward.`,
      detected: owning
    };
  }
  if (langgraph && requestedEngine !== 'langgraph') {
    return {
      ok: false,
      error: `refusing to resume ${targetPath} with the legacy engine: this target's workflow was created by the LangGraph engine (checkpoint at ${langgraph.path}, engine.name='${langgraph.engine_name}'). A bare 'resume --target' defaults to the legacy engine and does not read this checkpoint at all -- it would not see this workflow's real state. Retry with: harnesskit resume --engine langgraph --target ${targetPath} --resume-value '<json>'`,
      detected: owning
    };
  }
  if (legacy && !langgraph && requestedEngine === 'langgraph') {
    return {
      ok: false,
      error: `refusing to resume ${targetPath} with --engine langgraph: this target's workflow was created by the legacy engine (workflow-dag.json at ${legacy.path}, engine.name='${legacy.engine_name}'; no LangGraph checkpoint found). Retry without --engine (defaults to legacy) using --resolve-stage/--resolve-status/--resolve-outputs, e.g.: harnesskit resume --target ${targetPath} --resolve-stage <stage-id> --resolve-outputs '<json>'`,
      detected: owning
    };
  }
  return null;
}

// Two distinct things this repo calls "resume", both real: the harnesskit run-id state machine
// (--run-id, existing) and continuing a paused per-target .harnesskit/workflow-dag.json (--target,
// added this batch -- discovered missing when a real ART run legitimately paused at discover-task
// with a genuine tie and there was no way to feed the orchestrator's resolution back in and
// continue). One verb, not a new one -- the CLI stays at six.
async function cmdResume(a) {
  if (a.target) {
    const targetPath = path.resolve(a.target);
    const requestedEngine = a.engine === 'langgraph' ? 'langgraph' : 'legacy';
    const owning = await detectOwningEngine(targetPath);
    const mismatch = guardEngineMismatch(targetPath, requestedEngine, owning);
    if (mismatch) return printJson(mismatch);
    return requestedEngine === 'langgraph' ? cmdResumeLangGraph(a) : cmdResumeTarget(a);
  }
  if (!a['run-id']) return printJson({ ok: false, error: '--run-id (harnesskit run state) or --target (a paused .harnesskit workflow) required' });
  const root = harnessRoot();
  try {
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'resume-run.js'), '--run-id', a['run-id']], { encoding: 'utf8' });
    printJson(JSON.parse(out));
  } catch (e) {
    const stdout = (e && e.stdout) ? String(e.stdout) : '';
    try { printJson(JSON.parse(stdout)); } catch { printJson({ ok: false, error: String(e.message || e).slice(0, 300) }); }
  }
}

// harnesskit resume --target <path> [--resolve-stage <id> --resolve-status <status> --resolve-outputs '<json>']
// Loads the persisted workflow-dag.json, optionally applies an orchestrator resolution to one
// paused stage (via completeStage), then re-invokes executeWorkflow to continue. Resolving
// discover-task specifically (outputs.selected_task set) rewrites task-discovery.json to record
// who resolved it and why -- real evidence, not a silent override.
function cmdResumeTarget(a) {
  const targetPath = path.resolve(a.target);
  const lockAcq = acquireRunLock(targetPath, a);
  if (!lockAcq.ok) return printJson({ ok: false, error: lockAcq.error, conflict: lockAcq.conflict });
  try {
    return cmdResumeTargetLocked(a, targetPath);
  } finally {
    releaseRunLock(lockAcq);
  }
}

function cmdResumeTargetLocked(a, targetPath) {
  const artifactsDir = path.join(targetPath, '.harnesskit');
  const dagPath = path.join(artifactsDir, 'workflow-dag.json');
  if (!fs.existsSync(dagPath)) return printJson({ ok: false, error: `no workflow-dag.json found at ${dagPath} -- run 'harnesskit run' against this target first` });
  const dag = JSON.parse(fs.readFileSync(dagPath, 'utf8'));

  const taskDiscoveryPath = path.join(artifactsDir, 'task-discovery.json');
  let taskDiscovery = fs.existsSync(taskDiscoveryPath) ? JSON.parse(fs.readFileSync(taskDiscoveryPath, 'utf8')) : null;

  const { profile } = inspectRepo(targetPath);

  if (a['resolve-stage']) {
    const stageId = String(a['resolve-stage']);
    const status = a['resolve-status'] ? String(a['resolve-status']) : 'completed';
    let outputs = {};
    if (a['resolve-outputs']) {
      try { outputs = JSON.parse(String(a['resolve-outputs'])); }
      catch (e) { return printJson({ ok: false, error: `--resolve-outputs is not valid JSON: ${String(e.message || e).slice(0, 200)}` }); }
    }
    if (stageId === 'discover-task' && outputs.selected_task) {
      if (!taskDiscovery) return printJson({ ok: false, error: 'no task-discovery.json found to resolve against' });
      taskDiscovery = { ...taskDiscovery, selected_task: outputs.selected_task, decision: 'ORCHESTRATOR_RESOLVED', resolved_by: 'orchestrator', resolution_reason: outputs.resolution_reason || null };
      fs.writeFileSync(taskDiscoveryPath, JSON.stringify(taskDiscovery, null, 2));
    }
    completeStage(dag, stageId, { status, outputs });
  }

  // FINDING 1 FIX: ctx.runId must be STABLE across every resume of this same workflow (see
  // stableRunIdForWorkflow's own comment) so handlePrepareCommit's crash-idempotency guard can
  // actually recognize "this is the same run resuming again" rather than seeing a fresh id every
  // call and never matching HEAD's trailer.
  const ctx = { targetPath, artifactsDir, repoProfile: profile, taskDiscovery, instruction: dag.instruction || null, runId: stableRunIdForWorkflow(targetPath, dag) };
  if (a['commit-message']) ctx.commitMessage = String(a['commit-message']);
  // --verification-override '<json>': the explicit, recorded override deterministic-verify
  // requires before an overridable status (KNOWN_PREEXISTING_FAILURES / ENVIRONMENT_BLOCKED /
  // FLAKY_OR_INCONCLUSIVE / VERIFICATION_NOT_AVAILABLE) may proceed. Never applied silently -- it's
  // parsed here, passed through ctx, and recorded verbatim in the stage's outputs (see
  // handleDeterministicVerify / verification-classifier.js#isValidOverride).
  if (a['verification-override']) {
    try { ctx.verificationOverride = JSON.parse(String(a['verification-override'])); }
    catch (e) { return printJson({ ok: false, error: `--verification-override is not valid JSON: ${String(e.message || e).slice(0, 200)}` }); }
  }
  const { pausedAt } = executeWorkflow(dag, ctx);
  fs.writeFileSync(dagPath, JSON.stringify(dag, null, 2));

  printJson({
    ok: true, target_path: targetPath, instruction: dag.instruction || null, paused_at: pausedAt,
    stages: dag.stages.map(s => ({ stage_id: s.stage_id, status: s.status, selected_adapter: s.selected_adapter, outputs: s.outputs || null })),
    workflow_dag_path: dagPath,
    note: pausedAt ? `paused at '${pausedAt}'` : 'workflow completed with no pause point reached'
  });
}

// harnesskit run: locate/clone -> inspect -> discover -> compose -> execute (automated prefix) ->
// report exactly where it paused and why. Never claims end-to-end completion from one CLI call --
// orchestrator stages (plan/execute/independent-review) genuinely require the calling agent.
// Phase 5, additive: --engine langgraph delegates the SAME --repo/--instruction contract to
// scripts/langgraph-workflow.js's real StateGraph engine. Lazy-required so the legacy default path
// never pays the @langchain/langgraph require cost or needs the dependency installed.
async function cmdRunLangGraph(a) {
  if (!a.repo) return printJson({ ok: false, error: '--repo <url-or-path> required' });
  if (!a.instruction) return printJson({ ok: false, error: '--instruction "<text>" required' });
  const workspace = resolveWorkspace(a);
  let targetPath;
  try { targetPath = resolveTargetPath(a.repo, workspace); }
  catch (e) { return printJson({ ok: false, error: `locate/clone failed: ${String(e.message || e).slice(0, 500)}` }); }
  const { startWorkflow } = require('../scripts/langgraph-workflow.js');
  const result = await startWorkflow({ targetPath, instruction: a.instruction });
  printJson(result);
}

function parseJsonFlag(raw, flagName) {
  if (raw === undefined) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(String(raw)) }; }
  catch (e) { return { ok: false, error: `${flagName} is not valid JSON: ${String(e.message || e).slice(0, 200)}` }; }
}

async function cmdResumeLangGraph(a) {
  if (!a.target) return printJson({ ok: false, error: '--target <path> required for --engine langgraph resume' });
  const resumeParsed = parseJsonFlag(a['resume-value'], '--resume-value');
  if (!resumeParsed.ok) return printJson({ ok: false, error: resumeParsed.error });
  const stateUpdateParsed = parseJsonFlag(a['state-update'], '--state-update');
  if (!stateUpdateParsed.ok) return printJson({ ok: false, error: stateUpdateParsed.error });
  const stateUpdate = stateUpdateParsed.value || {};
  if (a['commit-message']) stateUpdate.commitMessage = String(a['commit-message']);
  const { resumeWorkflow } = require('../scripts/langgraph-workflow.js');
  const result = await resumeWorkflow({
    targetPath: path.resolve(a.target),
    resumeValue: resumeParsed.value,
    stateUpdate: Object.keys(stateUpdate).length > 0 ? stateUpdate : undefined
  });
  printJson(result);
}

function cmdRun(a) {
  if (a.engine === 'langgraph') return cmdRunLangGraph(a);
  if (!a.repo) return printJson({ ok: false, error: '--repo <url-or-path> required' });
  if (!a.instruction) return printJson({ ok: false, error: '--instruction "<text>" required' });
  const workspace = resolveWorkspace(a);
  let targetPath;
  try { targetPath = resolveTargetPath(a.repo, workspace); }
  catch (e) { return printJson({ ok: false, error: `locate/clone failed: ${String(e.message || e).slice(0, 500)}` }); }

  const lockAcq = acquireRunLock(targetPath, a);
  if (!lockAcq.ok) return printJson({ ok: false, error: lockAcq.error, conflict: lockAcq.conflict });
  try {
    return cmdRunLocked(a, targetPath, workspace);
  } finally {
    releaseRunLock(lockAcq);
  }
}

function cmdRunLocked(a, targetPath, workspace) {
  const artifactsDir = path.join(targetPath, '.harnesskit');
  const dagPath = path.join(artifactsDir, 'workflow-dag.json');
  if (fs.existsSync(dagPath)) {
    const existing = JSON.parse(fs.readFileSync(dagPath, 'utf8'));
    if (existing.stages.some(s => s.status !== 'pending')) {
      return printJson({ ok: false, error: `an in-progress workflow already exists at ${dagPath} -- use 'harnesskit resume --target ${targetPath}' to continue it instead of starting over`, workflow_dag_path: dagPath });
    }
  }

  const { profile } = inspectRepo(targetPath);
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, 'repo-profile.json'), JSON.stringify(profile, null, 2));

  const dag = composeWorkflow({ taskClass: null, repoProfile: profile });
  dag.instruction = a.instruction;
  // FINDING 1 FIX: derived from dag.composed_at (see stableRunIdForWorkflow) instead of
  // Date.now() -- the SAME value must come back out of a later `resume --target` call against
  // this same workflow for handlePrepareCommit's crash-idempotency guard to work at all.
  const ctx = { targetPath, artifactsDir, runId: stableRunIdForWorkflow(targetPath, dag), repoProfile: profile, instruction: a.instruction };
  const { pausedAt } = executeWorkflow(dag, ctx);
  fs.writeFileSync(dagPath, JSON.stringify(dag, null, 2));

  printJson({
    ok: true, target_path: targetPath, workspace, instruction: a.instruction,
    paused_at: pausedAt, stages: dag.stages.map(s => ({ stage_id: s.stage_id, status: s.status, selected_adapter: s.selected_adapter })),
    workflow_dag_path: path.join(artifactsDir, 'workflow-dag.json'),
    note: pausedAt ? `paused at '${pausedAt}' -- see status. Orchestrator stages require the calling agent; missing_capability stages require a real adapter before continuing.` : 'workflow completed with no pause point reached'
  });
}

const COMMANDS = { inspect: cmdInspect, capabilities: cmdCapabilities, doctor: cmdDoctor, status: cmdStatus, resume: cmdResume, run: cmdRun };

// async: the legacy commands are all synchronous (return undefined), so `await`ing them is a
// no-op; --engine langgraph commands return a real Promise (langgraph-workflow.js's API is
// async throughout) and this is what actually waits for it before the process exits.
async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  if (!verb || !COMMANDS[verb]) {
    console.log(`harnesskit — usage: harnesskit <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(verb ? 1 : 0);
  }
  const a = parseArgs(argv.slice(1));
  await COMMANDS[verb](a);
}

// Builds a local, network-free repo whose tree contains a Windows-reserved-device-name path
// (a real object in the git tree, never materialized on disk until checkout is attempted) --
// reproduces the exact failure class recoverHostileFixtureClone() exists to survive, without
// touching the network or requiring an actual hostile file to sit on disk beforehand.
function buildSyntheticHostileRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, encoding: 'utf8' });
  const normalBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: "print('normal')\n", encoding: 'utf8' }).trim();
  const reservedNameBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: "print('reserved-name')\n", encoding: 'utf8' }).trim();
  const overlongBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: "print('overlong-name')\n", encoding: 'utf8' }).trim();
  const overlongName = 'a'.repeat(280) + '.py'; // > Windows 260-char MAX_PATH -- second real failure shape hit against ART
  const treeInput = `100644 blob ${normalBlob}\tnormal.py\n100644 blob ${reservedNameBlob}\tcon.py\n100644 blob ${overlongBlob}\t${overlongName}\n`;
  const tree = execFileSync('git', ['mktree'], { cwd: dir, input: treeInput, encoding: 'utf8' }).trim();
  const commit = execFileSync('git', ['commit-tree', tree, '-m', 'synthetic hostile fixture'], { cwd: dir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'HEAD', commit], { cwd: dir, encoding: 'utf8' });
  return { overlongName };
}

async function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });

  // Known-defect fix: --self-test has an implicit precondition -- HARNESS_ROOT must point at a
  // directory containing config/adapter-registry.json (etc.), because capability resolution
  // (router/select-adapter.js) reads from harnessRoot() with no repo-relative fallback (see F27,
  // docs -- ~/.harnesskit/config/ is empty by default). Reported plainly, up front, once, instead of
  // letting every downstream run/resume-dependent assertion below fail confusingly or (as this
  // exact gap did before this fix) crash the whole process with an uncaught ENOENT reading an
  // artifact file that a silently-failed run/resume never wrote.
  {
    const configRootReachable = fs.existsSync(path.join(harnessRoot(), 'config', 'adapter-registry.json'));
    const detail = `HARNESS_ROOT (${harnessRoot()}) has no config/adapter-registry.json -- run/resume-dependent assertions below will legitimately fail closed (missing_capability), not silently pass; set HARNESS_ROOT to a directory that ships config/ (e.g. this repo) before trusting --self-test's overall verdict`;
    push('config_root_reachable_for_selftest', configRootReachable, detail);
    // Independent-review finding (real): pushing to `results` alone is not enough -- results only
    // ever prints in the final summary loop below, which a LATER uncaught exception (caught by the
    // top-level .catch() at the bottom of this file) prevents from ever running. Print this
    // precondition warning immediately, right here, so it surfaces even when something downstream
    // throws before selfTest() reaches its own end.
    if (!configRootReachable) console.error(`self-test precondition warning: ${detail}`);
  }

  push('resolveWorkspace_flag_wins', resolveWorkspace({ workspace: '/x' }) === '/x', 'explicit --workspace must win');
  push('resolveWorkspace_env_fallback', (() => {
    const prev = process.env.HARNESSKIT_WORKSPACE;
    process.env.HARNESSKIT_WORKSPACE = '/env-ws';
    const r = resolveWorkspace({});
    if (prev === undefined) delete process.env.HARNESSKIT_WORKSPACE; else process.env.HARNESSKIT_WORKSPACE = prev;
    return r === '/env-ws';
  })(), 'env var used when no flag given');
  push('resolveWorkspace_durable_default_not_tmpdir', (() => {
    const prev = process.env.HARNESSKIT_WORKSPACE;
    delete process.env.HARNESSKIT_WORKSPACE;
    const r = resolveWorkspace({});
    if (prev !== undefined) process.env.HARNESSKIT_WORKSPACE = prev;
    // MANDATORY FIX (Batch 1): no flag, no env -> a durable location under the harness root,
    // NEVER os.tmpdir() -- regression test proving an ART-like clone with no explicit workspace
    // override does not land in Temp (the real, live condition that put the actual ART clone one
    // Windows Temp-cleanup away from permanently losing an unpushed commit + run evidence).
    return r === path.join(harnessRoot(), 'workspace') && !isUnderTempDir(r);
  })(), 'no flag, no env -> durable harness-root workspace, never Temp');
  push('resolveWorkspace_explicit_temp_override_still_detectable', (() => {
    const tempPath = path.join(os.tmpdir(), 'some-explicit-choice');
    return isUnderTempDir(resolveWorkspace({ workspace: tempPath })) === true;
  })(), 'an explicit --workspace pointed at Temp is still correctly classified as Temp (for doctor to warn on), not silently normalized away');
  push('isRemoteRepoSpec_url', isRemoteRepoSpec('https://github.com/x/y.git') === true, 'https url detected');
  push('isRemoteRepoSpec_owner_repo', isRemoteRepoSpec('example-org/example-repo') === true, 'owner/repo shape detected');
  push('isRemoteRepoSpec_local_path_rejected', isRemoteRepoSpec('C:/example/some-repo') === false, 'a real local path must not be misread as owner/repo');

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-selftest-'));
  try {
    const src = path.join(scratchRoot, 'hostile-src');
    const { overlongName } = buildSyntheticHostileRepo(src);

    // Reproduce via `git clone`, the exact call resolveTargetPath() makes -- not a plain
    // checkout, since clone's all-paths-at-once checkout fails hard where a `.` pathspec
    // checkout degrades gracefully (prints the error but still exits 0).
    const dest = path.join(scratchRoot, 'hostile-dest');
    let cloneFailedAsExpected = false;
    try {
      execFileSync('git', ['clone', src, dest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      cloneFailedAsExpected = fs.existsSync(path.join(dest, '.git')) && /invalid path|unable to checkout working tree/i.test(String(e.stderr || e.message || ''));
    }
    push('synthetic_repo_reproduces_windows_clone_checkout_failure', cloneFailedAsExpected, 'a real reserved-device-name path in the tree must make `git clone` fail its checkout the same way it did against the real ART repo, else this self-test proves nothing');

    const { excludedPaths } = recoverHostileFixtureClone(dest);
    const expectedExcluded = ['con.py', overlongName].sort();
    push('recovery_excludes_both_hostile_shapes', JSON.stringify([...excludedPaths].sort()) === JSON.stringify(expectedExcluded), JSON.stringify(excludedPaths));
    push('recovery_leaves_normal_file_present', fs.existsSync(path.join(dest, 'normal.py')), 'the non-hostile path must actually be checked out, not also dropped');
    push('recovery_never_materializes_reserved_name_file', !fs.existsSync(path.join(dest, 'con.py')), 'the excluded reserved-name path must not exist on disk after recovery');
    push('recovery_never_materializes_overlong_name_file', !fs.existsSync(path.join(dest, overlongName)), 'the excluded overlong-name path must not exist on disk after recovery');
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  // End-to-end: `run` pauses honestly at a genuine discover-task tie (the real shape hit against
  // ART), `resume --target` applies an orchestrator resolution and continues, and the original
  // instruction survives the round-trip unchanged -- the actual proof this batch needs that
  // "resume retains the original goal, evidence, and producer history."
  {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cli-selftest-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoRoot, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot, encoding: 'utf8' });
      fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), 'Active task: TASKA100.\n\nAlso the active task right now: TASKB200.\n');
      execFileSync('git', ['add', '-A'], { cwd: repoRoot, encoding: 'utf8' });
      execFileSync('git', ['commit', '-q', '-m', 'chore: seed fixture'], { cwd: repoRoot, encoding: 'utf8' });

      const captured = [];
      const origLog = console.log;
      console.log = (...args) => captured.push(args.map(String).join(' '));
      try {
        COMMANDS.run({ repo: repoRoot, instruction: 'self-test instruction, must survive resume' });
      } finally { console.log = origLog; }
      const runOut = JSON.parse(captured[captured.length - 1]);
      push('cli_run_pauses_at_discover_task_tie', runOut.ok === true && runOut.paused_at === 'discover-task', JSON.stringify(runOut.paused_at));

      captured.length = 0;
      console.log = (...args) => captured.push(args.map(String).join(' '));
      try {
        await COMMANDS.resume({ target: repoRoot, 'resolve-stage': 'discover-task', 'resolve-status': 'completed', 'resolve-outputs': JSON.stringify({ selected_task: 'TASKA100', resolution_reason: 'self-test orchestrator pick' }) });
      } finally { console.log = origLog; }
      const resumeOut = JSON.parse(captured[captured.length - 1]);
      push('cli_resume_target_advances_past_resolved_stage', resumeOut.ok === true && resumeOut.paused_at !== 'discover-task', JSON.stringify(resumeOut.paused_at));
      push('cli_resume_target_preserves_original_instruction', resumeOut.instruction === 'self-test instruction, must survive resume', JSON.stringify(resumeOut.instruction));

      // Known-defect fix: this used to unconditionally fs.readFileSync task-discovery.json, which
      // only ever gets written by a successful resume past discover-task. When resume itself failed
      // (e.g. HARNESS_ROOT unset -> harnessRoot() falls back to the real ~/.harnesskit, which has no
      // config/adapter-registry.json -- inspect-repository never resolves 'terminal', so run() pauses
      // at inspect-repository with missing_capability, discover-task's task-discovery.json is never
      // written, and resume correctly replies {ok:false, error:'no task-discovery.json found...'}),
      // this line threw an uncaught ENOENT instead of a graceful FAIL. Check existence first --
      // consistent with every self-test in this file requiring a config-bearing HARNESS_ROOT to pass,
      // but no longer crashing the whole --self-test process when that precondition isn't met.
      const discoveryPath = path.join(repoRoot, '.harnesskit', 'task-discovery.json');
      if (fs.existsSync(discoveryPath)) {
        const persistedDiscovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
        push('cli_resume_target_records_resolution_evidence', persistedDiscovery.resolved_by === 'orchestrator' && persistedDiscovery.selected_task === 'TASKA100', JSON.stringify({ resolved_by: persistedDiscovery.resolved_by, selected_task: persistedDiscovery.selected_task }));
      } else {
        push('cli_resume_target_records_resolution_evidence', false, `task-discovery.json was never written at ${discoveryPath} (resumeOut=${JSON.stringify(resumeOut)}) -- resume did not advance past discover-task, most likely HARNESS_ROOT is unset/misconfigured (see config_root_missing_for_selftest below)`);
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  // FINDING 1 FIX (run-lock): the legacy `run`/`resume --target` path must refuse to proceed
  // against a target that another session already holds a live lease over, instead of silently
  // racing it (two concurrent invocations against the same target could otherwise both drive git
  // there at once). Simulated deterministically: pre-acquire a conflicting lease (a DIFFERENT
  // owner_session than this process's own, matching what a genuinely separate OS process would
  // look like) against the same target path, in an isolated `--lock-root` so this never touches
  // the real shared lock directory or leaves stale state behind for other self-test runs.
  {
    const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cli-lock-selftest-root-'));
    const repoRootLock = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cli-lock-selftest-repo-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoRootLock, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRootLock, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRootLock, encoding: 'utf8' });
      fs.writeFileSync(path.join(repoRootLock, 'README.md'), '# fixture\n\nActive task: TASKLOCK001.\n');
      execFileSync('git', ['add', '-A'], { cwd: repoRootLock, encoding: 'utf8' });
      execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: repoRootLock, encoding: 'utf8' });

      const conflicting = lease.acquireLease({
        scopes: [path.resolve(repoRootLock)], owner_session: `simulated-other-process-${process.pid}`,
        kind: 'path', ttlHours: 1, root: lockRoot
      });
      push('lock_selftest_setup_conflicting_lease_acquired', conflicting.ok === true, JSON.stringify(conflicting));

      const capturedLock = [];
      const origLogLock = console.log;
      console.log = (...args) => capturedLock.push(args.map(String).join(' '));
      try {
        COMMANDS.run({ repo: repoRootLock, instruction: 'must be rejected by the held lock', 'lock-root': lockRoot });
      } finally { console.log = origLogLock; }
      const lockedRunOut = JSON.parse(capturedLock[capturedLock.length - 1]);
      push('cli_run_rejected_by_conflicting_run_lock',
        lockedRunOut.ok === false && /already in progress/.test(lockedRunOut.error) && lockedRunOut.conflict && lockedRunOut.conflict.owner_session === conflicting.lock.owner_session,
        JSON.stringify(lockedRunOut));
      push('cli_run_rejected_by_lock_never_wrote_a_workflow_dag',
        !fs.existsSync(path.join(repoRootLock, '.harnesskit', 'workflow-dag.json')),
        'a rejected-by-lock run must never have started composing/executing a workflow against the target');

      lease.releaseLease({ root: lockRoot, lock_id: conflicting.lock.lock_id });

      capturedLock.length = 0;
      console.log = (...args) => capturedLock.push(args.map(String).join(' '));
      try {
        COMMANDS.run({ repo: repoRootLock, instruction: 'must succeed once the conflicting lease is released', 'lock-root': lockRoot });
      } finally { console.log = origLogLock; }
      const unlockedRunOut = JSON.parse(capturedLock[capturedLock.length - 1]);
      push('cli_run_proceeds_once_conflicting_lock_released', unlockedRunOut.ok === true, JSON.stringify({ ok: unlockedRunOut.ok, paused_at: unlockedRunOut.paused_at }));
    } finally {
      fs.rmSync(repoRootLock, { recursive: true, force: true });
      fs.rmSync(lockRoot, { recursive: true, force: true });
    }
  }

  // Phase 5: `--engine langgraph` is real CLI surface, not a library sitting unused -- proves the
  // SAME run/resume verbs, with the SAME --repo/--instruction/--target contract, route through
  // scripts/langgraph-workflow.js's real StateGraph engine when the flag is given, and that the
  // legacy engine (no flag) is completely unaffected by this addition.
  {
    const repoRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cli-lg-selftest-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repoRoot2, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot2, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot2, encoding: 'utf8' });
      fs.writeFileSync(path.join(repoRoot2, 'README.md'), '# fixture\n\nActive task: TASKX001.\n');
      execFileSync('git', ['add', '-A'], { cwd: repoRoot2, encoding: 'utf8' });
      execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: repoRoot2, encoding: 'utf8' });

      const captured2 = [];
      const origLog2 = console.log;
      console.log = (...args) => captured2.push(args.map(String).join(' '));
      try {
        await COMMANDS.run({ engine: 'langgraph', repo: repoRoot2, instruction: 'cli langgraph self-test' });
      } finally { console.log = origLog2; }
      const lgRunOut = JSON.parse(captured2[captured2.length - 1]);
      push('cli_engine_langgraph_run_reaches_plan', lgRunOut.ok === true && lgRunOut.engine === 'langgraph' && lgRunOut.paused_at === 'plan', JSON.stringify({ ok: lgRunOut.ok, engine: lgRunOut.engine, paused_at: lgRunOut.paused_at }));

      captured2.length = 0;
      console.log = (...args) => captured2.push(args.map(String).join(' '));
      try {
        await COMMANDS.resume({ engine: 'langgraph', target: repoRoot2, 'resume-value': JSON.stringify({ status: 'completed', outputs: { plan_summary: 'cli lg plan' } }) });
      } finally { console.log = origLog2; }
      const lgResumeOut = JSON.parse(captured2[captured2.length - 1]);
      push('cli_engine_langgraph_resume_advances_past_plan', lgResumeOut.ok === true && lgResumeOut.paused_at === 'execute', JSON.stringify(lgResumeOut.paused_at));

      // Default engine (no --engine flag) must be completely unaffected: same repo, fresh legacy
      // run, still pauses at 'discover-task' (there's no tie here, but discover-task still runs;
      // with only one candidate it should sail through to 'plan' too, same as the langgraph path --
      // confirms the legacy engine's behavior on the SAME fixture is unchanged by this addition).
      captured2.length = 0;
      console.log = (...args) => captured2.push(args.map(String).join(' '));
      const repoRootLegacy = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cli-legacy-unaffected-'));
      execFileSync('git', ['init', '-q'], { cwd: repoRootLegacy, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRootLegacy, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRootLegacy, encoding: 'utf8' });
      fs.writeFileSync(path.join(repoRootLegacy, 'README.md'), '# fixture\n\nActive task: TASKX001.\n');
      execFileSync('git', ['add', '-A'], { cwd: repoRootLegacy, encoding: 'utf8' });
      execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: repoRootLegacy, encoding: 'utf8' });
      try {
        await COMMANDS.run({ repo: repoRootLegacy, instruction: 'legacy engine unaffected check' });
      } finally { console.log = origLog2; }
      const legacyOut = JSON.parse(captured2[captured2.length - 1]);
      push('legacy_engine_unaffected_by_langgraph_addition', legacyOut.ok === true && legacyOut.paused_at === 'plan', JSON.stringify(legacyOut.paused_at));
      fs.rmSync(repoRootLegacy, { recursive: true, force: true });
    } finally {
      fs.rmSync(repoRoot2, { recursive: true, force: true });
    }
  }

  // Engine/checkpoint identity (docs/ENGINE_CHECKPOINT_IDENTITY_REPORT.md): the real, confirmed
  // hazard this batch closes -- bare `resume --target` (implicit legacy) or an explicit
  // `--engine langgraph` must never silently operate against a target actually owned by the OTHER
  // engine. Three scenarios, matching the task's required regression coverage:
  //   (a) langgraph-started target, bare resume attempt -> must refuse, not silently misroute.
  //   (b) legacy-started target, --engine langgraph resume attempt -> must refuse the same way.
  //   (c) a normal same-engine resume in both directions must still work through the new guard.
  // Plus one bonus case exercising guardEngineMismatch's third branch: a target with BOTH a real
  // legacy dag and a real langgraph checkpoint (the ambiguous-coexistence hazard the guard also
  // catches) must refuse regardless of which engine is requested.
  {
    // (a) LangGraph-started target, bare (implicit-legacy) resume attempt.
    const lgOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cli-identity-lgonly-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: lgOnlyRoot, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: lgOnlyRoot, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: lgOnlyRoot, encoding: 'utf8' });
      fs.writeFileSync(path.join(lgOnlyRoot, 'README.md'), '# fixture\n\nActive task: TASKQ001.\n');
      execFileSync('git', ['add', '-A'], { cwd: lgOnlyRoot, encoding: 'utf8' });
      execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: lgOnlyRoot, encoding: 'utf8' });

      const capA = [];
      const origLogA = console.log;
      console.log = (...args) => capA.push(args.map(String).join(' '));
      try {
        await COMMANDS.run({ engine: 'langgraph', repo: lgOnlyRoot, instruction: 'identity self-test: langgraph-started target' });
      } finally { console.log = origLogA; }
      const lgStart = JSON.parse(capA[capA.length - 1]);
      push('identity_setup_langgraph_start_paused_at_plan', lgStart.ok === true && lgStart.paused_at === 'plan', JSON.stringify(lgStart.paused_at));
      push('identity_setup_langgraph_start_wrote_no_legacy_dag', !fs.existsSync(path.join(lgOnlyRoot, '.harnesskit', 'workflow-dag.json')), 'a pure langgraph start must never write workflow-dag.json');

      capA.length = 0;
      console.log = (...args) => capA.push(args.map(String).join(' '));
      try {
        await COMMANDS.resume({ target: lgOnlyRoot, 'resolve-stage': 'plan', 'resolve-outputs': JSON.stringify({ plan_summary: 'must never silently apply' }) });
      } finally { console.log = origLogA; }
      const bareResumeOnLg = JSON.parse(capA[capA.length - 1]);
      push('bare_resume_on_langgraph_target_refuses_not_silently_misroutes',
        bareResumeOnLg.ok === false && /langgraph/i.test(bareResumeOnLg.error) && /--engine langgraph/.test(bareResumeOnLg.error),
        JSON.stringify(bareResumeOnLg));
      push('bare_resume_on_langgraph_target_never_created_a_legacy_dag',
        !fs.existsSync(path.join(lgOnlyRoot, '.harnesskit', 'workflow-dag.json')),
        'the refused bare resume must not have fallen through to cmdResumeTarget and created a fresh legacy workflow-dag.json for this langgraph-owned target');

      // (c) SAME-engine resume against this SAME target must still work normally through the guard.
      capA.length = 0;
      console.log = (...args) => capA.push(args.map(String).join(' '));
      try {
        await COMMANDS.resume({ engine: 'langgraph', target: lgOnlyRoot, 'resume-value': JSON.stringify({ status: 'completed', outputs: { plan_summary: 'identity self-test plan' } }) });
      } finally { console.log = origLogA; }
      const sameEngineResumeLg = JSON.parse(capA[capA.length - 1]);
      push('same_engine_langgraph_resume_still_works_through_the_guard', sameEngineResumeLg.ok === true && sameEngineResumeLg.paused_at === 'execute', JSON.stringify(sameEngineResumeLg.paused_at));
    } finally {
      fs.rmSync(lgOnlyRoot, { recursive: true, force: true });
    }

    // (b) Legacy-started target, --engine langgraph resume attempt.
    const legacyOnlyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-cli-identity-legacyonly-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: legacyOnlyRoot, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: legacyOnlyRoot, encoding: 'utf8' });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: legacyOnlyRoot, encoding: 'utf8' });
      fs.writeFileSync(path.join(legacyOnlyRoot, 'README.md'), '# fixture\n\nActive task: TASKZ002.\n');
      execFileSync('git', ['add', '-A'], { cwd: legacyOnlyRoot, encoding: 'utf8' });
      execFileSync('git', ['commit', '-q', '-m', 'chore: seed'], { cwd: legacyOnlyRoot, encoding: 'utf8' });

      const capB = [];
      const origLogB = console.log;
      console.log = (...args) => capB.push(args.map(String).join(' '));
      try {
        await COMMANDS.run({ repo: legacyOnlyRoot, instruction: 'identity self-test: legacy-started target' });
      } finally { console.log = origLogB; }
      const legacyStart = JSON.parse(capB[capB.length - 1]);
      push('identity_setup_legacy_start_paused_at_plan', legacyStart.ok === true && legacyStart.paused_at === 'plan', JSON.stringify(legacyStart.paused_at));
      push('identity_setup_legacy_start_wrote_no_langgraph_checkpoint', !fs.existsSync(path.join(legacyOnlyRoot, '.harnesskit', 'langgraph-checkpoints.sqlite')), 'a pure legacy start must never create a langgraph checkpoint file');

      capB.length = 0;
      console.log = (...args) => capB.push(args.map(String).join(' '));
      try {
        await COMMANDS.resume({ engine: 'langgraph', target: legacyOnlyRoot, 'resume-value': JSON.stringify({ status: 'completed', outputs: { plan_summary: 'must never silently apply' } }) });
      } finally { console.log = origLogB; }
      const lgResumeOnLegacy = JSON.parse(capB[capB.length - 1]);
      push('langgraph_resume_on_legacy_target_refuses_not_silently_misroutes',
        lgResumeOnLegacy.ok === false && /legacy engine/i.test(lgResumeOnLegacy.error) && /without --engine/.test(lgResumeOnLegacy.error),
        JSON.stringify(lgResumeOnLegacy));
      push('refused_cross_engine_probe_never_created_a_langgraph_checkpoint_file',
        !fs.existsSync(path.join(legacyOnlyRoot, '.harnesskit', 'langgraph-checkpoints.sqlite')),
        'the refusal must happen before compileGraph() is ever called, so it must not create the checkpoint sqlite file as a side effect');

      // (c) SAME-engine resume (bare, implicit legacy) against this SAME target must still work.
      capB.length = 0;
      console.log = (...args) => capB.push(args.map(String).join(' '));
      try {
        await COMMANDS.resume({ target: legacyOnlyRoot, 'resolve-stage': 'plan', 'resolve-outputs': JSON.stringify({ plan_summary: 'identity self-test legacy plan' }) });
      } finally { console.log = origLogB; }
      const sameEngineResumeLegacy = JSON.parse(capB[capB.length - 1]);
      push('same_engine_legacy_resume_still_works_through_the_guard', sameEngineResumeLegacy.ok === true && sameEngineResumeLegacy.paused_at !== 'plan', JSON.stringify(sameEngineResumeLegacy.paused_at));

      // Bonus: create the ambiguous-coexistence hazard on top of this SAME legacy-owned target (a
      // langgraph run started against a target that already has legacy history) and confirm the
      // guard's third branch refuses regardless of which engine is requested, rather than silently
      // picking one of two real, conflicting workflow states.
      const capC = [];
      const origLogC = console.log;
      console.log = (...args) => capC.push(args.map(String).join(' '));
      try {
        await COMMANDS.run({ engine: 'langgraph', repo: legacyOnlyRoot, instruction: 'identity self-test: force ambiguous coexistence' });
      } finally { console.log = origLogC; }
      const coexistStart = JSON.parse(capC[capC.length - 1]);
      push('ambiguous_setup_langgraph_run_also_succeeds_against_legacy_owned_target', coexistStart.ok === true, JSON.stringify(coexistStart.ok));

      capC.length = 0;
      console.log = (...args) => capC.push(args.map(String).join(' '));
      try {
        await COMMANDS.resume({ target: legacyOnlyRoot, 'resolve-stage': 'execute', 'resolve-outputs': JSON.stringify({}) });
      } finally { console.log = origLogC; }
      const ambiguousResume = JSON.parse(capC[capC.length - 1]);
      push('ambiguous_coexistence_refuses_regardless_of_requested_engine',
        ambiguousResume.ok === false && /BOTH/.test(ambiguousResume.error) && /ambiguous ownership/.test(ambiguousResume.error),
        JSON.stringify(ambiguousResume));
    } finally {
      fs.rmSync(legacyOnlyRoot, { recursive: true, force: true });
    }
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { COMMANDS, resolveWorkspace, resolveTargetPath, isRemoteRepoSpec, recoverHostileFixtureClone, detectOwningEngine, guardEngineMismatch };

if (require.main === module) {
  // Known-defect fix: this had no .catch() -- an uncaught exception from anywhere inside selfTest()
  // (e.g. a downstream MissingCapabilityError thrown by the LangGraph engine's capability
  // resolution when HARNESS_ROOT points at a root with no config/adapter-registry.json, see
  // resolveAndSetAdapter in scripts/langgraph-workflow.js) rejected this promise with no handler,
  // which Node reports as an uncaught-exception crash (non-graceful, no FAIL line, no controlled
  // exit code) rather than the plain FAIL this function's whole contract exists to produce. Mirrors
  // the .catch() main() already has below.
  if (process.argv.includes('--self-test')) {
    selfTest().then(ok => process.exit(ok ? 0 : 1)).catch(e => {
      console.error(`self-test: uncaught exception -- ${String((e && e.stack) || e)}`);
      process.exit(1);
    });
  } else main().catch(e => { console.error(String((e && e.stack) || e)); process.exit(1); });
}
