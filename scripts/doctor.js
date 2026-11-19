#!/usr/bin/env node
// scripts/doctor.js — capability-aware doctor (GAP_MATRIX.md G6, corrected by G11 "doctor
// circularity"). Backs `npm run doctor`.
//
// Governance requirement this implements (Decision 54 / G6, G11): doctor is NOT a blanket
// pass/fail. Every check maps to a named capability. A capability that is genuinely not built yet
// at THIS point in the project (LangGraph runtime, plugin manifest, release manifest) reports
// NOT_APPLICABLE -- never a silent PASS (that would be a false claim) and never a false BLOCKING
// failure (that would wrongly halt work on a capability nobody has declared they need yet).
//
// Four possible per-check statuses, in severity order: BLOCKING > DEGRADED > WARNING >
// NOT_APPLICABLE, plus PASS for a clean check. Only BLOCKING actually fails the run (exit 1);
// DEGRADED/WARNING/NOT_APPLICABLE are all informational -- they never flip the exit code, because
// a workflow only cares about a capability it has actually declared it needs (see
// --workflow-capabilities below).
//
// CLI:
//   node scripts/doctor.js                          human-readable report, this repo as root
//   node scripts/doctor.js --json                    machine-readable report
//   node scripts/doctor.js --root <dir>              check a different HarnessKit checkout
//   node scripts/doctor.js --workflow-capabilities git,node_runtime
//                                                     scope the pass/fail verdict (see below)
//   node scripts/doctor.js --self-test                run this file's own self-test
//
// Root resolution (deliberately NOT the same default as _lib.js#harnessRoot()): this script's
// primary use case is `npm run doctor` inside a working checkout (that's what the package.json
// script wires up), so the default root is THIS repo (the directory containing scripts/), not the
// global ~/.harnesskit install location other scripts fall back to. HARNESS_ROOT env var or
// --root still override it, for the case where this file is invoked against an installed copy.
//
// --workflow-capabilities is the literal mechanism for "doctor blocks a workflow only when a
// failed check affects a capability that workflow actually declares it needs": pass a
// comma-separated capability list and the exit code / `ok` field are scoped to just those
// capabilities' BLOCKING findings. Omit it (the default, and what `npm run doctor` does) and the
// literal Unix-convention rule applies: exit 0 iff there is no BLOCKING finding anywhere.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { parseArgs, readJson, resolveWorkspace, isUnderTempDir } = require('./_lib.js');

const STATUS = Object.freeze({
  PASS: 'PASS',
  BLOCKING: 'BLOCKING',
  DEGRADED: 'DEGRADED',
  WARNING: 'WARNING',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
});
const ALL_STATUSES = [STATUS.PASS, STATUS.BLOCKING, STATUS.DEGRADED, STATUS.WARNING, STATUS.NOT_APPLICABLE];

// ---------------------------------------------------------------------------
// The capability list (design requirement 1). Named explicitly, once, here -- every check below
// references one of these ids. A check referencing an id not in this object is a bug in this
// file, not a runtime state; the self-test asserts every check's capabilities are declared here.
// ---------------------------------------------------------------------------
const CAPABILITIES = Object.freeze({
  git: 'Git version control binary availability + basic operability',
  node_runtime: 'Node.js runtime, version-gated against package.json engines.node',
  npm_runtime: 'npm package manager binary availability',
  python_runtime: 'Python 3 interpreter (some adapters shell out to it; not the core path)',
  uv_runtime: 'uv Python package/venv manager (some adapters; not the core path)',
  bun_runtime: 'bun runtime -- required only by the GBrain integration, not core HarnessKit',
  langgraph_runtime: '@langchain/langgraph workflow runtime (Phase 5 -- not yet adopted)',
  gbrain_runtime: 'GBrain external cognitive-memory tool + database (bun + ~/gbrain clone)',
  plugin_manifest: 'Claude Code plugin manifest at .claude-plugin/plugin.json (Phase 4 -- not yet adopted)',
  skill_attestation: 'Skill registry two-hash attestation state (config/skill-registry.json)',
  worktree_support: 'git worktree operability in this checkout',
  release_manifest: 'Release manifest presence (Phase 10 -- not yet adopted)',
  config_schema: 'package.json config-schema well-formedness (version field)',
  secret_scan: 'Secret-scanning tooling presence + evidence of a recent run',
  workspace_location: 'Durable-clone workspace resolves outside Temp (Batch 1 mandatory fix)'
});

function errMsg(e) { return e && e.message ? String(e.message).slice(0, 300) : String(e).slice(0, 300); }
function firstLine(s) { return String(s || '').split(/\r?\n/)[0].trim(); }

