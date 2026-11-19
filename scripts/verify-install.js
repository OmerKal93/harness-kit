#!/usr/bin/env node
// verify-install.js -- HarnessKit install/config lane (Batch 1 Foundation, hk/p9b-install-config).
//
// Automates two install checks that would otherwise be manual, prose-only steps:
//   1. Recomputes sha256 of every path RELEASE_MANIFEST.json's integrity_checksums_sha256 lists,
//      and compares against the recorded value (today: a PowerShell `Get-FileHash` command a human
//      is told to run and eyeball). This is real "beyond just
//      package-lock.json existing" pin enforcement.
//   2. Checks package.json's "version" field against the top-level VERSION file for drift. Found
//      a real, live instance of this drift during this lane's research (VERSION said
//      0.1.0-internal while package.json said 0.2.0-internal) -- fixed as
//      part of this same commit; this check exists so it can't silently regress again.
//
// Deliberately resolves paths relative to THIS repo checkout (path.join(__dirname, '..')), not via
// HARNESS_ROOT: it verifies the checkout it lives in, not the configured harness root.
//
//   node scripts/verify-install.js            -- run both checks against this repo
//   node scripts/verify-install.js --self-test
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson } = require('./_lib.js');

const REPO_ROOT = path.join(__dirname, '..');

function sha256OfFile(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch { return null; }
}

// --- Check 1: package.json version vs VERSION file --------------------------------------------

function checkVersionConsistency(root) {
  root = root || REPO_ROOT;
  const pkg = readJson(path.join(root, 'package.json'), null);
  const versionFilePath = path.join(root, 'VERSION');
  const hasVersionFile = fs.existsSync(versionFilePath);
  if (!pkg || typeof pkg.version !== 'string') {
    return { check: 'version_consistency', status: 'BLOCKING', detail: 'package.json missing or has no "version" field', data: null };
  }
  if (!hasVersionFile) {
    return { check: 'version_consistency', status: 'NOT_APPLICABLE', detail: 'no top-level VERSION file present -- package.json version is the sole source of truth', data: { package_json_version: pkg.version } };
  }
  const fileVersion = fs.readFileSync(versionFilePath, 'utf8').trim();
  const match = fileVersion === pkg.version;
  return {
    check: 'version_consistency',
    status: match ? 'PASS' : 'FAIL',
    detail: match
      ? `VERSION file ("${fileVersion}") matches package.json version ("${pkg.version}")`
      : `VERSION file ("${fileVersion}") does NOT match package.json version ("${pkg.version}") -- one of these was not updated`,
    data: { package_json_version: pkg.version, version_file: fileVersion }
  };
}

// --- Check 2: RELEASE_MANIFEST.json integrity checksums vs live files --------------------------

function checkReleaseChecksums(root) {
  root = root || REPO_ROOT;
  const manifestPath = path.join(root, 'RELEASE_MANIFEST.json');
  if (!fs.existsSync(manifestPath)) {
    return { check: 'release_checksums', status: 'NOT_APPLICABLE', detail: 'no RELEASE_MANIFEST.json in this tree -- nothing to verify', data: null };
  }
  const manifest = readJson(manifestPath, null);
  const table = manifest && manifest.integrity_checksums_sha256;
  if (!table || typeof table !== 'object') {
    return { check: 'release_checksums', status: 'FAIL', detail: 'RELEASE_MANIFEST.json present but has no usable integrity_checksums_sha256 table', data: null };
  }
  const perFile = Object.entries(table).map(([relPath, expected]) => {
    const abs = path.join(root, relPath);
    if (!fs.existsSync(abs)) return { path: relPath, status: 'MISSING', expected, actual: null };
    const actual = sha256OfFile(abs);
    return { path: relPath, status: actual === expected ? 'MATCH' : 'MISMATCH', expected, actual };
  });
  const anyBad = perFile.some(f => f.status !== 'MATCH');
  return {
    check: 'release_checksums',
    status: anyBad ? 'FAIL' : 'PASS',
    detail: anyBad
      ? `${perFile.filter(f => f.status !== 'MATCH').length} of ${perFile.length} tracked file(s) do not match RELEASE_MANIFEST.json`
      : `all ${perFile.length} tracked file(s) match RELEASE_MANIFEST.json's recorded sha256`,
    data: { files: perFile }
  };
}

