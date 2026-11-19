#!/usr/bin/env node
// score-run-quality.js — Phase 4 Batch 4.
// Auto-compute dims 1, 2, 5 from run artifacts. Propose dims 3, 4 (best-effort, human-confirmable).
// Per reference/run-quality-score.md weights: 15/20/25/20/20.
//
// Inputs (auto-detected under runs/<run-id>/):
//   run.json, route.json, selected-agents.json, verification.md, learning.md,
//   memory/learnings-index.json (one level above runs/).
//
// CLI:
//   node scripts/score-run-quality.js --run-id <id> [--json]
//   node scripts/score-run-quality.js --run-dir <abs-path> [--json]
//
// Writes runs/<run-id>/quality-score.json. Honors kill switch. Deterministic. Read-only on logs.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, nowIso, readJson, writeJson, runDir } = require('./_lib.js');
const { redactString } = require('./redact.js');

const WEIGHTS = {
  classifier_confidence_accuracy: 15,
  routing_fitness:                20,
  verification_completeness:      25,
  learning_density:               20,
  rollback_cleanliness:           20
};

function exists(p) { try { return fs.statSync(p).size >= 0; } catch { return false; } }
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

// Dim 1: confidence-as-proxy. Real accuracy requires human eval; we calibrate to confidence.
function scoreClassifierConfidence(run) {
  const reasons = [];
  const taskType = run.task_type || (run.questions && run.questions.task_type && run.questions.task_type.value) || null;
  const conf = typeof run.confidence === 'number'
    ? run.confidence
    : (run.questions && run.questions.task_type && run.questions.task_type.confidence) || 0;
  reasons.push(`task_type=${taskType || 'null'}`);
  reasons.push(`confidence=${conf}`);
  let s;
  if (conf >= 0.90) s = 5;
  else if (conf >= 0.75) s = 4;
  else if (conf >= 0.60) s = 3;
  else if (conf >= 0.40) s = 2;
  else s = 1;
  if (!taskType || taskType === 'unknown') {
    reasons.push('cap@2: task_type missing/unknown');
    s = Math.min(s, 2);
  }
  return { score: s, auto: true, reasons };
}

// Dim 2: routing artifacts present + non-empty.
function scoreRoutingFitness(runDirPath, route) {
  const reasons = [];
  const signals = [];
  const wf = route && route.questions && route.questions.workflow_owner;
  const primary = wf && wf.primary;
  if (primary && typeof primary === 'string' && primary.length > 0) {
    signals.push('workflow_owner.primary');
    reasons.push(`primary=${primary}`);
  }
  const gates = (wf && Array.isArray(wf.gates)) ? wf.gates : [];
  if (gates.length >= 1) {
    signals.push('gates>=1');
    reasons.push(`gates=${gates.length}`);
  }
  const risk = route && route.questions && route.questions.risk_level && route.questions.risk_level.value;
  if (risk) { signals.push('risk_level_resolved'); reasons.push(`risk=${risk}`); }
  const agentsPath = path.join(runDirPath, 'selected-agents.json');
  const agentsPresent = exists(agentsPath);
  if (agentsPresent) {
    signals.push('selected-agents.json');
    const aj = readJson(agentsPath, null);
    if (aj && Array.isArray(aj.selected) && aj.selected.length > 0) reasons.push(`agents=${aj.selected.length}`);
  }
  let s;
  if (signals.length >= 4 && gates.length >= 2) s = 5;
  else if (signals.length >= 3) s = 4;
  else if (signals.length === 2) s = 3;
  else if (signals.length === 1) s = 2;
  else s = 1;
  return { score: s, auto: true, signals, reasons };
}

// Dim 3 (PROPOSED): verification completeness. Best-effort via presence + claim-support.
function scoreVerification(runDirPath) {
  const reasons = [];
  const vPath = path.join(runDirPath, 'verification.md');
  if (!exists(vPath)) {
    reasons.push('verification.md absent');
    return { score: 1, auto: false, proposed: true, reasons };
  }
  const text = readText(vPath);
  const len = text.length;
  reasons.push(`verification.md present (${len} bytes)`);
  // Run claim-support inline if available.
  let claimRatio = null;
  try {
    const cs = require('./claim-support-check.js');
    const tlogPath = path.join(runDirPath, 'tool-log.ndjson');
    const tlogArg = exists(tlogPath) ? tlogPath : null;
    const analysis = cs.analyzeFile(vPath, { toolLogPath: tlogArg, repoRoot: harnessRoot() });
    const total = analysis.totals && analysis.totals.tokens_total || 0;
    const unanchored = analysis.totals && analysis.totals.tokens_unanchored || 0;
    if (total > 0) {
      claimRatio = unanchored / total;
      reasons.push(`tokens=${total} unanchored=${unanchored} ratio=${claimRatio.toFixed(2)}`);
    } else {
      reasons.push('no extractable claim tokens');
    }
  } catch (e) {
    reasons.push('claim-support unavailable: ' + e.message.slice(0, 80));
  }
  let s;
  if (claimRatio === null) s = len >= 200 ? 3 : 2;
  else if (claimRatio === 0) s = 5;
  else if (claimRatio < 0.20) s = 4;
  else if (claimRatio < 0.50) s = 3;
  else s = 2;
  return { score: s, auto: false, proposed: true, reasons };
}

