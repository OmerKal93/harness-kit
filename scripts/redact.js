#!/usr/bin/env node
// Redaction utility. Applies patterns from config/redaction-rules.json to a string or stdin.
// Library: const { redactString, redactToolEvent, isPathBlocked } = require('./redact.js')
// CLI:     `cat file | node redact.js`  → redacted stdout
//          `node redact.js --check-path "/path/to/file"` → exits 0 if blocked, 1 if allowed
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// HARNESS_ROOT seam (Batch 3-impl): resolve the config dir via the shared canonical resolver
// (HARNESS_ROOT || legacy <harness-root>). Behavior unchanged when HARNESS_ROOT is unset.
const { harnessRoot } = require('./_lib.js');
const RULES_PATH = path.join(harnessRoot(), 'config', 'redaction-rules.json');
let _rules = null;
let _rulesLoadFailed = false;
let _rulesLoadError = null;

// FAIL-OPEN FIX: loadRules() previously swallowed any read/parse error into a silent, empty
// rules object — every caller (findSecretFindings, isPathBlocked) then reported "clean" with
// zero findings whenever HARNESS_ROOT was unset or misconfigured, with no warning anywhere.
// rulesLoadFailed()/rulesLoadError() let callers (security-boundary.js) detect this degraded
// state and fail closed instead of silently passing.
function loadRules() {
  if (_rules) return _rules;
  try {
    _rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch (e) {
    _rules = { patterns: [], path_blocklist: [] };
    _rulesLoadFailed = true;
    _rulesLoadError = e.message;
    process.stderr.write(`[redact.js] WARNING: failed to load ${RULES_PATH} (${e.message}) — ` +
      `secret/path-blocklist detection is running with ZERO rules until this is fixed. ` +
      `Set HARNESS_ROOT to a directory containing config/redaction-rules.json.\n`);
  }
  // Compile regexes once
  for (const p of _rules.patterns) {
    try { p._re = new RegExp(p.regex, p.flags || 'g'); }
    catch (e) { p._re = null; }
  }
  return _rules;
}

function rulesLoadFailed() { loadRules(); return _rulesLoadFailed; }
function rulesLoadError() { loadRules(); return _rulesLoadError; }
function rulesPath() { return RULES_PATH; }

function redactString(s) {
  if (typeof s !== 'string' || !s) return s;
  const rules = loadRules();
  let out = s;
  for (const p of rules.patterns) {
    if (!p._re) continue;
    try { out = out.replace(p._re, p.replacement); }
    catch { /* skip bad pattern */ }
  }
  return out;
}

function globToRegex(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('(^|/|\\\\)' + re + '$', 'i');
}

function isPathBlocked(p) {
  if (!p) return false;
  const rules = loadRules();
  const norm = String(p).replace(/\\/g, '/');
  for (const g of rules.path_blocklist || []) {
    if (globToRegex(g).test(norm)) return true;
  }
  return false;
}

// Redact a tool event before logging it. Returns a NEW object; does not mutate input.
function redactToolEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const out = JSON.parse(JSON.stringify(event));
  // Common fields
  if (out.tool_input && typeof out.tool_input === 'object') {
    const ti = out.tool_input;
    // Bash command
    if (typeof ti.command === 'string') ti.command = redactString(ti.command);
    // File paths
    const pathFields = ['file_path', 'path', 'notebook_path', 'output_file'];
    for (const f of pathFields) {
      if (typeof ti[f] === 'string' && isPathBlocked(ti[f])) {
        out._redacted_path = true;
        // Keep the path itself (it's metadata, not secret content), but flag.
      }
    }
    // Edit / Write content fields — redact aggressively if path is blocked
    const contentFields = ['content', 'new_string', 'old_string', 'pattern', 'prompt'];
    const pathHit = (ti.file_path || ti.path) && isPathBlocked(ti.file_path || ti.path);
    for (const f of contentFields) {
      if (typeof ti[f] === 'string') {
        ti[f] = pathHit ? '[REDACTED:blocked_path_content]' : redactString(ti[f]);
      }
    }
  }
  if (typeof out.tool_output === 'string') out.tool_output = redactString(out.tool_output);
  if (typeof out.output === 'string')      out.output      = redactString(out.output);
  if (typeof out.prompt === 'string')      out.prompt      = redactString(out.prompt);
  return out;
}

module.exports = { redactString, redactToolEvent, isPathBlocked, loadRules, rulesLoadFailed, rulesLoadError, rulesPath };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--check-path');
  if (idx !== -1) {
    const p = argv[idx + 1];
    process.exit(isPathBlocked(p) ? 0 : 1);
  }
  let raw = '';
  process.stdin.on('data', d => raw += d);
  process.stdin.on('end', () => { process.stdout.write(redactString(raw)); });
}
