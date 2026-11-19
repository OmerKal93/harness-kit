#!/usr/bin/env node
// workflow-handlers.js — HarnessKit Batch-1 (P5a, shared-handler extraction). Extracted verbatim
// (pure extraction, no behavior change) from scripts/execute-workflow.js so that
// scripts/langgraph-workflow.js no longer needs to `require()` the legacy engine's own file to get
// at the real stage handlers, the independent-review independence gate, or completeStage(). Before
// this extraction, langgraph-workflow.js destructured AUTOMATED_HANDLERS/ORCHESTRATOR_STAGES/
// completeStage/validateReviewIndependence straight out of execute-workflow.js -- meaning the
// legacy engine could never be retired as a file while the LangGraph engine depended on it
// directly. This module is now the one shared base BOTH engines depend on; neither engine file
// requires the other for any of what lives here (see the import-boundary self-test in
// execute-workflow.js --self-test, and the dual-engine parity smoke test alongside it).
//
// What stayed in execute-workflow.js (deliberately NOT extracted): topologicalOrder/
// transitivelyBlockedBy and the executeWorkflow() dispatch loop itself, and ORCHESTRATOR_STAGES --
// all legacy-engine-specific orchestration mechanics. LangGraph doesn't need ORCHESTRATOR_STAGES
// (it hardcodes plan/execute/independent-review as orchestrator nodes at graph-construction time
// via makeOrchestratorNode, confirmed by inspection -- it never actually read that import) and it
// has its own graph-native dispatch (StateGraph), not this one's Kahn's-algorithm loop.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nowIso, tokenizeCommand, gitDiffPaths } = require('./_lib.js');
const { route } = require('../router/select-adapter.js');
const { inspectRepo } = require('./inspect-repo.js');
const { discoverTasks, CONFIDENCE_SELECT_THRESHOLD } = require('./task-discovery.js');
// Secret/scanning trust boundary: real wired call sites at (5) before commit and (3) after tool
// output is produced -- see handlePrepareCommit and handleDeterministicVerify below. Routed through
// the broker layer (scripts/security-brokers/), not security-boundary.js directly -- see
// docs/SECURITY_BROKER_ARCHITECTURE_REPORT.md. scripts/check-broker-conformance.js fails the suite
// if this file (or any file outside scripts/security-brokers/) ever requires security-boundary.js
// directly again.
const commitBroker = require('./security-brokers/commit-broker.js');
const toolOutputBroker = require('./security-brokers/tool-output-broker.js');
const { verifyToken } = require('./security-brokers/provenance-token.js');
const { redactString } = require('./redact.js');
// Phase 8: 7-state verification classification (replaces the old binary pass/fail) + the
// blocking-vs-overridable policy that gates prepare-commit. tokenizeCommand lives in _lib.js (not
// re-defined here) specifically so this module and verification-classifier.js can both use it
// without a require cycle.
const {
  classifyVerification, combineStatuses, isValidOverride, isHeuristicOnlyAcknowledged,
  HARD_BLOCK_STATUSES, OVERRIDABLE_STATUSES
} = require('./verification-classifier.js');

// Engine/checkpoint identity metadata (P5a plumbing only).
// A single shared version constant both engines stamp onto their persisted `dag` (workflow-dag.json
// for the legacy engine, the LangGraph checkpoint's own state for the langgraph engine) so a run's
// dag/checkpoint always says which engine produced it and against which dag-shape contract. This is
// ONLY the field/plumbing -- the actual cross-engine-resume auto-detect-or-refuse behavior (reading
// this field back and refusing a mismatched resume) is P5b's (hk/p5b-engine-identity) scope, not
// implemented here.
const WORKFLOW_DAG_SCHEMA_VERSION = '1.0.0';

// --- Automated handlers ---
function handleInspectRepository(stage, ctx) {
  const { profile, facts, risk, knowledgeIndex } = inspectRepo(ctx.targetPath);
  fs.mkdirSync(ctx.artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.artifactsDir, 'repo-profile.json'), JSON.stringify(profile, null, 2));
  fs.writeFileSync(path.join(ctx.artifactsDir, 'repo-facts.json'), JSON.stringify(facts, null, 2));
  fs.writeFileSync(path.join(ctx.artifactsDir, 'repo-risk-report.json'), JSON.stringify(risk, null, 2));
  fs.writeFileSync(path.join(ctx.artifactsDir, 'repo-knowledge-index.json'), JSON.stringify(knowledgeIndex, null, 2));
  ctx.repoProfile = profile;
  const status = profile.stack.language === 'unknown' && !fs.existsSync(ctx.targetPath) ? 'failed' : 'completed';
  return { status, outputs: { repo_profile_path: path.join(ctx.artifactsDir, 'repo-profile.json'), stack: profile.stack.language } };
}

