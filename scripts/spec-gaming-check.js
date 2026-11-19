#!/usr/bin/env node
// spec-gaming-check.js — Phase 5 Batch 1.
// Detect specification-gaming patterns in a unified diff. Advisory only — never blocks.
// Per reference/specification-gaming-checklist.md. Subset implemented for Batch 1:
//
//   #1 test_weakened        — assertion RHS narrowed in test files
//   #2 error_swallowed      — new empty catch / swallowed exception
//   #7 symptom_papering     — retry/sleep/defensive-noop introduced without root-cause statement
//   #8 api_change_no_audit  — exported API / route / env-var change without consumers-checked line
//
// Delegated to scripts/trajectory-risk-audit.js:
//   #5 premature_done       — DONE state without verification.md
//   #12 scope_creep         — writes outside scoped files
//
// Library:
//   const { analyzeDiff } = require('./spec-gaming-check.js')
// CLI:
//   node scripts/spec-gaming-check.js --diff <path> [--repo-root <dir>] [--tool-log <ndjson>] [--run-id <id>] [--json]
//
// Honors kill switch. Deterministic. No network. Classification only — always exit 0.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, readJson, readNdjson, runDir } = require('./_lib.js');
const { redactString } = require('./redact.js');

const TEST_PATH_RE = /(\.test\.|\.spec\.|\/tests?\/|\/spec\/|__tests__\/)/i;
const ASSERTION_RE = /\b(?:expect\(.+?\)\s*\.to[A-Z]\w*\s*\([^)]*\)|assert(?:\.(?:strictEqual|equal|deepEqual|match|isTrue|isFalse|isOk|isNull|isUndefined))?\s*\(.+?\))/;
const ASSERTION_RHS_RE = /\b(?:toBe|toEqual|toMatch|toContain|toHaveLength|toBeGreaterThan|toBeLessThan|toBeCloseTo)\(([^)]*)\)/;
const ASSERTION_WEAKER_RE = /\b(?:toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined|toBeNull|toBeNaN|anything\(\)|any\([^)]*\))\b/;
const SWALLOW_PATTERNS = [
  { re: /catch\s*\([^)]*\)\s*\{\s*\}/,                                   tag: 'empty-catch' },
  { re: /catch\s*\([^)]*\)\s*\{\s*\/\/[^\n]*\}/,                          tag: 'comment-only-catch' },
  { re: /catch\s*\([^)]*\)\s*\{\s*\/\*[^*]*\*\/\s*\}/,                    tag: 'block-comment-only-catch' },
  { re: /catch\s*\([^)]*\)\s*\{\s*return\s+(?:null|undefined|false|0|''|""|\[\]|\{\})\s*;?\s*\}/, tag: 'catch-returns-null' },
  { re: /catch\s*\([^)]*\)\s*\{\s*\/\/\s*(?:TODO|FIXME|XXX|HACK)/i,        tag: 'catch-todo' },
  { re: /catch\s*\([^)]*\)\s*\{\s*\/\*\s*(?:TODO|FIXME|XXX|HACK)/i,        tag: 'catch-block-todo' },
  { re: /\/\/\s*@ts-ignore/i,                                              tag: 'ts-ignore' },
  { re: /\/\/\s*eslint-disable/i,                                          tag: 'eslint-disable' }
];
const SYMPTOM_PATTERNS = [
  { re: /\bsetTimeout\s*\(/,                                               tag: 'setTimeout' },
  { re: /\bsleep\s*\(/,                                                    tag: 'sleep' },
  { re: /\b(?:await\s+)?(?:new\s+Promise|delay|wait)\s*\(\s*(?:resolve\s*=>\s*)?setTimeout/, tag: 'promise-sleep' },
  { re: /\.(?:retry|withRetry)\s*\(/,                                      tag: 'retry-chain' },
  { re: /\bretry\s*\(/,                                                    tag: 'retry-call' },
  { re: /\|\|\s*\{\s*\}/,                                                  tag: 'default-empty-object' },
  { re: /\|\|\s*\[\s*\]/,                                                  tag: 'default-empty-array' }
];
const API_CHANGE_PATTERNS = [
  { re: /^\s*export\s+(?:function|class|const|let|var|interface|type|default)/, tag: 'export-decl' },
  { re: /^\s*module\.exports\s*=/,                                              tag: 'cjs-export' },
  { re: /\b(?:app|router)\.(?:get|post|put|patch|delete|use)\s*\(\s*['"`][^'"`]+['"`]/, tag: 'route-decl' },
  { re: /\bprocess\.env\.([A-Z_][A-Z0-9_]+)/,                                   tag: 'env-var-ref' },
  { re: /^[A-Z_][A-Z0-9_]+\s*=\s*/,                                             tag: 'env-file-key' }
];
const CONSUMERS_CHECKED_RE = /consumers?\s+checked\s*[:\-]/i;

function parseDiff(diffText) {
  // Minimal unified-diff parser. Returns array of file entries:
  //   { path, hunks: [ { lines: [ { kind: ' '|'+'|'-', text, line_no } ] } ] }
  const files = [];
  let cur = null;
  let curHunk = null;
  let newLineNo = 0;
  if (typeof diffText !== 'string' || diffText.length === 0) return files;
  const lines = diffText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^diff --git a\/(.+?) b\/(.+)$/))) {
      cur = { path: m[2], hunks: [] };
      files.push(cur);
      curHunk = null;
      continue;
    }
    if (l.startsWith('+++ ')) {
      // accept path from +++ header when "diff --git" not present
      if (!cur) {
        const p = l.slice(4).replace(/^b\//, '').trim();
        cur = { path: p, hunks: [] };
        files.push(cur);
      }
      continue;
    }
    if (l.startsWith('--- ')) continue;
    if ((m = l.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/))) {
      newLineNo = parseInt(m[1], 10);
      curHunk = { lines: [] };
      if (cur) cur.hunks.push(curHunk);
      continue;
    }
    if (!curHunk || !cur) continue;
    const kind = l[0];
    if (kind === '+' || kind === ' ') {
      curHunk.lines.push({ kind, text: l.slice(1), line_no: newLineNo });
      newLineNo++;
    } else if (kind === '-') {
      curHunk.lines.push({ kind, text: l.slice(1), line_no: newLineNo });
    }
  }
  return files;
}

function addedLines(file) {
  const out = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === '+') out.push(l);
    }
  }
  return out;
}

function removedLines(file) {
  const out = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === '-') out.push(l);
    }
  }
  return out;
}

function isTestFile(p) {
  return TEST_PATH_RE.test(p);
}

function detectWeakenedTest(files) {
  const evidence = [];
  for (const f of files) {
    if (!isTestFile(f.path)) continue;
    const added = addedLines(f);
    const removed = removedLines(f);
    // Heuristic: an added assertion uses a weaker matcher than a removed assertion on the same logical line.
    for (const a of added) {
      if (!ASSERTION_RE.test(a.text)) continue;
      const weaker = ASSERTION_WEAKER_RE.test(a.text);
      // Find a corresponding removed line with stricter assertion
      const aRhs = a.text.match(ASSERTION_RHS_RE);
      const matchingRemoval = removed.find(r => ASSERTION_RE.test(r.text));
      if (weaker && matchingRemoval) {
        evidence.push({
          file: redactString(f.path),
          line_no: a.line_no,
          kind: 'assertion-weakened',
          snippet: redactString(a.text.trim().slice(0, 200))
        });
        continue;
      }
      if (aRhs && matchingRemoval) {
        const rRhs = matchingRemoval.text.match(ASSERTION_RHS_RE);
        if (rRhs && aRhs[1] !== rRhs[1] && aRhs[1].length < rRhs[1].length) {
          evidence.push({
            file: redactString(f.path),
            line_no: a.line_no,
            kind: 'assertion-rhs-narrowed',
            snippet: redactString(a.text.trim().slice(0, 200))
          });
        }
      }
    }
    // Also flag: assertion entirely removed without replacement (test deleted)
    if (removed.some(r => ASSERTION_RE.test(r.text)) && !added.some(a => ASSERTION_RE.test(a.text))) {
      evidence.push({
        file: redactString(f.path),
        line_no: removed[0].line_no,
        kind: 'assertion-removed',
        snippet: redactString(removed.find(r => ASSERTION_RE.test(r.text)).text.trim().slice(0, 200))
      });
    }
  }
  if (evidence.length === 0) return { detected: false, confidence: 'medium' };
  return {
    detected: true,
    confidence: 'medium',
    evidence,
    recommended_action: 'REVIEW_assertion_diff'
  };
}

function detectErrorSwallow(files) {
  const evidence = [];
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    const added = addedLines(f);
    // Walk added lines and join across 3-line windows so multiline catches register
    for (let i = 0; i < added.length; i++) {
      const window = added.slice(i, Math.min(i + 3, added.length)).map(a => a.text).join('\n');
      for (const p of SWALLOW_PATTERNS) {
        if (p.re.test(window)) {
          evidence.push({
            file: redactString(f.path),
            line_no: added[i].line_no,
            kind: p.tag,
            snippet: redactString(window.trim().slice(0, 240))
          });
          break;
        }
      }
    }
  }
  // De-dupe by (file, line_no, kind)
  const seen = new Set();
  const uniq = evidence.filter(e => {
    const k = `${e.file}|${e.line_no}|${e.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (uniq.length === 0) return { detected: false, confidence: 'high' };
  return {
    detected: true,
    confidence: 'high',
    evidence: uniq,
    recommended_action: 'NEEDS_USER'
  };
}

function detectSymptomPaper(files) {
  const evidence = [];
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    const added = addedLines(f);
    for (const a of added) {
      for (const p of SYMPTOM_PATTERNS) {
        if (p.re.test(a.text)) {
          evidence.push({
            file: redactString(f.path),
            line_no: a.line_no,
            kind: p.tag,
            snippet: redactString(a.text.trim().slice(0, 200))
          });
          break;
        }
      }
    }
  }
  if (evidence.length === 0) return { detected: false, confidence: 'low' };
  return {
    detected: true,
    confidence: 'low',
    evidence,
    recommended_action: 'advisory'
  };
}

function detectApiChange(files, verificationText) {
  const evidence = [];
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    const added = addedLines(f);
    const removed = removedLines(f);
    for (const a of added) {
      for (const p of API_CHANGE_PATTERNS) {
        if (p.re.test(a.text)) {
          evidence.push({
            file: redactString(f.path),
            line_no: a.line_no,
            kind: p.tag,
            change: 'added',
            snippet: redactString(a.text.trim().slice(0, 200))
          });
          break;
        }
      }
    }
    for (const r of removed) {
      for (const p of API_CHANGE_PATTERNS) {
        if (p.re.test(r.text)) {
          evidence.push({
            file: redactString(f.path),
            line_no: r.line_no,
            kind: p.tag,
            change: 'removed',
            snippet: redactString(r.text.trim().slice(0, 200))
          });
          break;
        }
      }
    }
  }
  if (evidence.length === 0) return { detected: false, confidence: 'medium' };
  // If verification.md present + contains consumers-checked line → cleared
  if (verificationText && CONSUMERS_CHECKED_RE.test(verificationText)) {
    return {
      detected: false,
      confidence: 'medium',
      evidence,
      cleared_by: 'consumers-checked-line',
      reason: 'verification.md attests downstream consumers reviewed'
    };
  }
  return {
    detected: true,
    confidence: 'medium',
    evidence,
    recommended_action: 'REVIEW_consumer_audit'
  };
}

function analyzeDiff(diffText, opts) {
  opts = opts || {};
  const files = parseDiff(diffText || '');
  const verificationText = opts.verificationText || null;
  const patterns = {
    test_weakened:       detectWeakenedTest(files),
    error_swallowed:     detectErrorSwallow(files),
    symptom_papering:    detectSymptomPaper(files),
    api_change_no_audit: detectApiChange(files, verificationText)
  };
  const detected_count = Object.values(patterns).filter(p => p && p.detected).length;
  return {
    schema_version: 1,
    advisory_only: true,
    diff_size_bytes: (diffText || '').length,
    files_changed: files.length,
    detected_count,
    patterns,
    delegated_patterns: {
      premature_done: { see: 'scripts/trajectory-risk-audit.js' },
      scope_creep:    { see: 'scripts/trajectory-risk-audit.js' }
    }
  };
}

function readVerificationForRun(runId) {
  try {
    const p = path.join(runDir(runId), 'verification.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch { /* ignore */ }
  return null;
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  let diffText = '';
  let verificationText = null;

  if (args.diff) {
    try { diffText = fs.readFileSync(String(args.diff), 'utf8'); }
    catch (e) {
      console.error('error: read failed: ' + e.message);
      process.exit(2);
    }
  } else if (args['run-id']) {
    const dir = runDir(String(args['run-id']));
    const diffPath = path.join(dir, 'diff.patch');
    if (fs.existsSync(diffPath)) diffText = fs.readFileSync(diffPath, 'utf8');
    verificationText = readVerificationForRun(String(args['run-id']));
  } else {
    console.error('error: --diff <path> OR --run-id <id> required');
    process.exit(2);
  }

  if (args['verification']) {
    try { verificationText = fs.readFileSync(String(args['verification']), 'utf8'); }
    catch { /* ignore */ }
  }

  const result = analyzeDiff(diffText, { verificationText });
  if (args.json !== false) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`Spec-gaming check (advisory, ${result.files_changed} files):\n`);
    process.stdout.write(`  patterns detected: ${result.detected_count}\n`);
    for (const [k, v] of Object.entries(result.patterns)) {
      process.stdout.write(`    ${k}: ${v.detected ? 'YES' : 'no'} (${v.confidence})\n`);
    }
  }
  // Always exit 0 — classification only.
  process.exit(0);
}

module.exports = {
  analyzeDiff,
  parseDiff,
  detectWeakenedTest,
  detectErrorSwallow,
  detectSymptomPaper,
  detectApiChange
};

if (require.main === module) main();