// Windows shim safety: npm (and other PATH-installed tools) resolve to a `.cmd`/`.bat` shim on
// Windows, which execFileSync cannot spawn directly (ENOENT/EINVAL) without shell:true -- and
// shell:true with an args array trips Node's DEP0190 unescaped-argument warning. The documented
// safe workaround (Node child_process docs) is routing through `cmd.exe /d /s /c <file> <args...>`
// with args kept as separate array elements (never concatenated into one string), which resolves
// PATHEXT shims correctly with no shell-interpolation risk. On non-Windows this is a plain
// execFileSync. Real subprocess either way -- never stubbed.
function runBinary(bin, args, opts) {
  opts = opts || {};
  const baseOpts = { encoding: 'utf8', timeout: opts.timeout || 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', bin, ...(args || [])], baseOpts);
  }
  return execFileSync(bin, args || [], baseOpts);
}

function mkResult(id, capabilities, status, detail, evidence) {
  return { id, capabilities: Array.isArray(capabilities) ? capabilities : [capabilities], status, detail, evidence: evidence === undefined ? null : evidence };
}

// ---------------------------------------------------------------------------
// Minimal semver-range satisfaction -- zero-dependency by design (matches the rest of this repo).
// Supports the shapes actually used in engines.node (">=18", "18", "^18", "~18.1", space-ANDed
// clauses). Not a general semver-range implementation; documented limitation, not a silent gap.
// ---------------------------------------------------------------------------
function parseVersionTriple(v) {
  const m = String(v || '').trim().match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}
function compareTriples(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
  return 0;
}
function satisfiesRange(actualVersion, range) {
  const actual = parseVersionTriple(actualVersion);
  if (!actual) return false;
  const clauses = String(range || '').trim().split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return true;
  return clauses.every(clause => {
    const m = clause.match(/^(>=|<=|>|<|=|\^|~)?(.+)$/);
    if (!m) return true;
    const op = m[1] || '>=';
    const target = parseVersionTriple(m[2]);
    if (!target) return true;
    const cmp = compareTriples(actual, target);
    switch (op) {
      case '>=': return cmp >= 0;
      case '<=': return cmp <= 0;
      case '>': return cmp > 0;
      case '<': return cmp < 0;
      case '=': return cmp === 0;
      case '^': return actual[0] === target[0] && cmp >= 0;
      case '~': return actual[0] === target[0] && actual[1] === target[1] && cmp >= 0;
      default: return cmp >= 0;
    }
  });
}

// ---------------------------------------------------------------------------
// Generic real-binary check -- actually runs the binary (design requirement 3: "actually run
// them, don't stub"). Real subprocess, real failure mode; this is also what the self-test's
// missing-binary case (6a) exercises directly against a binary name that cannot exist.
// ---------------------------------------------------------------------------
function checkBinaryVersion(id, capability, binName, args, opts) {
  opts = opts || {};
  try {
    const out = runBinary(binName, args || ['--version'], { timeout: opts.timeout || 5000 }).trim();
    return mkResult(id, capability, STATUS.PASS, `${binName} available: ${firstLine(out)}`, { raw: firstLine(out) });
  } catch (e) {
    const sev = opts.severity || STATUS.WARNING;
    const note = opts.note ? ` (${opts.note})` : '';
    return mkResult(id, capability, sev, `${binName} not found or failed to execute${note}`, { error: errMsg(e) });
  }
}

function checkNodeRuntime(pkg) {
  let out;
  try {
    out = runBinary('node', ['--version'], { timeout: 5000 }).trim();
  } catch (e) {
    return mkResult('node_version', 'node_runtime', STATUS.BLOCKING, 'node binary not found or failed to execute', { error: errMsg(e) });
  }
  const required = pkg && pkg.engines && pkg.engines.node;
  if (!required) {
    return mkResult('node_version', 'node_runtime', STATUS.PASS, `node available: ${out} (package.json declares no engines.node constraint)`, { version: out });
  }
  const ok = satisfiesRange(out.replace(/^v/, ''), required);
  if (!ok) {
    return mkResult('node_version', 'node_runtime', STATUS.BLOCKING, `node ${out} does not satisfy required engines.node "${required}"`, { version: out, required });
  }
  return mkResult('node_version', 'node_runtime', STATUS.PASS, `node ${out} satisfies engines.node "${required}"`, { version: out, required });
}

function checkLangGraphRuntime(root) {
  const dir = path.join(root, 'node_modules', '@langchain', 'langgraph');
  if (!fs.existsSync(dir)) {
    return mkResult('langgraph_runtime', 'langgraph_runtime', STATUS.NOT_APPLICABLE,
      'LangGraph not yet adopted in this repo (Phase 5 pending)', null);
  }
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return mkResult('langgraph_runtime', 'langgraph_runtime', STATUS.PASS, `@langchain/langgraph present (v${pkgJson.version})`, { version: pkgJson.version });
  } catch (e) {
    return mkResult('langgraph_runtime', 'langgraph_runtime', STATUS.DEGRADED, '@langchain/langgraph directory present but its package.json is unreadable', { error: errMsg(e) });
  }
}

