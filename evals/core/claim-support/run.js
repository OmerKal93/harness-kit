#!/usr/bin/env node
// evals/core/claim-support/run.js — Phase 4 Batch 2.
// Iterates fixture pairs under evals/fixtures/claim-support/{anchored,unanchored,mixed}/.
// Each pair: <n>.md (verification doc) + <n>.expected.json (ground truth).
// Invokes scripts/claim-support-check.js per fixture via execFileSync. Asserts counts.
//
// Honors kill switch. Deterministic. Zero network.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs } = require('../../../scripts/_lib.js');

function walkMd(dir) {
  const out = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '_tool-logs') continue;
        walk(full);
      } else if (e.isFile() && full.endsWith('.md') && !full.endsWith('README.md')) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

function runScript(args) {
  try {
    const stdout = execFileSync('node', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      cwd: harnessRoot()
    });
    return { ok: true, stdout, exitCode: 0 };
  } catch (e) {
    return { ok: false, stdout: (e.stdout && e.stdout.toString()) || '', exitCode: typeof e.status === 'number' ? e.status : 1 };
  }
}

function evalFixture(mdFile, fixturesDir) {
  const expectedPath = mdFile.replace(/\.md$/, '.expected.json');
  let expectedDoc;
  try { expectedDoc = JSON.parse(fs.readFileSync(expectedPath, 'utf8')); }
  catch (e) {
    return { id: path.basename(mdFile), label: 'unknown', pass: false, checks: [{ check: 'expected-file', error: e.message, pass: false }] };
  }
  const expected = expectedDoc.expected || {};
  const withToolLog = expectedDoc.with_tool_log === true;
  const toolLogPath = withToolLog ? path.join(fixturesDir, '_tool-logs', 'synthetic.ndjson') : null;

  const scriptPath = path.join(harnessRoot(), 'scripts', 'claim-support-check.js');
  const args = [scriptPath, '--verification', mdFile, '--repo-root', harnessRoot(), '--json'];
  if (toolLogPath) { args.push('--tool-log', toolLogPath); }
  const r = runScript(args);

  let parsed;
  try { parsed = JSON.parse(r.stdout); }
  catch (e) {
    return {
      id: path.basename(mdFile),
      label: expectedDoc.label,
      pass: false,
      checks: [{ check: 'parse', error: 'stdout not JSON', pass: false }]
    };
  }
  const checks = [];
  let pass = true;
  for (const k of ['claim_lines', 'anchored', 'unanchored', 'flagged_count']) {
    if (expected[k] === undefined) continue;
    const ok = parsed[k] === expected[k];
    checks.push({ check: k, expected: expected[k], actual: parsed[k], pass: ok });
    if (!ok) pass = false;
  }
  return { id: path.basename(mdFile, '.md'), label: expectedDoc.label, pass, checks };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'claim-support');

  const files = walkMd(fixturesDir);
  const results = [];
  for (const f of files) {
    const r = evalFixture(f, fixturesDir);
    r.file = path.relative(fixturesDir, f);
    results.push(r);
    if (results.length > 5000) break;
  }

  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  const out = {
    category: 'claim-support',
    pass: total > 0 && failed.length === 0,
    score,
    total,
    passed,
    failed: failed.length,
    failures: failed.slice(0, 20),
    by_label: countBy(results)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

function countBy(results) {
  const out = {};
  for (const r of results) {
    const key = r.label || 'unlabeled';
    if (!out[key]) out[key] = { total: 0, passed: 0 };
    out[key].total += 1;
    if (r.pass) out[key].passed += 1;
  }
  return out;
}

if (require.main === module) main();
