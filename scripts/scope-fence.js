#!/usr/bin/env node
// scope-fence.js — PR13/W13: report-only implementation-scope guard. Compares the real `git diff`
// against caller-supplied allowed-file globs, reports out-of-scope files, and counts real files/lines
// changed (closing the "no diff capture" gap named in docs/contracts/impl_ce_work.md). REPORT-ONLY:
// never blocks, never writes code, never transitions state, never auto-fires. Reuses existing local
// helpers (_lib.js#globMatch, the same glob engine sensitivePathHits already uses) rather than
// inventing a second glob engine. No network, no model, no external tool beyond local `git`.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isDisabled } = require('./is-disabled.js');
const { globMatch, parseArgs, harnessRoot, runDir, nowIso } = require('./_lib.js');

// Parses `git diff --numstat` output: "<added>\t<deleted>\t<path>" per line. Binary files report
// "-\t-\t<path>" (added/deleted unknown) — counted as a changed file with 0 countable lines, never
// silently dropped.
function parseNumstat(text) {
  const src = typeof text === 'string' ? text : '';
  const entries = [];
  for (const line of src.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!m) continue;
    const added = m[1] === '-' ? 0 : Number(m[1]);
    const deleted = m[2] === '-' ? 0 : Number(m[2]);
    entries.push({ path: m[3], added, deleted, binary: m[1] === '-' });
  }
  return entries;
}

