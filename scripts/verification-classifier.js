#!/usr/bin/env node
// verification-classifier.js — Phase 8: turns a raw test-run result (command, exit code,
// stdout, stderr) into one of 7 canonical verification statuses, instead of the binary
// pass/fail deterministic-verify produced before this file existed.
//
//   VERIFIED_PASS               exit 0.
//   ENVIRONMENT_BLOCKED         failure signature is a missing-tool/module/setup problem, not a
//                               real assertion failure (checked BEFORE the flaky rerun, since an
//                               absent binary won't become present by running it again).
//   FLAKY_OR_INCONCLUSIVE       a real rerun of the same command disagrees with the first run
//                               (different exit code, or the same nonzero exit but a different
//                               set of failing test names).
//   KNOWN_PREEXISTING_FAILURES  every failing test name is on the caller-supplied baseline
//                               allowlist (pre-existing, unrelated to the current diff).
//   REGRESSION_DETECTED         failing tests are NOT all on the baseline, and at least one
//                               unexplained failure's name overlaps a file touched by the diff.
//   FAILED                      genuine nonzero exit; none of the above explains it.
//   VERIFICATION_NOT_AVAILABLE  no command was resolved for this repo at all (command is falsy).
//
// Only REGRESSION_DETECTED and FAILED are hard blocks (see HARD_BLOCK_STATUSES). The other three
// failure-shaped statuses plus VERIFICATION_NOT_AVAILABLE require an explicit, recorded override
// object (see isValidOverride) before a workflow may proceed past them -- never silently.
'use strict';

const { execFileSync } = require('child_process');
const { tokenizeCommand, gitDiffPaths, parseArgs } = require('./_lib.js');

const STATUSES = Object.freeze([
  'VERIFIED_PASS', 'KNOWN_PREEXISTING_FAILURES', 'ENVIRONMENT_BLOCKED',
  'REGRESSION_DETECTED', 'FLAKY_OR_INCONCLUSIVE', 'VERIFICATION_NOT_AVAILABLE', 'FAILED'
]);

// Most-severe-first: used both to pick a single overall status across several capability runs
// (deterministic-verify may run test+lint+typecheck) and to document precedence rules.
const SEVERITY_ORDER = Object.freeze([
  'REGRESSION_DETECTED', 'FAILED', 'ENVIRONMENT_BLOCKED', 'FLAKY_OR_INCONCLUSIVE',
  'KNOWN_PREEXISTING_FAILURES', 'VERIFICATION_NOT_AVAILABLE', 'VERIFIED_PASS'
]);

const HARD_BLOCK_STATUSES = Object.freeze(['REGRESSION_DETECTED', 'FAILED']);
const OVERRIDABLE_STATUSES = Object.freeze([
  'KNOWN_PREEXISTING_FAILURES', 'ENVIRONMENT_BLOCKED', 'FLAKY_OR_INCONCLUSIVE', 'VERIFICATION_NOT_AVAILABLE'
]);

const ENVIRONMENT_BLOCKED_PATTERNS = Object.freeze([
  /command not found/i,
  /is not recognized as an internal or external command/i, // Windows cmd.exe
  /ENOENT/,
  /no such file or directory/i,
  /modulenotfounderror/i,
  /cannot find module/i,
  /error: cannot find module/i,
  /importerror: no module named/i,
  /command '.+' not found/i,
  /is not installed/i,
  /not found in \$?PATH/i,
  /spawn .+ enoent/i
]);

// Failing-test-name extraction: covers this repo's own self-test convention
// ("FAIL  self-test:name  (detail)") plus generic test-framework shapes (jest/mocha ✕, TAP
// "not ok", pytest "FAILED path::name"). Best-effort — a pattern miss degrades to "0 named
// failures found", which still lets classifyStatic fall through to FAILED honestly rather than
// mis-reporting KNOWN_PREEXISTING_FAILURES for something it couldn't actually identify.
const FAILING_TEST_PATTERNS = Object.freeze([
  /^FAIL\s+self-test:(\S+)/gm,
  /^FAILED\s+(\S+)/gm,
  /^\s*not ok \d+ - (.+)$/gm,
  /[✕×]\s+(.+)$/gm
]);

