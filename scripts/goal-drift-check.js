#!/usr/bin/env node
// goal-drift-check.js — Phase 4 Batch 3.
// Advisory drift check: compare a run's INTAKE goal against the most recent
// tool-log activity. v1 heuristic: token overlap between the goal text and the
// recent tool_input excerpts. Low overlap = drift signal.
//
// Library:
//   const { check } = require('./goal-drift-check.js')
//   check({ goal, toolLog, recentN }) → { drift_score, similarity, evidence, recommendation }
//
// CLI:
//   node scripts/goal-drift-check.js --run-id <id> [--recent 20] [--json]
//   node scripts/goal-drift-check.js --goal "<text>" --tool-log <ndjson> [--recent 20] [--json]
//
// Advisory only — never blocks. Honors kill switch.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const { parseArgs, readNdjson, runDir, readJson } = require('./_lib.js');
const { redactString } = require('./redact.js');

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','of','to','in','on','at','by','for','with','as','is','are','was','were','be','been','being',
  'this','that','these','those','it','its','i','you','he','she','they','we','our','your','their','my','me','us','them',
  'do','does','did','done','have','has','had','will','would','should','could','may','might','can',
  'so','than','too','very','just','only','also','still','about','from','into','onto','over','under',
  'not','no','yes','any','all','some','more','less'
]);

function tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase()
    .replace(/[`*_~"'\[\](){}<>!?.,:;|\\/]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function uniqueTokens(arr) { return new Set(arr); }

function jaccard(a, b) {
  if (!a.size && !b.size) return 1.0;
  if (!a.size || !b.size) return 0.0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function extractRecentExcerpts(toolLog, recentN) {
  const tail = toolLog.slice(-recentN);
  const parts = [];
  for (const e of tail) {
    const i = e.tool_input || {};
    if (typeof e.tool_name === 'string') parts.push(e.tool_name);
    if (typeof i.file_path === 'string') parts.push(i.file_path);
    if (typeof i.path === 'string') parts.push(i.path);
    if (typeof i.command === 'string') parts.push(i.command);
    if (typeof i.pattern === 'string') parts.push(i.pattern);
    if (typeof i.prompt === 'string') parts.push(i.prompt.slice(0, 400));
    if (typeof i.query === 'string') parts.push(i.query);
    if (typeof i.url === 'string') parts.push(i.url);
    if (typeof e.summary === 'string') parts.push(e.summary.slice(0, 400));
  }
  return parts.join('\n');
}

function recommendationFor(score) {
  if (score >= 0.30) return 'within_goal_acceptable';
  if (score >= 0.15) return 'soft_drift_review_suggested';
  if (score >= 0.05) return 'drift_likely_NEEDS_USER';
  return 'severe_drift_halt_NEEDS_USER';
}

function check(opts) {
  const goal = opts.goal || '';
  const toolLog = opts.toolLog || [];
  const recentN = opts.recentN || 20;

  const goalTokens = uniqueTokens(tokenize(goal));
  const activity = extractRecentExcerpts(toolLog, recentN);
  const activityTokens = uniqueTokens(tokenize(activity));

  const similarity = jaccard(goalTokens, activityTokens);
  const overlap = [];
  for (const t of goalTokens) if (activityTokens.has(t)) overlap.push(t);

  // drift_score is 1 - similarity, capped [0,1]. Higher = more drift.
  const drift_score = Math.max(0, Math.min(1, 1 - similarity));

  // Asymmetric coverage signals — advisory companions to jaccard.
  // Divide-by-zero policy: empty denominator → 0 (no coverage).
  const gSize = goalTokens.size;
  const aSize = activityTokens.size;
  const interCount = overlap.length;
  const goal_coverage = gSize === 0 ? 0 : Number((interCount / gSize).toFixed(3));
  const activity_overlap_ratio = aSize === 0 ? 0 : Number((interCount / aSize).toFixed(3));

  return {
    schema_version: 1,
    drift_score: Number(drift_score.toFixed(3)),
    similarity: Number(similarity.toFixed(3)),
    goal_coverage,
    activity_overlap_ratio,
    evidence: {
      goal_excerpt: redactString(String(goal).slice(0, 240)),
      goal_token_count: goalTokens.size,
      activity_token_count: activityTokens.size,
      overlap_tokens: overlap.slice(0, 24).map(redactString),
      recent_excerpt: redactString(activity.slice(0, 400))
    },
    recommendation: recommendationFor(similarity)
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const recentN = args.recent ? Number(args.recent) : 20;

  let goal = args.goal || null;
  let toolLog = [];

  if (args['run-id']) {
    const dir = runDir(String(args['run-id']));
    const route = readJson(path.join(dir, 'route.json'), null);
    if (route && route.questions) {
      // derive goal from prompt_excerpt + task_type
      const tt = (route.questions.task_type && route.questions.task_type.value) || '';
      goal = goal || ((route.prompt_excerpt || '') + ' [' + tt + ']');
    } else if (!goal) {
      const runJson = readJson(path.join(dir, 'run.json'), null);
      goal = (runJson && runJson.prompt) || '';
    }
    toolLog = readNdjson(path.join(dir, 'tool-log.ndjson'));
  } else if (args['tool-log']) {
    if (!goal) { console.error('error: --goal required when --run-id is not given'); process.exit(2); }
    toolLog = readNdjson(String(args['tool-log']));
  } else {
    console.error('error: --run-id <id> OR --goal "<text>" --tool-log <path> required');
    process.exit(2);
  }

  const result = check({ goal: goal || '', toolLog, recentN });
  result.run_id = args['run-id'] || null;

  if (args.json !== false) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`Goal drift check ${result.run_id || '(adhoc)'}\n`);
    process.stdout.write(`  similarity:    ${result.similarity}\n`);
    process.stdout.write(`  drift_score:   ${result.drift_score}\n`);
    process.stdout.write(`  recommendation: ${result.recommendation}\n`);
  }
  process.exit(0);
}

module.exports = { check, tokenize, jaccard, extractRecentExcerpts };

if (require.main === module) main();