// GBrain is real, external, machine-global shared state (Reality Report correction). It is a
// hard bun+~/gbrain-clone dependency, NOT a package inside this repo. Per this project's own gap
// matrix (G3: brain_score 10/100, half-installed migration), GBrain is honestly far below the
// "active cognitive runtime" bar today -- this check never reports BLOCKING because the core
// HarnessKit workflow does not need it; it degrades gracefully (never hangs/crashes) if bun or
// ~/gbrain aren't reachable, and reports DEGRADED with the real score when they are.
function checkGbrainRuntime(root, opts) {
  opts = opts || {};
  const scriptPath = path.join(root, 'scripts', 'gbrain-doctor.js');
  if (!fs.existsSync(scriptPath)) {
    return mkResult('gbrain_runtime', 'gbrain_runtime', STATUS.NOT_APPLICABLE,
      'scripts/gbrain-doctor.js not present in this repo -- cannot evaluate GBrain health', null);
  }
  const timeoutMs = opts.timeoutMs || 20000;
  let r;
  try {
    r = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', timeout: timeoutMs, cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    return mkResult('gbrain_runtime', 'gbrain_runtime', STATUS.DEGRADED, 'GBrain doctor could not be executed: ' + errMsg(e), null);
  }
  if (r.error) {
    return mkResult('gbrain_runtime', 'gbrain_runtime', STATUS.DEGRADED, 'GBrain doctor execution error (bun/~/gbrain likely unreachable): ' + errMsg(r.error), null);
  }
  if (r.signal || r.status === null) {
    return mkResult('gbrain_runtime', 'gbrain_runtime', STATUS.DEGRADED,
      `GBrain doctor timed out after ${timeoutMs}ms (bun/~/gbrain unreachable or slow) -- degrading gracefully, not blocking`, { signal: r.signal });
  }
  let parsed = null;
  try { parsed = JSON.parse(r.stdout || ''); } catch { /* fall through to unparseable branch */ }
  if (!parsed) {
    const raw = ((r.stdout || '') + (r.stderr || '')).slice(0, 200);
    return mkResult('gbrain_runtime', 'gbrain_runtime', STATUS.DEGRADED, 'GBrain doctor produced unparseable output (bun/gbrain likely unavailable on this machine): ' + raw, { exit_code: r.status });
  }
  const detail = `GBrain reachable: version=${parsed.version || '?'}, overall_score=${parsed.overall_score}/100, ` +
    `brain_score line: ${(parsed.warnings || []).find(w => /brain_score/.test(w)) || 'n/a'}. ` +
    `Below the v53 "active cognitive runtime" bar (Gap G3) -- reported DEGRADED, never blocking, since the core HarnessKit workflow does not depend on it.`;
  return mkResult('gbrain_runtime', 'gbrain_runtime', STATUS.DEGRADED, detail, parsed);
}

function checkPluginManifest(root) {
  const p = path.join(root, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(p)) {
    return mkResult('plugin_manifest', 'plugin_manifest', STATUS.NOT_APPLICABLE,
      'no .claude-plugin/plugin.json -- plugin manifest not yet adopted in this repo (Phase 4 pending)', null);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return mkResult('plugin_manifest', 'plugin_manifest', STATUS.PASS, 'plugin.json present and parses as valid JSON', { name: parsed.name, version: parsed.version });
  } catch (e) {
    return mkResult('plugin_manifest', 'plugin_manifest', STATUS.BLOCKING, 'plugin.json is present but fails to parse as JSON -- a broken manifest is worse than none', { error: errMsg(e) });
  }
}

const ACTIVE_SKILL_STATES = ['enabled', 'enabled-allowed'];

