#!/usr/bin/env node
// evals/core/routing/run.js — Phase 4 Batch 3.
// Iterates fixtures in evals/fixtures/routing/prompts.json. For each prompt:
//   - invokes router/classify-task.js --prompt "..." --profile example-app --no-risk
//   - asserts task_type exact match
//   - computes trigger Jaccard against expected triggers
//
// Pass criteria from corpus.pass_criteria.
//   - task_type_exact ratio ≥ task_type_exact_min_ratio
//   - mean trigger Jaccard ≥ trigger_jaccard_min
//
// Honors kill switch. Deterministic. Zero network.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');

function runClassifier(prompt, profile) {
  const script = path.join(harnessRoot(), 'router', 'classify-task.js');
  try {
    const stdout = execFileSync('node', [script, '--prompt', prompt, '--profile', profile, '--no-risk'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      cwd: harnessRoot(),
      timeout: 10000
    });
    return { ok: true, stdout, exit: 0 };
  } catch (e) {
    return { ok: false, stdout: (e.stdout && e.stdout.toString()) || '', exit: typeof e.status === 'number' ? e.status : 1, error: String(e.message).slice(0, 200) };
  }
}

function jaccard(a, b) {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  if (sa.size === 0 && sb.size === 0) return 1.0;
  if (sa.size === 0 || sb.size === 0) return 0.0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const uni = sa.size + sb.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function evalPrompt(fx, profile) {
  const r = runClassifier(fx.prompt, profile);
  let parsed;
  try { parsed = JSON.parse(r.stdout); }
  catch (e) {
    return { id: fx.id, pass: false, exact_match: false, jaccard: 0, error: 'classifier output not JSON', stdout_excerpt: (r.stdout || '').slice(0, 240) };
  }
  const expectTT = fx.expected_task_type;
  const expectTr = fx.expected_triggers || [];
  const exact = parsed.task_type === expectTT;
  const j = jaccard(parsed.triggers || [], expectTr);
  return {
    id: fx.id,
    expected_task_type: expectTT,
    actual_task_type: parsed.task_type,
    expected_triggers: expectTr,
    actual_triggers: parsed.triggers || [],
    confidence: parsed.confidence,
    exact_match: exact,
    jaccard: Number(j.toFixed(3)),
    pass: exact
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'routing');
  const corpusPath = path.join(fixturesDir, 'prompts.json');

  let corpus;
  try { corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')); }
  catch (e) {
    console.log(JSON.stringify({ category: 'routing', pass: false, error: 'prompts.json unreadable: ' + e.message }, null, 2));
    process.exit(1);
  }
  const profile = corpus.profile || 'example-app';
  const prompts = corpus.prompts || [];
  const passCriteria = corpus.pass_criteria || { task_type_exact_min_ratio: 0.85, trigger_jaccard_min: 0.90 };

  const results = prompts.map(p => evalPrompt(p, profile));

  const total = results.length;
  const exact = results.filter(r => r.exact_match).length;
  const exactRatio = total > 0 ? exact / total : 0;
  const meanJaccard = total > 0 ? results.reduce((s, r) => s + r.jaccard, 0) / total : 0;

  const exactPass = exactRatio >= passCriteria.task_type_exact_min_ratio;
  const jaccardPass = meanJaccard >= passCriteria.trigger_jaccard_min;
  const overallPass = exactPass && jaccardPass && total > 0;

  const failures = results.filter(r => !r.pass);

  const out = {
    category: 'routing',
    pass: overallPass,
    score: Number(((exactRatio + meanJaccard) / 2).toFixed(3)),
    total,
    exact_match_count: exact,
    exact_match_ratio: Number(exactRatio.toFixed(3)),
    mean_trigger_jaccard: Number(meanJaccard.toFixed(3)),
    pass_criteria: passCriteria,
    exact_match_pass: exactPass,
    jaccard_pass: jaccardPass,
    failures: failures.slice(0, 20)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module) main();