function extractFailingTestNames(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  const names = new Set();
  for (const re of FAILING_TEST_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) names.add(m[1].trim());
  }
  return Array.from(names).sort();
}

function isEnvironmentBlocked(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  const matched = ENVIRONMENT_BLOCKED_PATTERNS.find(re => re.test(text));
  return matched ? { blocked: true, pattern: matched.toString() } : { blocked: false, pattern: null };
}

// matchesBaseline(failingTests, baseline) -> {allKnown, matched, unknown}
// baseline: array of known-preexisting failing-test-name strings (case-sensitive exact match --
// deliberately strict; a fuzzy match here would silently launder a NEW failure into "known").
function matchesBaseline(failingTests, baseline) {
  const list = Array.isArray(baseline) ? baseline : [];
  const matched = failingTests.filter(t => list.includes(t));
  const unknown = failingTests.filter(t => !list.includes(t));
  return { allKnown: failingTests.length > 0 && unknown.length === 0, matched, unknown };
}

// Generic/low-information basenames that commonly collide with unrelated test names purely by
// naming convention, not by any real relationship to what changed -- nearly every pytest-style test
// file token-matches a diffed 'test.py' (test files are conventionally named test_*.py), and
// 'app'/'index'/'config'/'base'/'utils'/etc. are some of the most common project filenames in
// existence. A match against one of these is never treated as a confident, explicit same-file
// correlation -- only ever 'weak' (heuristic-only). Not exhaustive; a real, documented judgment
// call naming the exact classes this finding called out, not an arbitrary list.
const GENERIC_STEMS = new Set([
  'test', 'tests', 'spec', 'specs', 'index', 'main', 'app', 'base', 'common',
  'utils', 'util', 'helper', 'helpers', 'config', 'constants', 'types'
]);

// overlapsDiff(names, diffFiles) -> { overlaps, confidence: 'strong'|'weak'|null, matches }.
// Heuristic: a failing test name references the basename (extension-stripped) of a file the
// current diff touched. Good enough to separate "this failure plausibly relates to what changed"
// from "this failure is unrelated to the diff" without needing a real coverage map (out of scope
// here).
//
// Tightened from a raw substring check (any diffed basename appearing ANYWHERE in the test name
// string) to a whole-token match: the test name is split into alphanumeric tokens on any
// non-alphanumeric delimiter ('/', '.', '::', '_', space, ...) and a diffed stem must equal one of
// those tokens EXACTLY. This fixes the class of accidental collision a raw substring check invites
// -- e.g. diffed stem 'app' no longer "matches" an unrelated test named 'test_happy_path' just
// because the letters a-p-p happen to appear inside 'happy'.
//
// Even a whole-token match is not perfect confidence: GENERIC_STEMS above will legitimately
// token-match huge swathes of unrelated test names purely by naming convention. A match against one
// of those stems is reported as confidence:'weak' (heuristic-only overlap) rather than 'strong' (a
// match on a distinctive, non-generic name -- a real explicit correlation). Callers use this to
// decide whether REGRESSION_DETECTED should still be an unconditional hard block or must offer an
// override (see execute-workflow.js#handleDeterministicVerify).
function overlapsDiff(names, diffFiles) {
  if (!Array.isArray(diffFiles) || diffFiles.length === 0) return { overlaps: false, confidence: null, matches: [] };
  const stems = diffFiles.map(f => String(f).replace(/\\/g, '/').split('/').pop().replace(/\.[^./]+$/, '').toLowerCase()).filter(Boolean);
  const matches = [];
  for (const n of names) {
    const tokens = String(n).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (const stem of stems) {
      if (stem && tokens.includes(stem)) matches.push({ name: n, stem, generic: GENERIC_STEMS.has(stem) });
    }
  }
  if (matches.length === 0) return { overlaps: false, confidence: null, matches: [] };
  const confidence = matches.every(m => m.generic) ? 'weak' : 'strong';
  return { overlaps: true, confidence, matches };
}

