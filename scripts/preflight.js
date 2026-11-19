#!/usr/bin/env node
// preflight.js — CI-0: local, read-only safety baseline. Codifies the manual checks run after
// every wiring slice (W1-W8): module self-tests, registry shape, contract conformity, staged-file
// guard, raw repair_loop bypass tripwire, DISABLED-honesty static check. Never mutates the repo,
// never stages/unstages, never spawns Codex/network. This repo is LOCAL-ONLY / never-push — for
// this repo, preflight IS the CI, not a stub for future GitHub Actions.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { harnessRoot, parseArgs } = require('./_lib.js');

const ALLOWED_WORK_STATES = ['inventoried', 'contract_drafted', 'wired', 'verified'];
// P2 capability-inventory supersession (this same batch): config/capability-registry.json is now
// _deprecated (superseded by config/capability-inventory.json), but this pattern is deliberately
// NOT updated to point at the new file, and NOT extended to also cover it. The protection here was
// always about capability-registry.json's own nature -- a HELD, personal, registry_owner:"owner"
// file (per docs/contracts/finalize_commit.md: "do not stage held config/capability-registry.json
// unless explicitly approved") -- not about "whichever file is the current capability source of
// truth". config/capability-inventory.json is the opposite of held: it is a machine-verified,
// agent-buildable ledger (like capability-matrix.json, also never in this list, always was), built
// and committed by this very lane. Verified via a real self-test case (see selfTest() case 3b)
// that staging it is NOT flagged, so this is a proven decision, not an oversight.
const FORBIDDEN_STAGED_PATTERNS = [
  /^config\/capability-registry\.json$/i,
  /^runs\//i,
  /reviewer-verdicts\.ndjson$/i,
  /decision-log\.ndjson$/i,
  /\.plugin-check\.json$/i
];
// Only enterRepairLoop is a legal source of a raw `transitionStage(..., to:'repair_loop', ...)`
// call — every other caller must go through it (W5/W6 admission: cap check + single increment).
const RAW_REPAIR_LOOP_ALLOWLIST = ['enterRepairLoop'];
// Flags whose branch runs a meaningful/external-adjacent action. Each must either check
// isDisabled() itself OR delegate to a conductor function that is known (by reading the source)
// to check it internally. Narrow and evidence-based on purpose — not a general control-flow prover.
const DISABLED_CHECK_TARGETS = {
  'run-codex': ['isDisabled'],
  'check-codex-timeout-retry': ['isDisabled', 'runWithTimeoutRetry'],
  'run-qa-self-tests': ['isDisabled', 'runQaSelfTests'],
  'run-ponytail-budget': ['isDisabled', 'runPonytailBudget'],
  'enter-repair-loop': ['isDisabled', 'enterRepairLoop'],
  'check-max-repair-loops': ['isDisabled', 'checkMaxRepairLoops'],
  'run-qa-evals': ['isDisabled', 'runQaEvals']
};
const SELF_TEST_MODULES = ['workflow-state.js', 'loop-conductor.js', 'harness-loop.js'];
// W9: provenance stamping sites — static evidence that each write path carries its hardcoded
// provenance. This is the honest substitute for runtime-testing the live-Codex path (which would
// spawn real Codex): the live_codex stamp is verified by inspection, not execution.
const PROVENANCE_STAMP_SITES = [
  { file: 'scripts/loop-conductor.js', pattern: /provenance:\s*'live_codex'/, min: 1, label: 'runCodexReview stamps live_codex' },
  { file: 'scripts/loop-conductor.js', pattern: /provenance:\s*'deterministic_internal'/g, min: 3, label: 'qa_self_tests + ponytail_budget + qa_evals stamp deterministic_internal' },
  { file: 'scripts/harness-loop.js', pattern: /stampProvenance\(verdict,\s*'cli_human'\)/, min: 1, label: '--continue force-stamps cli_human' },
  { file: 'scripts/loop-conductor.js', pattern: /reviewer:\s*'qa_evals'/, min: 1, label: 'runQaEvals records reviewer qa_evals' }
];
// REVIEW-INDEPENDENCE-1: same honest-substitute-for-runtime-testing category as PROVENANCE_STAMP_SITES
// above -- proves adapter_id/provider_id are hardcoded literals at their one legitimate call site
// in each file, not derived from any model-writable input.
const REVIEW_INDEPENDENCE_STAMP_SITES = [
  { file: 'scripts/stamp-producer.js', pattern: /adapterId:\s*'claude-code',\s*providerId:\s*'anthropic'/, min: 1, label: 'stamp-producer.js hardcodes claude-code/anthropic for main-thread producer stamps' },
  { file: 'scripts/review-independence/adapters/cli-stamp.js', pattern: /adapter_id:\s*'human'/, min: 1, label: 'cli-stamp.js hardcodes human for recordHumanReviewer' },
  { file: 'scripts/review-independence/adapters/claude-code-hooks.js', pattern: /adapter_id:\s*'claude-code'/, min: 1, label: 'claude-code-hooks.js hardcodes claude-code for finalized subagent reviewer stamps' }
];
// REVIEW-INDEPENDENCE-1: structural core/adapter separation -- core/*.js must never directly read a
// raw Claude Code hook payload field. `hook_event_name` and a literal `.agent_id` property access
// are precise, meaningful signals of a leak (unlike a comment mentioning "SubagentStart" for
// context, which is legitimate documentation, not a dependency). Real, not merely conventional: if
// this ever fires, core/ has started depending on a specific runtime's payload shape.
const CORE_ADAPTER_SEPARATION = {
  coreDir: 'scripts/review-independence/core',
  forbiddenPatterns: [/hook_event_name/, /\.agent_id\b/]
};
// W10: plan-lint guard must run inside runCodexReview BEFORE the codex spawn site.
// Purely static — this is the honest substitute for proving the ordering without spawning Codex.
// 2026-07-10: spawnPattern updated from the literal `command: 'codex'` to `command: resolved.command`
// -- the ENOENT fix (see adapter-registry.json's codex-cli.incidents) made the executable resolved
// at runtime (Windows shim-path resolution) instead of hardcoded, so the old literal no longer
// appears in the file. Same lexical-tripwire limitation as before: this is tied to the current
// variable name at the one real call site, not a deep AST guarantee -- a future rename must update
// this pattern too, exactly as a rename of the old 'codex' literal would have.
const PLAN_LINT_GUARD_SITE = { file: 'scripts/loop-conductor.js', usesPattern: /lintPlanForRun\s*\(/, spawnPattern: /command:\s*resolved\.command/, label: 'runCodexReview lints plan.md before the codex spawn' };
// W12: decision-log hardening — forced transitions must be visibly marked, and state patches must
// emit a state_patched event. Static evidence over scripts/workflow-state.js (uses checkProvenanceStamps,
// which is generic pattern-count checking despite the name).
const DECISION_LOG_HARDENING_SITES = [
  { file: 'scripts/workflow-state.js', pattern: /forced:\s*!!change\.force/, min: 1, label: 'transitionStage logs forced:<bool> explicitly (never silently omitted)' },
  { file: 'scripts/workflow-state.js', pattern: /event_type:\s*'state_patched'/, min: 1, label: 'updateWorkflowState emits a state_patched decision-log event' }
];
// PR13/W13: scope-fence must exist and stay local-only (no network/model client imports). Purely
// static — a text scan, not a real dependency-graph analysis; a narrow, evidence-based tripwire.
const NETWORK_MODULE_RE = /require\(\s*['"](https?|net|tls|dgram|dns)['"]\s*\)|\bfetch\s*\(|\baxios\b|\bXMLHttpRequest\b/;
function checkScopeFenceLocalOnly(source) {
  if (typeof source !== 'string') return { ok: false, evidence: 'scripts/scope-fence.js not found' };
  const networkHit = source.match(NETWORK_MODULE_RE);
  if (networkHit) return { ok: false, evidence: `network/model-ish reference found: ${JSON.stringify(networkHit[0])}` };
  return { ok: true, evidence: 'no network/model client references found in scripts/scope-fence.js' };
}

// ---------------------------------------------------------------------------
// Pure check functions — no fs/git access. Each takes already-gathered data (or an injected
// accessor) so --self-test can exercise them hermetically without touching the real repo.
// ---------------------------------------------------------------------------

function evaluateRegistry(reg, contractExistsFn) {
  const errors = [];
  const counts = { total: 0, inventoried: 0, contract_drafted: 0, wired: 0, verified: 0 };
  if (!reg || typeof reg !== 'object' || !Array.isArray(reg.components)) {
    return { ok: false, counts, errors: ['registry: not an object with a components[] array'] };
  }
  const seenIds = new Set();
  for (const c of reg.components) {
    counts.total++;
    if (!c || typeof c !== 'object') { errors.push('registry: non-object entry in components[]'); continue; }
    for (const f of ['component_id', 'contract', 'executor', 'work_state']) {
      if (typeof c[f] !== 'string' || !c[f]) errors.push(`registry: component missing/empty field "${f}" (id=${c.component_id || '?'})`);
    }
    if (c.component_id) {
      if (seenIds.has(c.component_id)) errors.push(`registry: duplicate component_id "${c.component_id}"`);
      seenIds.add(c.component_id);
    }
    if (typeof c.work_state === 'string') {
      if (!ALLOWED_WORK_STATES.includes(c.work_state)) errors.push(`registry: illegal work_state "${c.work_state}" (id=${c.component_id || '?'})`);
      else counts[c.work_state]++;
    }
    if (typeof c.contract === 'string' && c.contract) {
      if (!contractExistsFn(c.contract)) errors.push(`registry: referenced contract file missing: ${c.contract} (id=${c.component_id || '?'})`);
    }
  }
  return { ok: errors.length === 0, counts, errors };
}

// Returns the sorted unique list of contract paths a registry references (for the conformity check).
function registryContractPaths(reg) {
  const set = new Set();
  for (const c of (reg && reg.components) || []) if (c && typeof c.contract === 'string' && c.contract) set.add(c.contract);
  return Array.from(set).sort();
}

// readContractFn(contractPath) -> { exists, nonEmpty, hasSection } | { exists:false }
function evaluateContracts(contractPaths, readContractFn) {
  const errors = [];
  for (const p of contractPaths) {
    const r = readContractFn(p) || { exists: false };
    if (!r.exists) { errors.push(`contract missing: ${p}`); continue; }
    if (!r.nonEmpty) { errors.push(`contract empty: ${p}`); continue; }
    if (!r.hasSection) { errors.push(`contract has no numbered section heading (## N.): ${p}`); continue; }
  }
  return { ok: errors.length === 0, errors, checked: contractPaths.length };
}

function evaluateStagedFiles(stagedFiles) {
  const hits = [];
  for (const f of stagedFiles || []) {
    const norm = String(f).replace(/\\/g, '/');
    if (FORBIDDEN_STAGED_PATTERNS.some(re => re.test(norm))) hits.push(norm);
  }
  return { ok: hits.length === 0, hits };
}

// fileMap: { relPath: content }. Flags a real `transitionStage(...)` call whose `to:` target is
// literally 'repair_loop'/"repair_loop" on the same line, in a file whose enclosing top-level
// `function name(...) {` is not in RAW_REPAIR_LOOP_ALLOWLIST. Deliberately narrow: matching only
// the literal `to:` target (not any line merely mentioning "repair_loop", e.g. in a reason string
// or comment) avoids noise from legitimate neighbors like escalation's `reason` text.
const RAW_REPAIR_LOOP_TARGET_RE = /to:\s*['"]repair_loop['"]/;
function scanRawRepairLoopBypass(fileMap) {
  const hits = [];
  for (const [relPath, content] of Object.entries(fileMap || {})) {
    const lines = content.split(/\r?\n/);
    let currentFn = null;
    for (let i = 0; i < lines.length; i++) {
      const fnMatch = lines[i].match(/^function\s+(\w+)\s*\(/);
      if (fnMatch) currentFn = fnMatch[1];
      const line = lines[i];
      if (line.includes('transitionStage(') && RAW_REPAIR_LOOP_TARGET_RE.test(line)) {
        if (!RAW_REPAIR_LOOP_ALLOWLIST.includes(currentFn)) {
          hits.push({ file: relPath, line: i + 1, text: line.trim(), enclosing_function: currentFn || '(unknown/top-level)' });
        }
      }
    }
  }
  return { ok: hits.length === 0, hits };
}

// Extracts the `if (args['<flag>']) { ... }` block by brace-counting from the first `{` after the
// `if (args['<flag>'])` match, then checks for any of the allowed delegate names inside it.
function findFlagBlock(source, flag) {
  const marker = `args['${flag}']`;
  const idx = source.indexOf(marker);
  if (idx === -1) return null;
  const braceStart = source.indexOf('{', idx);
  if (braceStart === -1) return null;
  let depth = 0, end = -1;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  return source.slice(braceStart, end + 1);
}

// sourcesByFile: { relPath: content }. Pure — counts pattern occurrences per stamping site.
function checkProvenanceStamps(sourcesByFile, sites) {
  const findings = [];
  for (const site of sites) {
    const src = sourcesByFile[site.file];
    if (typeof src !== 'string') { findings.push({ site: site.label, ok: false, evidence: `cannot read ${site.file}` }); continue; }
    const re = new RegExp(site.pattern.source, site.pattern.flags.includes('g') ? site.pattern.flags : site.pattern.flags + 'g');
    const count = (src.match(re) || []).length;
    findings.push({ site: site.label, ok: count >= site.min, evidence: `found ${count} occurrence(s) in ${site.file} (need >= ${site.min})` });
  }
  return { ok: findings.every(f => f.ok), findings };
}

// REVIEW-INDEPENDENCE-1: coreFiles = { relPath: content } for every file under core/. Fails if any
// forbidden pattern (a raw Claude hook payload field) appears in ANY core file.
function checkCoreAdapterSeparation(coreFiles, forbiddenPatterns) {
  const findings = [];
  for (const [file, src] of Object.entries(coreFiles)) {
    if (typeof src !== 'string') { findings.push({ file, ok: false, evidence: `cannot read ${file}` }); continue; }
    const hits = forbiddenPatterns.filter(p => p.test(src));
    findings.push({
      file, ok: hits.length === 0,
      evidence: hits.length ? `forbidden Claude-specific pattern(s) found in core/: ${hits.map(h => h.source).join(', ')}` : 'clean'
    });
  }
  return { ok: findings.every(f => f.ok), findings };
}

// source: the file content to check. Requires BOTH patterns present AND the guard's use-pattern to
// appear BEFORE the spawn pattern (textual order — proxy for "runs before, in the same function").
function checkPlanLintGuard(source, site) {
  if (typeof source !== 'string') return { ok: false, evidence: `cannot read ${site.file}` };
  const useIdx = source.search(site.usesPattern);
  const spawnIdx = source.search(site.spawnPattern);
  if (useIdx === -1) return { ok: false, evidence: `no lintPlanForRun( call found in ${site.file}` };
  if (spawnIdx === -1) return { ok: false, evidence: `no codex spawn site (pattern ${site.spawnPattern}) found in ${site.file}` };
  if (useIdx >= spawnIdx) return { ok: false, evidence: `lintPlanForRun( appears AFTER the codex spawn site in ${site.file} — guard not ordered before spawn` };
  return { ok: true, evidence: `lintPlanForRun( at offset ${useIdx} precedes codex spawn site at offset ${spawnIdx} in ${site.file}` };
}

function checkDisabledHonesty(harnessLoopSource, targets) {
  const findings = [];
  for (const [flag, delegates] of Object.entries(targets)) {
    const block = findFlagBlock(harnessLoopSource, flag);
    if (block === null) { findings.push({ flag, ok: false, evidence: 'branch not found in source' }); continue; }
    const matched = delegates.find(d => block.includes(d + '('));
    findings.push({ flag, ok: !!matched, evidence: matched ? `calls ${matched}(...)` : `none of [${delegates.join(', ')}] found in branch block` });
  }
  return { ok: findings.every(f => f.ok), findings };
}

// ---------------------------------------------------------------------------
// Real-repo accessors — the only functions that touch fs/git for the actual harness tree.
// ---------------------------------------------------------------------------

function realSelfTests(root) {
  const results = [];
  for (const mod of SELF_TEST_MODULES) {
    const file = path.join(root, 'scripts', mod);
    if (!fs.existsSync(file)) { results.push({ module: mod, ok: false, detail: 'missing module' }); continue; }
    try {
      execFileSync(process.execPath, [file, '--self-test'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
      results.push({ module: mod, ok: true });
    } catch (e) {
      const code = (e && typeof e.status === 'number') ? e.status : null;
      results.push({ module: mod, ok: false, exit: code, detail: String((e && e.message) || '').slice(0, 200) });
    }
  }
  return { ok: results.every(r => r.ok), results };
}

function realRegistryEval(root) {
  const regPath = path.join(root, 'config', 'loop-components.json');
  let reg = null;
  try { reg = JSON.parse(fs.readFileSync(regPath, 'utf8')); }
  catch (e) { return { evalResult: { ok: false, counts: { total: 0, inventoried: 0, contract_drafted: 0, wired: 0, verified: 0 }, errors: ['registry: cannot read/parse ' + regPath + ': ' + String(e.message || e)] }, reg: null }; }
  const evalResult = evaluateRegistry(reg, (contractRel) => fs.existsSync(path.join(root, contractRel)));
  return { evalResult, reg };
}

function realContractsEval(root, contractPaths) {
  return evaluateContracts(contractPaths, (p) => {
    const full = path.join(root, p);
    if (!fs.existsSync(full)) return { exists: false };
    const content = fs.readFileSync(full, 'utf8');
    return { exists: true, nonEmpty: content.trim().length > 0, hasSection: /^##\s*\d+\./m.test(content) };
  });
}

function realStagedFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}

function listJsFilesRecursive(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsFilesRecursive(full));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function realRawBypassScan(root) {
  const scriptsDir = path.join(root, 'scripts');
  // preflight.js itself is excluded: its own comments/docstrings/self-test fixtures necessarily
  // contain the literal search pattern as EXAMPLES (not real transitions), which would otherwise
  // make this tripwire permanently noisy against its own source.
  const files = listJsFilesRecursive(scriptsDir).filter(f => path.basename(f) !== 'preflight.js');
  const fileMap = {};
  for (const f of files) {
    try { fileMap[path.relative(root, f).replace(/\\/g, '/')] = fs.readFileSync(f, 'utf8'); } catch { /* unreadable file: skip, not a bypass */ }
  }
  return scanRawRepairLoopBypass(fileMap);
}

function realProvenanceStamps(root) {
  const sources = {};
  for (const site of PROVENANCE_STAMP_SITES) {
    if (sources[site.file] !== undefined) continue;
    try { sources[site.file] = fs.readFileSync(path.join(root, site.file), 'utf8'); } catch { sources[site.file] = null; }
  }
  return checkProvenanceStamps(sources, PROVENANCE_STAMP_SITES);
}

function realReviewIndependenceStamps(root) {
  const sources = {};
  for (const site of REVIEW_INDEPENDENCE_STAMP_SITES) {
    if (sources[site.file] !== undefined) continue;
    try { sources[site.file] = fs.readFileSync(path.join(root, site.file), 'utf8'); } catch { sources[site.file] = null; }
  }
  return checkProvenanceStamps(sources, REVIEW_INDEPENDENCE_STAMP_SITES);
}

function realCoreAdapterSeparation(root) {
  const dir = path.join(root, CORE_ADAPTER_SEPARATION.coreDir);
  const files = {};
  try {
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
      const rel = path.join(CORE_ADAPTER_SEPARATION.coreDir, f).replace(/\\/g, '/');
      try { files[rel] = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { files[rel] = null; }
    }
  } catch { /* directory missing -> checkCoreAdapterSeparation reports per-file read failures as empty set, ok:true trivially; guarded by min-file-count below */ }
  if (Object.keys(files).length === 0) return { ok: false, findings: [{ file: CORE_ADAPTER_SEPARATION.coreDir, ok: false, evidence: 'no core/*.js files found -- cannot verify separation' }] };
  return checkCoreAdapterSeparation(files, CORE_ADAPTER_SEPARATION.forbiddenPatterns);
}

function realDecisionLogHardening(root) {
  const sources = {};
  for (const site of DECISION_LOG_HARDENING_SITES) {
    if (sources[site.file] !== undefined) continue;
    try { sources[site.file] = fs.readFileSync(path.join(root, site.file), 'utf8'); } catch { sources[site.file] = null; }
  }
  return checkProvenanceStamps(sources, DECISION_LOG_HARDENING_SITES);
}

function realScopeFenceLocalOnly(root) {
  let src = null;
  try { src = fs.readFileSync(path.join(root, 'scripts', 'scope-fence.js'), 'utf8'); } catch { /* checkScopeFenceLocalOnly handles null */ }
  return checkScopeFenceLocalOnly(src);
}

function realPlanLintGuard(root) {
  let src = null;
  try { src = fs.readFileSync(path.join(root, PLAN_LINT_GUARD_SITE.file), 'utf8'); } catch { /* checkPlanLintGuard handles null */ }
  return checkPlanLintGuard(src, PLAN_LINT_GUARD_SITE);
}

function realDisabledHonesty(root) {
  const f = path.join(root, 'scripts', 'harness-loop.js');
  let src = '';
  try { src = fs.readFileSync(f, 'utf8'); } catch { return { ok: false, findings: [{ flag: '(file)', ok: false, evidence: 'cannot read scripts/harness-loop.js' }] }; }
  return checkDisabledHonesty(src, DISABLED_CHECK_TARGETS);
}

// ---------------------------------------------------------------------------
// Orchestrator. opts.stagedFiles, when provided, is used INSTEAD of a real git call — the only
// injection seam, used by --self-test so no real git/staging state is touched.
// ---------------------------------------------------------------------------
function runPreflight(opts = {}) {
  const root = opts.root || harnessRoot();
  const checks = [];
  const A = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });

  const st = realSelfTests(root);
  A('self-test:workflow-state.js', st.results.find(r => r.module === 'workflow-state.js')?.ok, st.results.find(r => r.module === 'workflow-state.js'));
  A('self-test:loop-conductor.js', st.results.find(r => r.module === 'loop-conductor.js')?.ok, st.results.find(r => r.module === 'loop-conductor.js'));
  A('self-test:harness-loop.js', st.results.find(r => r.module === 'harness-loop.js')?.ok, st.results.find(r => r.module === 'harness-loop.js'));

  const { evalResult: regEval, reg } = realRegistryEval(root);
  A('registry:invariants', regEval.ok, regEval.errors);

  const contractPaths = registryContractPaths(reg);
  const contractsEval = realContractsEval(root, contractPaths);
  A('contracts:conformity', contractsEval.ok, contractsEval.errors);

  const stagedFiles = Array.isArray(opts.stagedFiles) ? opts.stagedFiles : realStagedFiles(root);
  const stagedEval = evaluateStagedFiles(stagedFiles);
  A('staging:forbidden-files', stagedEval.ok, stagedEval.hits);

  const bypassEval = realRawBypassScan(root);
  A('tripwire:raw-repair-loop-bypass', bypassEval.ok, bypassEval.hits);

  const disabledEval = realDisabledHonesty(root);
  A('honesty:disabled-check-coverage', disabledEval.ok, disabledEval.findings);

  const provenanceEval = realProvenanceStamps(root);
  A('provenance:stamping-sites', provenanceEval.ok, provenanceEval.findings);

  const riProvenanceEval = realReviewIndependenceStamps(root);
  A('review-independence:stamping-sites', riProvenanceEval.ok, riProvenanceEval.findings);

  const riSeparationEval = realCoreAdapterSeparation(root);
  A('review-independence:core-adapter-separation', riSeparationEval.ok, riSeparationEval.findings);

  const planLintEval = realPlanLintGuard(root);
  A('guard:plan-lint-before-codex-spawn', planLintEval.ok, planLintEval.evidence);

  const decisionLogEval = realDecisionLogHardening(root);
  A('hardening:decision-log-forced-and-patched', decisionLogEval.ok, decisionLogEval.findings);

  const scopeFenceEval = realScopeFenceLocalOnly(root);
  A('local-only:scope-fence', scopeFenceEval.ok, scopeFenceEval.evidence);

  const failures = checks.filter(c => !c.ok).map(c => ({ check: c.name, detail: c.detail }));
  const summary = {
    ok: failures.length === 0,
    checks_total: checks.length,
    checks_passed: checks.length - failures.length,
    checks_failed: failures.length,
    failures,
    counts: regEval.counts,
    staged_forbidden_files: stagedEval.hits,
    raw_repair_loop_hits: bypassEval.hits,
    disabled_check_findings: disabledEval.findings,
    provenance_stamp_findings: provenanceEval.findings,
    plan_lint_guard_evidence: planLintEval.evidence,
    decision_log_hardening_findings: decisionLogEval.findings,
    scope_fence_local_only_evidence: scopeFenceEval.evidence
  };
  return { checks, summary };
}

function printResults(checks, summary) {
  for (const c of checks) process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n`);
  process.stdout.write(summary.ok ? 'preflight: ALL PASS\n' : 'preflight: FAILURES\n');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// --self-test: hermetic. Temp fixture root for the full-pipeline case; pure-function unit checks
// for the rest. Never touches the real repo, never runs real git, never spawns Codex/network.
// ---------------------------------------------------------------------------
function selfTest() {
  const os = require('os');
  const results = [];
  const A = (n, c) => results.push([n, !!c]);
  let tmpRoot = null;
  try {
    // Case 1: clean synthetic repo state -> full runPreflight PASS.
    tmpRoot = path.join(os.tmpdir(), 'hk-preflight-selftest-' + process.pid);
    const scriptsDir = path.join(tmpRoot, 'scripts');
    const contractsDir = path.join(tmpRoot, 'docs', 'contracts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(contractsDir, { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
    for (const mod of SELF_TEST_MODULES) {
      fs.writeFileSync(path.join(scriptsDir, mod), "if (process.argv.includes('--self-test')) process.exit(0);\n");
    }
    // W12: fixture workflow-state.js carries the hardening patterns so hardening:decision-log-forced-
    // and-patched passes on the clean synthetic repo.
    fs.writeFileSync(path.join(scriptsDir, 'workflow-state.js'),
      "if (process.argv.includes('--self-test')) process.exit(0);\n" +
      "// fixture hardening sites:\n" +
      "// forced: !!change.force\n" +
      "// event_type: 'state_patched'\n");
    // Fixture conductor carries the W9 stamp patterns so provenance:stamping-sites passes on the
    // clean synthetic repo (mirrors the real stamping sites).
    fs.writeFileSync(path.join(scriptsDir, 'loop-conductor.js'),
      "if (process.argv.includes('--self-test')) process.exit(0);\n" +
      "// fixture stamp sites:\n" +
      "// provenance: 'live_codex'\n" +
      "// provenance: 'deterministic_internal'\n" +
      "// provenance: 'deterministic_internal'\n" +
      "// provenance: 'deterministic_internal'\n" +
      "// reviewer: 'qa_evals'\n" +
      "// fixture plan-lint guard ordering: lintPlanForRun( runs before the spawn.\n" +
      "// lintPlanForRun(runId, opts);\n" +
      "// command: resolved.command\n");
    // PR13/W13: fixture scope-fence.js — clean, local-only (no network references).
    fs.writeFileSync(path.join(scriptsDir, 'scope-fence.js'), "if (process.argv.includes('--self-test')) process.exit(0);\nmodule.exports = {};\n");
    fs.writeFileSync(path.join(scriptsDir, 'harness-loop.js'),
      "if (process.argv.includes('--self-test')) process.exit(0);\n" +
      "if (args['run-codex']) { isDisabled(); }\n" +
      "if (args['check-codex-timeout-retry']) { conductor.runWithTimeoutRetry(); }\n" +
      "if (args['run-qa-self-tests']) { conductor.runQaSelfTests(); }\n" +
      "if (args['run-ponytail-budget']) { conductor.runPonytailBudget(); }\n" +
      "if (args['enter-repair-loop']) { conductor.enterRepairLoop(); }\n" +
      "if (args['check-max-repair-loops']) { conductor.checkMaxRepairLoops(); }\n" +
      "if (args['run-qa-evals']) { isDisabled(); conductor.runQaEvals(); }\n" +
      "// fixture stamp site: verdict = stampProvenance(verdict, 'cli_human');\n");
    fs.writeFileSync(path.join(contractsDir, 'fixture.md'), '# fixture\n\n## 1. Purpose\nok\n');
    fs.writeFileSync(path.join(tmpRoot, 'config', 'loop-components.json'), JSON.stringify({
      components: [{ component_id: 'fixture_component', contract: 'docs/contracts/fixture.md', executor: 'node:fixture.js', work_state: 'wired' }]
    }));
    // REVIEW-INDEPENDENCE-1: fixture files carrying the hardcoded-literal patterns so
    // review-independence:stamping-sites passes on the clean synthetic repo (mirrors the W9
    // provenance-stamp fixture above), plus a clean core/ dir so core-adapter-separation passes.
    fs.writeFileSync(path.join(scriptsDir, 'stamp-producer.js'),
      "if (process.argv.includes('--self-test')) process.exit(0);\n// fixture: adapterId: 'claude-code', providerId: 'anthropic',\n");
    const riAdaptersDir = path.join(scriptsDir, 'review-independence', 'adapters');
    const riCoreDir = path.join(scriptsDir, 'review-independence', 'core');
    fs.mkdirSync(riAdaptersDir, { recursive: true });
    fs.mkdirSync(riCoreDir, { recursive: true });
    fs.writeFileSync(path.join(riAdaptersDir, 'cli-stamp.js'), "// fixture: adapter_id: 'human',\n");
    fs.writeFileSync(path.join(riAdaptersDir, 'claude-code-hooks.js'), "// fixture: adapter_id: 'claude-code',\n");
    fs.writeFileSync(path.join(riCoreDir, 'fixture-core.js'), "// clean core fixture -- no Claude-specific payload field references\nmodule.exports = {};\n");
    const clean = runPreflight({ root: tmpRoot, stagedFiles: [] });
    A('case1: clean synthetic repo -> PASS', clean.summary.ok === true && clean.summary.checks_failed === 0);

    // Case 2: bad registry with illegal work_state -> FAIL.
    const badReg = { components: [{ component_id: 'x', contract: 'docs/contracts/fixture.md', executor: 'node:x', work_state: 'bogus_state' }] };
    const case2 = evaluateRegistry(badReg, () => true);
    A('case2: illegal work_state -> FAIL', case2.ok === false && case2.errors.some(e => /illegal work_state/.test(e)));

    // Case 3: simulated forbidden staged file list -> FAIL.
    const case3 = evaluateStagedFiles(['config/capability-registry.json', 'runs/some-run/workflow-state.json', 'src/ok.js']);
    A('case3: forbidden staged files -> FAIL', case3.ok === false && case3.hits.length === 2);

    // Case 3b (P2 capability-inventory supersession): config/capability-inventory.json staged
    // alongside its still-held predecessor -> only the held file is flagged. Proves the decision
    // to leave the new inventory file OUT of FORBIDDEN_STAGED_PATTERNS was deliberate (the new
    // file is machine-verified/agent-buildable, unlike the held registry it supersedes), not an
    // oversight that would silently start blocking commits of the new inventory.
    const case3b = evaluateStagedFiles(['config/capability-inventory.json', 'config/capability-registry.json']);
    A('case3b: new capability-inventory.json staged is NOT forbidden, its held predecessor still is', case3b.ok === false && case3b.hits.length === 1 && case3b.hits[0] === 'config/capability-registry.json');

    // Case 4: missing referenced contract file -> FAIL.
    const case4 = evaluateContracts(['docs/contracts/missing.md'], () => ({ exists: false }));
    A('case4: missing contract -> FAIL', case4.ok === false && case4.errors.some(e => /missing/.test(e)));

    // Case 5: raw transitionStage(...to:'repair_loop'...) outside allowlist -> FAIL.
    const badFileMap = {
      'scripts/bad.js': "function suspiciousCaller(runId, opts) {\n  const tr = wstate.transitionStage(runId, { to: 'repair_loop', reason: 'oops' }, opts);\n  return tr;\n}\n",
      'scripts/ok.js': "function enterRepairLoop(runId, opts) {\n  const tr = wstate.transitionStage(runId, { to: 'repair_loop', reason }, opts);\n  return tr;\n}\n"
    };
    const case5 = scanRawRepairLoopBypass(badFileMap);
    A('case5: raw repair_loop bypass outside allowlist -> FAIL', case5.ok === false && case5.hits.length === 1 && case5.hits[0].file === 'scripts/bad.js' && case5.hits[0].enclosing_function === 'suspiciousCaller');

    // Case 6: output summary shape is valid JSON-compatible.
    const roundTrip = JSON.parse(JSON.stringify(clean.summary));
    A('case6: summary JSON round-trips with required keys', ['ok', 'checks_total', 'checks_passed', 'checks_failed', 'failures', 'counts', 'staged_forbidden_files', 'raw_repair_loop_hits', 'disabled_check_findings', 'provenance_stamp_findings', 'plan_lint_guard_evidence', 'decision_log_hardening_findings', 'scope_fence_local_only_evidence'].every(k => k in roundTrip));

    // Case 8 (W9): provenance stamping-sites — missing stamps fail with evidence; present stamps pass.
    const goodSrc = { 'scripts/loop-conductor.js': "provenance: 'live_codex'\nprovenance: 'deterministic_internal'\nprovenance: 'deterministic_internal'\nprovenance: 'deterministic_internal'\nreviewer: 'qa_evals'\n", 'scripts/harness-loop.js': "verdict = stampProvenance(verdict, 'cli_human');\n" };
    const badSrc = { 'scripts/loop-conductor.js': "provenance: 'deterministic_internal'\n", 'scripts/harness-loop.js': 'no stamp here\n' };
    const provGood = checkProvenanceStamps(goodSrc, PROVENANCE_STAMP_SITES);
    const provBad = checkProvenanceStamps(badSrc, PROVENANCE_STAMP_SITES);
    A('case8: provenance stamps present -> PASS; missing -> FAIL with per-site evidence', provGood.ok === true && provBad.ok === false && provBad.findings.filter(f => !f.ok).length === 4);

    // Case 9 (W10): plan-lint guard ordering — lint call before spawn -> PASS; after/missing -> FAIL.
    const orderedOk = checkPlanLintGuard("function runCodexReview() {\n  lintPlanForRun(runId, opts);\n  command: resolved.command\n}\n", PLAN_LINT_GUARD_SITE);
    const orderedBad = checkPlanLintGuard("function runCodexReview() {\n  command: resolved.command\n  lintPlanForRun(runId, opts);\n}\n", PLAN_LINT_GUARD_SITE);
    const missingGuard = checkPlanLintGuard("function runCodexReview() {\n  command: resolved.command\n}\n", PLAN_LINT_GUARD_SITE);
    A('case9: plan-lint guard before spawn -> PASS; after spawn -> FAIL; missing -> FAIL', orderedOk.ok === true && orderedBad.ok === false && missingGuard.ok === false);

    // Case 10 (W12): decision-log hardening sites — forced-marker + state_patched presence/absence.
    const dlGoodSrc = { 'scripts/workflow-state.js': "forced: !!change.force\nevent_type: 'state_patched'\n" };
    const dlBadSrc = { 'scripts/workflow-state.js': 'nothing relevant here\n' };
    const dlGood = checkProvenanceStamps(dlGoodSrc, DECISION_LOG_HARDENING_SITES);
    const dlBad = checkProvenanceStamps(dlBadSrc, DECISION_LOG_HARDENING_SITES);
    A('case10: decision-log hardening sites present -> PASS; missing -> FAIL with per-site evidence', dlGood.ok === true && dlBad.ok === false && dlBad.findings.filter(f => !f.ok).length === 2);

    // Case 11 (PR13/W13): scope-fence must exist and stay local-only.
    const sfClean = checkScopeFenceLocalOnly("module.exports = { runScopeFence };\n");
    const sfNetwork = checkScopeFenceLocalOnly("const axios = require('http');\nmodule.exports = {};\n");
    const sfMissing = checkScopeFenceLocalOnly(null);
    A('case11: scope-fence local-only check: clean -> PASS; network reference -> FAIL; missing file -> FAIL', sfClean.ok === true && sfNetwork.ok === false && sfMissing.ok === false);

    // Case 12 (REVIEW-INDEPENDENCE-1): review-independence stamping-sites — missing hardcoded
    // literal fails with evidence; present literal passes.
    const riGoodSrc = { 'scripts/stamp-producer.js': "adapterId: 'claude-code', providerId: 'anthropic'\n" };
    const riBadSrc = { 'scripts/stamp-producer.js': 'no hardcoded literal here\n' };
    const riGoodSite = [REVIEW_INDEPENDENCE_STAMP_SITES[0]];
    const riProvGood = checkProvenanceStamps(riGoodSrc, riGoodSite);
    const riProvBad = checkProvenanceStamps(riBadSrc, riGoodSite);
    A('case12: review-independence stamp present -> PASS; missing -> FAIL', riProvGood.ok === true && riProvBad.ok === false);

    // Case 13 (REVIEW-INDEPENDENCE-1): core/adapter separation — a core file referencing a raw
    // Claude hook field name (hook_event_name, .agent_id) fails; a clean core file passes.
    const cleanCore = { 'scripts/review-independence/core/evaluator.js': 'function evaluate(dispatch_id, execution_id) { return dispatch_id !== execution_id; }\n' };
    const dirtyCore = { 'scripts/review-independence/core/evaluator.js': 'function evaluate(payload) { return payload.hook_event_name === "SubagentStart" && payload.agent_id; }\n' };
    const sepClean = checkCoreAdapterSeparation(cleanCore, CORE_ADAPTER_SEPARATION.forbiddenPatterns);
    const sepDirty = checkCoreAdapterSeparation(dirtyCore, CORE_ADAPTER_SEPARATION.forbiddenPatterns);
    A('case13: core/adapter separation clean -> PASS; Claude-specific field leak -> FAIL', sepClean.ok === true && sepDirty.ok === false);

    // Case 7: real repo preflight function callable, no throw, no live Codex/network — smoke only,
    // does not assert pass/fail (real tree state is out of this test's control).
    let realOk = true, realShapeOk = false;
    try {
      const real = runPreflight({ root: harnessRoot() });
      realShapeOk = typeof real.summary.ok === 'boolean' && Array.isArray(real.checks);
    } catch (e) { realOk = false; }
    A('case7: real-repo preflight callable without throwing, valid shape', realOk && realShapeOk);
  } catch (e) {
    results.push(['exception: ' + (e && e.message), false]);
  } finally {
    if (tmpRoot) try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
  let pass = true;
  for (const [n, ok] of results) { process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${n}\n`); if (!ok) pass = false; }
  process.stdout.write(pass ? 'self-test: ALL PASS\n' : 'self-test: FAILURES\n');
  return pass;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['self-test']) process.exit(selfTest() ? 0 : 1);
  if (args.root === true) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --root <dir>' }) + '\n'); process.exit(2); }
  const root = (args.root && args.root !== true) ? String(args.root) : harnessRoot();
  const { checks, summary } = runPreflight({ root });
  printResults(checks, summary);
  process.exit(summary.ok ? 0 : 1);
}

module.exports = { evaluateRegistry, registryContractPaths, evaluateContracts, evaluateStagedFiles, scanRawRepairLoopBypass, checkDisabledHonesty, checkProvenanceStamps, checkPlanLintGuard, checkScopeFenceLocalOnly, runPreflight };

if (require.main === module) main();
