#!/usr/bin/env node
// inspect-repo.js — HarnessKit Productization Phase 1: generic, read-only repository forensics-
// lite for an ARBITRARY target repo. Zero product-specific logic — nothing here knows about ART,
// a downstream project, or any specific project. Every fact is tagged with its source and a confidence level;
// nothing is asserted without real evidence (a file that exists, a section that was actually
// parsed). An unknown stack is reported honestly (`stack.language: 'unknown'`), never guessed.
//
//   node scripts/inspect-repo.js --target <path> --out <dir>
//
// Writes, into --out (defaults to <target>/.harnesskit/):
//   repo-profile.json        -- stack, package manager, commands, CI, doc precedence, git state
//   repo-facts.json          -- flat {fact, value, source, confidence}[] list
//   repo-risk-report.json    -- real sensitive-path matches (not just candidate globs)
//   repo-knowledge-index.json -- lean structured index combining the above for quick lookup
//
// Derived indexes never replace canonical repository files -- they are HarnessKit's own working
// notes, written under .harnesskit/, not edits to the target repo's own content.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseArgs, nowIso } = require('./_lib.js');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__', '.harnesskit', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache']);
const SENSITIVE_GLOBS = [
  { glob: '.env*', trigger: 'env_secrets' },
  { glob: '**/credentials*', trigger: 'env_secrets' },
  { glob: '**/*.key', trigger: 'env_secrets' },
  { glob: '**/*.pem', trigger: 'env_secrets' },
  { glob: '**/migrations/**', trigger: 'db_migration' }
];

function walk(dir, depth, maxDepth, out) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && !['.github', '.harnesskit'].includes(e.name) && e.isDirectory()) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1, maxDepth, out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
}

function readTextSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function existsSafe(p) { try { return fs.existsSync(p); } catch { return false; } }

// --- Stack + package-root detection (supports monorepo/workspace nesting, bounded depth) ---
function findPackageRoots(targetPath) {
  const allFiles = [];
  walk(targetPath, 0, 4, allFiles);
  const roots = [];
  for (const f of allFiles) {
    const base = path.basename(f);
    if (base === 'pyproject.toml') roots.push({ dir: path.dirname(f), kind: 'python', manifest: f });
    else if (base === 'package.json' && !f.includes(`${path.sep}node_modules${path.sep}`)) roots.push({ dir: path.dirname(f), kind: 'node', manifest: f });
  }
  return roots;
}

