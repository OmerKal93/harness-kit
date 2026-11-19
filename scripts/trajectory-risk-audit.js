#!/usr/bin/env node
// trajectory-risk-audit.js — Phase 4 Batch 3.
// Audit a run's tool-log.ndjson + decision-log.ndjson for trajectory-shape risks.
// Per reference/trajectory-risk-taxonomy.md. Detects (subset implemented for Batch 3):
//
//   #1  retry_storm           — ≥3 identical (tool, target) calls
//   #2  tool_target_oscillation — A→B→A→B on (tool, target)
//   #3  scope_creep           — distinct files outside named scope vs inside > 1:2
//   #4  dead_end              — subagent dispatch with no consumed output (best-effort)
//   #6  premature_done        — DONE without verification.md evidence link in run dir
//   #8  hook_bypass_attempt   — blocked tool followed by alternate-route attempt at same target
//   #10 trace_incompleteness  — state transition without corresponding artifact in window
//
// Library:
//   const { auditRun, auditLogs } = require('./trajectory-risk-audit.js')
// CLI:
//   node scripts/trajectory-risk-audit.js --run-id <id> [--json]
//   node scripts/trajectory-risk-audit.js --tool-log <ndjson> --decision-log <ndjson> [--run-dir <dir>] [--json]
//
// Honors kill switch. Deterministic. No network. Read-only on the run.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, readNdjson, runDir } = require('./_lib.js');
const { redactString } = require('./redact.js');

const ARTIFACT_FOR_STATE = {
  PLANNING_OR_DEBUGGING: 'plan.md',
  REVIEW: 'review.md',
  VERIFICATION: 'verification.md',
  LEARNING: 'learning.md',
  DONE: 'next-action.md',
  BLOCKED: 'next-action.md',
  NEEDS_USER: 'next-action.md'
};

function normalizeName(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const candidates = [entry.tool_name, entry.tool, entry.name, entry.recipient_name];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return '';
}

const WRITE_LIKE_NAMES = new Set([
  'Edit', 'Write', 'NotebookEdit',
  'MultiEdit',
  'functions.apply_patch', 'apply_patch'
]);

function targetOf(entry) {
  const i = entry.tool_input || {};
  if (typeof i.file_path === 'string') return i.file_path;
  if (typeof i.path === 'string') return i.path;
  if (typeof i.command === 'string') return i.command.slice(0, 120);
  if (typeof i.url === 'string') return i.url;
  if (typeof i.pattern === 'string') return i.pattern;
  return '';
}

function tupleKey(entry) {
  return (normalizeName(entry) || '<no-tool>') + '|' + targetOf(entry);
}

