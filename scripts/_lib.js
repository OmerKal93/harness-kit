#!/usr/bin/env node
// Shared helpers for harnesskit scripts. Zero deps.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Canonical harness root resolver (Batch 3-impl seam). HARNESS_ROOT overrides the root for a
// future generic location (e.g. ~/.claude/harness-kit); unset → legacy <harness-root>, so
// existing setups are unchanged.
function harnessRoot() {
  return process.env.HARNESS_ROOT || path.join(os.homedir(), '.harnesskit');
}

// Workspace-location policy (Batch 1 mandatory fix): the durable-clone default must never be
// os.tmpdir() -- a real ART dogfood clone landed there and was one Windows Temp-cleanup away from
// permanently losing an unpushed commit + run evidence, found and fixed during Batch-0 evidence
// gathering. Precedence, in order: explicit --workspace flag (caller-level, not resolved here) >
// HARNESSKIT_WORKSPACE env var > a durable location tied to the harness root (~/.harnesskit or
// HARNESS_ROOT, whichever harnessRoot() resolves to) -- never Temp by default. Temp remains fully
// legitimate for explicitly disposable fixtures/self-tests (which call os.tmpdir() directly, not
// through this function) -- this only changes the DEFAULT for a caller that didn't ask for Temp.
function resolveWorkspace(a) {
  a = a || {};
  if (a.workspace) return a.workspace;
  if (process.env.HARNESSKIT_WORKSPACE) return process.env.HARNESSKIT_WORKSPACE;
  return path.join(harnessRoot(), 'workspace');
}

// True if `p` resolves under the OS temp directory -- used by doctor's workspace-location check
// to warn when an explicit override (env var or flag) still points somewhere volatile.
function isUnderTempDir(p) {
  if (!p) return false;
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  const resolved = path.resolve(String(p)).toLowerCase();
  return resolved === tmp || resolved.startsWith(tmp + path.sep);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[k] = true; }
      else { out[k] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return fallback === undefined ? null : fallback; }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function appendNdjson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}

