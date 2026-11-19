#!/usr/bin/env node
// detect-risk.js — match changed paths against project profile sensitive_paths.
// Usage:
//   node detect-risk.js --run-id <id>                   (reads run dir + project profile)
//   node detect-risk.js --changed "p1,p2,..." [--profile <name>]
//   node detect-risk.js --branch HEAD~1 [--cwd <path>] [--profile <name>]
//   node detect-risk.js < paths-on-stdin                (one path per line)
//
// Exit codes:
//   0 = no critical halt conditions
//   2 = critical halt conditions present (env_secrets etc.)
//
// Output (stdout, JSON):
//   { ts, paths, fileCount, overFiveFileRule, triggers, haltConditions, riskLevel }
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const {
  parseArgs, nowIso, harnessRoot, runDir, readJson, writeJson,
  detectProjectProfile, loadProjectProfile, globMatch, gitDiffPaths
} = require('./_lib.js');

function gatherPaths(args) {
  if (args.changed) return args.changed.split(',').map(s => s.trim()).filter(Boolean);
  if (args.branch) return gitDiffPaths(args.cwd || process.cwd(), args.branch);
  if (args['run-id']) {
    const rd = runDir(args['run-id']);
    const run = readJson(path.join(rd, 'run.json'), {});
    if (Array.isArray(run.changed_paths_hint)) return run.changed_paths_hint;
    if (run.project_root) return gitDiffPaths(run.project_root, args.branch || 'HEAD');
    return [];
  }
  if (!process.stdin.isTTY) {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function resolveProfile(args) {
  if (args.profile) {
    const data = loadProjectProfile(args.profile);
    if (data) return { name: args.profile, data };
  }
  if (args['run-id']) {
    const rd = runDir(args['run-id']);
    const run = readJson(path.join(rd, 'run.json'), {});
    if (run.project_profile) {
      const data = loadProjectProfile(run.project_profile);
      if (data) return { name: run.project_profile, data };
    }
  }
  const auto = detectProjectProfile(args.cwd || process.cwd());
  return auto ? { name: auto.name, data: auto.data } : null;
}

function classifyRisk(triggers, fileCount) {
  const haltKeys = new Set(['env_secrets', 'wiki_handbook_docs']);
  const haltConditions = triggers
    .filter(t => haltKeys.has(t.trigger))
    .map(t => t.trigger);
  const uniqueTriggers = new Set(triggers.map(t => t.trigger));
  const riskLevel = haltConditions.length ? 'critical'
                  : uniqueTriggers.size >= 2 ? 'high'
                  : uniqueTriggers.size === 1 ? 'med'
                  : fileCount > 5 ? 'med'
                  : 'low';
  return { haltConditions: Array.from(new Set(haltConditions)), riskLevel };
}

function main() {
  const dis = isDisabled();
  if (dis.disabled) {
    process.stdout.write(JSON.stringify({ ok: false, disabled: true, reason: dis.reason }) + '\n');
    process.exit(0);
  }
  const args = parseArgs(process.argv.slice(2));
  const paths = gatherPaths(args);
  const prof = resolveProfile(args);
  const sensitive = prof?.data?.sensitive_paths || [];

  const triggers = [];
  for (const p of paths) {
    for (const sp of sensitive) {
      if (globMatch(sp.glob, p)) {
        triggers.push({
          path: p,
          trigger: sp.trigger,
          glob: sp.glob,
          note: sp.note || null,
          approval: sp.approval || null
        });
      }
    }
  }
  const { haltConditions, riskLevel } = classifyRisk(triggers, paths.length);
  const report = {
    ts: nowIso(),
    profile: prof ? prof.name : null,
    paths,
    fileCount: paths.length,
    overFiveFileRule: paths.length > 5,
    triggers,
    haltConditions,
    riskLevel
  };

  if (args['run-id']) {
    writeJson(path.join(runDir(args['run-id']), 'risk-report.json'), report);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(haltConditions.length ? 2 : 0);
}

main();