function detectPython(root, facts) {
  const content = readTextSafe(root.manifest) || '';
  const commands = {};
  const hasUvLock = existsSafe(path.join(root.dir, 'uv.lock'));
  const runner = hasUvLock ? 'uv run ' : '';
  facts.push({ fact: 'package_manager', value: hasUvLock ? 'uv' : 'pip', source: hasUvLock ? 'uv.lock present' : 'pyproject.toml without uv.lock', confidence: hasUvLock ? 'high' : 'medium' });

  const hasPytestSection = /\[tool\.pytest/.test(content) || existsSafe(path.join(root.dir, 'pytest.ini'));
  if (hasPytestSection) commands.test = { command: `${runner}pytest`, source: '[tool.pytest] in pyproject.toml (or pytest.ini)', confidence: 'high' };

  const hasRuffSection = /\[tool\.ruff/.test(content);
  if (hasRuffSection) commands.lint = { command: `${runner}ruff check .`, source: '[tool.ruff] in pyproject.toml', confidence: 'high' };

  const hasMypySection = /\[tool\.mypy/.test(content);
  if (hasMypySection) {
    const srcDir = existsSafe(path.join(root.dir, 'src')) ? 'src' : '.';
    commands.typecheck = { command: `${runner}mypy ${srcDir}`, source: `[tool.mypy] in pyproject.toml, target dir detected via ${srcDir === 'src' ? "'src/' directory presence" : 'fallback to repo root (no src/ dir found)'}`, confidence: srcDir === 'src' ? 'high' : 'medium' };
  }
  // "build" for a Python package = the standard wheel build; only claim it if a build backend is declared.
  if (/\[build-system\]/.test(content)) commands.build = { command: `${runner}python -m build`, source: '[build-system] declared in pyproject.toml', confidence: 'medium' };

  return { language: 'python', confidence: 'high', evidence: [`pyproject.toml at ${path.relative(process.cwd(), root.manifest)}`], commands };
}

function detectNode(root, facts) {
  let pkg = null;
  try { pkg = JSON.parse(readTextSafe(root.manifest) || '{}'); } catch { pkg = {}; }
  const scripts = pkg.scripts || {};
  const commands = {};
  for (const [want, key] of [['test', 'test'], ['lint', 'lint'], ['typecheck', 'typecheck'], ['build', 'build']]) {
    if (typeof scripts[key] === 'string') {
      const pm = existsSafe(path.join(root.dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSafe(path.join(root.dir, 'yarn.lock')) ? 'yarn' : 'npm';
      commands[want] = { command: `${pm} run ${key}`, source: `package.json scripts.${key}`, confidence: 'high' };
    }
  }
  facts.push({ fact: 'package_manager', value: existsSafe(path.join(root.dir, 'pnpm-lock.yaml')) ? 'pnpm' : existsSafe(path.join(root.dir, 'yarn.lock')) ? 'yarn' : 'npm', source: 'lockfile presence', confidence: 'high' });
  return { language: 'node', confidence: 'high', evidence: [`package.json at ${path.relative(process.cwd(), root.manifest)}`], commands };
}

// --- Doc precedence: parse AGENTS.md's own declared precedence if present, else a generic default ---
function detectDocPrecedence(targetPath, facts) {
  const candidates = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'CONTRIBUTING.md'];
  const present = candidates.filter(f => existsSafe(path.join(targetPath, f)));
  const agentsPath = path.join(targetPath, 'AGENTS.md');
  const agentsContent = readTextSafe(agentsPath);
  if (agentsContent) {
    // Look for a numbered list of backtick-quoted filenames near "precedence" language.
    const precedenceSectionMatch = agentsContent.match(/precedence[\s\S]{0,600}/i);
    if (precedenceSectionMatch) {
      const fileMentions = [...precedenceSectionMatch[0].matchAll(/`([A-Za-z0-9_.\-]+\.md)`/g)].map(m => m[1]);
      if (fileMentions.length > 0) {
        facts.push({ fact: 'doc_precedence', value: fileMentions, source: `AGENTS.md's own declared "precedence" section`, confidence: 'high' });
        return fileMentions;
      }
    }
  }
  facts.push({ fact: 'doc_precedence', value: present, source: 'default generic order (AGENTS.md > CLAUDE.md > README.md > CONTRIBUTING.md), filtered to files that exist', confidence: present.length ? 'medium' : 'low' });
  return present;
}

function detectGit(targetPath) {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: targetPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: targetPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
    let remote = null;
    try { remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: targetPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no remote configured */ }
    return { branch, head, dirty, remote };
  } catch {
    return null; // not a git repo yet, or git unavailable -- honest null, not a guess
  }
}

function detectCiWorkflows(targetPath) {
  const dir = path.join(targetPath, '.github', 'workflows');
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml')).map(f => path.join('.github', 'workflows', f)); }
  catch { return []; }
}

function detectSensitivePaths(targetPath) {
  const allFiles = [];
  walk(targetPath, 0, 6, allFiles);
  const hits = [];
  for (const f of allFiles) {
    const rel = path.relative(targetPath, f).replace(/\\/g, '/');
    for (const sp of SENSITIVE_GLOBS) {
      const pattern = sp.glob.replace(/\*\*/g, '.*').replace(/(?<!\.)\*/g, '[^/]*');
      if (new RegExp(`^${pattern}$`).test(rel) || new RegExp(`(^|/)${sp.glob.replace('**/', '').replace(/\*/g, '.*')}$`).test(rel)) {
        hits.push({ path: rel, trigger: sp.trigger });
        break;
      }
    }
  }
  return hits;
}

function inspectRepo(targetPath) {
  const facts = [];
  facts.push({ fact: 'target_path_exists', value: existsSafe(targetPath), source: 'fs.existsSync', confidence: 'high' });
  if (!existsSafe(targetPath)) {
    return {
      profile: { target_path: targetPath, stack: { language: 'unknown', confidence: 'n/a', evidence: ['target path does not exist -- clone required first'] }, generated_at: nowIso() },
      facts, risk: { sensitive_paths: [] }, knowledgeIndex: null
    };
  }

  const packageRoots = findPackageRoots(targetPath);
  facts.push({ fact: 'package_roots_found', value: packageRoots.length, source: 'recursive scan for pyproject.toml/package.json (depth<=4)', confidence: 'high' });

  let stack = { language: 'unknown', confidence: 'low', evidence: ['no pyproject.toml or package.json found within scan depth'], commands: {} };
  let packageRoot = null;
  if (packageRoots.length === 1) {
    packageRoot = packageRoots[0];
    stack = packageRoot.kind === 'python' ? detectPython(packageRoot, facts) : detectNode(packageRoot, facts);
  } else if (packageRoots.length > 1) {
    facts.push({ fact: 'multiple_package_roots', value: packageRoots.map(r => path.relative(targetPath, r.dir)), source: 'recursive scan', confidence: 'high' });
    // Ambiguous by construction -- report all candidates, resolve the primary one honestly as
    // "first found" only when the caller doesn't have more context (task-discovery.js may narrow
    // this further using the discovered active task).
    packageRoot = packageRoots[0];
    stack = packageRoot.kind === 'python' ? detectPython(packageRoot, facts) : detectNode(packageRoot, facts);
    stack.confidence = 'medium';
    stack.evidence.push(`ambiguous: ${packageRoots.length} package roots found, using ${path.relative(targetPath, packageRoot.dir)} as primary (first found, not yet task-scoped)`);
  }

  const docPrecedence = detectDocPrecedence(targetPath, facts);
  const git = detectGit(targetPath);
  facts.push({ fact: 'git_repo', value: !!git, source: 'git rev-parse HEAD', confidence: 'high' });
  const ciWorkflows = detectCiWorkflows(targetPath);
  facts.push({ fact: 'ci_workflows_count', value: ciWorkflows.length, source: '.github/workflows/ listing', confidence: 'high' });
  const sensitiveHits = detectSensitivePaths(targetPath);

  const profile = {
    target_path: targetPath,
    package_root: packageRoot ? path.relative(targetPath, packageRoot.dir) || '.' : null,
    stack,
    commands: stack.commands || {},
    ci_workflows: ciWorkflows,
    doc_precedence: docPrecedence,
    git,
    generated_at: nowIso()
  };
  const risk = { sensitive_paths: sensitiveHits, generated_at: nowIso() };
  const knowledgeIndex = {
    target_path: targetPath, stack_language: stack.language, package_root: profile.package_root,
    doc_precedence: docPrecedence, git_branch: git ? git.branch : null, git_head: git ? git.head : null,
    ci_workflow_count: ciWorkflows.length, sensitive_path_count: sensitiveHits.length,
    generated_at: nowIso()
  };
  return { profile, facts, risk, knowledgeIndex };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  const target = a.target;
  if (!target) { console.log(JSON.stringify({ ok: false, error: '--target <path> required' })); process.exit(1); }
  const outDir = a.out || path.join(target, '.harnesskit');
  const { profile, facts, risk, knowledgeIndex } = inspectRepo(path.resolve(target));
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* may already exist */ }
  fs.writeFileSync(path.join(outDir, 'repo-profile.json'), JSON.stringify(profile, null, 2));
  fs.writeFileSync(path.join(outDir, 'repo-facts.json'), JSON.stringify(facts, null, 2));
  fs.writeFileSync(path.join(outDir, 'repo-risk-report.json'), JSON.stringify(risk, null, 2));
  fs.writeFileSync(path.join(outDir, 'repo-knowledge-index.json'), JSON.stringify(knowledgeIndex, null, 2));
  console.log(JSON.stringify({ ok: true, out_dir: outDir, profile }, null, 2));
  process.exit(0);
}

function selfTest() {
  const os = require('os');
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-inspect-repo-selftest-'));

  try {
    // 1. Python fixture: pyproject.toml with pytest+ruff+mypy sections, src/ dir, uv.lock.
    {
      const proj = path.join(tmpRoot, 'py-proj');
      fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'pyproject.toml'), '[project]\nname="x"\n[tool.pytest.ini_options]\ntestpaths=["tests"]\n[tool.ruff]\nline-length=100\n[tool.mypy]\nstrict=true\n[build-system]\nrequires=["hatchling"]\n');
      fs.writeFileSync(path.join(proj, 'uv.lock'), '');
      const { profile } = inspectRepo(proj);
      push('python_stack_detected', profile.stack.language === 'python', JSON.stringify(profile.stack));
      push('python_test_command_detected', profile.commands.test && profile.commands.test.command === 'uv run pytest', JSON.stringify(profile.commands.test));
      push('python_typecheck_targets_src_dir', profile.commands.typecheck && profile.commands.typecheck.command === 'uv run mypy src', JSON.stringify(profile.commands.typecheck));
    }
    // 2. Node fixture: package.json with real scripts.
    {
      const proj = path.join(tmpRoot, 'node-proj');
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'jest', lint: 'eslint .' } }));
      const { profile } = inspectRepo(proj);
      push('node_stack_detected', profile.stack.language === 'node', JSON.stringify(profile.stack));
      push('node_test_command_from_real_scripts', profile.commands.test && profile.commands.test.command === 'npm run test', JSON.stringify(profile.commands.test));
      push('node_build_not_claimed_when_absent', !profile.commands.build, 'no scripts.build in fixture -> not claimed');
    }
    // 3. Unknown stack: empty dir -> honestly reports unknown, never guesses.
    {
      const proj = path.join(tmpRoot, 'empty-proj');
      fs.mkdirSync(proj, { recursive: true });
      const { profile } = inspectRepo(proj);
      push('unknown_stack_reported_honestly', profile.stack.language === 'unknown', JSON.stringify(profile.stack));
    }
    // 4. Nonexistent target path -> reports the gap, does not crash.
    {
      const { profile } = inspectRepo(path.join(tmpRoot, 'does-not-exist'));
      push('nonexistent_target_reported_not_crashed', profile.stack.evidence[0].includes('clone required'), JSON.stringify(profile));
    }
    // 5. AGENTS.md-declared precedence is parsed when present.
    {
      const proj = path.join(tmpRoot, 'agents-precedence-proj');
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# AGENTS\n\n## Instruction precedence\n\n1. `EXECUTION.md`\n2. `PLAN.md`\n3. `CONTRIBUTING.md`\n');
      const facts = [];
      const precedence = detectDocPrecedence(proj, facts);
      push('agents_md_declared_precedence_parsed', JSON.stringify(precedence) === JSON.stringify(['EXECUTION.md', 'PLAN.md', 'CONTRIBUTING.md']), JSON.stringify(precedence));
    }
    // 6. Sensitive-path detection: a real .env file is flagged.
    {
      const proj = path.join(tmpRoot, 'secrets-proj');
      fs.mkdirSync(proj, { recursive: true });
      fs.writeFileSync(path.join(proj, '.env'), 'SECRET=x\n');
      const { risk } = inspectRepo(proj);
      push('sensitive_env_file_detected', risk.sensitive_paths.some(h => h.path === '.env'), JSON.stringify(risk.sensitive_paths));
    }
    // 7. Multiple package roots reported as ambiguous, not silently resolved.
    {
      const proj = path.join(tmpRoot, 'monorepo-proj');
      fs.mkdirSync(path.join(proj, 'packages', 'a'), { recursive: true });
      fs.mkdirSync(path.join(proj, 'packages', 'b'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'packages', 'a', 'pyproject.toml'), '[project]\nname="a"\n');
      fs.writeFileSync(path.join(proj, 'packages', 'b', 'pyproject.toml'), '[project]\nname="b"\n');
      const { profile, facts } = inspectRepo(proj);
      const multiFact = facts.find(f => f.fact === 'multiple_package_roots');
      push('multiple_package_roots_reported_ambiguous', !!multiFact && multiFact.value.length === 2 && profile.stack.confidence === 'medium', JSON.stringify({ multiFact, confidence: profile.stack.confidence }));
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { inspectRepo, detectDocPrecedence, detectGit, findPackageRoots };
if (require.main === module) main();