// classifyStatic: classify a single (post-flakiness-check) run. Never runs a process itself.
function classifyStatic({ exitCode, stdout, stderr, baseline, diffFiles }) {
  if (exitCode === 0) {
    return { status: 'VERIFIED_PASS', reason: 'exit code 0', evidence: { exit_code: exitCode } };
  }
  const env = isEnvironmentBlocked(stdout, stderr);
  if (env.blocked) {
    return {
      status: 'ENVIRONMENT_BLOCKED',
      reason: 'failure signature matches a missing-tool/missing-module/environment-setup class of error, not a test assertion failure',
      evidence: { exit_code: exitCode, matched_pattern: env.pattern }
    };
  }
  const failingTests = extractFailingTestNames(stdout, stderr);
  const baselineCheck = matchesBaseline(failingTests, baseline);
  if (failingTests.length > 0 && baselineCheck.allKnown) {
    return {
      status: 'KNOWN_PREEXISTING_FAILURES',
      reason: `all ${failingTests.length} failing test(s) match the known-baseline allowlist`,
      evidence: { exit_code: exitCode, failing_tests: failingTests, matched: baselineCheck.matched }
    };
  }
  const unexplained = baselineCheck.unknown.length > 0 ? baselineCheck.unknown : failingTests;
  const overlap = overlapsDiff(unexplained, diffFiles);
  if (unexplained.length > 0 && overlap.overlaps) {
    const heuristicOnly = overlap.confidence === 'weak';
    return {
      status: 'REGRESSION_DETECTED',
      reason: heuristicOnly
        ? 'failing test(s) are not on the known-baseline allowlist and share only a generic, low-information filename token with a file touched by the current diff -- heuristic-only overlap, not a confirmed same-file correlation'
        : 'failing test(s) are not on the known-baseline allowlist and overlap file(s) touched by the current diff',
      evidence: {
        exit_code: exitCode, failing_tests: failingTests, unexplained, diff_files: diffFiles,
        overlap_confidence: overlap.confidence, heuristic_only: heuristicOnly, overlap_matches: overlap.matches
      }
    };
  }
  return {
    status: 'FAILED',
    reason: failingTests.length > 0
      ? 'genuine nonzero exit with unexplained failing test(s): not on the baseline allowlist, no diff overlap, no environment-block signature'
      : 'genuine nonzero exit; no named failing tests could be extracted, no environment-block signature, no baseline/diff explanation fits',
    evidence: { exit_code: exitCode, failing_tests: failingTests, unexplained }
  };
}

