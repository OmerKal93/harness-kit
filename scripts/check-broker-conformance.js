#!/usr/bin/env node
// check-broker-conformance.js — Mechanism 1 of the Security Broker Architecture (see
// docs/SECURITY_BROKER_ARCHITECTURE_REPORT.md). A static eval that fails the suite if any .js file
// outside scripts/security-brokers/ directly requires security-boundary.js -- the raw scan-point
// module. This is what makes "did this code go through the broker layer" a checkable FACT instead
// of an unenforceable convention.
//
// Why static, not a runtime "attempt a bypass and confirm it's caught" test: a prior review
// correctly flagged that a bypass-attempt acceptance test is untestable in a plain JS/CLI codebase
// with no in-process interposition layer -- a script that never calls anything is simply invisible
// at runtime, nothing can force it through a gate it never approaches. Static analysis of require()
// graphs, by contrast, is fully mechanical and provably correct: every disallowed require is a line
// of source text that either exists or doesn't.
//
// SCOPE, disclosed explicitly (see Mechanism 3 in the report): this checks security-boundary.js's
// own require graph only -- NOT scripts/redact.js (a lower-level utility legitimately used directly
// by several files for reasons unrelated to the 6 trust-boundary scan points, e.g.
// execute-workflow.js's own tool-output redaction, detect-context-drift.js). Broadening this rule to
// redact.js would flag pre-existing, legitimate direct usage across files this lane does not own,
// which is exactly the kind of ownership-boundary ambiguity
// evidence/WORKTREE_FILE_OWNERSHIP_MATRIX.md's "division of labor" note warns against. Likewise,
// this does NOT statically grep for "invokes git commit/push/memory-write primitives" -- that
// enforcement lives in Mechanism 2 (the provenance-token gate in handlePrepareCommit), which
// verifies the CONTENT about to be committed actually carries a broker-minted token, a strictly
// stronger and less brittle guarantee than pattern-matching for `execFileSync('git', ['commit', ...])`
// call sites across an evolving codebase.
//
// Library only. Zero network. Deterministic.
// Library: const { run, findViolations } = require('./check-broker-conformance.js')
// CLI:     node scripts/check-broker-conformance.js [--root <dir>] [--self-test]
'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRE_RE = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

// listJsFiles(rootDir) -> absolute paths of every .js file under rootDir, recursive, skipping
// node_modules/.git/any evals-results-style generated dirs that would never contain hand-written
// require() calls worth checking.
const SKIP_DIRS = new Set(['node_modules', '.git']);
function listJsFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
    }
  }
  return out;
}

// findViolations(rootDir, opts) -> [{ file, line, requireString }]
// opts.securityBoundaryPath: absolute path to the real security-boundary.js.
// opts.brokersDir: absolute path to scripts/security-brokers -- files under here are the allowed
// callers and are exempt; security-boundary.js requiring itself (e.g. its own self-test's
// subprocess probe via __filename) is exempt too, since that is not a boundary bypass.
// opts.checkerPath: absolute path to THIS file. Exempt for a disclosed, structural reason: this
// checker's own --self-test builds fixture files whose CONTENTS are string literals like
// "require('./security-boundary.js')" written as test data (never touching the real tree) -- a
// line-based static grep cannot distinguish "a real require call" from "a string literal containing
// require-shaped text" without a full JS parser, and this file is the one place in the repo
// guaranteed to contain such literals as legitimate self-test fixtures. Excluding this exact file
// from the scan (not weakening the regex, which stays precise for every other file) is the
// honest fix; every other file in the repo is still checked at full strictness.
function findViolations(rootDir, opts) {
  const violations = [];
  for (const file of listJsFiles(rootDir)) {
    const absFile = path.resolve(file);
    if (absFile === opts.securityBoundaryPath) continue;
    if (opts.checkerPath && absFile === opts.checkerPath) continue;
    const relToBrokersDir = path.relative(opts.brokersDir, absFile);
    const isUnderBrokersDir = relToBrokersDir === '' || (!relToBrokersDir.startsWith('..') && !path.isAbsolute(relToBrokersDir));
    if (isUnderBrokersDir) continue;

    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = src.split('\n');
    lines.forEach((lineText, idx) => {
      REQUIRE_RE.lastIndex = 0;
      let m;
      while ((m = REQUIRE_RE.exec(lineText)) !== null) {
        const requirePath = m[2];
        if (!requirePath.includes('security-boundary')) continue;
        const resolvedBase = path.resolve(path.dirname(file), requirePath);
        const resolvedJs = resolvedBase.endsWith('.js') ? resolvedBase : resolvedBase + '.js';
        if (resolvedJs === opts.securityBoundaryPath) {
          violations.push({ file: absFile, line: idx + 1, requireString: lineText.trim() });
        }
      }
    });
  }
  return violations;
}