// Real diff — mirrors _lib.js#gitDiffPaths' own convention exactly (git diff <ref||'HEAD'>, so it
// captures ALL TRACKED uncommitted changes — staged + unstaged, modified/added/deleted/renamed —
// relative to the last commit by default). Does NOT see untracked (new, never-`git add`ed) files —
// that gap is closed separately via `git status --porcelain` below.
function realNumstat(root, ref) {
  try {
    const out = execFileSync('git', ['-C', root, 'diff', '--numstat', ref || 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseNumstat(out);
  } catch { return []; }
}

// Parses `git status --porcelain` output: 2-char status code + space + path (renames as
// "old -> new" — the new path is taken; "simple support", no full old/new tracking). Quoted paths
// (spaces/special chars) have surrounding quotes stripped; no deeper C-style unescaping (narrow scope).
function parsePorcelain(text) {
  const src = typeof text === 'string' ? text : '';
  const out = [];
  for (const line of src.split(/\r?\n/)) {
    if (!line) continue;
    const code = line.slice(0, 2);
    let rest = line.slice(3);
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    const arrow = rest.indexOf(' -> ');
    const p = arrow !== -1 ? rest.slice(arrow + 4) : rest;
    out.push({ code, path: p });
  }
  return out;
}

function realStatusPorcelain(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parsePorcelain(out);
  } catch { return []; }
}

// Reads a local file to count its lines for untracked-file line counting (git diff cannot report a
// line count for a file it doesn't track). Binary heuristic: a NUL byte anywhere → line count unknown
// (never guessed, never silently 0-disguised-as-known). Unreadable file → unknown for the same reason.
function countFileLines(fullPath) {
  let buf;
  try { buf = fs.readFileSync(fullPath); } catch { return { known: false }; }
  if (buf.includes(0)) return { known: false };
  const text = buf.toString('utf8');
  if (text === '') return { known: true, lines: 0 };
  const parts = text.split(/\r?\n/);
  const lines = parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
  return { known: true, lines };
}

// Untracked ('??') entries from `git status --porcelain`, converted to the same entry shape as
// realNumstat's tracked entries (path/added/deleted/binary) plus `untracked:true` and
// `line_count_unknown` — NEVER silently treated as 0 lines when the count can't be determined.
function untrackedEntries(root, statusEntries) {
  return statusEntries.filter(e => e.code === '??').map(e => {
    const lc = countFileLines(path.join(root, e.path));
    return { path: e.path, added: lc.known ? lc.lines : 0, deleted: 0, binary: false, untracked: true, line_count_unknown: !lc.known };
  });
}

// Pure comparison — no fs/git access. allowedGlobs: array of glob strings (caller-supplied; scope-fence
// does NOT parse plan.md prose — globs are an explicit, structured input). Empty/missing allowedGlobs
// means "no scope declared" — files are reported UNSCOPED (fail-closed: never silently assumed in-scope).
// entries may include tracked (numstat) and untracked (`line_count_unknown` possible) files together —
// this function doesn't care about the source, only the shape.
function compareScope(entries, allowedGlobs) {
  const globs = Array.isArray(allowedGlobs) ? allowedGlobs.filter(Boolean) : [];
  const inScope = [], outOfScope = [];
  let files = 0, lines = 0;
  const linesUnknownFor = [];
  for (const e of entries || []) {
    files++;
    if (e.line_count_unknown) linesUnknownFor.push(e.path);
    else lines += (e.added || 0) + (e.deleted || 0);
    if (!globs.length) { outOfScope.push(e.path); continue; }
    const matched = globs.some(g => globMatch(g, e.path));
    (matched ? inScope : outOfScope).push(e.path);
  }
  return {
    ok: true,
    unscoped: globs.length === 0,
    files, lines,
    lines_unknown_for: linesUnknownFor,
    in_scope: inScope, out_of_scope: outOfScope,
    summary: globs.length === 0
      ? `no allowed globs declared — all ${files} changed file(s) reported unscoped (fail-closed, not assumed in-scope)`
      : `${files} file(s) changed, ${lines} known line(s)${linesUnknownFor.length ? ` (+${linesUnknownFor.length} file(s) with unknown line count, never counted as 0)` : ''}; ${inScope.length} in-scope, ${outOfScope.length} out-of-scope`
  };
}

function logScopeFenceCheck(runId, extra, opts) {
  try {
    const p = path.join(runDir(runId, opts.root), 'decision-log.ndjson');
    fs.appendFileSync(p, JSON.stringify(Object.assign({ ts: nowIso(), run_id: runId, event_type: 'scope_fence_check', report_only: true, no_transition: true }, extra)) + '\n');
  } catch { /* decision-log is bookkeeping; non-fatal */ }
}

// runScopeFence(opts) -> report. opts: { root?, ref?, allowedGlobs?, runId?, entries? (injected tracked
// entries, tests only), statusEntries? (injected porcelain entries, tests only) }. Merges TRACKED
// changes (git diff --numstat: modified/added/deleted/renamed) with UNTRACKED new files (git status
// --porcelain '??' entries, line-counted by reading the file) — a new out-of-scope file can no longer
// be invisible to this tool. DISABLED-honored (no git spawn under the kill switch). Writes a
// decision-log event ONLY when opts.runId is given (matches runWithTimeoutRetry/checkMaxRepairLoops
// convention) — never a reviewer verdict, never a state transition; this component has no verdict_log
// role.
function runScopeFence(opts = {}) {
  const dis = isDisabled();
  if (dis.disabled) return { ok: true, report_only: true, outcome: 'skipped', disabled: true, reason: dis.reason, note: 'kill switch active — no diff read' };
  const root = opts.root || harnessRoot();
  const tracked = Array.isArray(opts.entries) ? opts.entries : realNumstat(root, opts.ref);
  const statusEntries = Array.isArray(opts.statusEntries) ? opts.statusEntries : realStatusPorcelain(root);
  const untracked = untrackedEntries(root, statusEntries);
  const cmp = compareScope(tracked.concat(untracked), opts.allowedGlobs);
  if (opts.runId) logScopeFenceCheck(opts.runId, { files: cmp.files, lines: cmp.lines, out_of_scope_count: cmp.out_of_scope.length, unscoped: cmp.unscoped, untracked_count: untracked.length }, opts);
  return Object.assign({ report_only: true, note: 'report-only: no blocking, no write, no transition, no repair; includes both tracked diff and untracked new files' }, cmp);
}

module.exports = { parseNumstat, realNumstat, parsePorcelain, realStatusPorcelain, countFileLines, untrackedEntries, compareScope, runScopeFence };

// ---------------------------------------------------------------------------
// Self-test: hermetic temp git repo + pure-function unit tests. No real repo mutation, no network.
// ---------------------------------------------------------------------------
function selfTest() {
  const os = require('os');
  const results = [];
  const A = (n, c) => results.push([n, !!c]);
  try {
    // Pure numstat parsing.
    const parsed = parseNumstat('3\t1\tsrc/a.js\n-\t-\tassets/logo.png\n0\t5\tsrc/b.js\n');
    A('parseNumstat: text file counts + binary file (0 countable lines, still counted)', parsed.length === 3 && parsed[0].path === 'src/a.js' && parsed[0].added === 3 && parsed[0].deleted === 1 && parsed[1].binary === true && parsed[1].added === 0);
    A('parseNumstat: empty/garbage input -> empty array, no throw', parseNumstat('').length === 0 && parseNumstat(null).length === 0);

    // Pure porcelain parsing.
    const porc = parsePorcelain(' M scripts/tracked.js\n?? scripts/new-file.js\n?? "quoted path.js"\nR  old.js -> new.js\n');
    A('parsePorcelain: modified/untracked/quoted/renamed all parsed', porc.length === 4 && porc[0].code === ' M' && porc[0].path === 'scripts/tracked.js' && porc[1].code === '??' && porc[1].path === 'scripts/new-file.js' && porc[2].path === 'quoted path.js' && porc[3].path === 'new.js');
    A('parsePorcelain: empty input -> empty array, no throw', parsePorcelain('').length === 0 && parsePorcelain(null).length === 0);

    // Pure untrackedEntries + countFileLines (via a real small temp dir, no git needed for this part).
    const utDir = path.join(os.tmpdir(), 'hk-scope-fence-ut-' + process.pid);
    fs.mkdirSync(utDir, { recursive: true });
    fs.writeFileSync(path.join(utDir, 'new.js'), 'line1\nline2\nline3\n');
    fs.writeFileSync(path.join(utDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]));
    const ut = untrackedEntries(utDir, [{ code: '??', path: 'new.js' }, { code: '??', path: 'binary.bin' }, { code: ' M', path: 'ignored-not-untracked.js' }]);
    A('untrackedEntries: only ?? entries included, modified entries ignored', ut.length === 2);
    A('untrackedEntries: text file line count correct, untracked:true, known', ut[0].path === 'new.js' && ut[0].added === 3 && ut[0].untracked === true && ut[0].line_count_unknown === false);
    A('untrackedEntries: binary file -> line_count_unknown:true, never silently 0-as-known', ut[1].path === 'binary.bin' && ut[1].line_count_unknown === true);
    try { fs.rmSync(utDir, { recursive: true, force: true }); } catch {}

    // Pure scope comparison.
    const entries = [{ path: 'scripts/foo.js', added: 5, deleted: 2 }, { path: 'docs/readme.md', added: 1, deleted: 0 }, { path: 'unrelated/other.js', added: 10, deleted: 0 }];
    const cmp = compareScope(entries, ['scripts/**', 'docs/*.md']);
    A('compareScope: in-scope files matched by glob', cmp.in_scope.includes('scripts/foo.js') && cmp.in_scope.includes('docs/readme.md'));
    A('compareScope: out-of-scope file correctly flagged', cmp.out_of_scope.length === 1 && cmp.out_of_scope[0] === 'unrelated/other.js');
    A('compareScope: file + line counts correct', cmp.files === 3 && cmp.lines === 18);
    A('compareScope: unscoped=false when globs provided', cmp.unscoped === false);

    const noGlobs = compareScope(entries, []);
    A('compareScope: no globs declared -> ALL files unscoped (fail-closed, never assumed in-scope)', noGlobs.unscoped === true && noGlobs.out_of_scope.length === 3 && noGlobs.in_scope.length === 0);

    const emptyDiff = compareScope([], ['scripts/**']);
    A('compareScope: empty diff -> 0 files, 0 lines, no findings', emptyDiff.files === 0 && emptyDiff.lines === 0 && emptyDiff.in_scope.length === 0 && emptyDiff.out_of_scope.length === 0);

    // Glob edge cases: ** vs * vs no-match.
    const globCases = compareScope([{ path: 'a/b/c.js', added: 1, deleted: 0 }, { path: 'a/c.js', added: 1, deleted: 0 }, { path: 'z/c.js', added: 1, deleted: 0 }], ['a/**']);
    A('compareScope: ** matches nested paths, sibling top-level dir excluded', globCases.in_scope.includes('a/b/c.js') && globCases.in_scope.includes('a/c.js') && globCases.out_of_scope.includes('z/c.js'));

    // Real-diff mode against a hermetic temp git repo (no real repo touched).
    const tmpRoot = path.join(os.tmpdir(), 'hk-scope-fence-selftest-' + process.pid);
    fs.mkdirSync(tmpRoot, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpRoot });
    fs.mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'scripts', 'a.js'), 'line1\nline2\n');
    fs.writeFileSync(path.join(tmpRoot, 'unrelated.js'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: tmpRoot });
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: tmpRoot });
    fs.writeFileSync(path.join(tmpRoot, 'scripts', 'a.js'), 'line1\nline2\nline3\n');
    fs.writeFileSync(path.join(tmpRoot, 'unrelated.js'), 'x\ny\n');
    const realCmp = runScopeFence({ root: tmpRoot, allowedGlobs: ['scripts/**'] });
    A('runScopeFence: real hermetic git diff detects both TRACKED changed files (existing behavior)', realCmp.files === 2 && realCmp.ok === true);
    A('runScopeFence: real diff correctly classifies in/out of declared scope', realCmp.in_scope.includes('scripts/a.js') && realCmp.out_of_scope.includes('unrelated.js'));
    A('runScopeFence: report_only note present, no side effects claimed', realCmp.report_only === true);

    // Untracked-file coverage (the bug this patch fixes): a brand-new, never-`git add`ed file must be
    // visible — in-scope if it matches an allowed glob, out-of-scope otherwise, counted in files/lines.
    fs.writeFileSync(path.join(tmpRoot, 'scripts', 'brand-new.js'), 'a\nb\nc\nd\n');
    fs.writeFileSync(path.join(tmpRoot, 'also-new-unrelated.js'), 'x\ny\n');
    const withUntracked = runScopeFence({ root: tmpRoot, allowedGlobs: ['scripts/**'] });
    A('runScopeFence: untracked in-scope file detected (scripts/brand-new.js)', withUntracked.in_scope.includes('scripts/brand-new.js'));
    A('runScopeFence: untracked out-of-scope file detected (also-new-unrelated.js)', withUntracked.out_of_scope.includes('also-new-unrelated.js'));
    A('runScopeFence: untracked files counted in files/lines totals (existing tracked-diff behavior preserved)', withUntracked.files === 4 && withUntracked.in_scope.includes('scripts/a.js') && withUntracked.out_of_scope.includes('unrelated.js') && withUntracked.lines >= realCmp.lines + 6);
    A('runScopeFence: untracked line counts are known (not unknown) for a readable text file', withUntracked.lines_unknown_for.length === 0);

    // runId given -> decision-log event written (report-only, no transition).
    const wstate = require('./workflow-state.js');
    wstate.initWorkflowState({ runId: 'sf-selftest', workflowId: 'runtime_code_change', root: tmpRoot });
    const withLog = runScopeFence({ root: tmpRoot, allowedGlobs: ['scripts/**'], runId: 'sf-selftest' });
    A('runScopeFence with runId writes scope_fence_check decision-log event', withLog.ok === true && (function () { const f = path.join(tmpRoot, 'runs', 'sf-selftest', 'decision-log.ndjson'); return fs.existsSync(f) && /"event_type":"scope_fence_check"[\s\S]*"report_only":true/.test(fs.readFileSync(f, 'utf8')); })());
    A('runScopeFence writes NO reviewer verdict (not a verdict_log role)', !fs.existsSync(path.join(tmpRoot, 'runs', 'sf-selftest', 'reviewer-verdicts.ndjson')));
    A('runScopeFence does NOT transition state', wstate.readWorkflowState('sf-selftest', { root: tmpRoot }).status === 'initialized');

    // DISABLED honored — no git spawn.
    const _envD = process.env.HARNESSKIT_DISABLED, _envH = process.env.HARNESS_ROOT;
    process.env.HARNESSKIT_DISABLED = '1';
    const disabledRun = runScopeFence({ root: tmpRoot, allowedGlobs: ['scripts/**'] });
    if (_envD === undefined) delete process.env.HARNESSKIT_DISABLED; else process.env.HARNESSKIT_DISABLED = _envD;
    if (_envH === undefined) delete process.env.HARNESS_ROOT; else process.env.HARNESS_ROOT = _envH;
    A('runScopeFence under DISABLED -> skipped, no git diff read', disabledRun.outcome === 'skipped' && disabledRun.disabled === true && !('files' in disabledRun));

    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  } catch (e) {
    results.push(['exception: ' + (e && e.message), false]);
  }
  let pass = true;
  for (const [n, ok] of results) { process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}\n`); if (!ok) pass = false; }
  process.stdout.write(pass ? 'self-test: ALL PASS\n' : 'self-test: FAILURES\n');
  return pass;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) process.exit(selfTest() ? 0 : 1);
  const root = (args.root && args.root !== true) ? String(args.root) : harnessRoot();
  const allowedGlobs = (args.allowed && args.allowed !== true) ? String(args.allowed).split(',').map(s => s.trim()).filter(Boolean) : [];
  const runId = (args['run-id'] && args['run-id'] !== true) ? String(args['run-id']) : undefined;
  const ref = (args.ref && args.ref !== true) ? String(args.ref) : undefined;
  const res = runScopeFence({ root, allowedGlobs, runId, ref });
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) main();
