#!/usr/bin/env node
// compose-workflow.js — HarnessKit Productization Phase 1: assembles a REAL, evidence-driven
// stage graph for a run, persisted as workflow-dag.json. Not a decorative report: every stage's
// required_capabilities are resolved NOW via capability-resolver.js, so selected_adapter and
// status already reflect real capability availability at compose time (execute-workflow.js
// re-resolves at execution time too, since state can change between compose and execute).
//
// The "deterministic-verify" stage's required_capabilities are genuinely repo-driven: it only
// requires repo.<cmd> for commands inspect-repo.js actually detected in THIS target repo -- a
// repo with no typechecker configured does not get a typecheck requirement invented for it.
'use strict';

const path = require('path');
const fs = require('fs');
const { parseArgs, nowIso } = require('./_lib.js');
const { resolveStage } = require('./capability-resolver.js');

// Engine/checkpoint identity (see docs/ENGINE_CHECKPOINT_IDENTITY_REPORT.md): every composed dag
// is stamped with which engine produced it, so a workflow started under one engine (legacy vs.
// langgraph) is never silently resumed by the other. Bump ENGINE_SCHEMA_VERSION only on a change
// to the *shape* of dag.engine itself (not on unrelated dag/stage-shape changes).
const ENGINE_SCHEMA_VERSION = 1;
const KNOWN_ENGINES = ['legacy', 'langgraph'];

const STAGE_TEMPLATE = [
  { stage_id: 'inspect-repository', required_capabilities: ['terminal'] },
  { stage_id: 'discover-task', required_capabilities: ['terminal'] },
  { stage_id: 'classify-task', required_capabilities: ['planning'] },
  { stage_id: 'challenge-task', required_capabilities: ['architecture'] },
  { stage_id: 'plan', required_capabilities: ['planning'] },
  { stage_id: 'execute', required_capabilities: ['implementation'] },
  { stage_id: 'deterministic-verify', required_capabilities: null }, // filled dynamically below
  { stage_id: 'independent-review', required_capabilities: ['review'] },
  { stage_id: 'prepare-commit', required_capabilities: ['git'] },
  { stage_id: 'final-report', required_capabilities: ['documentation'] }
];

// Linear chain by default -- each stage depends on the one before it. This is the honest "one
// reasonable default sequence," not a claim of general DAG scheduling; compose-workflow.js's real
// contribution is resolving EACH stage's capabilities from live evidence, not the shape of the
// chain itself (which is a template, explicitly allowed to seed the graph per the spec).
function defaultDependencies() {
  const deps = {};
  for (let i = 0; i < STAGE_TEMPLATE.length; i++) {
    deps[STAGE_TEMPLATE[i].stage_id] = i === 0 ? [] : [STAGE_TEMPLATE[i - 1].stage_id];
  }
  return deps;
}