function detectRetryStorm(toolLog, threshold = 3) {
  const counts = new Map();
  for (const e of toolLog) {
    const k = tupleKey(e);
    if (!k.includes('|')) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const hits = [];
  for (const [k, n] of counts) {
    if (n >= threshold) hits.push({ tuple: redactString(k), count: n });
  }
  if (hits.length === 0) return { detected: false };
  return { detected: true, evidence: hits, recommended_action: 'block_at_5x_surface_trajectory' };
}

function detectOscillation(toolLog) {
  // A → B → A → B on (tool, target). Walk pairwise.
  const keys = toolLog.map(tupleKey);
  let osc = 0;
  const pairs = new Set();
  for (let i = 3; i < keys.length; i++) {
    if (keys[i] && keys[i] === keys[i - 2] && keys[i - 1] === keys[i - 3] && keys[i] !== keys[i - 1]) {
      osc++;
      pairs.add(redactString(keys[i]) + ' ↔ ' + redactString(keys[i - 1]));
    }
  }
  if (osc === 0) return { detected: false };
  return { detected: true, evidence: { oscillations: osc, pairs: Array.from(pairs) }, recommended_action: 'NEEDS_USER' };
}

function detectScopeCreep(toolLog, scopedFiles) {
  if (!scopedFiles || scopedFiles.length === 0) {
    return { detected: false, reason: 'no scope set' };
  }
  const inside = new Set();
  const outside = new Set();
  for (const e of toolLog) {
    const t = targetOf(e);
    if (!t) continue;
    const writeLike = WRITE_LIKE_NAMES.has(normalizeName(e));
    if (!writeLike) continue;
    const inScope = scopedFiles.some(s => t.includes(s) || s.includes(t));
    if (inScope) inside.add(t); else outside.add(t);
  }
  const ins = inside.size, outs = outside.size;
  if (outs === 0) return { detected: false, evidence: { in_scope: ins, outside_scope: 0 } };
  if (ins === 0) {
    return {
      detected: true,
      evidence: {
        in_scope: 0,
        outside_scope: outs,
        ratio: null,
        ratio_note: 'zero_in_scope_writes',
        examples: Array.from(outside).slice(0, 5).map(redactString)
      },
      recommended_action: 'REVIEW_split_diff'
    };
  }
  const ratio = outs / ins;
  if (ratio <= 0.5) return { detected: false, evidence: { in_scope: ins, outside_scope: outs } };
  return {
    detected: true,
    evidence: { in_scope: ins, outside_scope: outs, ratio: Number(ratio.toFixed(2)), examples: Array.from(outside).slice(0, 5).map(redactString) },
    recommended_action: 'REVIEW_split_diff'
  };
}

function detectDeadEnd(decisionLog) {
  // Heuristic: a decision-log entry naming subagent dispatch with no follow-on consume entry within window.
  const dispatches = decisionLog.filter(d => d.from === 'SUBAGENT_DISPATCH' || (d.event === 'subagent_dispatch'));
  const consumes  = decisionLog.filter(d => d.event === 'subagent_consume' || d.consumed_from === 'subagent');
  if (dispatches.length === 0) return { detected: false };
  const dangling = dispatches.length - Math.min(dispatches.length, consumes.length);
  if (dangling <= 0) return { detected: false };
  return {
    detected: true,
    evidence: { dispatches: dispatches.length, consumed: consumes.length, dangling },
    recommended_action: 'annotate_dead_end_in_decision_log'
  };
}

function detectPrematureDone(decisionLog, runDirPath) {
  // DONE transition without a verification.md present in the run dir.
  const done = decisionLog.find(d => d.to === 'DONE' || d.state === 'DONE');
  if (!done) return { detected: false };
  const verPath = path.join(runDirPath || '', 'verification.md');
  if (!runDirPath) return { detected: false, reason: 'no run dir to probe' };
  if (fs.existsSync(verPath) && fs.statSync(verPath).size > 0) {
    return { detected: false, evidence: { verification_present: true } };
  }
  return {
    detected: true,
    evidence: { verification_present: false, verification_path: redactString(verPath) },
    recommended_action: 'state_stays_at_VERIFICATION'
  };
}

function detectHookBypass(toolLog) {
  // A blocked tool call entry (carries `blocked_by_hook` or `_blocked: true`) followed by an
  // alternate-route attempt at the same target within the next 5 entries.
  const hits = [];
  for (let i = 0; i < toolLog.length; i++) {
    const e = toolLog[i];
    const blocked = e.blocked_by_hook || e._blocked === true || (e.result && /\bblocked\b/i.test(String(e.result)));
    if (!blocked) continue;
    const tgt = targetOf(e);
    if (!tgt) continue;
    for (let j = i + 1; j <= Math.min(i + 5, toolLog.length - 1); j++) {
      const f = toolLog[j];
      if (!f) continue;
      const otherTarget = targetOf(f);
      if (otherTarget && (otherTarget === tgt || otherTarget.includes(tgt) || tgt.includes(otherTarget))) {
        hits.push({
          blocked_index: i,
          retry_index: j,
          blocked_tool: normalizeName(e),
          retry_tool: normalizeName(f),
          target: redactString(tgt)
        });
        break;
      }
    }
  }
  if (hits.length === 0) return { detected: false };
  return { detected: true, evidence: hits, recommended_action: 'halt_run_NEEDS_USER' };
}

function detectTraceIncompleteness(decisionLog, runDirPath) {
  if (!runDirPath) return { detected: false, reason: 'no run dir to probe' };
  const transitionsWithoutArtifact = [];
  for (const d of decisionLog) {
    const toState = d.to || d.state;
    const artifact = ARTIFACT_FOR_STATE[toState];
    if (!artifact) continue;
    const p = path.join(runDirPath, artifact);
    if (!fs.existsSync(p)) {
      transitionsWithoutArtifact.push({ to: toState, missing_artifact: artifact });
    }
  }
  if (transitionsWithoutArtifact.length === 0) return { detected: false };
  return {
    detected: true,
    evidence: transitionsWithoutArtifact,
    recommended_action: 'synthesize_placeholder_capture_learning'
  };
}

function auditLogs(toolLog, decisionLog, opts = {}) {
  const scopedFiles = opts.scopedFiles || [];
  const runDirPath = opts.runDirPath || null;

  const patterns = {
    retry_storm:               detectRetryStorm(toolLog),
    tool_target_oscillation:   detectOscillation(toolLog),
    scope_creep:               detectScopeCreep(toolLog, scopedFiles),
    dead_end:                  detectDeadEnd(decisionLog),
    premature_done:            detectPrematureDone(decisionLog, runDirPath),
    hook_bypass_attempt:       detectHookBypass(toolLog),
    trace_incompleteness:      detectTraceIncompleteness(decisionLog, runDirPath)
  };

  const detected_count = Object.values(patterns).filter(p => p && p.detected).length;
  return {
    schema_version: 1,
    detected_count,
    patterns
  };
}

function auditRun(runId) {
  const dir = runDir(runId);
  const toolLog = readNdjson(path.join(dir, 'tool-log.ndjson'));
  const decisionLog = readNdjson(path.join(dir, 'decision-log.ndjson'));
  const route = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'route.json'), 'utf8')); }
    catch { return null; }
  })();
  const scopedFiles = (route && route.questions && route.questions.context_sufficient && route.questions.context_sufficient.scope_files) || [];
  const result = auditLogs(toolLog, decisionLog, { scopedFiles, runDirPath: dir });
  result.run_id = runId;
  result.run_dir = dir;
  return result;
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  let result;

  if (args['run-id']) {
    result = auditRun(String(args['run-id']));
  } else if (args['tool-log'] || args['decision-log']) {
    const toolLog = args['tool-log'] ? readNdjson(String(args['tool-log'])) : [];
    const decisionLog = args['decision-log'] ? readNdjson(String(args['decision-log'])) : [];
    const runDirPath = args['run-dir'] ? String(args['run-dir']) : null;
    const scopedFiles = args['scoped-files'] ? String(args['scoped-files']).split(',').filter(Boolean) : [];
    result = auditLogs(toolLog, decisionLog, { scopedFiles, runDirPath });
  } else {
    console.error('error: --run-id <id> OR --tool-log <path> [--decision-log <path>] required');
    process.exit(2);
  }

  if (args.json !== false) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`Trajectory audit ${result.run_id || '(adhoc)'}\n`);
    process.stdout.write(`  patterns detected: ${result.detected_count}\n`);
    for (const [k, v] of Object.entries(result.patterns)) {
      process.stdout.write(`    ${k}: ${v.detected ? 'YES' : 'no'}\n`);
    }
  }
  process.exit(result.detected_count > 0 ? 1 : 0);
}

module.exports = { auditLogs, auditRun };

if (require.main === module) main();
