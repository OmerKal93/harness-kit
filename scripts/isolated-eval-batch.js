#!/usr/bin/env node
// isolated-eval-batch.js — ORCH-4/R6: productizes the Gate-1 isolation pattern
// (runs/20260705-*/run_one.sh: fresh unique dir per call, unique output path, sequential
// foreground, no session persistence) into a reusable, adapter-agnostic script.
//
// Spawn mechanism: execFileSync('bash', [scripts/isolated-eval-run.sh, ...fixedArgs], { input:
// prompt, timeout }) — bash.exe is a genuine binary (confirmed this session: resolves fine via
// plain execFileSync, no shell:true needed, unlike npm .cmd shims such as codex.cmd/agy.cmd). The
// prompt/task text NEVER appears in argv — only in `input` (stdin) — so there is no cmd.exe/shell
// argument-injection surface, the same concern that correctly blocked a shell:true attempt in
// scripts/codex-adapter.js this session. execFileSync's own `timeout`+`killSignal` options own
// process-tree cancellation; this module never tracks or kills a PID itself.
//
// CLI:
//   node scripts/isolated-eval-batch.js --adapter claude-code --mode review --prompt-file <f> [--timeout-ms 180000] [--json]
//   node scripts/isolated-eval-batch.js --self-test
//
// Library:
//   const { runIsolated, createIsolatedDir } = require('./isolated-eval-batch.js')
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseArgs, nowIso, harnessRoot } = require('./_lib.js');
const { isDisabled } = require('./is-disabled.js');

const SCRIPT_PATH = path.join(__dirname, 'isolated-eval-run.sh');
const DEFAULT_TIMEOUT_MS = 180000;
const ALLOWED_ADAPTERS = new Set(['claude-code', 'codex-cli']);
const ALLOWED_MODES = new Set(['review', 'implement']);

