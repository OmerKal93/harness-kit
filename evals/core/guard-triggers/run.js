#!/usr/bin/env node
// evals/core/guard-triggers/run.js — Harness v1 G3 trigger precision.
// Type 'bash': spawns hooks/pre_tool_use_guard.js with a stdin PreToolUse Bash event;
//   the DESTRUCTIVE check runs before run resolution, so block/allow is deterministic
//   (benign fixtures avoid legacy matchRequiresOwner keywords by construction).
// Type 'glob': calls _lib.sensitivePathHits with the LIVE example-app.json profile against
//   a path STRING under the example project's project_root — pure function, zero project fs
//   access, so any future glob drift (the apps/ reorg failure mode) fails this eval.
// Contract: prints {category,pass,score,total,passed,failed,...} envelope, exit 0/1.
// Honors kill switch. Zero network, zero writes outside this process.
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs, readJson, sensitivePathHits } = require('../../../scripts/_lib.js');

const GUARD = path.join(harnessRoot(), 'hooks', 'pre_tool_use_guard.js');

function spawnGuard(command) {
  const event = { tool_name: 'Bash', tool_input: { command }, cwd: harnessRoot() };
  try {
    execFileSync('node', [GUARD], { input: JSON.stringify(event), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return 0;
  } catch (e) { return e.status == null ? 1 : e.status; }
}

function evalCase(fx, profileData) {
  const fails = [];
  if (fx.type === 'bash') {
    const exit = spawnGuard(fx.command);
    const got = exit === 2 ? 'block' : exit === 0 ? 'allow' : `exit-${exit}`;
    if (got !== fx.expect) fails.push(`bash:actual=${got}/expected=${fx.expect}`);
  } else if (fx.type === 'glob') {
    let triggers = [];
    try { triggers = Array.from(new Set(sensitivePathHits(fx.path, profileData).map(h => h.trigger))).sort(); }
    catch (e) { fails.push('glob:THREW ' + String(e && e.message).slice(0, 120)); }
    const expected = (fx.expect_triggers || []).slice().sort();
    if (JSON.stringify(triggers) !== JSON.stringify(expected)) {
      fails.push(`glob:actual=[${triggers}]/expected=[${expected}]`);
    }
  } else {
    fails.push('unknown fixture type: ' + fx.type);
  }
  return { id: fx.id, label: fx.label || 'positive', pass: fails.length === 0, fail_reason: fails.length ? fails.join('|') : null };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'guard-triggers');
  const data = readJson(path.join(fixturesDir, 'cases.json'), { fixtures: [] });
  const cases = data.fixtures || [];

  // G6: resolve the profile per fixture (default 'example-app' — backward compatible). Lets
  // harnesskit self-protection fixtures assert against config/project-profiles/harnesskit.json.
  const profileCache = {};
  const getProfile = (name) => {
    const key = name || 'example-app';
    if (!(key in profileCache)) {
      profileCache[key] = readJson(path.join(harnessRoot(), 'config', 'project-profiles', key + '.json'), null);
    }
    return profileCache[key];
  };

  const cfg = readJson(path.join(harnessRoot(), 'evals', 'config.json'), { categories: {} });
  const minRatio = (cfg.categories['guard-triggers'] && typeof cfg.categories['guard-triggers'].min_pass_ratio === 'number')
    ? cfg.categories['guard-triggers'].min_pass_ratio : 1.0;

  const results = cases.map(fx => evalCase(fx, getProfile(fx.profile)));
  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failures = results.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  const byLabel = {};
  for (const r of results) {
    byLabel[r.label] = byLabel[r.label] || { total: 0, passed: 0 };
    byLabel[r.label].total++;
    if (r.pass) byLabel[r.label].passed++;
  }

  const out = {
    category: 'guard-triggers',
    pass: total > 0 && score >= minRatio,
    score, total, passed, failed: failures.length,
    min_pass_ratio: minRatio,
    by_label: byLabel,
    failures: failures.slice(0, 30)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module) main();