function checkSkillAttestation(root) {
  const registryPath = path.join(root, 'config', 'skill-registry.json');
  const registry = readJson(registryPath, null);
  if (!registry || !Array.isArray(registry.skills)) {
    return mkResult('skill_attestation', 'skill_attestation', STATUS.DEGRADED,
      'config/skill-registry.json missing or malformed -- cannot evaluate skill attestation', null);
  }
  let validateRecord;
  try { ({ validateRecord } = require('./validate-skill-registration.js')); }
  catch (e) {
    return mkResult('skill_attestation', 'skill_attestation', STATUS.DEGRADED, 'scripts/validate-skill-registration.js could not be loaded: ' + errMsg(e), null);
  }

  const results = [];
  let anyActiveFail = false;
  let anyQuarantinedFail = false;
  for (const rec of registry.skills) {
    const skillDir = path.join(root, 'skills', rec.id);
    let r;
    if (!fs.existsSync(skillDir)) {
      r = { ok: false, violations: [{ code: 'missing_skill_dir', severity: 'critical' }] };
    } else {
      try { r = validateRecord(skillDir, rec); }
      catch (e) { r = { ok: false, violations: [{ code: 'validate_threw', detail: errMsg(e) }] }; }
    }
    const isActive = ACTIVE_SKILL_STATES.includes(rec.enable_state);
    if (!r.ok) { if (isActive) anyActiveFail = true; else anyQuarantinedFail = true; }
    results.push({ id: rec.id, enable_state: rec.enable_state, ok: r.ok, violations: (r.violations || []).map(v => v.code || v), active: isActive });
  }

  let status, detail;
  if (anyActiveFail) {
    status = STATUS.BLOCKING;
    detail = 'a registered, non-quarantined (active) skill fails attestation -- this blocks';
  } else if (anyQuarantinedFail) {
    status = STATUS.WARNING;
    detail = `${results.filter(r => !r.ok).length} quarantined/inactive skill(s) fail attestation (tracked, non-blocking since none are active)`;
  } else {
    status = STATUS.PASS;
    detail = `all ${results.length} registered skill(s) pass attestation, or are inactive/quarantined with no violations`;
  }
  return mkResult('skill_attestation', 'skill_attestation', status, detail, results);
}

function checkWorktreeSupport(root, gitResult) {
  if (gitResult && gitResult.status === STATUS.BLOCKING) {
    return mkResult('worktree_support', 'worktree_support', STATUS.NOT_APPLICABLE,
      'git itself is unavailable -- worktree support cannot be evaluated', null);
  }
  try {
    const out = runBinary('git', ['-C', root, 'worktree', 'list'], { timeout: 5000 });
    return mkResult('worktree_support', 'worktree_support', STATUS.PASS, 'git worktree list ran without error', { lines: out.trim().split(/\r?\n/).filter(Boolean).length });
  } catch (e) {
    return mkResult('worktree_support', 'worktree_support', STATUS.DEGRADED, 'git worktree list failed -- worktree-based workflows unavailable', { error: errMsg(e) });
  }
}

const RELEASE_MANIFEST_CANDIDATES = ['RELEASE_MANIFEST.json', 'RELEASE_MANIFEST.md', path.join('docs', 'RELEASE_MANIFEST.json'), path.join('docs', 'RELEASE_MANIFEST.md')];
function checkReleaseManifest(root) {
  const found = RELEASE_MANIFEST_CANDIDATES.find(c => fs.existsSync(path.join(root, c)));
  if (!found) {
    return mkResult('release_manifest', 'release_manifest', STATUS.NOT_APPLICABLE,
      'no RELEASE_MANIFEST found -- release manifest not yet adopted in this repo (Phase 10 pending)', null);
  }
  return mkResult('release_manifest', 'release_manifest', STATUS.PASS, `release manifest found at ${found}`, { path: found });
}

function checkConfigSchema(pkg, pkgError) {
  if (!pkg) {
    return mkResult('config_schema', 'config_schema', STATUS.BLOCKING, 'package.json missing or unreadable: ' + (pkgError || 'unknown error'), null);
  }
  const v = pkg.version;
  const ok = typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v);
  if (!ok) {
    return mkResult('config_schema', 'config_schema', STATUS.WARNING, `package.json "version" field is missing or not well-formed semver-like (got: ${JSON.stringify(v)})`, { version: v });
  }
  return mkResult('config_schema', 'config_schema', STATUS.PASS, `package.json version "${v}" is present and well-formed`, { version: v });
}

const SECRET_SCAN_SCRIPTS = [path.join('scripts', 'gbrain-audit-secrets.js'), path.join('scripts', 'redact.js'), path.join('scripts', 'memory-poisoning-scan.js')];
const SECRET_SCAN_EVIDENCE_MAX_AGE_DAYS = 30;

function findFilesRecursive(dir, pattern, maxDepth) {
  const out = [];
  function walk(d, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (pattern.test(e.name)) {
        try { out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs }); } catch { /* unreadable: skip */ }
      }
    }
  }
  walk(dir, 0);
  return out;
}

