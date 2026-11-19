#!/usr/bin/env node
// resolve-codex-shim.js — shared Windows executable-resolution helper for the Codex CLI.
//
// Extracted out of codex-adapter.js so loop-conductor.js can reuse it too, without creating a
// require cycle (codex-adapter.js already requires loop-conductor.js for parseCodexVerdict).
//
// npm installs `codex` as a `.cmd`/`.bat`/extensionless shim on Windows, and Node refuses to exec
// `.cmd` files directly without shell:true -- which would open a cmd.exe argument-injection surface
// for untrusted content (this is the exact pattern that was correctly blocked twice, see
// config/adapter-registry.json's codex-cli.incidents). Instead of shelling out, this reads the
// shim's own npm-generated wrapper script to find the real node_modules/.../bin/codex.js it
// launches, and returns enough info to invoke that directly via process.execPath -- no shell
// involved at any point. POSIX doesn't need any of this (spawnSync/execFileSync('codex', args)
// already resolves via PATH there without a shell).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function resolveCodexExecutableWin32({ whereOutput, readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const lines = String(whereOutput || '').trim().split(/\r?\n/).filter(Boolean);
  const cmdShim = lines.find(l => l.toLowerCase().endsWith('.cmd'));
  if (!cmdShim) return { ok: false, reason: 'no .cmd shim found in `where codex` output' };
  let content;
  try { content = readFile(cmdShim, 'utf8'); } catch (e) { return { ok: false, reason: `could not read shim: ${e.message}` }; }
  const m = content.match(/%dp0%\\+"?\s*([^"\r\n]+?\.js)"?\s*%\*/);
  if (!m) return { ok: false, reason: 'shim content did not match expected npm-generated .cmd pattern' };
  const resolved = path.join(path.dirname(cmdShim), m[1]);
  if (!exists(resolved)) return { ok: false, reason: `resolved path does not exist: ${resolved}` };
  return { ok: true, command: process.execPath, prefixArgs: [resolved], resolved_path: resolved };
}

let _resolvedCodexExecutableCache = null;
function resolveCodexExecutable() {
  if (process.platform !== 'win32') return { ok: true, command: 'codex', prefixArgs: [] };
  if (_resolvedCodexExecutableCache) return _resolvedCodexExecutableCache;

  // Primary: npm's default global-prefix bin dir on Windows is %APPDATA%\npm. process.env is
  // always correctly decoded by Node regardless of the console's active codepage, so this finds
  // the common case without spawning anything. (Shelling out to `where`, below, is fallback-only:
  // its captured output can come back mis-decoded on a non-ASCII-username machine -- observed
  // directly on this host -- because `where.exe`'s stdout bytes are in the console's OEM codepage,
  // not UTF-8, and Node has no zero-dependency codepage table to correct for that.)
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'codex.cmd'));
  try {
    const whereOutput = execFileSync('where', ['codex'], { encoding: 'utf8', timeout: 5000 });
    for (const line of String(whereOutput).trim().split(/\r?\n/)) {
      if (line.toLowerCase().endsWith('.cmd')) candidates.push(line);
    }
  } catch { /* `where` unavailable or codex not on PATH -- the APPDATA guess above still stands */ }

  for (const cmdShim of candidates) {
    const r = resolveCodexExecutableWin32({ whereOutput: cmdShim });
    if (r.ok) { _resolvedCodexExecutableCache = r; return r; }
  }
  _resolvedCodexExecutableCache = {
    ok: false,
    reason: candidates.length
      ? `none of ${candidates.length} candidate shim path(s) resolved to an existing codex.js`
      : 'no codex shim found via %APPDATA%\\npm or `where codex`'
  };
  return _resolvedCodexExecutableCache;
}

// Test-only: reset the module-level cache so a fresh `where`/APPDATA lookup runs.
function _resetCacheForTest() { _resolvedCodexExecutableCache = null; }

module.exports = { resolveCodexExecutable, resolveCodexExecutableWin32, _resetCacheForTest };