function handleDiscoverTask(stage, ctx) {
  const docPrecedence = (ctx.repoProfile && ctx.repoProfile.doc_precedence) || [];
  const result = discoverTasks({ targetPath: ctx.targetPath, docPrecedence });
  fs.writeFileSync(path.join(ctx.artifactsDir, 'task-discovery.json'), JSON.stringify(result, null, 2));
  ctx.taskDiscovery = result;
  if (result.decision === 'NEEDS_USER') {
    return { status: 'needs_user', outputs: { task_discovery_path: path.join(ctx.artifactsDir, 'task-discovery.json'), reason: result.decision_reason } };
  }
  return { status: 'completed', outputs: { task_discovery_path: path.join(ctx.artifactsDir, 'task-discovery.json'), selected_task: result.selected_task } };
}

// Lean, generic, real keyword classifier -- not NLP, not ART-specific. Maps discovered-task
// context text onto the 12 task classes the mandate names.
const CLASS_KEYWORDS = [
  ['bug', /\b(bug|fix|broken|error|regression)\b/i],
  ['migration', /\bmigrat/i],
  ['docs', /\b(doc|readme|documentation)\b/i],
  ['security', /\b(security|vulnerab|secret|cve)\b/i],
  ['ci_repair', /\b(ci|pipeline)\s+(fail|broken|repair)\b/i],
  ['release', /\brelease\b/i],
  ['refactor', /\brefactor/i],
  ['repository_audit', /\baudit\b/i],
  ['research', /\bresearch\b/i],
  ['incident', /\bincident\b/i],
  ['greenfield_build', /\b(bootstrap|scaffold|initial(ize)?)\b/i],
  ['feature', /\b(add|implement|feature|build)\b/i]
];
function classifyTaskClass(contextText) {
  for (const [cls, re] of CLASS_KEYWORDS) if (re.test(contextText)) return cls;
  return 'feature'; // honest default -- most agent-lint-shaped work is additive feature work
}
function handleClassifyTask(stage, ctx) {
  const selected = ctx.taskDiscovery && ctx.taskDiscovery.selected_task;
  const candidate = ctx.taskDiscovery && ctx.taskDiscovery.candidate_tasks.find(c => c.id === selected);
  const contextText = candidate ? candidate.mentions.map(m => m.context).join(' ') : '';
  const taskClass = classifyTaskClass(contextText);
  ctx.taskClass = taskClass;
  return { status: 'completed', outputs: { task_class: taskClass, based_on_context: contextText.slice(0, 200) } };
}

function handleChallengeTask(stage, ctx) {
  const selected = ctx.taskDiscovery && ctx.taskDiscovery.selected_task;
  if (!selected) return { status: 'needs_user', outputs: { reason: 'no task was selected by discover-task to challenge' } };
  // Adversarial recheck: re-run discovery fresh (guards against staleness between discover and
  // challenge, e.g. new commits landing) and confirm the selection still holds up.
  const docPrecedence = (ctx.repoProfile && ctx.repoProfile.doc_precedence) || [];
  const fresh = discoverTasks({ targetPath: ctx.targetPath, docPrecedence });

  if (fresh.selected_task === selected) {
    return { status: 'completed', outputs: { challenged_task: selected, reconfirmed: true, contradictions_found: fresh.contradictions.length } };
  }

  // The selection may have come from an orchestrator resolving a genuine tie (discover-task
  // legitimately returned NEEDS_USER with multiple co-equal candidates -- rerunning auto-discovery
  // will tie again, by construction, so exact-match-with-fresh-auto-pick can never succeed here).
  // The real adversarial question in that case isn't "did auto-pick agree" but "does this specific
  // candidate still hold up": does it still exist, still clear the selection threshold, and does a
  // fresh scan show it's now already completed (the actual staleness risk this stage exists to catch).
  if (ctx.taskDiscovery.resolved_by === 'orchestrator') {
    const freshCandidate = fresh.candidate_tasks.find(c => c.id === selected);
    if (!freshCandidate) {
      return { status: 'needs_user', outputs: { reason: `challenge found '${selected}' no longer appears as a real candidate on a fresh scan` } };
    }
    if (freshCandidate.evidence.completion_commit_found) {
      return { status: 'needs_user', outputs: { reason: `challenge found '${selected}' now has a completion-shaped commit -- appears already done` } };
    }
    if (freshCandidate.confidence < CONFIDENCE_SELECT_THRESHOLD) {
      return { status: 'needs_user', outputs: { reason: `challenge found '${selected}' confidence dropped to ${freshCandidate.confidence.toFixed(2)}, below selection threshold ${CONFIDENCE_SELECT_THRESHOLD}` } };
    }
    return { status: 'completed', outputs: { challenged_task: selected, reconfirmed: true, reconfirmed_via: 'orchestrator_tie_still_viable', contradictions_found: fresh.contradictions.length } };
  }

  return { status: 'needs_user', outputs: { reason: `challenge found the selection changed on recheck: was ${selected}, fresh recheck says ${fresh.selected_task || 'NEEDS_USER'}` } };
}

