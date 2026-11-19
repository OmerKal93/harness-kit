#!/usr/bin/env node
// gbrain-query-memory.js — Phase 3B helper.
// Wraps `gbrain query` / `gbrain think`. Always passes output through redactString.
// Honors kill switch. Emits a tool-log line per call when --run-id is provided.
//
// Usage:
//   node gbrain-query-memory.js --q "kill switch contract"
//   node gbrain-query-memory.js --think "what are recurring failures"
//   node gbrain-query-memory.js --q "..." --run-id <id>
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, nowIso, appendNdjson, runDir } = require('./_lib.js');
const { redactString } = require('./redact.js');

const GBRAIN_DIR = process.env.GBRAIN_DIR || path.join(os.homedir(), 'gbrain');
const CLI = path.join(GBRAIN_DIR, 'src', 'cli.ts');
const fs = require('fs');

function resolveBun() {
  if (process.env.BUN_BIN && fs.existsSync(process.env.BUN_BIN)) return process.env.BUN_BIN;
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
    path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
    '/usr/local/bin/bun',
    '/usr/bin/bun'
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'bun';
}
const BUN = resolveBun();

function runGbrain(args) {
  try {
    return {
      ok: true,
      stdout: execFileSync(BUN, ['run', CLI, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: GBRAIN_DIR,
        maxBuffer: 32 * 1024 * 1024
      })
    };
  } catch (e) {
    return { ok: false, stdout: '', error: String(e.message || e).slice(0, 500) };
  }
}

function logToolUse(runId, summary) {
  if (!runId) return;
  const p = path.join(runDir(runId), 'tool-log.ndjson');
  appendNdjson(p, {
    ts: nowIso(),
    source: 'gbrain-query-memory',
    summary
  });
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const query = args.q || args.query;
  const think = args.think;
  const runId = args['run-id'] || null;

  if (!query && !think) {
    console.error('error: --q "<query>" OR --think "<query>" required');
    process.exit(2);
  }

  const subcommand = think ? ['think', String(think)] : ['query', String(query)];
  const t0 = Date.now();
  const r = runGbrain(subcommand);
  const elapsedMs = Date.now() - t0;

  // ALWAYS redact before display
  const redacted = redactString(r.stdout || '');

  console.log(redacted);

  // Tool-log entry per debug-contract
  const inputExcerpt = (query || think).slice(0, 120);
  // crude result count: number of non-empty lines that look like result rows / citations
  const resultLines = (redacted.match(/\n/g) || []).length;
  logToolUse(runId, {
    subcommand: subcommand[0],
    input_excerpt: inputExcerpt,
    result_lines: resultLines,
    elapsed_ms: elapsedMs,
    ok: r.ok,
    error: r.error || null
  });

  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) main();