function readNdjson(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function nowIso() { return new Date().toISOString(); }

// Real shell-word tokenizer (single/double-quote aware) -- naive .split(' ') breaks any detected
// command with a quoted argument (e.g. `python -c "import sys; sys.exit(1)"`), silently letting
// the literal quote characters leak into the argv passed to execFileSync. Shared here (rather than
// living only in execute-workflow.js) so other modules (e.g. verification-classifier.js) can reuse
// it without creating a require cycle back into execute-workflow.js.
function tokenizeCommand(cmdString) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < cmdString.length; i++) {
    const ch = cmdString[i];
    if (quote) {
      if (ch === quote) { quote = null; }
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function slugify(s) {
  return String(s || 'run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'run';
}

function genRunId(prompt) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${ts}-${slugify(prompt)}`;
}

function runDir(runId, root) {
  return path.join(root || harnessRoot(), 'runs', runId);
}

function loadGlobalPolicy() {
  return readJson(path.join(harnessRoot(), 'config', 'global-policy.json'), {});
}

function loadProjectProfile(name) {
  const p = path.join(harnessRoot(), 'config', 'project-profiles', `${name}.json`);
  return readJson(p, null);
}

function detectProjectProfile(cwd) {
  cwd = path.resolve(cwd || process.cwd());
  const profilesDir = path.join(harnessRoot(), 'config', 'project-profiles');
  if (!fs.existsSync(profilesDir)) return null;
  const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json') && f !== 'default.json');
  for (const f of files) {
    const data = readJson(path.join(profilesDir, f), null);
    if (!data || !data.project_root) continue;
    const root = path.resolve(data.project_root);
    if (cwd === root || cwd.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      return { name: path.basename(f, '.json'), data, matched: 'cwd' };
    }
  }
  const def = readJson(path.join(profilesDir, 'default.json'), null);
  if (def) return { name: 'default', data: def, matched: 'fallback' };
  return null;
}

function globToRegex(glob) {
  // Minimal: ** matches anything (including /), * matches anything except /, ? matches one char.
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i+1] === '*') { re += '.*'; i += 2; if (glob[i] === '/') i++; }
    else if (c === '*') { re += '[^/]*'; i++; }
    else if (c === '?') { re += '[^/]'; i++; }
    else if ('.+^${}()|[]\\'.includes(c)) { re += '\\' + c; i++; }
    else { re += c; i++; }
  }
  return new RegExp('^' + re + '$', 'i');
}

function globMatch(glob, p) {
  if (!glob || !p) return false;
  const norm = String(p).replace(/\\/g, '/');
  return globToRegex(glob).test(norm);
}

function gitDiffPaths(repoRoot, ref) {
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'diff', '--name-only', ref || 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}

function ensureRunDir(runId) {
  const d = runDir(runId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function indexRun(runId, state, taskType, confidence, root) {
  const idx = path.join(root || harnessRoot(), 'runs', '.index.ndjson');
  appendNdjson(idx, {
    ts: nowIso(),
    run_id: runId,
    state,
    task_type: taskType || null,
    confidence: confidence == null ? null : Number(confidence.toFixed?.(2) ?? confidence)
  });
}

function listRuns(limit = 25, root) {
  const idx = path.join(root || harnessRoot(), 'runs', '.index.ndjson');
  const all = readNdjson(idx);
  const byId = new Map();
  for (const e of all) byId.set(e.run_id, e); // last-wins = latest state
  const arr = Array.from(byId.values());
  const ranks = { INTAKE: 1, CONTEXT_GATHERING: 1, ROUTING: 1, PLANNING_OR_DEBUGGING: 1, EXECUTION: 1, REVIEW: 1, VERIFICATION: 1, LEARNING: 1, SUSPEND: 2, NEEDS_USER: 3, BLOCKED: 4, DONE: 5, EXPIRED: 5 };
  arr.sort((a, b) => (ranks[a.state] || 9) - (ranks[b.state] || 9) || (b.ts || '').localeCompare(a.ts || ''));
  return arr.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Run lifecycle (run-lifecycle-hygiene-v1 E2): .current-run pointer + TTL.
// resolveCurrentRun() is the single source of truth for "the active run" —
// used by pre_tool_use_guard.js, post_tool_use_ledger.js and resume-run.js.
// ---------------------------------------------------------------------------

// Hardcoded safe fallback. The config block in global-policy.json#run_lifecycle is
// advisory tuning only: it may WIDEN the inactive set or change the TTL, but on any
// read failure / malformed content this fallback applies, and the effective inactive
// set is always the UNION of fallback + config (never narrower than the fallback).
const RUN_LIFECYCLE_FALLBACK = Object.freeze({
  ttl_hours: 24,
  inactive_states: Object.freeze(['DONE', 'BLOCKED', 'NEEDS_USER', 'EXPIRED']),
  pointer_file: 'runs/.current-run'
});

function runLifecyclePolicy(root) {
  try {
    const base = root || harnessRoot();
    const pol = readJson(path.join(base, 'config', 'global-policy.json'), null);
    const rl = pol && pol.run_lifecycle;
    if (!rl || typeof rl !== 'object') {
      return { ttl_hours: RUN_LIFECYCLE_FALLBACK.ttl_hours, inactive_states: [...RUN_LIFECYCLE_FALLBACK.inactive_states], pointer_file: RUN_LIFECYCLE_FALLBACK.pointer_file };
    }
    const ttl = Number(rl.ttl_hours);
    const cfgStates = Array.isArray(rl.inactive_states) ? rl.inactive_states.map(s => String(s)) : [];
    return {
      ttl_hours: Number.isFinite(ttl) && ttl > 0 ? ttl : RUN_LIFECYCLE_FALLBACK.ttl_hours,
      inactive_states: Array.from(new Set([...RUN_LIFECYCLE_FALLBACK.inactive_states, ...cfgStates])),
      pointer_file: typeof rl.pointer_file === 'string' && rl.pointer_file ? rl.pointer_file : RUN_LIFECYCLE_FALLBACK.pointer_file
    };
  } catch {
    return { ttl_hours: RUN_LIFECYCLE_FALLBACK.ttl_hours, inactive_states: [...RUN_LIFECYCLE_FALLBACK.inactive_states], pointer_file: RUN_LIFECYCLE_FALLBACK.pointer_file };
  }
}

function currentRunPointerPath(root) {
  return path.join(root || harnessRoot(), 'runs', '.current-run');
}

function readCurrentRunPointer(root) {
  try {
    const data = readJson(currentRunPointerPath(root), null);
    if (!data || typeof data.run_id !== 'string' || !data.run_id) return null;
    return data;
  } catch { return null; }
}

function writeCurrentRunPointer(runId, root) {
  writeJson(currentRunPointerPath(root), { run_id: String(runId), ts: nowIso() });
}

// Clears the pointer; if runId given, only when the pointer references that run.
function clearCurrentRunPointer(runId, root) {
  try {
    const p = currentRunPointerPath(root);
    if (!fs.existsSync(p)) return false;
    if (runId) {
      const cur = readJson(p, null);
      if (!cur || cur.run_id !== runId) return false;
    }
    fs.unlinkSync(p);
    return true;
  } catch { return false; }
}

// resolveCurrentRun({root?, now?}) → { run_id, state, last_state_change, run } | null.
// Valid iff: pointer exists ∧ pointed run.json readable ∧ state not inactive ∧
// age(last_state_change) <= ttl_hours (age == ttl is valid; age > ttl is expired).
// NEVER THROWS: PreToolUse only blocks on exit code 2 — an uncaught exception would
// exit 1 and ALLOW a sensitive write, so every internal error fails closed via null
// (corrupt pointer, missing run dir, corrupt run.json, bad timestamp, bad state,
// policy read failure, malformed run_lifecycle config).
function resolveCurrentRun(opts) {
  try {
    const root = (opts && opts.root) || harnessRoot();
    const nowMs = opts && opts.now !== undefined ? new Date(opts.now).getTime() : Date.now();
    if (!Number.isFinite(nowMs)) return null;
    const policy = runLifecyclePolicy(root);
    const ptr = readCurrentRunPointer(root);
    if (!ptr) return null;
    const rj = readJson(path.join(root, 'runs', ptr.run_id, 'run.json'), null);
    if (!rj || typeof rj.state !== 'string' || !rj.state) return null;
    if (policy.inactive_states.includes(rj.state)) return null;
    const ts = Date.parse(rj.last_state_change || '');
    if (!Number.isFinite(ts)) return null;
    const ageHours = (nowMs - ts) / 3600000;
    if (ageHours > policy.ttl_hours) return null;
    return { run_id: ptr.run_id, state: rj.state, last_state_change: rj.last_state_change, run: rj };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Sensitive-path + approval matching, hoisted from pre_tool_use_guard.js so the
// guard (read side) and post_tool_use_ledger.js (consume side) share ONE logic.
// ---------------------------------------------------------------------------

// Returns matching sensitive_paths entries for a write path, or [].
function sensitivePathHits(filePath, profileData) {
  try {
    if (!filePath || !profileData) return [];
    const root = profileData.project_root ? String(profileData.project_root).replace(/\\/g, '/') : null;
    const abs = String(filePath).replace(/\\/g, '/');
    let rel = abs;
    if (root && abs.toLowerCase().startsWith(root.toLowerCase())) {
      rel = abs.slice(root.length).replace(/^\/+/, '');
    }
    const hits = [];
    for (const sp of profileData.sensitive_paths || []) {
      if (globMatch(sp.glob, rel) || globMatch(sp.glob, abs)) hits.push(sp);
    }
    return hits;
  } catch { return []; }
}

// Resolve the project profile owning filePath (project_root prefix match),
// falling back to cwd detection. Never throws.
function findProfileForFile(filePath, cwd) {
  try {
    const profilesDir = path.join(harnessRoot(), 'config', 'project-profiles');
    if (filePath && fs.existsSync(profilesDir)) {
      for (const f of fs.readdirSync(profilesDir).filter(n => n.endsWith('.json') && n !== 'default.json')) {
        const data = readJson(path.join(profilesDir, f), null);
        if (!data || !data.project_root) continue;
        const root = String(data.project_root).replace(/\\/g, '/').toLowerCase();
        const fp = String(filePath).replace(/\\/g, '/').toLowerCase();
        if (fp.startsWith(root)) return { name: path.basename(f, '.json'), data };
      }
    }
    return detectProjectProfile(cwd);
  } catch { return null; }
}

// Indexes of UNCONSUMED approvals matching a trigger — text matching semantics
// byte-identical to the guard's historical inline check (substring both directions +
// requires_owner alias bridge). The ledger flips exactly what the guard accepted.
//
// G2 field enforcement (fail-closed, NO legacy grace — applied after text match):
//   granted_by === "owner"  ∧  granted_ts parseable, not future-dated > 5 min
//   ∧  expires_ts parseable, not in the past (boundary: expires_ts == now valid)
//   ∧  when apr.files glob present AND opts.writtenPath given → path must match.
// Approvals missing expires_ts or granted_ts are REJECTED. File-scope narrows only
// write tools (actual path); Bash/no-path matches cannot be file-scope-narrowed.
// opts: { writtenPath?, now? } — now injected by evals, defaults to Date.now().
const GRANT_FUTURE_SKEW_MS = 5 * 60000;
function matchingApprovalIndexes(approvalsRaw, trigger, requiresOwner, opts) {
  const out = [];
  try {
    const nowMs = opts && opts.now !== undefined ? new Date(opts.now).getTime() : Date.now();
    if (!Number.isFinite(nowMs)) return out;
    const writtenPath = opts && opts.writtenPath ? String(opts.writtenPath) : null;
    const reqs = (requiresOwner || []).map(s => String(s).toLowerCase());
    const trigLower = String(trigger || '').toLowerCase();
    if (!trigLower) return out;
    (approvalsRaw || []).forEach((apr, i) => {
      if (!apr || apr.consumed) return;
      const a = String(apr.action || '').toLowerCase();
      if (!a) return;
      const textMatch = a.includes(trigLower) ||
          trigLower.includes(a.split(/\s/)[0]) ||
          reqs.some(r => a.includes(r.split(/\s/)[0]) && r.includes(trigLower));
      if (!textMatch) return;
      if (apr.granted_by !== 'owner') return;
      const gts = Date.parse(apr.granted_ts || '');
      if (!Number.isFinite(gts)) return;
      if (gts > nowMs + GRANT_FUTURE_SKEW_MS) return;
      const ets = Date.parse(apr.expires_ts || '');
      if (!Number.isFinite(ets)) return;
      if (ets < nowMs) return;
      if (apr.files && writtenPath) {
        const norm = writtenPath.replace(/\\/g, '/');
        const g = String(apr.files);
        // rel-style globs also match absolute paths (same spirit as sensitivePathHits)
        if (!globMatch(g, norm) && !(g.startsWith('**') ? false : globMatch('**/' + g, norm))) return;
      }
      out.push(i);
    });
  } catch { /* fail closed: no matches */ }
  return out;
}

function matchApproval(approvalsRaw, trigger, requiresOwner, opts) {
  return matchingApprovalIndexes(approvalsRaw, trigger, requiresOwner, opts).length > 0;
}

module.exports = {
  harnessRoot, resolveWorkspace, isUnderTempDir, parseArgs, readJson, writeJson, appendNdjson, readNdjson,
  nowIso, tokenizeCommand, slugify, genRunId, runDir, ensureRunDir,
  loadGlobalPolicy, loadProjectProfile, detectProjectProfile,
  globMatch, globToRegex, gitDiffPaths, indexRun, listRuns,
  runLifecyclePolicy, readCurrentRunPointer, writeCurrentRunPointer,
  clearCurrentRunPointer, resolveCurrentRun,
  sensitivePathHits, findProfileForFile, matchingApprovalIndexes, matchApproval
};
