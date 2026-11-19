#!/usr/bin/env node
// run-evals.js — Phase 4 Batch 1 orchestrator.
// Discovers evals/core/<category>/run.js. Reads evals/config.json for enable flags.
// Executes each enabled category via execFileSync('node', [runPath, ...]) — no shell.
// Aggregates per-category JSON output into evals/results/<run-id>/results.json.
// Honors kill switch. All persisted strings pass through redactString.
//
// Usage:
//   node scripts/run-evals.js
//   node scripts/run-evals.js --run-id <custom-id>
//   node scripts/run-evals.js --only redaction,poisoning
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, nowIso, readJson, writeJson } = require('./_lib.js');
const { redactString } = require('./redact.js');

function tsRunId() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-evals`
  );
}

function resolveUnderRoot(p, root) {
  const abs = path.resolve(p);
  const rootAbs = path.resolve(root);
  if (!abs.toLowerCase().startsWith(rootAbs.toLowerCase() + path.sep) && abs.toLowerCase() !== rootAbs.toLowerCase()) {
    throw new Error('path escapes harnesskit root: ' + p);
  }
  return abs;
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const root = harnessRoot();
  const evalsDir = path.join(root, 'evals');
  const configPath = path.join(evalsDir, 'config.json');
  const config = readJson(configPath, { categories: {} });

  const onlyFilter = (args.only || '').split(',').map(s => s.trim()).filter(Boolean);
  const runId = String(args['run-id'] || tsRunId()).replace(/[^A-Za-z0-9._-]/g, '_');
  const resultsDir = resolveUnderRoot(path.join(evalsDir, 'results', runId), root);
  fs.mkdirSync(resultsDir, { recursive: true });

  const categories = config.categories || {};
  const harnessEvalsDir = path.join(evalsDir, 'core');

  const results = {
    schema_version: 1,
    run_id: runId,
    started_at: nowIso(),
    categories: {}
  };

  const t0 = Date.now();
  for (const [name, cfg] of Object.entries(categories)) {
    if (onlyFilter.length && !onlyFilter.includes(name)) {
      results.categories[name] = { enabled: !!cfg.enabled, skipped: true, reason: 'filtered_by_only' };
      continue;
    }
    if (!cfg || !cfg.enabled) {
      results.categories[name] = { enabled: false, skipped: true, reason: 'disabled_in_config' };
      continue;
    }
    const runScript = path.join(harnessEvalsDir, name, 'run.js');
    if (!fs.existsSync(runScript)) {
      results.categories[name] = { enabled: true, skipped: true, reason: 'driver_not_found', driver_path: runScript };
      continue;
    }
    const fixturesDir = path.join(evalsDir, 'fixtures', name);

    const tcat0 = Date.now();
    let stdout = '';
    let ok = false;
    let exitCode = null;
    try {
      stdout = execFileSync('node', [runScript, '--fixtures-dir', fixturesDir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
        cwd: root
      });
      ok = true;
      exitCode = 0;
    } catch (e) {
      stdout = (e.stdout && e.stdout.toString()) || '';
      exitCode = typeof e.status === 'number' ? e.status : 1;
      ok = false;
    }
    const tcat = Date.now() - tcat0;

    let parsed = null;
    try { parsed = JSON.parse(stdout); }
    catch {
      parsed = {
        pass: false,
        parse_error: true,
        raw_excerpt: redactString(stdout.slice(0, 2000))
      };
    }
    results.categories[name] = {
      enabled: true,
      duration_ms: tcat,
      exit_code: exitCode,
      ok,
      ...parsed
    };
  }

  results.duration_ms = Date.now() - t0;
  results.ended_at = nowIso();

  const live = Object.values(results.categories).filter(c => !c.skipped);
  const allPass = live.length > 0 && live.every(c => c.pass === true);
  results.all_pass = allPass;

  const outPath = path.join(resultsDir, 'results.json');
  writeJson(outPath, results);

  const summary = {
    ok: allPass,
    run_id: runId,
    results_path: outPath,
    duration_ms: results.duration_ms,
    categories: Object.fromEntries(
      Object.entries(results.categories).map(([k, v]) => {
        const entry = {
          skipped: !!v.skipped,
          pass: v.pass === true,
          score: v.score,
          total: v.total,
          passed: v.passed,
          failed: v.failed,
          duration_ms: v.duration_ms
        };
        // Carry advisory fields through when present (additive, backward-compatible).
        if (typeof v.display_state === 'string') entry.display_state = v.display_state;
        if (typeof v.meets_win_threshold === 'boolean') entry.meets_win_threshold = v.meets_win_threshold;
        if (v.counts && typeof v.counts === 'object') entry.counts = v.counts;
        return [k, entry];
      })
    )
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(allPass ? 0 : 1);
}

if (require.main === module) main();