// `engine`: the engine composing this dag. Every current call site is either the legacy CLI (no
// `engine` passed -- defaults to 'legacy', preserving today's on-disk shape exactly) or
// scripts/langgraph-workflow.js's startWorkflow (passes 'langgraph' explicitly). Unknown values
// fail loudly rather than silently mislabeling a run's provenance.
function composeWorkflow({ taskClass, repoProfile, risk, policy, engine }) {
  const engineName = engine || 'legacy';
  if (!KNOWN_ENGINES.includes(engineName)) {
    throw new Error(`composeWorkflow: unknown engine '${engineName}' -- must be one of ${KNOWN_ENGINES.join(', ')}`);
  }
  const detectedCommands = Object.keys((repoProfile && repoProfile.commands) || {});
  const verifyCapabilities = detectedCommands.length > 0 ? detectedCommands.map(c => `repo.${c}`) : ['repo.test'];
  const deps = defaultDependencies();

  const stages = STAGE_TEMPLATE.map(t => {
    const requiredCapabilities = t.stage_id === 'deterministic-verify' ? verifyCapabilities : t.required_capabilities;
    const resolution = resolveStage({ stage_id: t.stage_id, required_capabilities: requiredCapabilities }, { repoProfile, policy: policy || 'highest_verified_quality' });
    return {
      stage_id: t.stage_id,
      required_capabilities: requiredCapabilities,
      selected_adapter: resolution.ok ? resolution.selected_adapter : null,
      inputs: [],
      outputs: [],
      dependencies: deps[t.stage_id],
      selection_reason: resolution.ok
        ? `resolved: ${resolution.results.map(r => `${r.capability_id}->${r.selected_adapter}`).join(', ')}`
        : `unresolved at compose time: ${resolution.results.filter(r => !r.ok).map(r => `${r.capability_id}: ${r.detail}`).join('; ')}`,
      status: resolution.ok ? 'pending' : 'missing_capability'
    };
  });

  return {
    task_class: taskClass || null,
    // Identity metadata (see docs/ENGINE_CHECKPOINT_IDENTITY_REPORT.md): persisted verbatim into
    // workflow-dag.json for the legacy engine, and -- because this whole object becomes the
    // LangGraph graph's `dag` state channel -- into the LangGraph sqlite checkpoint's serialized
    // state too, with no separate write path needed for that second store.
    engine: { name: engineName, schema_version: ENGINE_SCHEMA_VERSION },
    stages,
    composed_at: nowIso(),
    composition_note: 'linear default chain seeded from a template; per-stage capability resolution is real and evidence-driven, re-checked at execution time'
  };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  const profileDir = a['profile-dir'];
  const out = a.out || (profileDir ? path.join(profileDir, '..') : null);
  if (!profileDir || !out) { console.log(JSON.stringify({ ok: false, error: '--profile-dir and --out required' })); process.exit(1); }
  let repoProfile = null;
  try { repoProfile = JSON.parse(fs.readFileSync(path.join(profileDir, 'repo-profile.json'), 'utf8')); } catch { /* proceed without */ }
  const dag = composeWorkflow({ taskClass: a['task-class'], repoProfile, policy: a.policy });
  fs.writeFileSync(path.join(out, 'workflow-dag.json'), JSON.stringify(dag, null, 2));
  console.log(JSON.stringify({ ok: true, out: path.join(out, 'workflow-dag.json'), stages: dag.stages.map(s => ({ stage_id: s.stage_id, status: s.status, selected_adapter: s.selected_adapter })) }, null, 2));
  process.exit(0);
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. Repo with detected test+lint -> deterministic-verify requires exactly those, both resolve.
  {
    const repoProfile = { commands: { test: { command: 'pytest' }, lint: { command: 'ruff check .' } } };
    const dag = composeWorkflow({ taskClass: 'feature', repoProfile });
    const dv = dag.stages.find(s => s.stage_id === 'deterministic-verify');
    push('verify_stage_capabilities_match_detected_commands',
      JSON.stringify(dv.required_capabilities.sort()) === JSON.stringify(['repo.lint', 'repo.test']) && dv.status === 'pending',
      JSON.stringify(dv));
  }
  // 2. Repo with NO detected commands -> deterministic-verify honestly requires repo.test and fails closed (missing_capability), not silently invented as satisfied.
  {
    const repoProfile = { commands: {} };
    const dag = composeWorkflow({ taskClass: 'feature', repoProfile });
    const dv = dag.stages.find(s => s.stage_id === 'deterministic-verify');
    push('verify_stage_fails_closed_when_no_commands_detected', dv.status === 'missing_capability', JSON.stringify(dv));
  }
  // 3. Every stage has all 8 required fields.
  {
    const dag = composeWorkflow({ taskClass: 'feature', repoProfile: { commands: { test: { command: 'pytest' } } } });
    const requiredFields = ['stage_id', 'required_capabilities', 'selected_adapter', 'inputs', 'outputs', 'dependencies', 'selection_reason', 'status'];
    const allFieldsPresent = dag.stages.every(s => requiredFields.every(f => f in s));
    push('every_stage_declares_all_required_fields', allFieldsPresent, JSON.stringify(Object.keys(dag.stages[0])));
  }
  // 4. Dependency chain is real and well-formed: first stage has no deps, each later stage depends on the one before.
  {
    const dag = composeWorkflow({ taskClass: 'feature', repoProfile: {} });
    const chainOk = dag.stages[0].dependencies.length === 0 &&
      dag.stages.slice(1).every((s, i) => JSON.stringify(s.dependencies) === JSON.stringify([dag.stages[i].stage_id]));
    push('dependency_chain_well_formed', chainOk, JSON.stringify(dag.stages.map(s => ({ id: s.stage_id, deps: s.dependencies }))));
  }
  // 5. All 10 required stage_ids present (per the mandate's minimum handler list).
  {
    const dag = composeWorkflow({ taskClass: 'feature', repoProfile: {} });
    const required = ['inspect-repository', 'discover-task', 'classify-task', 'challenge-task', 'plan', 'execute', 'deterministic-verify', 'independent-review', 'prepare-commit', 'final-report'];
    const present = required.every(id => dag.stages.some(s => s.stage_id === id));
    push('all_10_required_stages_present', present, JSON.stringify(dag.stages.map(s => s.stage_id)));
  }
  // 6. selection_reason is never empty -- every stage's adapter choice (or lack of one) is explained.
  {
    const dag = composeWorkflow({ taskClass: 'feature', repoProfile: {} });
    push('every_stage_has_nonempty_selection_reason', dag.stages.every(s => typeof s.selection_reason === 'string' && s.selection_reason.length > 0), '');
  }
  // 7. Engine identity (docs/ENGINE_CHECKPOINT_IDENTITY_REPORT.md): defaults to 'legacy' when no
  // `engine` option is given (today's only real caller, bin/harnesskit.js's legacy run path, never
  // passes one -- this default must never silently change the on-disk shape existing consumers of
  // workflow-dag.json already depend on), and an explicit value is stamped verbatim + versioned.
  {
    const dagDefault = composeWorkflow({ taskClass: 'feature', repoProfile: {} });
    push('engine_identity_defaults_to_legacy', dagDefault.engine && dagDefault.engine.name === 'legacy' && dagDefault.engine.schema_version === ENGINE_SCHEMA_VERSION, JSON.stringify(dagDefault.engine));

    const dagLg = composeWorkflow({ taskClass: 'feature', repoProfile: {}, engine: 'langgraph' });
    push('engine_identity_stamps_explicit_langgraph', dagLg.engine && dagLg.engine.name === 'langgraph' && dagLg.engine.schema_version === ENGINE_SCHEMA_VERSION, JSON.stringify(dagLg.engine));

    let threw = false;
    try { composeWorkflow({ taskClass: 'feature', repoProfile: {}, engine: 'some-made-up-engine' }); }
    catch (e) { threw = /unknown engine/.test(String(e.message)); }
    push('engine_identity_rejects_unknown_engine_name', threw, 'an unrecognized engine value must fail loudly, not silently mislabel provenance');
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { composeWorkflow, STAGE_TEMPLATE, ENGINE_SCHEMA_VERSION, KNOWN_ENGINES };
if (require.main === module) main();