// handleDeterministicVerify: runs every detected repo.* command for real, classifies each run's
// result into one of the 7 canonical verification statuses (verification-classifier.js), combines
// them into one overall status by severity, and applies the blocking policy:
//   - REGRESSION_DETECTED / FAILED (HARD_BLOCK_STATUSES): stage fails, no override possible.
//   - KNOWN_PREEXISTING_FAILURES / ENVIRONMENT_BLOCKED / FLAKY_OR_INCONCLUSIVE /
//     VERIFICATION_NOT_AVAILABLE (OVERRIDABLE_STATUSES): stage only completes if ctx.verificationOverride
//     is a well-shaped, explicit override (isValidOverride) -- otherwise 'blocked_pending_override'.
// The override, when present, is always recorded in outputs (never applied silently) so it's
// visible in the persisted workflow-dag.json and in handleFinalReport's report.
function handleDeterministicVerify(stage, ctx) {
  const packageRoot = ctx.repoProfile && ctx.repoProfile.package_root ? path.join(ctx.targetPath, ctx.repoProfile.package_root) : ctx.targetPath;
  const diffFiles = ctx.diffFiles || gitDiffPaths(ctx.targetPath);
  const results = [];
  for (const capId of stage.required_capabilities) {
    const cmdKey = capId.startsWith('repo.') ? capId.slice('repo.'.length) : capId;
    const detected = ctx.repoProfile && ctx.repoProfile.commands && ctx.repoProfile.commands[cmdKey];
    const baseline = (ctx.verificationBaselines && ctx.verificationBaselines[cmdKey]) || [];
    if (!detected) {
      const classification = classifyVerification({ command: null });
      results.push({ capability: capId, ran: false, reason: 'not detected', classification });
      continue;
    }
    const [cmd, ...args] = tokenizeCommand(detected.command);
    // Trust boundary (3): after tool output is produced. Real commands can echo back leaked
    // secrets (env dumps, tokens in stack traces) into stdout/stderr that then gets written to
    // disk as an artifact -- scan + redact the captured tail before it's ever persisted below.
    try {
      const out = execFileSync(cmd, args, { cwd: packageRoot, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
      const tail = out.slice(-2000);
      const scan = toolOutputBroker.scanAfterToolOutput(tail);
      const classification = classifyVerification({ command: detected.command, cwd: packageRoot, exitCode: 0, stdout: out, stderr: '', baseline, diffFiles });
      results.push({ capability: capId, ran: true, command: detected.command, exit_code: 0, output_tail: scan.clean ? tail : redactString(tail), output_scan: { clean: scan.clean, finding_count: scan.findings.length }, classification });
    } catch (e) {
      const stdout = String(e.stdout || '');
      const stderr = String(e.stderr || '');
      const tail = stdout.slice(-2000);
      const scan = toolOutputBroker.scanAfterToolOutput(tail);
      const classification = classifyVerification({ command: detected.command, cwd: packageRoot, exitCode: e.status != null ? e.status : null, stdout, stderr, baseline, diffFiles });
      results.push({ capability: capId, ran: true, command: detected.command, exit_code: e.status != null ? e.status : null, error: String(e.message || e).slice(0, 500), output_tail: scan.clean ? tail : redactString(tail), output_scan: { clean: scan.clean, finding_count: scan.findings.length }, classification });
    }
  }

  const overallStatus = combineStatuses(results.map(r => (r.classification && r.classification.status) || 'VERIFICATION_NOT_AVAILABLE'));

  if (HARD_BLOCK_STATUSES.includes(overallStatus)) {
    // REGRESSION_DETECTED is a hard block by default (HARD_BLOCK_STATUSES is unchanged) -- a real,
    // explicit-confidence regression correlation still can never be waved through casually. But
    // verification-classifier.js's overlapsDiff heuristic can ONLY ever tell "this failing test's
    // name shares a generic, low-information filename token (utils/index/config/base/app/test/...)
    // with a diffed file" from a genuine same-file regression -- a diff touching any commonly-named
    // file would otherwise hard-block on pure naming-convention coincidence with zero override path.
    // So: when EVERY regression-classified result here is marked heuristic_only (none reached
    // 'strong'/distinctive-name confidence), this specific carve-out treats the status as
    // overridable -- but only via an override whose 'classification_basis' field is the exact
    // 'heuristic_only_acknowledged' enum value (see verification-classifier.js#isHeuristicOnlyAcknowledged),
    // never a plain free-text reason, so this can't be confused with, or casually reused for, waving
    // through a real named regression.
    //
    // FINDING 3 FIX (adversarial review, 2026-07-12): this used to accept ANY override whose
    // free-text `reason` merely contained the substring "heuristic-only" -- since THIS FILE'S OWN
    // blocked-reason message (below) contains that exact phrase, an orchestrating agent could clear
    // this hard-block gate by echoing the guard's own vocabulary back at it in a self-authored
    // string, with zero actual proof anyone but the agent itself decided this was heuristic-only.
    // isHeuristicOnlyAcknowledged() closes that specific loophole (see its own comment for why the
    // fix is scoped this way, not a full approval-token system).
    const regressionResults = results.filter(r => r.classification && r.classification.status === 'REGRESSION_DETECTED');
    const allHeuristicOnly = overallStatus === 'REGRESSION_DETECTED' && regressionResults.length > 0 &&
      regressionResults.every(r => r.classification.evidence && r.classification.evidence.heuristic_only === true);
    if (allHeuristicOnly) {
      const override = ctx.verificationOverride;
      const acknowledgesHeuristicOnly = isHeuristicOnlyAcknowledged(override);
      if (acknowledgesHeuristicOnly) {
        return {
          status: 'completed',
          outputs: {
            results, verification_status: overallStatus, blocking: false,
            override: Object.assign({}, override, { applied_to_status: overallStatus, heuristic_only_override: true })
          }
        };
      }
      return {
        status: 'blocked_pending_override',
        outputs: {
          results, verification_status: overallStatus, blocking: false, override: null,
          reason: `verification status '${overallStatus}' is heuristic-only (diff-overlap filename-token collision, no confirmed same-file correlation) -- requires an explicit, recorded override whose 'classification_basis' field is exactly 'heuristic_only_acknowledged' (a free-text reason alone, even one that says the words "heuristic-only", is not sufficient) before the workflow can proceed`
        }
      };
    }
    return { status: 'failed', outputs: { results, verification_status: overallStatus, blocking: true, override: null } };
  }
  if (OVERRIDABLE_STATUSES.includes(overallStatus)) {
    const override = ctx.verificationOverride;
    if (isValidOverride(override)) {
      return { status: 'completed', outputs: { results, verification_status: overallStatus, blocking: false, override: Object.assign({}, override, { applied_to_status: overallStatus }) } };
    }
    return {
      status: 'blocked_pending_override',
      outputs: {
        results, verification_status: overallStatus, blocking: false, override: null,
        reason: `verification status '${overallStatus}' requires an explicit, recorded override (ctx.verificationOverride: {overridden_by, reason, overridden_at}) before the workflow can proceed`
      }
    };
  }
  return { status: 'completed', outputs: { results, verification_status: overallStatus, blocking: false, override: null } };
}

function handlePrepareCommit(stage, ctx, allStages) {
  const gateStages = ['plan', 'execute', 'deterministic-verify', 'independent-review'];
  const gateOk = gateStages.every(id => {
    const s = allStages.find(x => x.stage_id === id);
    return s && (s.status === 'completed');
  });
  if (!gateOk) {
    return { status: 'blocked', outputs: { reason: 'upstream gate stages not all completed: ' + gateStages.map(id => `${id}=${(allStages.find(x => x.stage_id === id) || {}).status}`).join(', ') } };
  }
  if (!ctx.commitMessage) return { status: 'blocked', outputs: { reason: 'no commit message provided by orchestrator (ctx.commitMessage)' } };
  const targetPath = ctx.repoProfile ? ctx.targetPath : ctx.targetPath;
  // FINDING 1 FIX (checkpoint-vs-side-effect crash window): if the process died AFTER `git commit`
  // landed but BEFORE the caller's checkpoint/dag-write recorded 'prepare-commit' as complete, a
  // resume re-enters this function. Re-running `git add -A` + commit blindly would stage and commit
  // whatever new dirt has since accumulated in the working tree, under the SAME commit message --
  // a duplicate/incorrect commit, violating this project's idempotency rule. Guard against that by
  // checking whether HEAD *already* carries this specific run's completion trailer before touching
  // the index at all. `ctx.runId` is stable across every resume of the same run (the legacy CLI
  // derives it from the persisted dag's `composed_at`; the LangGraph engine carries it as its own
  // checkpointed state channel -- see bin/harnesskit.js / langgraph-workflow.js), so the SAME run
  // resuming twice sees the SAME trailer value, while a genuinely different run never does.
  const RUN_TRAILER_KEY = 'HarnessKit-Run-Id';
  if (ctx.runId) {
    let headMessage = '';
    try {
      headMessage = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: targetPath, encoding: 'utf8' });
    } catch { /* no commits yet, or not a git repo -- fall through to the normal commit path below */ }
    const trailerRe = new RegExp(`^${RUN_TRAILER_KEY}:\\s*${ctx.runId}\\s*$`, 'm');
    if (trailerRe.test(headMessage)) {
      let sha = null;
      try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetPath, encoding: 'utf8' }).trim(); } catch { /* unreachable if the log call above succeeded */ }
      return {
        status: 'completed',
        outputs: {
          commit_sha: sha, message: ctx.commitMessage, pushed: false, idempotent_replay: true,
          note: `prepare-commit already completed for run '${ctx.runId}' (HEAD already carries this run's '${RUN_TRAILER_KEY}' trailer) -- git add -A was NOT re-run, no duplicate commit created`
        }
      };
    }
  }
  try {
    execFileSync('git', ['add', '-A'], { cwd: targetPath, encoding: 'utf8' });
    // Trust boundary (5): before commit. Scan exactly what's about to be committed (the staged
    // diff) for secrets/injected content before the real `git commit` runs. A dirty scan unstages
    // and blocks -- it never silently commits, and never crashes the run (reported as 'blocked'
    // like any other unmet gate).
    //
    // `git diff --cached` exits 0 with empty stdout when nothing is staged -- it does NOT throw for
    // that case (verified empirically). So ANY thrown error here is a genuine failure of the diff
    // command itself (most plausibly: the staged diff is larger than maxBuffer) -- never a signal
    // that "nothing is staged". Defaulting to an empty-string scan on ANY catch would trivially scan
    // clean and let a commit through with ZERO secret scanning on exactly the large-diff case where
    // scanning matters most. So on failure, confirm via a second, much cheaper call (--name-only,
    // tiny output even for a huge diff) whether anything is genuinely staged: only THAT specific,
    // independently-confirmed "truly nothing staged" case is safe to treat as an empty diff. Any
    // other failure mode (the cheap check also fails, or it shows staged files while the real diff
    // still failed) blocks the commit rather than proceeding unscanned.
    let diff = '';
    try {
      diff = execFileSync('git', ['diff', '--cached'], { cwd: targetPath, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    } catch (diffErr) {
      let nameOnly = null;
      try {
        nameOnly = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: targetPath, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
      } catch { /* nameOnly stays null -- treated as a failed confirmation below */ }
      const genuinelyNothingStaged = nameOnly !== null && nameOnly.trim().length === 0;
      if (!genuinelyNothingStaged) {
        try { execFileSync('git', ['reset'], { cwd: targetPath, encoding: 'utf8' }); } catch { /* best-effort unstage */ }
        return {
          status: 'blocked',
          outputs: {
            reason: `git diff --cached failed (${String(diffErr.message || diffErr).slice(0, 300)}) and staged content could not be confirmed empty -- refusing to commit unscanned rather than silently treating the failure as an empty diff`,
            diff_error: String(diffErr.message || diffErr).slice(0, 500)
          }
        };
      }
      // genuinely nothing staged, independently confirmed via --name-only -- safe to scan '' below.
    }
    const scan = commitBroker.scanBeforeCommit(diff);
    // Provenance-token gate (Security Broker Architecture Mechanism 2, see
    // docs/SECURITY_BROKER_ARCHITECTURE_REPORT.md): require a valid broker-minted token bound to
    // THIS exact diff before accepting it as "scanned" -- a single, additive check, not a rewrite
    // of the existing scan-and-block logic below. Catches the case where a future refactor stops
    // routing through commitBroker (no token -> rejected here) or where the diff was mutated
    // between minting and this check (content_mismatch -> rejected here), neither of which the
    // plain `!scan.clean` check alone would ever catch.
    const tokenCheck = verifyToken(diff, scan.token);
    if (!tokenCheck.valid) {
      try { execFileSync('git', ['reset'], { cwd: targetPath, encoding: 'utf8' }); } catch { /* best-effort unstage */ }
      return { status: 'blocked', outputs: { reason: `security-broker provenance check failed (${tokenCheck.reason}) -- staged diff could not be verified as having gone through the commit broker's scan -- commit refused`, token_check: tokenCheck } };
    }
    if (!scan.clean) {
      try { execFileSync('git', ['reset'], { cwd: targetPath, encoding: 'utf8' }); } catch { /* best-effort unstage */ }
      return { status: 'blocked', outputs: { reason: 'security-boundary scanBeforeCommit found findings in the staged diff -- commit refused', findings: scan.findings } };
    }
    // Stamp the run-id trailer (when known) so a crash-then-resume can recognize this exact commit
    // as already-landed instead of re-running -- see the idempotency guard above. `-s` still adds
    // its own Signed-off-by trailer after; git trailers stack fine as separate lines.
    const messageToCommit = ctx.runId ? `${ctx.commitMessage}\n\n${RUN_TRAILER_KEY}: ${ctx.runId}` : ctx.commitMessage;
    execFileSync('git', ['commit', '-s', '-m', messageToCommit], { cwd: targetPath, encoding: 'utf8' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetPath, encoding: 'utf8' }).trim();
    return { status: 'completed', outputs: { commit_sha: sha, message: ctx.commitMessage, pushed: false } };
  } catch (e) {
    return { status: 'failed', outputs: { error: String(e.message || e).slice(0, 500) } };
  }
}

function handleFinalReport(stage, ctx, allStages) {
  const report = {
    run_id: ctx.runId, target_path: ctx.targetPath, task_class: ctx.taskClass,
    // outputs included (not just status/selected_adapter) so a verification override or an
    // independent-review independence-check rejection is genuinely visible in the final report,
    // not just inferable from status strings.
    stages: allStages.map(s => ({ stage_id: s.stage_id, status: s.status, selected_adapter: s.selected_adapter, outputs: s.outputs || null })),
    generated_at: nowIso()
  };
  fs.writeFileSync(path.join(ctx.artifactsDir, 'workflow-final-report.json'), JSON.stringify(report, null, 2));
  return { status: 'completed', outputs: { report_path: path.join(ctx.artifactsDir, 'workflow-final-report.json') } };
}

const AUTOMATED_HANDLERS = {
  'inspect-repository': handleInspectRepository,
  'discover-task': handleDiscoverTask,
  'classify-task': handleClassifyTask,
  'challenge-task': handleChallengeTask,
  'deterministic-verify': handleDeterministicVerify,
  'prepare-commit': handlePrepareCommit,
  'final-report': handleFinalReport
};

// validateReviewIndependence: the real blocking check behind the independent-review gate. Reviewer
// eligibility is capability-based (see the excludeAdapter resolution in the engines' dispatch
// loops) -- this is the complementary check on what a completion CLAIMS actually happened, so a
// gate can't be satisfied just by an orchestrator asserting "it's fine". Generalized on purpose: it
// only ever compares adapter_id/dispatch_id strings, never branches on a specific vendor name
// (codex, claude, or anything else are all just values here, not special-cased code paths).
//
// A non-empty, textually-distinct reviewer_adapter_id is NOT sufficient by itself -- anyone could
// write 'ghost-adapter-never-registered-anywhere' and pass the string checks above. The id must
// also be a REAL adapter, registered in config/adapter-registry.json, that itself resolves as
// review-capable under the exact same 'independent_review' policy (+ excludeAdapter) that the
// 'independent-review' stage resolved through at execution time -- reused via the same route()
// every stage's capability resolution goes through, never a hand-rolled second copy of the
// eligibility rules. `root` is pinned to THIS harness's own install (path.resolve(__dirname, '..'),
// not process.env.HARNESS_ROOT/harnessRoot(), which may point at a different location in some
// environments) so this check reads the harness's own adapter-registry.json regardless of what
// target repo is being worked on or how the process environment is configured. `opts`
// (adapters/root) is injectable for self-tests only.
function validateReviewIndependence(dag, outputs, opts) {
  const executeStage = dag.stages.find(s => s.stage_id === 'execute');
  const producerAdapterId = (executeStage && executeStage.selected_adapter) ||
    (executeStage && executeStage.outputs && executeStage.outputs.producer_adapter_id) || null;
  const o = outputs || {};
  if (!o.reviewer_adapter_id) {
    return { ok: false, reason: 'missing_reviewer_adapter_id: independent-review completion must declare which adapter/capability actually performed the review' };
  }
  if (producerAdapterId && o.reviewer_adapter_id === producerAdapterId) {
    return { ok: false, reason: `reviewer_adapter_id '${o.reviewer_adapter_id}' matches the producer adapter '${producerAdapterId}' -- not independent` };
  }
  if (o.producer_dispatch_id && o.reviewer_dispatch_id && o.producer_dispatch_id === o.reviewer_dispatch_id) {
    return { ok: false, reason: 'reviewer_dispatch_id matches producer_dispatch_id -- same actor, not independent' };
  }
  const reviewResolution = route({
    requiredCapabilities: ['review'],
    policy: 'independent_review',
    excludeAdapter: producerAdapterId,
    root: (opts && opts.root) || path.resolve(__dirname, '..'),
    adapters: opts && opts.adapters
  });
  const eligible = (reviewResolution && reviewResolution.eligible_adapters) || [];
  if (!eligible.includes(o.reviewer_adapter_id)) {
    return {
      ok: false,
      reason: `reviewer_adapter_id '${o.reviewer_adapter_id}' is not a real, registered, review-capable adapter under the independent_review policy (config/adapter-registry.json) -- eligible reviewers were: [${eligible.join(', ') || 'none'}]`
    };
  }
  return { ok: true };
}

// completeStage(dag, stageId, {status, outputs}) -> mutates dag.stages in place. The orchestrator
// (the calling agent, after doing the real plan/execute/review work) calls this to report back --
// on BOTH engines: the legacy CLI (bin/harnesskit.js) and langgraph-workflow.js's nodes both call
// this exact same function, never a per-engine reimplementation.
//
// The one stage this function does NOT simply trust as claimed: 'independent-review'. A completion
// claiming status:'completed' there is only honored if validateReviewIndependence passes -- a real
// blocking gate, not documentation. A failed check flips the recorded status to
// 'rejected_not_independent' (which handlePrepareCommit's gateStages check will never treat as
// satisfied), and the rejection reason is preserved in outputs so it's visible, not swallowed.
function completeStage(dag, stageId, result) {
  const stage = dag.stages.find(s => s.stage_id === stageId);
  if (!stage) throw new Error(`unknown stage_id: ${stageId}`);
  if (stageId === 'independent-review' && result.status === 'completed') {
    const check = validateReviewIndependence(dag, result.outputs || {});
    if (!check.ok) {
      stage.status = 'rejected_not_independent';
      stage.outputs = Object.assign({}, result.outputs || {}, { independence_check_failed: check.reason });
      return dag;
    }
  }
  stage.status = result.status;
  stage.outputs = result.outputs || {};
  return dag;
}

module.exports = {
  WORKFLOW_DAG_SCHEMA_VERSION,
  AUTOMATED_HANDLERS,
  completeStage,
  validateReviewIndependence,
  classifyTaskClass,
  handleInspectRepository,
  handleDiscoverTask,
  handleClassifyTask,
  handleChallengeTask,
  handleDeterministicVerify,
  handlePrepareCommit,
  handleFinalReport
};

if (require.main === module) {
  console.log('workflow-handlers.js — library, shared by scripts/execute-workflow.js and scripts/langgraph-workflow.js. No standalone --self-test of its own: its behavior is exercised by both engines\' own --self-test suites.');
  process.exit(0);
}
