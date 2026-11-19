#!/usr/bin/env node
// gbrain-doctor.js — Phase 3B helper.
// Wraps `gbrain doctor`. Honors kill switch. Reads gbrain via bun run from
// the audited clone at ~/gbrain (commit pin enforced upstream via policy file).
// Emits JSON: { version, pglite_ok, brain_size_pages, warnings, errors }.
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { readJson } = require('./_lib.js');

const GBRAIN_DIR = process.env.GBRAIN_DIR || path.join(os.homedir(), 'gbrain');
const CLI = path.join(GBRAIN_DIR, 'src', 'cli.ts');

function resolveBun() {
  if (process.env.BUN_BIN && fs.existsSync(process.env.BUN_BIN)) return process.env.BUN_BIN;
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
    path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
    '/usr/local/bin/bun',
    '/usr/bin/bun'
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'bun';
}
const BUN = resolveBun();

function runGbrain(args, opts = {}) {
  return execFileSync(BUN, ['run', CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: GBRAIN_DIR,
    env: { ...process.env, ...(opts.env || {}) },
    maxBuffer: 32 * 1024 * 1024
  });
}

function policyCommitPin() {
  const p = readJson(path.join(harnessRoot(), 'config', 'gbrain-import-policy.json'), {});
  return { version_pin: p.version_pin, commit_pin: p.commit_pin };
}

function gbrainCommit() {
  try {
    return execFileSync('git', ['-C', GBRAIN_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { return null; }
}

function parseDoctor(raw) {
  const out = { warnings: [], errors: [], ok_count: 0 };
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*\[(OK|WARN|ERROR|FAIL|CRITICAL)\]\s+(.*)$/i);
    if (!m) continue;
    const sev = m[1].toUpperCase();
    const msg = m[2].slice(0, 200);
    if (sev === 'OK') out.ok_count++;
    else if (sev === 'WARN') out.warnings.push(msg);
    else out.errors.push(`[${sev}] ${msg}`);
  }
  const sc = raw.match(/Overall health score:\s*(\d+)\/100/);
  if (sc) out.overall_score = Number(sc[1]);
  return out;
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  // Verify commit pin
  const policy = policyCommitPin();
  const actualCommit = gbrainCommit();
  const commitOk = !policy.commit_pin || (actualCommit && actualCommit === policy.commit_pin);

  let version = null;
  try { version = runGbrain(['--version']).trim(); } catch (e) {
    console.log(JSON.stringify({ ok: false, error: 'gbrain --version failed', detail: String(e.message || e).slice(0, 200) }));
    process.exit(1);
  }

  let stats = null;
  try {
    const s = runGbrain(['stats']);
    const pagesLine = s.match(/Pages:\s*(\d+)/);
    stats = { pages: pagesLine ? Number(pagesLine[1]) : null, raw_excerpt: s.split(/\r?\n/).slice(0, 10).join(' | ').slice(0, 300) };
  } catch (e) {
    stats = { error: String(e.message || e).slice(0, 200) };
  }

  let doctor = { warnings: [], errors: [], ok_count: 0, overall_score: null };
  try {
    // gbrain doctor exits non-zero on warnings; use spawnSync to capture regardless
    const { spawnSync } = require('child_process');
    const r = spawnSync(BUN, ['run', CLI, 'doctor'], {
      encoding: 'utf8',
      cwd: GBRAIN_DIR,
      maxBuffer: 32 * 1024 * 1024
    });
    const raw = (r.stdout || '') + (r.stderr || '');
    doctor = parseDoctor(raw);
    doctor.exit_code = r.status;
  } catch (e) {
    doctor = { warnings: [], errors: [String(e.message || e).slice(0, 200)], ok_count: 0, overall_score: null };
  }

  const result = {
    ok: !!version && doctor && !doctor.error,
    version,
    version_pin: policy.version_pin,
    commit: actualCommit ? actualCommit.slice(0, 12) : null,
    commit_pin: policy.commit_pin ? policy.commit_pin.slice(0, 12) : null,
    commit_pin_match: commitOk,
    pglite_ok: stats && stats.pages !== null,
    brain_size_pages: stats ? stats.pages : null,
    overall_score: doctor ? doctor.overall_score : null,
    ok_checks: doctor ? doctor.ok_count : null,
    warnings: doctor ? doctor.warnings.slice(0, 10) : [],
    errors: doctor ? doctor.errors : []
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok && result.commit_pin_match ? 0 : 2);
}

if (require.main === module) main();