function runAll(root) {
  const results = [checkVersionConsistency(root), checkReleaseChecksums(root)];
  // Fail-closed only on real integrity violations (FAIL). BLOCKING (unreadable package.json) also
  // fails the process. NOT_APPLICABLE never fails it -- absence of a manifest/VERSION file on a
  // given checkout is a legitimate, disclosed state, not a violation.
  const ok = results.every(r => r.status === 'PASS' || r.status === 'NOT_APPLICABLE');
  return { ok, results };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) { process.exit(selfTest() ? 0 : 1); return; }
  const rootFlagIdx = args.indexOf('--root');
  const root = rootFlagIdx !== -1 ? args[rootFlagIdx + 1] : REPO_ROOT;
  const report = runAll(root);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail: detail === undefined ? '' : JSON.stringify(detail) });
  const os = require('os');

  function mkTmpRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-verify-install-selftest-'));
    return dir;
  }

  // 1. Matching VERSION file + package.json -> PASS.
  {
    const dir = mkTmpRepo();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    fs.writeFileSync(path.join(dir, 'VERSION'), '1.2.3\n');
    const r = checkVersionConsistency(dir);
    push('matching_version_and_VERSION_file_passes', r.status === 'PASS', r);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 2. Mismatched VERSION file -> FAIL (this is the exact real drift found during this lane's
  //    research: VERSION said 0.1.0-internal, package.json said 0.2.0-internal).
  {
    const dir = mkTmpRepo();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.2.0-internal' }));
    fs.writeFileSync(path.join(dir, 'VERSION'), '0.1.0-internal\n');
    const r = checkVersionConsistency(dir);
    push('mismatched_version_and_VERSION_file_fails', r.status === 'FAIL', r);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 3. No VERSION file at all -> NOT_APPLICABLE, not a failure (package.json alone is a valid
  //    single-source-of-truth state).
  {
    const dir = mkTmpRepo();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const r = checkVersionConsistency(dir);
    push('missing_VERSION_file_is_not_applicable_not_a_failure', r.status === 'NOT_APPLICABLE', r);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 4. No RELEASE_MANIFEST.json -> NOT_APPLICABLE for checksum check.
  {
    const dir = mkTmpRepo();
    const r = checkReleaseChecksums(dir);
    push('missing_release_manifest_is_not_applicable', r.status === 'NOT_APPLICABLE', r);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 5. A tracked file whose live bytes match the manifest's recorded sha256 -> PASS/MATCH.
  {
    const dir = mkTmpRepo();
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'hello world');
    const expected = sha256OfFile(path.join(dir, 'tracked.txt'));
    fs.writeFileSync(path.join(dir, 'RELEASE_MANIFEST.json'), JSON.stringify({ integrity_checksums_sha256: { 'tracked.txt': expected } }));
    const r = checkReleaseChecksums(dir);
    push('matching_tracked_file_passes', r.status === 'PASS' && r.data.files[0].status === 'MATCH', r);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 6. A tracked file whose live bytes were tampered with after the manifest was written -> FAIL/MISMATCH.
  //    This is the real integrity-violation case this check exists to catch.
  {
    const dir = mkTmpRepo();
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'hello world');
    const expected = sha256OfFile(path.join(dir, 'tracked.txt'));
    fs.writeFileSync(path.join(dir, 'RELEASE_MANIFEST.json'), JSON.stringify({ integrity_checksums_sha256: { 'tracked.txt': expected } }));
    fs.writeFileSync(path.join(dir, 'tracked.txt'), 'TAMPERED CONTENT');
    const r = checkReleaseChecksums(dir);
    push('tampered_tracked_file_fails', r.status === 'FAIL' && r.data.files[0].status === 'MISMATCH', r);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 7. A tracked file that was deleted after the manifest was written -> FAIL/MISSING, not a crash.
  {
    const dir = mkTmpRepo();
    fs.writeFileSync(path.join(dir, 'RELEASE_MANIFEST.json'), JSON.stringify({ integrity_checksums_sha256: { 'gone.txt': 'deadbeef'.repeat(8) } }));
    const r = checkReleaseChecksums(dir);
    push('deleted_tracked_file_reported_missing_not_crashed', r.status === 'FAIL' && r.data.files[0].status === 'MISSING', r);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // 8. Real repo: this checkout's actual RELEASE_MANIFEST.json + package.json/VERSION are checked
  //    for real (proves the checks run cleanly against genuine repo state, not just fixtures).
  //    This assertion is intentionally about "runs without crashing and returns a real verdict",
  //    not "must be PASS" -- a real drift here is exactly the kind of thing this tool should be
  //    free to report FAIL on.
  {
    const report = runAll(REPO_ROOT);
    const structurallySound = report && Array.isArray(report.results) && report.results.length === 2 &&
      report.results.every(r => ['PASS', 'FAIL', 'BLOCKING', 'NOT_APPLICABLE'].includes(r.status));
    push('real_repo_check_runs_and_returns_a_verdict', structurallySound, report);
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { checkVersionConsistency, checkReleaseChecksums, runAll };
if (require.main === module) main();