function createIsolatedDir(tag) {
  const dir = path.join(os.tmpdir(), `hk-isolated-eval-${(tag || 'run').replace(/[^A-Za-z0-9_-]/g, '_')}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Pure: normalize a completed (or failed) execFileSync attempt into a structural result. Split
// out from runIsolated so it is unit-testable without a real spawn.
function normalizeRun({ adapter, mode, cwd, outFile, spawnErr, durationMs, exitCodeFile }) {
  const base = { adapter, mode, cwd, duration_ms: durationMs, ts: nowIso() };
  if (spawnErr) {
    const timedOut = spawnErr.killed === true || spawnErr.code === 'ETIMEDOUT' || spawnErr.signal != null;
    return { ...base, ok: false, outcome: timedOut ? 'timeout' : 'spawn_error', error: String(spawnErr.message || spawnErr).slice(0, 300) };
  }
  let exitCode = null;
  try { exitCode = parseInt(fs.readFileSync(exitCodeFile, 'utf8').trim(), 10); } catch { /* absent */ }
  let raw = ''; try { raw = fs.readFileSync(outFile + '.raw', 'utf8'); } catch { /* absent */ }
  let stderr = ''; try { stderr = fs.readFileSync(outFile + '.stderr', 'utf8'); } catch { /* absent */ }
  let codexMsg = null; try { codexMsg = fs.readFileSync(outFile + '.codexmsg', 'utf8'); } catch { /* only exists for codex-cli */ }
  return {
    ...base, ok: true, outcome: 'completed', exit_code: exitCode,
    raw_output: raw, stderr, codex_message: codexMsg,
    output_path: outFile
  };
}

function runIsolated({ adapter, mode, prompt, cwd, timeoutMs, tag }) {
  if (isDisabled().disabled) return { ok: false, gate: 'DISABLED' };
  if (!ALLOWED_ADAPTERS.has(adapter)) return { ok: false, error: 'unknown_adapter', allowed: [...ALLOWED_ADAPTERS] };
  if (!ALLOWED_MODES.has(mode)) return { ok: false, error: 'unknown_mode', allowed: [...ALLOWED_MODES] };
  const dir = cwd || createIsolatedDir(tag);
  const outFile = path.join(dir, 'isolated-eval-out');
  const start = Date.now();
  let spawnErr = null;
  try {
    execFileSync('bash', [SCRIPT_PATH, adapter, mode, dir, outFile], {
      encoding: 'utf8', input: String(prompt || ''), timeout: timeoutMs || DEFAULT_TIMEOUT_MS
    });
  } catch (e) { spawnErr = e; }
  const durationMs = Date.now() - start;
  return normalizeRun({ adapter, mode, cwd: dir, outFile, spawnErr, durationMs, exitCodeFile: outFile + '.exitcode' });
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  push('rejects_unknown_adapter', runIsolated({ adapter: 'gpt-nope', mode: 'review', prompt: 'x' }).error === 'unknown_adapter', 'unknown adapter id must be rejected before any spawn');
  push('rejects_unknown_mode', runIsolated({ adapter: 'claude-code', mode: 'nope', prompt: 'x' }).error === 'unknown_mode', 'unknown mode must be rejected before any spawn');

  {
    const before = process.env.HARNESSKIT_DISABLED;
    process.env.HARNESSKIT_DISABLED = '1';
    const r = runIsolated({ adapter: 'claude-code', mode: 'review', prompt: 'x' });
    if (before === undefined) delete process.env.HARNESSKIT_DISABLED; else process.env.HARNESSKIT_DISABLED = before;
    push('kill_switch_short_circuits', r.gate === 'DISABLED', JSON.stringify(r));
  }

  // normalizeRun on a synthetic completed attempt (no real spawn).
  {
    const tmp = createIsolatedDir('selftest-normalize');
    fs.writeFileSync(path.join(tmp, 'isolated-eval-out.exitcode'), '0\n');
    fs.writeFileSync(path.join(tmp, 'isolated-eval-out.raw'), '{"result":"ok"}');
    fs.writeFileSync(path.join(tmp, 'isolated-eval-out.stderr'), '');
    const r = normalizeRun({ adapter: 'claude-code', mode: 'review', cwd: tmp, outFile: path.join(tmp, 'isolated-eval-out'), spawnErr: null, durationMs: 42, exitCodeFile: path.join(tmp, 'isolated-eval-out.exitcode') });
    push('normalize_completed_run', r.ok === true && r.exit_code === 0 && r.raw_output.includes('"ok"'), JSON.stringify(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // normalizeRun distinguishes timeout from generic spawn error.
  {
    const rTimeout = normalizeRun({ adapter: 'codex-cli', mode: 'review', cwd: '.', outFile: 'x', spawnErr: { killed: true, message: 'ETIMEDOUT' }, durationMs: 180000, exitCodeFile: 'x' });
    const rSpawn = normalizeRun({ adapter: 'codex-cli', mode: 'review', cwd: '.', outFile: 'x', spawnErr: new Error('ENOENT'), durationMs: 5, exitCodeFile: 'x' });
    push('timeout_vs_spawn_error_distinguished', rTimeout.outcome === 'timeout' && rSpawn.outcome === 'spawn_error', JSON.stringify({ t: rTimeout.outcome, s: rSpawn.outcome }));
  }
  // integration smoke: bash itself resolves without a real CLI call (dry structural check only —
  // does not invoke claude/codex, keeps self-test free and fast).
  {
    let bashOk = false;
    try { execFileSync('bash', ['--version'], { encoding: 'utf8', timeout: 10000 }); bashOk = true; } catch { bashOk = false; }
    push('bash_spawn_mechanism_available', bashOk, 'execFileSync(bash) must resolve without shell:true on this host for runIsolated to function at all');
  }
  push('companion_script_exists', fs.existsSync(SCRIPT_PATH), SCRIPT_PATH);

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  const prompt = a['prompt-file'] ? fs.readFileSync(String(a['prompt-file']), 'utf8') : '';
  const result = runIsolated({ adapter: a.adapter, mode: a.mode, prompt, timeoutMs: a['timeout-ms'] ? Number(a['timeout-ms']) : undefined, tag: a.tag });
  if (a.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`adapter=${result.adapter} mode=${result.mode} ok=${result.ok} outcome=${result.outcome} duration_ms=${result.duration_ms}`);
  process.exit(result.ok ? 0 : 1);
}

module.exports = { runIsolated, createIsolatedDir, normalizeRun, SCRIPT_PATH };
if (require.main === module) main();