// run(rootDir) -> { pass, violations }
function run(rootDir) {
  const securityBoundaryPath = path.resolve(rootDir, 'scripts', 'security-boundary.js');
  const brokersDir = path.resolve(rootDir, 'scripts', 'security-brokers');
  const checkerPath = path.resolve(__filename);
  const violations = findViolations(rootDir, { securityBoundaryPath, brokersDir, checkerPath });
  return { pass: violations.length === 0, violations };
}

module.exports = { run, findViolations, listJsFiles };

function selfTest() {
  const os = require('os');
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // Synthetic fixture repo under a temp dir -- proves the DETECTION LOGIC in isolation, independent
  // of whatever the real repo currently looks like (the real-repo demonstration is done separately,
  // by hand, and pasted into docs/SECURITY_BROKER_ARCHITECTURE_REPORT.md, not relied on here).
  function buildFixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-broker-conformance-fixture-'));
    fs.mkdirSync(path.join(tmp, 'scripts', 'security-brokers'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'scripts', 'security-boundary.js'), 'module.exports = { scanBeforeCommit(){ return {clean:true, findings:[]}; } };\n');
    fs.writeFileSync(path.join(tmp, 'scripts', 'security-brokers', 'commit-broker.js'),
      "const sb = require('../security-boundary.js');\nmodule.exports = { scanBeforeCommit: sb.scanBeforeCommit };\n");
    fs.writeFileSync(path.join(tmp, 'scripts', 'execute-workflow.js'),
      "const commitBroker = require('./security-brokers/commit-broker.js');\nmodule.exports = { commitBroker };\n");
    return tmp;
  }

  // 1. A clean fixture (only the broker module requires security-boundary.js) passes.
  {
    const tmp = buildFixture();
    const result = run(tmp);
    push('clean_fixture_passes', result.pass === true && result.violations.length === 0, JSON.stringify(result));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 2. THE TEST OF THE TEST, per the task mandate: deliberately add a disallowed direct require of
  //    security-boundary.js to a non-broker file -- the checker must fail the suite and cite the
  //    exact offending file/line, THEN pass again once it's removed (not a one-way/stuck detector).
  {
    const tmp = buildFixture();
    const offendingFile = path.join(tmp, 'scripts', 'some-other-module.js');
    fs.writeFileSync(offendingFile,
      "const sb = require('./security-boundary.js');\nmodule.exports = { scan: sb.scanBeforeCommit };\n");
    const resultFail = run(tmp);
    push('disallowed_require_is_detected',
      resultFail.pass === false && resultFail.violations.some(v => path.resolve(v.file) === path.resolve(offendingFile) && v.line === 1),
      JSON.stringify(resultFail));

    fs.writeFileSync(offendingFile, "module.exports = {};\n"); // remove the disallowed require
    const resultPass = run(tmp);
    push('removing_the_disallowed_require_restores_a_pass', resultPass.pass === true && resultPass.violations.length === 0, JSON.stringify(resultPass));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 3. A disallowed require reached via a relative path from a NESTED subdirectory is still caught
  //    (this is real path resolution, not a brittle string-contains check).
  {
    const tmp = buildFixture();
    fs.mkdirSync(path.join(tmp, 'scripts', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'scripts', 'nested', 'deep.js'),
      "const sb = require('../security-boundary.js');\nmodule.exports = { scan: sb.scanBeforeCommit };\n");
    const result = run(tmp);
    push('nested_relative_require_detected', result.pass === false && result.violations.some(v => v.file.endsWith(path.join('nested', 'deep.js'))), JSON.stringify(result));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 4. Files under scripts/security-brokers/ itself are exempt (they ARE the allowed callers) --
  //    and security-boundary.js's own self-reference (its self-test's subprocess probe) is exempt.
  {
    const tmp = buildFixture();
    fs.writeFileSync(path.join(tmp, 'scripts', 'security-boundary.js'),
      `const path = require('path');\nfunction probe(){ require('./security-boundary.js'); }\nmodule.exports = { scanBeforeCommit(){ return {clean:true, findings:[]}; }, probe };\n`);
    const result = run(tmp);
    push('broker_dir_and_self_reference_are_exempt', result.pass === true, JSON.stringify(result));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const rootFlagIdx = args.indexOf('--root');
  const rootDir = rootFlagIdx !== -1 ? path.resolve(args[rootFlagIdx + 1]) : path.resolve(process.env.HARNESS_ROOT || process.cwd());
  const { pass, violations } = run(rootDir);
  if (!pass) {
    console.log(`FAIL  broker-conformance: found ${violations.length} disallowed direct require(s) of security-boundary.js outside scripts/security-brokers/:`);
    for (const v of violations) console.log(`  ${v.file}:${v.line}  ${v.requireString}`);
    process.exit(1);
  }
  console.log('PASS  broker-conformance: no disallowed direct requires of security-boundary.js found outside scripts/security-brokers/');
  process.exit(0);
}