// Real default rerun: executes the SAME command again for real. Injectable so unit tests can
// supply a synthetic second result without spawning a process.
function defaultRerun(command, cwd, timeoutMs) {
  const [cmd, ...args] = tokenizeCommand(command);
  try {
    const out = execFileSync(cmd, args, { cwd: cwd || process.cwd(), encoding: 'utf8', timeout: timeoutMs || 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { exitCode: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { exitCode: e.status != null ? e.status : null, stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message || '') };
  }
}

// classifyVerification: the one entry point. Given a first real run's result, decides the
// canonical status. Only reruns (for flakiness) when the first run failed and a command exists --
// a passing run or an unresolved command never pays the rerun cost.
function classifyVerification(input) {
  const { command, cwd, exitCode, stdout, stderr, baseline, diffFiles, rerun, timeoutMs } = input || {};

  if (!command) {
    return { status: 'VERIFICATION_NOT_AVAILABLE', reason: 'no test/verification command could be resolved for this repo', evidence: {} };
  }
  if (exitCode === 0) {
    return { status: 'VERIFIED_PASS', reason: 'exit code 0, no baseline needed', evidence: { exit_code: 0 } };
  }
  const env = isEnvironmentBlocked(stdout, stderr);
  if (env.blocked) {
    return {
      status: 'ENVIRONMENT_BLOCKED',
      reason: 'failure signature matches a missing-tool/missing-module/environment-setup class of error, not a test assertion failure',
      evidence: { exit_code: exitCode, matched_pattern: env.pattern }
    };
  }

  const rerunFn = rerun || defaultRerun;
  const second = rerunFn(command, cwd, timeoutMs);
  const firstFailing = extractFailingTestNames(stdout, stderr);
  const secondFailing = extractFailingTestNames(second.stdout, second.stderr);
  const sameExit = second.exitCode === exitCode;
  const sameFailingSet = JSON.stringify(firstFailing) === JSON.stringify(secondFailing);
  if (!sameExit || (firstFailing.length > 0 && !sameFailingSet)) {
    return {
      status: 'FLAKY_OR_INCONCLUSIVE',
      reason: 'the same command produced different results across 2 consecutive runs',
      evidence: {
        first: { exit_code: exitCode, failing_tests: firstFailing },
        second: { exit_code: second.exitCode, failing_tests: secondFailing }
      }
    };
  }

  return classifyStatic({ exitCode, stdout, stderr, baseline, diffFiles });
}

// combineStatuses: when deterministic-verify runs several capabilities (test, lint, typecheck),
// pick one overall status by severity, never averaging or silently picking the first.
function combineStatuses(statuses) {
  for (const s of SEVERITY_ORDER) if (statuses.includes(s)) return s;
  return 'VERIFICATION_NOT_AVAILABLE';
}

// isValidOverride: the minimum a recorded override must carry to count as "explicit" -- who/what
// overrode it, why, and when. Never validates WHETHER the reason is a good one; that judgment
// belongs to whoever reviews the recorded override later, not to this gate.
function isValidOverride(o) {
  return !!o && typeof o === 'object' &&
    typeof o.overridden_by === 'string' && o.overridden_by.length > 0 &&
    typeof o.reason === 'string' && o.reason.length > 0 &&
    typeof o.overridden_at === 'string' && o.overridden_at.length > 0;
}

// isHeuristicOnlyAcknowledged: the EXTRA bar a REGRESSION_DETECTED override must clear when the
// regression correlation itself was only ever heuristic (a generic, low-information filename-token
// overlap -- see overlapsDiff/GENERIC_STEMS above -- not a confirmed same-file correlation). This is
// the one carve-out that can wave through an otherwise-hard-blocked status
// (execute-workflow.js#handleDeterministicVerify), so it needs a stronger check than isValidOverride's
// bare shape test alone.
//
// FINDING (adversarial review, 2026-07-12): the previous check was
// `isValidOverride(override) && /heuristic-only/i.test(override.reason)` -- a loose substring match
// against the override's own free-text `reason` field. Because this file's OWN blocked-reason
// message (see the 'blocked_pending_override' branch below) literally contains the phrase
// "heuristic-only", an orchestrating agent could clear this specific hard-block gate just by
// echoing that exact phrase back into a self-authored `reason` string -- zero actual proof anyone
// but the agent itself made that determination. Same "agent-authored string treated as authority"
// problem as elsewhere in this project's governance work.
//
// Fix: require an exact, distinct enum value on a SEPARATE field (`classification_basis`) that
// never appears anywhere in this module's own guard vocabulary/messages, instead of a substring
// test against free text. This does not solve general override-provenance (isValidOverride's
// overridden_by/reason/overridden_at are still bare, unverified strings -- a disclosed, pre-existing
// tradeoff for the other three OVERRIDABLE_STATUSES, which are lower-severity than a hard-blocked
// regression and are left as-is here rather than over-engineering a full approval-token system for
// them). It DOES close the specific, concrete exploit named above: a bare "I acknowledge this is
// heuristic-only" free-text reason -- even word-for-word -- is no longer sufficient on its own.
const HEURISTIC_ONLY_ACKNOWLEDGMENT = 'heuristic_only_acknowledged';
function isHeuristicOnlyAcknowledged(o) {
  return isValidOverride(o) && o.classification_basis === HEURISTIC_ONLY_ACKNOWLEDGMENT;
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });
  const noRerun = () => ({ exitCode: 1, stdout: '', stderr: '' }); // never invoked when exitCode===0 or env-blocked

  // 1. VERIFIED_PASS
  {
    const r = classifyVerification({ command: 'pytest', exitCode: 0, stdout: '12 passed', stderr: '' });
    push('status_VERIFIED_PASS', r.status === 'VERIFIED_PASS', JSON.stringify(r));
  }

  // 2. KNOWN_PREEXISTING_FAILURES -- failing test matches baseline, consistent across rerun.
  {
    const stdout = 'FAILED tests/test_x.py::test_flaky_legacy\n';
    const sameRerun = () => ({ exitCode: 1, stdout, stderr: '' });
    const r = classifyVerification({
      command: 'pytest', exitCode: 1, stdout, stderr: '',
      baseline: ['tests/test_x.py::test_flaky_legacy'], diffFiles: ['src/unrelated.py'], rerun: sameRerun
    });
    push('status_KNOWN_PREEXISTING_FAILURES', r.status === 'KNOWN_PREEXISTING_FAILURES', JSON.stringify(r));
  }

  // 3. ENVIRONMENT_BLOCKED -- missing module, never even reaches the rerun step.
  {
    let rerunCalled = false;
    const r = classifyVerification({
      command: 'pytest', exitCode: 1, stdout: '', stderr: 'ModuleNotFoundError: No module named \'pytest\'',
      rerun: () => { rerunCalled = true; return { exitCode: 1, stdout: '', stderr: '' }; }
    });
    push('status_ENVIRONMENT_BLOCKED', r.status === 'ENVIRONMENT_BLOCKED' && !rerunCalled, JSON.stringify({ r, rerunCalled }));
  }

  // 4. REGRESSION_DETECTED -- failing test not on baseline, name overlaps a diffed file. 'widget'
  //    is a distinctive, non-generic name, so this is a 'strong' (confident, non-heuristic-only)
  //    correlation.
  {
    const stdout = 'FAILED tests/test_widget.py::test_widget_renders\n';
    const sameRerun = () => ({ exitCode: 1, stdout, stderr: '' });
    const r = classifyVerification({
      command: 'pytest', exitCode: 1, stdout, stderr: '',
      baseline: ['test_flaky_legacy'], diffFiles: ['src/widget.py'], rerun: sameRerun
    });
    push('status_REGRESSION_DETECTED', r.status === 'REGRESSION_DETECTED', JSON.stringify(r));
    push('status_REGRESSION_DETECTED_is_strong_confidence_for_distinctive_name',
      r.evidence.overlap_confidence === 'strong' && r.evidence.heuristic_only === false, JSON.stringify(r.evidence));
  }

  // 4a. FINDING 3 FIX (part 1 -- tightened match): a diffed file whose basename happens to be a
  //     short substring of an unrelated test name's WORDS (not a whole token) must no longer be
  //     misclassified as REGRESSION_DETECTED at all. Diffed stem 'app' is a raw substring of
  //     'happy' -- the OLD substring-based overlapsDiff would have matched this; the tightened
  //     whole-token match must not.
  {
    const stdout = 'FAILED tests/test_happy_path.py::test_renders_a_happy_path_banner\n';
    const sameRerun = () => ({ exitCode: 1, stdout, stderr: '' });
    const r = classifyVerification({
      command: 'pytest', exitCode: 1, stdout, stderr: '',
      baseline: [], diffFiles: ['src/app.py'], rerun: sameRerun
    });
    push('accidental_substring_collision_no_longer_misclassified_as_regression',
      r.status === 'FAILED', JSON.stringify(r));
  }

  // 4b. FINDING 3 FIX (part 2 -- heuristic-only marking): a diffed file whose basename IS a real
  //     whole-token match ('utils' from src/utils.py) but only against a GENERIC, low-information
  //     name is still reported as REGRESSION_DETECTED (never silently downgraded/hidden -- a real
  //     token match did occur), but the classification now honestly marks it heuristic_only:true /
  //     confidence:'weak' so a caller (handleDeterministicVerify) can offer an override instead of
  //     an unconditional hard block. The failing test here ('string utils formatting') is genuinely
  //     unrelated to src/utils.py -- the token match is a pure naming-convention coincidence.
  {
    const stdout = 'FAILED tests/test_string_utils_formatting.py::test_format_currency\n';
    const sameRerun = () => ({ exitCode: 1, stdout, stderr: '' });
    const r = classifyVerification({
      command: 'pytest', exitCode: 1, stdout, stderr: '',
      baseline: [], diffFiles: ['src/utils.py'], rerun: sameRerun
    });
    push('generic_filename_overlap_still_flagged_but_marked_heuristic_only',
      r.status === 'REGRESSION_DETECTED' && r.evidence.overlap_confidence === 'weak' && r.evidence.heuristic_only === true,
      JSON.stringify(r));
  }

  // 5. FLAKY_OR_INCONCLUSIVE -- real rerun-and-compare: first run fails, second run passes.
  {
    const r = classifyVerification({
      command: 'pytest', exitCode: 1, stdout: 'FAILED tests/test_y.py::test_y\n', stderr: '',
      rerun: () => ({ exitCode: 0, stdout: 'all passed', stderr: '' })
    });
    push('status_FLAKY_OR_INCONCLUSIVE_different_exit', r.status === 'FLAKY_OR_INCONCLUSIVE', JSON.stringify(r));
  }
  // 5b. Flaky variant: same nonzero exit code both times, but a DIFFERENT failing test each time.
  {
    const r = classifyVerification({
      command: 'pytest', exitCode: 1, stdout: 'FAILED tests/test_a.py::test_a\n', stderr: '',
      rerun: () => ({ exitCode: 1, stdout: 'FAILED tests/test_b.py::test_b\n', stderr: '' })
    });
    push('status_FLAKY_OR_INCONCLUSIVE_same_exit_different_failure', r.status === 'FLAKY_OR_INCONCLUSIVE', JSON.stringify(r));
  }

  // 6. VERIFICATION_NOT_AVAILABLE -- no command resolved at all.
  {
    const r = classifyVerification({ command: null });
    push('status_VERIFICATION_NOT_AVAILABLE', r.status === 'VERIFICATION_NOT_AVAILABLE', JSON.stringify(r));
  }

  // 7. FAILED -- genuine failure, not on baseline, no diff overlap, no environment signature,
  //    reproducible across rerun (so not flaky either).
  {
    const stdout = 'FAILED tests/test_z.py::test_z_totally_unrelated\n';
    const sameRerun = () => ({ exitCode: 1, stdout, stderr: '' });
    const r = classifyVerification({
      command: 'pytest', exitCode: 1, stdout, stderr: '',
      baseline: ['test_flaky_legacy'], diffFiles: ['src/widget.py'], rerun: sameRerun
    });
    push('status_FAILED', r.status === 'FAILED', JSON.stringify(r));
  }

  // 8. combineStatuses picks the most severe status, not the first or last in the input array.
  {
    push('combine_picks_most_severe',
      combineStatuses(['VERIFIED_PASS', 'KNOWN_PREEXISTING_FAILURES', 'REGRESSION_DETECTED']) === 'REGRESSION_DETECTED',
      combineStatuses(['VERIFIED_PASS', 'KNOWN_PREEXISTING_FAILURES', 'REGRESSION_DETECTED']));
    push('combine_all_pass_is_pass', combineStatuses(['VERIFIED_PASS', 'VERIFIED_PASS']) === 'VERIFIED_PASS', '');
    push('combine_empty_is_not_available', combineStatuses([]) === 'VERIFICATION_NOT_AVAILABLE', '');
  }

  // 9. HARD_BLOCK_STATUSES / OVERRIDABLE_STATUSES partition all 7 statuses with no overlap and no gaps.
  {
    const union = [...HARD_BLOCK_STATUSES, ...OVERRIDABLE_STATUSES, 'VERIFIED_PASS'].sort();
    push('statuses_fully_partitioned', JSON.stringify(union) === JSON.stringify([...STATUSES].sort()), JSON.stringify(union));
    const overlap = HARD_BLOCK_STATUSES.filter(s => OVERRIDABLE_STATUSES.includes(s));
    push('hard_block_and_overridable_disjoint', overlap.length === 0, JSON.stringify(overlap));
  }

  // 10. isValidOverride: well-shaped override accepted, missing/empty fields rejected.
  {
    const good = { overridden_by: 'owner', reason: 'known flaky suite, tracked in issue #42', overridden_at: '2026-07-11T00:00:00.000Z' };
    push('valid_override_accepted', isValidOverride(good) === true, JSON.stringify(good));
    push('override_missing_reason_rejected', isValidOverride({ overridden_by: 'owner', overridden_at: 'x' }) === false, '');
    push('override_empty_reason_rejected', isValidOverride({ overridden_by: 'owner', reason: '', overridden_at: 'x' }) === false, '');
    push('null_override_rejected', isValidOverride(null) === false, '');
  }

  // 10b. FINDING 3 FIX: isHeuristicOnlyAcknowledged rejects the OLD, weak shape (a bare free-text
  //      `reason` that just happens to contain the phrase "heuristic-only", satisfying the previous
  //      regex-based check) and only accepts a distinct, exact `classification_basis` enum value.
  {
    const oldWeakShapeStillHasThePhrase = {
      overridden_by: 'owner', reason: 'confirmed heuristic-only overlap, unrelated to this diff', overridden_at: '2026-07-11T00:00:00.000Z'
    };
    push('old_freetext_only_shape_no_longer_sufficient', isHeuristicOnlyAcknowledged(oldWeakShapeStillHasThePhrase) === false, JSON.stringify(oldWeakShapeStillHasThePhrase));

    const wellFormed = {
      overridden_by: 'owner', reason: 'confirmed heuristic-only overlap, unrelated to this diff', overridden_at: '2026-07-11T00:00:00.000Z',
      classification_basis: 'heuristic_only_acknowledged'
    };
    push('exact_enum_field_accepted', isHeuristicOnlyAcknowledged(wellFormed) === true, JSON.stringify(wellFormed));

    const wrongEnumValue = Object.assign({}, wellFormed, { classification_basis: 'HEURISTIC_ONLY_ACKNOWLEDGED' });
    push('enum_value_is_exact_match_not_case_insensitive_guess', isHeuristicOnlyAcknowledged(wrongEnumValue) === false, JSON.stringify(wrongEnumValue));

    const missingShapeButRightEnum = { classification_basis: 'heuristic_only_acknowledged' };
    push('exact_enum_alone_without_valid_override_shape_still_rejected', isHeuristicOnlyAcknowledged(missingShapeButRightEnum) === false, JSON.stringify(missingShapeButRightEnum));
  }

  // 11. Real rerun-and-compare against a REAL subprocess (not a synthetic rerun function) --
  //     a genuinely flaky command (alternates exit code by invocation count via a temp state file)
  //     must be caught by defaultRerun's real execFileSync call, not just the injectable path.
  {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const stateFile = path.join(os.tmpdir(), `hk-verify-classifier-flaky-${process.pid}-${Date.now()}.state`);
    const scriptFile = path.join(os.tmpdir(), `hk-verify-classifier-flaky-${process.pid}-${Date.now()}.js`);
    fs.writeFileSync(stateFile, '0');
    // Written as a real .js file (not an inline `node -e "..."` string) so this test never has to
    // reason about tokenizeCommand's quote-escaping rules -- `node <file>` has no quoting at all.
    fs.writeFileSync(scriptFile,
      `const fs=require('fs');const p=${JSON.stringify(stateFile)};let n=parseInt(fs.readFileSync(p,'utf8'),10);fs.writeFileSync(p,String(n+1));process.exit(n===0?1:0);`);
    const cmd = `node ${scriptFile}`;
    const [firstCmd, ...firstArgs] = tokenizeCommand(cmd);
    let firstExitCode = 0;
    try { execFileSync(firstCmd, firstArgs, { cwd: os.tmpdir(), encoding: 'utf8' }); }
    catch (e) { firstExitCode = e.status != null ? e.status : null; }
    // First real invocation above (n=0 -> exit 1, matches firstExitCode). classifyVerification's
    // internal rerun then performs the SECOND real invocation (n=1 -> exit 0) via the real
    // defaultRerun path (no injected rerun) -- a genuine subprocess-level flakiness detection.
    const r = classifyVerification({ command: cmd, cwd: os.tmpdir(), exitCode: firstExitCode, stdout: '', stderr: '' });
    fs.unlinkSync(stateFile);
    fs.unlinkSync(scriptFile);
    push('real_subprocess_rerun_catches_real_flakiness', firstExitCode === 1 && r.status === 'FLAKY_OR_INCONCLUSIVE', JSON.stringify({ firstExitCode, r }));
  }

  // 12. REAL end-to-end: actually run this repo's real local-ci.js control-plane script (not a
  //     fixture) and classify its real output for real. Not registered in local-ci.js's own
  //     self-test module list (that would recurse: local-ci.js would spawn this file's
  //     --self-test, which spawns local-ci.js again). This call is a one-shot, real subprocess,
  //     evaluated for a sane (non-throwing, real-status) result -- not asserted to be any
  //     particular status, since the repo's real health at self-test time is exactly what's
  //     being observed, not fixed in advance.
  {
    const path = require('path');
    const localCiPath = path.join(__dirname, 'local-ci.js');
    // Bounded to 25s (not local-ci.js's own much longer natural runtime -- it composes ~20 real
    // subprocess self-tests plus the full eval suite, and can legitimately take well over a
    // minute under concurrent system load). A real timeout here is still real, non-fixture
    // evidence (a bounded rerun, same as any CI wrapper would impose) -- the assertion below only
    // checks that SOME real one-of-7 status came out the other end, not which one, and the same
    // 25s bound is threaded into classifyVerification's own rerun so the whole assertion has a
    // hard worst-case ceiling (~50s) that can never make this self-test itself hang.
    const boundedMs = 25000;
    let real;
    try {
      const out = execFileSync(process.execPath, [localCiPath, '--json'], { encoding: 'utf8', timeout: boundedMs, stdio: ['ignore', 'pipe', 'pipe'] });
      real = { exitCode: 0, stdout: out, stderr: '' };
    } catch (e) {
      real = { exitCode: e.status != null ? e.status : null, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
    }
    const classification = classifyVerification({
      command: `node scripts/local-ci.js --json`, cwd: path.join(__dirname, '..'),
      exitCode: real.exitCode, stdout: real.stdout, stderr: real.stderr,
      baseline: [], diffFiles: gitDiffPaths(path.join(__dirname, '..')), timeoutMs: boundedMs
    });
    push('real_e2e_local_ci_classified_to_a_real_status',
      STATUSES.includes(classification.status),
      JSON.stringify({ real_exit_code: real.exitCode, classified_status: classification.status, reason: classification.reason }));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = {
  STATUSES, SEVERITY_ORDER, HARD_BLOCK_STATUSES, OVERRIDABLE_STATUSES,
  classifyVerification, classifyStatic, combineStatuses, isValidOverride,
  HEURISTIC_ONLY_ACKNOWLEDGMENT, isHeuristicOnlyAcknowledged,
  extractFailingTestNames, isEnvironmentBlocked, matchesBaseline, overlapsDiff, defaultRerun
};

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  console.log('verification-classifier.js — library. node scripts/verification-classifier.js --self-test');
  process.exit(0);
}