function checkSecretScan(root) {
  const presentScripts = SECRET_SCAN_SCRIPTS.filter(c => fs.existsSync(path.join(root, c)));
  let secretSkill = null;
  try { secretSkill = fs.readdirSync(path.join(root, 'skills')).find(d => /secret|forensic/i.test(d)); } catch { /* skills/ absent or unreadable */ }

  if (presentScripts.length === 0 && !secretSkill) {
    return mkResult('secret_scan', 'secret_scan', STATUS.NOT_APPLICABLE, 'no secret-scanning script or skill found in this repo', null);
  }

  const toolingDesc = presentScripts.concat(secretSkill ? [path.join('skills', secretSkill)] : []).join(', ');
  const runsDir = path.join(root, 'runs');
  const evidence = fs.existsSync(runsDir) ? findFilesRecursive(runsDir, /secret-audit\.md$/i, 4) : [];
  if (evidence.length === 0) {
    return mkResult('secret_scan', 'secret_scan', STATUS.WARNING,
      `secret-scanning tooling present (${toolingDesc}) but no evidence of a recent run found under runs/`, { tooling: presentScripts.concat(secretSkill ? [secretSkill] : []) });
  }
  const newest = evidence.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  const ageDays = (Date.now() - newest.mtimeMs) / 86400000;
  const fresh = ageDays <= SECRET_SCAN_EVIDENCE_MAX_AGE_DAYS;
  return mkResult('secret_scan', 'secret_scan', fresh ? STATUS.PASS : STATUS.WARNING,
    `most recent secret-scan evidence: ${path.relative(root, newest.path)} (${ageDays.toFixed(1)} days old)`,
    { age_days: Number(ageDays.toFixed(1)), fresh });
}