// Dim 4 (PROPOSED): learning density via presence + length + placeholder absence + index entry.
function scoreLearningDensity(runDirPath, runId) {
  const reasons = [];
  const lPath = path.join(runDirPath, 'learning.md');
  const signals = [];
  if (!exists(lPath)) {
    reasons.push('learning.md absent');
    return { score: 1, auto: false, proposed: true, reasons };
  }
  const text = readText(lPath);
  reasons.push(`learning.md present (${text.length} bytes)`);
  if (text.length >= 200) signals.push('len>=200');
  const placeholderRe = /\(fill[\s_-]?in\)|TODO|TBD/i;
  if (!placeholderRe.test(text)) signals.push('no_placeholders'); else reasons.push('placeholders detected');
  const idxPath = path.join(harnessRoot(), 'memory', 'learnings-index.json');
  let idxHit = false;
  if (exists(idxPath)) {
    const idx = readJson(idxPath, null);
    if (idx && Array.isArray(idx.learnings)) {
      idxHit = idx.learnings.some(e => e && (e.run_id === runId || (typeof e.path === 'string' && e.path.includes(runId))));
    } else if (Array.isArray(idx)) {
      idxHit = idx.some(e => e && (e.run_id === runId || (typeof e.path === 'string' && e.path.includes(runId))));
    }
  }
  if (idxHit) signals.push('learnings-index entry');
  else reasons.push('no learnings-index entry');
  let s;
  if (signals.length >= 3) s = 5;
  else if (signals.length === 2) s = 4;
  else if (signals.length === 1) s = 3;
  else s = 2;
  return { score: s, auto: false, proposed: true, reasons, signals };
}

// Dim 5: rollback cleanliness. Terminal state + ledger entry + DISABLED absent + artifacts consistent.
function scoreRollback(runDirPath, run) {
  const reasons = [];
  const state = run.state || 'UNKNOWN';
  reasons.push(`state=${state}`);
  const terminal = new Set(['DONE', 'BLOCKED', 'NEEDS_USER', 'SUSPEND']);
  const isTerminal = terminal.has(state);
  const ks = isDisabled();
  if (ks.disabled) reasons.push(`kill switch ACTIVE: ${ks.reason}`);
  const idxPath = path.join(harnessRoot(), 'runs', '.index.ndjson');
  const idxExists = exists(idxPath);
  const runId = run.run_id;
  let ledgerHit = false;
  if (idxExists && runId) {
    const lines = readText(idxPath).split(/\r?\n/).filter(Boolean);
    ledgerHit = lines.some(l => l.includes(runId));
  }
  if (ledgerHit) reasons.push('ledger entry present');
  else reasons.push('ledger entry missing');
  // Premature-DONE check: DONE without verification.md → penalty.
  const verExists = exists(path.join(runDirPath, 'verification.md'));
  let s;
  if (state === 'DONE' && !verExists) {
    s = 2;
    reasons.push('DONE without verification.md → cap@2');
  } else if (isTerminal && ledgerHit && !ks.disabled) s = 5;
  else if (isTerminal && !ks.disabled) s = 4;
  else if (isTerminal) s = 3;
  else s = 2;
  return { score: s, auto: true, reasons };
}

function weightedTotal(dims) {
  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const d = dims[k];
    if (!d) continue;
    total += (d.score / 5) * w;
  }
  return Math.round(total * 10) / 10;
}

function tierSignal(total) {
  if (total >= 90) return 'exemplary';
  if (total >= 75) return 'clean';
  if (total >= 50) return 'rough';
  return 'bad';
}

function scoreRun(runId) {
  const dir = runDir(runId);
  if (!fs.existsSync(dir)) throw new Error(`run dir missing: ${dir}`);
  return scoreRunDir(dir, runId);
}

function scoreRunDir(dir, runId) {
  const run = readJson(path.join(dir, 'run.json'), {});
  const route = readJson(path.join(dir, 'route.json'), {});
  const id = runId || run.run_id || path.basename(dir);
  const dims = {
    classifier_confidence_accuracy: scoreClassifierConfidence(run),
    routing_fitness:                scoreRoutingFitness(dir, route),
    verification_completeness:      scoreVerification(dir),
    learning_density:               scoreLearningDensity(dir, id),
    rollback_cleanliness:           scoreRollback(dir, run)
  };
  for (const d of Object.values(dims)) {
    d.reasons = (d.reasons || []).map(r => redactString(String(r)));
  }
  const total = weightedTotal(dims);
  return {
    schema_version: 1,
    run_id: id,
    run_dir: dir,
    scored_at: nowIso(),
    scorer: 'score-run-quality.js@phase4-batch4',
    dimensions: dims,
    total_weighted: total,
    tier_signal: tierSignal(total),
    weights: WEIGHTS,
    notes: 'auto: dims 1+2+5; proposed: dims 3+4 (human-confirmable)'
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  let dir, id;
  if (args['run-dir']) {
    dir = path.resolve(String(args['run-dir']));
    id = path.basename(dir);
  } else if (args['run-id']) {
    id = String(args['run-id']);
    dir = runDir(id);
  } else {
    console.error('error: --run-id <id> OR --run-dir <abs-path> required');
    process.exit(2);
  }
  if (!fs.existsSync(dir)) {
    console.error('error: run dir missing: ' + dir);
    process.exit(2);
  }
  const result = scoreRunDir(dir, id);
  const out = path.join(dir, 'quality-score.json');
  writeJson(out, result);
  if (args.json !== false) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`Run ${result.run_id} score: ${result.total_weighted}/100 (${result.tier_signal})\n`);
    for (const [k, v] of Object.entries(result.dimensions)) {
      process.stdout.write(`  ${k}: ${v.score}/5${v.proposed ? ' (proposed)' : ''}\n`);
    }
    process.stdout.write(`  written: ${out}\n`);
  }
  process.exit(0);
}

module.exports = { scoreRun, scoreRunDir, WEIGHTS, tierSignal, weightedTotal };

if (require.main === module) main();
