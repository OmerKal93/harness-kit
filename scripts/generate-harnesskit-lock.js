#!/usr/bin/env node
// generate-harnesskit-lock.js — HarnessKit Productization Phase 1: generator for a CONSUMING
// overlay's lock file. The public core provides this generator + the schema + a validator; it
// never writes the real lock file for any specific overlay itself (that file belongs in the
// overlay's own directory/repo, e.g. example-overlay/harnesskit.lock.json for a private example-project
// distribution -- not created here, since project-side writes remain frozen; see
// examples/overlay-example/ for a synthetic demonstration instead).
//
//   node scripts/generate-harnesskit-lock.js --overlay-name <name> --out <path> [--core-repo-url <url>]
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseArgs, harnessRoot, nowIso } = require('./_lib.js');

const GENERATOR_VERSION = 'generate-harnesskit-lock.js@1';

function getCoreHead(root, getHeadFn) {
  if (getHeadFn) return getHeadFn();
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function generateLock({ overlayName, coreRepoUrl, root, getHeadFn, now, notes }) {
  if (!overlayName || typeof overlayName !== 'string') throw new Error('overlayName is required');
  const coreCommit = getCoreHead(root || harnessRoot(), getHeadFn);
  if (!/^[0-9a-f]{40}$/.test(coreCommit)) throw new Error(`resolved core_commit does not look like a real 40-char SHA: ${coreCommit}`);
  return {
    schema_version: 1,
    overlay_name: overlayName,
    core_commit: coreCommit,
    core_repo_url: coreRepoUrl || null,
    generated_at: now || nowIso(),
    generator_version: GENERATOR_VERSION,
    notes: notes || null
  };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  const overlayName = a['overlay-name'];
  const out = a.out;
  if (!overlayName || !out) { console.log(JSON.stringify({ ok: false, error: '--overlay-name and --out are required' })); process.exit(1); }
  let lock;
  try { lock = generateLock({ overlayName, coreRepoUrl: a['core-repo-url'], notes: a.notes }); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exit(1); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(lock, null, 2));
  console.log(JSON.stringify({ ok: true, out, lock }, null, 2));
  process.exit(0);
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. Real generation with an injected fixed HEAD produces a well-formed lock.
  {
    const fixedSha = '1234567890abcdef1234567890abcdef12345678';
    const lock = generateLock({ overlayName: 'example-overlay', getHeadFn: () => fixedSha, now: '2026-01-01T00:00:00.000Z' });
    push('generates_well_formed_lock', lock.overlay_name === 'example-overlay' && lock.core_commit === fixedSha && lock.schema_version === 1, JSON.stringify(lock));
  }
  // 2. Missing overlay name is rejected, not silently defaulted.
  {
    let threw = false;
    try { generateLock({ overlayName: '', getHeadFn: () => '1234567890abcdef1234567890abcdef12345678' }); } catch { threw = true; }
    push('missing_overlay_name_rejected', threw, '');
  }
  // 3. A malformed (non-SHA) resolved HEAD is rejected rather than written.
  {
    let threw = false;
    try { generateLock({ overlayName: 'x', getHeadFn: () => 'not-a-real-sha' }); } catch { threw = true; }
    push('malformed_core_commit_rejected', threw, '');
  }
  // 4. Real invocation against THIS repo's actual git HEAD produces a real, verifiable SHA.
  {
    const lock = generateLock({ overlayName: 'real-repo-test' });
    push('real_repo_head_resolves_to_real_sha', /^[0-9a-f]{40}$/.test(lock.core_commit), JSON.stringify(lock.core_commit));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { generateLock };
if (require.main === module) main();
