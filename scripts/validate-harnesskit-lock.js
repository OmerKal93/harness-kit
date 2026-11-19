#!/usr/bin/env node
// validate-harnesskit-lock.js — HarnessKit Productization Phase 1: validates a consuming
// overlay's lock file against config/harnesskit-lock.schema.json, and optionally checks whether
// core_commit is actually reachable in this repo's real git history (not just shape-valid).
//
//   node scripts/validate-harnesskit-lock.js --lock <path> [--check-reachable]
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseArgs, harnessRoot, readJson } = require('./_lib.js');

const REQUIRED_FIELDS = ['schema_version', 'overlay_name', 'core_commit', 'generated_at', 'generator_version'];

function validateShape(lock) {
  const errors = [];
  if (!lock || typeof lock !== 'object') return { ok: false, errors: ['lock is not an object'] };
  for (const f of REQUIRED_FIELDS) if (!(f in lock)) errors.push(`missing required field: ${f}`);
  if (lock.schema_version !== 1) errors.push(`schema_version must be 1, got ${lock.schema_version}`);
  if (typeof lock.overlay_name !== 'string' || !lock.overlay_name) errors.push('overlay_name must be a non-empty string');
  if (typeof lock.core_commit !== 'string' || !/^[0-9a-f]{40}$/.test(lock.core_commit)) errors.push('core_commit must be a full 40-char lowercase hex SHA');
  if (typeof lock.generated_at !== 'string' || Number.isNaN(Date.parse(lock.generated_at))) errors.push('generated_at must be a valid ISO timestamp');
  if (typeof lock.generator_version !== 'string' || !lock.generator_version) errors.push('generator_version must be a non-empty string');
  return { ok: errors.length === 0, errors };
}

function checkReachable(coreCommit, root) {
  try {
    execFileSync('git', ['-C', root, 'cat-file', '-e', coreCommit], { stdio: ['ignore', 'ignore', 'ignore'] });
    return { ok: true };
  } catch {
    return { ok: false, reason: `core_commit ${coreCommit} is not reachable in this repo's git history` };
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  const lockPath = a.lock;
  if (!lockPath) { console.log(JSON.stringify({ ok: false, error: '--lock <path> required' })); process.exit(1); }
  const lock = readJson(lockPath, null);
  const shapeResult = validateShape(lock);
  let reachableResult = null;
  if (shapeResult.ok && a['check-reachable']) reachableResult = checkReachable(lock.core_commit, harnessRoot());
  const ok = shapeResult.ok && (!reachableResult || reachableResult.ok);
  console.log(JSON.stringify({ ok, shape: shapeResult, reachable: reachableResult }, null, 2));
  process.exit(ok ? 0 : 1);
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. A well-formed lock validates clean.
  {
    const lock = { schema_version: 1, overlay_name: 'x', core_commit: '1234567890abcdef1234567890abcdef12345678', generated_at: '2026-01-01T00:00:00.000Z', generator_version: 'v1' };
    const r = validateShape(lock);
    push('well_formed_lock_validates', r.ok === true, JSON.stringify(r));
  }
  // 2. Missing required fields are all reported, not just the first.
  {
    const r = validateShape({ schema_version: 1 });
    push('missing_fields_all_reported', r.ok === false && r.errors.length >= 3, JSON.stringify(r));
  }
  // 3. A malformed core_commit (not a real SHA shape) is rejected.
  {
    const r = validateShape({ schema_version: 1, overlay_name: 'x', core_commit: 'not-a-sha', generated_at: '2026-01-01T00:00:00.000Z', generator_version: 'v1' });
    push('malformed_sha_rejected', r.ok === false && r.errors.some(e => e.includes('core_commit')), JSON.stringify(r));
  }
  // 4. A "verified" claim without required evidence must fail -- this IS the drift-detection contract.
  {
    const r = validateShape(null);
    push('null_lock_fails_closed', r.ok === false, JSON.stringify(r));
  }
  // 5. Real reachability check: THIS repo's own real HEAD is reachable (obviously); a made-up SHA is not.
  {
    const root = harnessRoot();
    const realHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const reachableReal = checkReachable(realHead, root);
    const reachableFake = checkReachable('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', root);
    push('real_commit_reachable_fake_is_not', reachableReal.ok === true && reachableFake.ok === false, JSON.stringify({ reachableReal, reachableFake }));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { validateShape, checkReachable };
if (require.main === module) main();