// Batch 1 mandatory fix: warn when the effective durable-clone workspace resolves into the OS
// Temp directory. Since resolveWorkspace()'s own default no longer does this (see _lib.js), this
// check only fires on an explicit HARNESSKIT_WORKSPACE override that still points at Temp -- a
// real, live misconfiguration this check exists to catch before another clone repeats the exact
// failure that put the real ART dogfood clone one Windows Temp-cleanup away from permanently
// losing an unpushed commit and run evidence.
function checkWorkspaceLocation() {
  const resolved = resolveWorkspace({});
  const inTemp = isUnderTempDir(resolved);
  if (!inTemp) {
    return mkResult('workspace_location', 'workspace_location', STATUS.PASS,
      `durable-clone workspace resolves outside Temp: ${resolved}`, { resolved, in_temp: false });
  }
  const viaEnv = !!process.env.HARNESSKIT_WORKSPACE;
  return mkResult('workspace_location', 'workspace_location', STATUS.WARNING,
    `durable-clone workspace resolves INTO the OS Temp directory (${resolved})` +
    (viaEnv ? ' via an explicit HARNESSKIT_WORKSPACE override' : '') +
    ' -- any commit or run evidence created there is one Temp-cleanup away from permanent loss. ' +
    'Set HARNESSKIT_WORKSPACE to a durable, non-Temp location, or pass --workspace explicitly, ' +
    'unless this run is genuinely an explicitly disposable fixture/test.',
    { resolved, in_temp: true, via_env_override: viaEnv });
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------
function defaultRoot() {
  if (process.env.HARNESS_ROOT) return process.env.HARNESS_ROOT;
  return path.resolve(__dirname, '..');
}

function countStatuses(results) {
  const counts = {}; for (const s of ALL_STATUSES) counts[s] = 0;
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

function runDoctor(opts) {
  opts = opts || {};
  const root = opts.root || defaultRoot();

  let pkg = null, pkgError = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }
  catch (e) { pkgError = errMsg(e); }

  const results = [];
  const git = checkBinaryVersion('git_version', 'git', 'git', ['--version'], { severity: STATUS.BLOCKING });
  results.push(git);
  results.push(checkNodeRuntime(pkg));
  results.push(checkBinaryVersion('npm_version', 'npm_runtime', 'npm', ['--version'], { severity: STATUS.BLOCKING }));
  results.push(checkPythonRuntime(opts));
  results.push(checkBinaryVersion('uv_version', 'uv_runtime', 'uv', ['--version'], { severity: STATUS.DEGRADED, note: 'needed for some adapters, not the core path' }));
  results.push(checkBinaryVersion('bun_version', 'bun_runtime', 'bun', ['--version'], { severity: STATUS.DEGRADED, note: 'needed only by the GBrain integration, not core HarnessKit' }));
  results.push(checkLangGraphRuntime(root));
  results.push(checkGbrainRuntime(root, { timeoutMs: opts.gbrainTimeoutMs }));
  results.push(checkPluginManifest(root));
  results.push(checkSkillAttestation(root));
  results.push(checkWorktreeSupport(root, git));
  results.push(checkReleaseManifest(root));
  results.push(checkConfigSchema(pkg, pkgError));
  results.push(checkSecretScan(root));
  results.push(checkWorkspaceLocation());

  const declared = Array.isArray(opts.declaredCapabilities) && opts.declaredCapabilities.length ? opts.declaredCapabilities : null;
  const scoped = declared ? results.filter(r => r.capabilities.some(c => declared.includes(c))) : results;
  const counts = countStatuses(results);
  const scopedCounts = declared ? countStatuses(scoped) : null;
  const blockingOverall = counts[STATUS.BLOCKING] > 0;
  const blockingScoped = declared ? scopedCounts[STATUS.BLOCKING] > 0 : null;

  return {
    generated_at: new Date().toISOString(),
    root,
    capabilities: CAPABILITIES,
    declared_capabilities: declared,
    checks: results,
    counts,
    scoped_counts: scopedCounts,
    blocking_overall: blockingOverall,
    blocking_scoped: blockingScoped,
    ok: declared ? !blockingScoped : !blockingOverall
  };
}

// Python check tries `python` then `python3` -- either satisfying the check is enough.
function checkPythonRuntime(opts) {
  opts = opts || {};
  const attempts = [];
  for (const bin of ['python', 'python3']) {
    try {
      const out = runBinary(bin, ['--version'], { timeout: 5000 }).trim();
      return mkResult('python_version', 'python_runtime', STATUS.PASS, `${bin} available: ${firstLine(out) || out}`, { binary: bin, raw: firstLine(out) || out });
    } catch (e) {
      attempts.push(`${bin}: ${errMsg(e)}`);
    }
  }
  return mkResult('python_version', 'python_runtime', STATUS.DEGRADED, 'neither python nor python3 found on PATH (needed for some adapters, not the core path)', { attempts });
}

// ---------------------------------------------------------------------------
// Human-readable output.
// ---------------------------------------------------------------------------
function printHuman(report) {
  const lines = [];
  lines.push(`HarnessKit doctor -- ${report.generated_at}`);
  lines.push(`root: ${report.root}`);
  lines.push('');
  for (const c of report.checks) {
    lines.push(`[${c.status}]  ${c.id}  (capabilities: ${c.capabilities.join(', ')})`);
    lines.push(`         ${c.detail}`);
  }
  lines.push('');
  lines.push('capabilities:');
  for (const [id, desc] of Object.entries(report.capabilities)) lines.push(`  - ${id}: ${desc}`);
  lines.push('');
  lines.push(`counts: ${ALL_STATUSES.map(s => `${s}=${report.counts[s]}`).join(' ')}`);
  if (report.declared_capabilities) {
    lines.push(`scoped to declared capabilities [${report.declared_capabilities.join(', ')}]: ${ALL_STATUSES.map(s => `${s}=${report.scoped_counts[s]}`).join(' ')}`);
    lines.push(`scoped verdict: ${report.blocking_scoped ? 'BLOCKING finding present in declared capability set' : 'no blocking finding in declared capability set'}`);
  }
  lines.push('');
  lines.push(report.ok ? 'doctor: PASS (no blocking finding)' : 'doctor: FAIL (at least one blocking finding)');
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Self-test. Hermetic where possible (temp fixture roots); the one real-repo case (8) actually
// runs the full pipeline against this checkout (including a real GBrain subprocess call bounded
// by a timeout) to satisfy "JSON and human output modes both run without crashing on this real
// machine" -- not just a pure-function check.
// ---------------------------------------------------------------------------
function selfTest() {
  const os = require('os');
  const results = [];
  const A = (n, c) => results.push([n, !!c]);
  let tmpRoot = null;

  try {
    // Case 1 (design requirement 6a): a genuinely missing binary reports BLOCKING. Real
    // subprocess spawn against a binary name that cannot exist on any machine.
    const fake = checkBinaryVersion('fake_bin', 'fake_capability', 'definitely-not-a-real-binary-xyz-123', ['--version'], { severity: STATUS.BLOCKING });
    A('case1: missing binary -> BLOCKING (real subprocess spawn)', fake.status === STATUS.BLOCKING && /not found or failed to execute/.test(fake.detail));

    // Case 2: a present-but-degraded-severity binary reports DEGRADED, not BLOCKING, when told to.
    const fakeDegraded = checkBinaryVersion('fake_bin2', 'fake_capability', 'definitely-not-a-real-binary-xyz-123', ['--version'], { severity: STATUS.DEGRADED });
    A('case2: missing binary with DEGRADED severity config -> DEGRADED (not BLOCKING)', fakeDegraded.status === STATUS.DEGRADED);

    // Build a temp fixture root for the "not yet built capability" cases.
    tmpRoot = path.join(os.tmpdir(), 'hk-doctor-selftest-' + process.pid);
    fs.mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.1', engines: { node: '>=18' } }));

    // Case 3 (design requirement 6b): LangGraph not adopted -> NOT_APPLICABLE, never a false FAIL.
    const lg = checkLangGraphRuntime(tmpRoot);
    A('case3: LangGraph absent -> NOT_APPLICABLE (not a false failure)', lg.status === STATUS.NOT_APPLICABLE);

    // Case 4 (design requirement 6b): plugin manifest not adopted -> NOT_APPLICABLE.
    const pm = checkPluginManifest(tmpRoot);
    A('case4: plugin manifest absent -> NOT_APPLICABLE (not a false failure)', pm.status === STATUS.NOT_APPLICABLE);

    // Case 4b: a malformed plugin manifest, once one exists, is BLOCKING (broken worse than absent).
    fs.mkdirSync(path.join(tmpRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.claude-plugin', 'plugin.json'), '{ not valid json');
    const pmBad = checkPluginManifest(tmpRoot);
    A('case4b: malformed plugin.json -> BLOCKING', pmBad.status === STATUS.BLOCKING);

    // Case 5: release manifest not adopted -> NOT_APPLICABLE.
    const rm = checkReleaseManifest(tmpRoot);
    A('case5: release manifest absent -> NOT_APPLICABLE', rm.status === STATUS.NOT_APPLICABLE);

    // Case 6: no secret-scanning tooling in a bare fixture -> NOT_APPLICABLE.
    const ss = checkSecretScan(tmpRoot);
    A('case6: no secret-scan tooling -> NOT_APPLICABLE', ss.status === STATUS.NOT_APPLICABLE);

    // Case 6b: secret-scan tooling present, no run evidence -> WARNING.
    fs.writeFileSync(path.join(tmpRoot, 'scripts', 'redact.js'), '// fixture\n');
    const ssWarn = checkSecretScan(tmpRoot);
    A('case6b: secret-scan tooling present, no run evidence -> WARNING', ssWarn.status === STATUS.WARNING);

    // Case 6c: secret-scan tooling present with fresh evidence -> PASS.
    fs.mkdirSync(path.join(tmpRoot, 'runs', 'r1'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'runs', 'r1', 'gbrain-secret-audit.md'), '# fixture audit\n');
    const ssPass = checkSecretScan(tmpRoot);
    A('case6c: secret-scan tooling with fresh evidence -> PASS', ssPass.status === STATUS.PASS);

    // Case 7: config-schema — missing package.json -> BLOCKING; malformed version -> WARNING; good -> PASS.
    const csMissing = checkConfigSchema(null, 'ENOENT fixture');
    const csMalformed = checkConfigSchema({ version: 'not-a-version' }, null);
    const csGood = checkConfigSchema({ version: '1.2.3' }, null);
    A('case7: config_schema missing/malformed/good -> BLOCKING/WARNING/PASS', csMissing.status === STATUS.BLOCKING && csMalformed.status === STATUS.WARNING && csGood.status === STATUS.PASS);

    // Case 8: GBrain check on a fixture with no gbrain-doctor.js -> NOT_APPLICABLE (fast, hermetic;
    // the real repo's GBrain path is exercised separately by case 11 below).
    const gb = checkGbrainRuntime(tmpRoot);
    A('case8: gbrain-doctor.js absent -> NOT_APPLICABLE', gb.status === STATUS.NOT_APPLICABLE);

    // Case 9: worktree_support reports NOT_APPLICABLE when git itself is unavailable (dependency
    // propagation), rather than piling a second BLOCKING on top of the git failure.
    const wtNoGit = checkWorktreeSupport(tmpRoot, { status: STATUS.BLOCKING });
    A('case9: worktree_support when git unavailable -> NOT_APPLICABLE (no duplicate BLOCKING)', wtNoGit.status === STATUS.NOT_APPLICABLE);

    // Case 9b: workspace_location (Batch 1 mandatory fix). With no HARNESSKIT_WORKSPACE set, the
    // durable default must resolve outside Temp -> PASS. With it explicitly set to a Temp path,
    // the check must WARN, not silently pass -- this is the real, live misconfiguration case the
    // check exists to catch (the exact condition that put the real ART clone one Temp-cleanup
    // away from permanent loss, before the resolveWorkspace()-level fix in _lib.js).
    const wsPrevEnv = process.env.HARNESSKIT_WORKSPACE;
    delete process.env.HARNESSKIT_WORKSPACE;
    const wsDefault = checkWorkspaceLocation();
    A('case9b: workspace_location default (no env) -> PASS, not in Temp', wsDefault.status === STATUS.PASS && wsDefault.evidence.in_temp === false);
    process.env.HARNESSKIT_WORKSPACE = path.join(os.tmpdir(), 'doctor-selftest-explicit-temp-choice');
    const wsTempOverride = checkWorkspaceLocation();
    if (wsPrevEnv === undefined) delete process.env.HARNESSKIT_WORKSPACE; else process.env.HARNESSKIT_WORKSPACE = wsPrevEnv;
    A('case9c: workspace_location explicit Temp override -> WARNING, not silently PASS', wsTempOverride.status === STATUS.WARNING && wsTempOverride.evidence.via_env_override === true);

    // Case 10: skill_attestation — build a real skill fixture, mismatch its recorded hash, verify
    // an ACTIVE (non-quarantined) skill escalates to BLOCKING while a QUARANTINED one with the
    // identical defect stays WARNING (design requirement 3's literal "BLOCKING only if a
    // registered, non-quarantined skill fails").
    const skillDir = path.join(tmpRoot, 'skills', 'fixture-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nid: fixture-skill\nname: Fixture\nversion: 1.0.0\n---\nbody\n');
    const registryQuarantined = { skills: [{ id: 'fixture-skill', enable_state: 'quarantined', runtime_hash: 'sha256:deadbeef', validation_hash: 'sha256:deadbeef' }] };
    fs.writeFileSync(path.join(tmpRoot, 'config', 'skill-registry.json'), JSON.stringify(registryQuarantined));
    const skQuarantined = checkSkillAttestation(tmpRoot);
    A('case10a: quarantined skill with hash mismatch -> WARNING (not BLOCKING)', skQuarantined.status === STATUS.WARNING);

    const registryActive = { skills: [{ id: 'fixture-skill', enable_state: 'enabled', runtime_hash: 'sha256:deadbeef', validation_hash: 'sha256:deadbeef' }] };
    fs.writeFileSync(path.join(tmpRoot, 'config', 'skill-registry.json'), JSON.stringify(registryActive));
    const skActive = checkSkillAttestation(tmpRoot);
    A('case10b: active (non-quarantined) skill with hash mismatch -> BLOCKING', skActive.status === STATUS.BLOCKING);

    // Case 11 (design requirement 6c + 7): full pipeline against the REAL repo this file lives
    // in -- both JSON and human-readable rendering must run without throwing. This is the one
    // non-hermetic case; it genuinely invokes the real gbrain-doctor.js subprocess (bounded by a
    // 20s default timeout) and real git/node/npm/python/uv/bun binaries on this machine.
    let realOk = true, realShapeOk = false, humanOk = false, jsonOk = false;
    try {
      const real = runDoctor({});
      realShapeOk = typeof real.ok === 'boolean' && Array.isArray(real.checks) && real.checks.length > 0 &&
        real.checks.every(c => Array.isArray(c.capabilities) && c.capabilities.every(cap => cap in CAPABILITIES));
      try { JSON.stringify(real); jsonOk = true; } catch { jsonOk = false; }
      try {
        const origWrite = process.stdout.write;
        process.stdout.write = () => true;
        try { printHuman(real); humanOk = true; } finally { process.stdout.write = origWrite; }
      } catch { humanOk = false; }
    } catch (e) { realOk = false; }
    A('case11: real-repo doctor runs without throwing, every check capability is declared, JSON+human render clean', realOk && realShapeOk && jsonOk && humanOk);

    // Case 12: --workflow-capabilities scoping narrows the verdict as documented. Uses
    // release_manifest (untouched by any earlier case -> still NOT_APPLICABLE on tmpRoot), not
    // plugin_manifest (mutated to a malformed/BLOCKING manifest by case4b above).
    const scopedReport = runDoctor({ root: tmpRoot, declaredCapabilities: ['release_manifest'] });
    A('case12: scoping to a NOT_APPLICABLE-only capability set never blocks', scopedReport.ok === true);
  } catch (e) {
    results.push(['exception: ' + (e && e.message), false]);
  } finally {
    if (tmpRoot) try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }

  let pass = true;
  for (const [n, ok] of results) { process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}\n`); if (!ok) pass = false; }
  process.stdout.write(pass ? 'self-test: ALL PASS\n' : 'self-test: FAILURES\n');
  return pass;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) process.exit(selfTest() ? 0 : 1);

  const root = (args.root && args.root !== true) ? String(args.root) : defaultRoot();
  const declared = (args['workflow-capabilities'] && args['workflow-capabilities'] !== true)
    ? String(args['workflow-capabilities']).split(',').map(s => s.trim()).filter(Boolean)
    : null;

  const report = runDoctor({ root, declaredCapabilities: declared });
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printHuman(report);
  process.exit(report.ok ? 0 : 1);
}

module.exports = {
  STATUS, CAPABILITIES, satisfiesRange, checkBinaryVersion, checkNodeRuntime, checkPythonRuntime,
  checkLangGraphRuntime, checkGbrainRuntime, checkPluginManifest, checkSkillAttestation,
  checkWorktreeSupport, checkReleaseManifest, checkConfigSchema, checkSecretScan,
  checkWorkspaceLocation, runDoctor, printHuman
};

if (require.main === module) main();
