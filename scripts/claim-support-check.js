#!/usr/bin/env node
// claim-support-check.js — Phase 4 Batch 2.
// Parse a verification.md file, extract claim tokens (path-shaped, inline-code-shaped,
// tool-log literal), and anchor each token against the repo /  /
// an optional tool-log ndjson. Flag unanchored claims.
//
// Library:
//   const { extractTokens, anchorTokens, analyzeFile } = require('./claim-support-check.js')
//
// CLI:
//   node scripts/claim-support-check.js --verification <path>
//                                       [--tool-log <ndjson>]
//                                       [--repo-root <dir>]
//                                       [--json]
//
// Honors kill switch. Persisted strings pass through redactString.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, readNdjson } = require('./_lib.js');
const { redactString } = require('./redact.js');

const PATH_TOKEN_RE = /\b[\w./\\-]+\.(?:md|js|json|ts|tsx|jsx|sql|yml|yaml|txt|sh|html|css|conf|env|ndjson|toml|lock|py|rb|go|java|kt|swift|rs|c|cpp|h|hpp|cs|php)\b/g;
const INLINE_CODE_RE = /`([^`\n]{1,200})`/g;
const TOOL_LOG_LITERAL_RE = /\btool-log\.ndjson\b|\bdecision-log\.ndjson\b|\brun\.json\b|\broute\.json\b/g;

// Heuristic: code-token looks "actionable" if it contains a slash, dot, parens, dash, or is a
// known tool/command name. Used so casual inline-code like `foo` doesn't count as a claim.
const KNOWN_TOOL_NAMES = new Set([
  'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'PowerShell',
  'WebFetch', 'WebSearch', 'Skill', 'Agent',
  'execFileSync', 'spawnSync', 'redactString', 'scanContent',
  'isDisabled', 'parseArgs', 'readNdjson', 'globMatch',
  'fs.existsSync', 'fs.readFileSync', 'fs.writeFileSync'
]);

function isActionableInlineToken(token) {
  if (!token) return false;
  if (KNOWN_TOOL_NAMES.has(token)) return true;
  if (/[\/\\]/.test(token)) return true;            // path-like
  if (/^[a-z]+\s+[-\w]+/.test(token)) return true;  // shell command shape
  if (/\.[A-Za-z]{1,6}$/.test(token)) return true;  // ends with extension
  if (/\(\)/.test(token)) return true;              // function call shape
  if (/^[A-Z][A-Za-z0-9]+\.[A-Za-z]/.test(token)) return true; // method shape
  return false;
}

function extractTokens(line) {
  const tokens = [];
  let m;
  PATH_TOKEN_RE.lastIndex = 0;
  while ((m = PATH_TOKEN_RE.exec(line)) !== null) {
    tokens.push({ kind: 'path', value: m[0] });
  }
  INLINE_CODE_RE.lastIndex = 0;
  while ((m = INLINE_CODE_RE.exec(line)) !== null) {
    const inner = m[1].trim();
    if (isActionableInlineToken(inner)) tokens.push({ kind: 'code', value: inner });
  }
  TOOL_LOG_LITERAL_RE.lastIndex = 0;
  while ((m = TOOL_LOG_LITERAL_RE.exec(line)) !== null) {
    tokens.push({ kind: 'tool-log-literal', value: m[0] });
  }
  // de-dupe by (kind, value)
  const seen = new Set();
  return tokens.filter(t => {
    const k = t.kind + ':' + t.value;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function resolveCandidates(token, repoRoot) {
  const harnessRootArg = harnessRoot();
  const norm = token.replace(/\\/g, '/').replace(/^\.\//, '');
  const candidates = new Set();
  candidates.add(path.join(repoRoot, norm));
  candidates.add(path.join(harnessRootArg, norm));
  // also try the basename — covers cases like "edited verification.md" where the path
  // is bare but the file lives in any of several run dirs. Only triggers if basename
  // is uncommon (length >= 8).
  const base = path.basename(norm);
  if (base !== norm && base.length >= 8) {
    candidates.add(path.join(harnessRootArg, base));
  }
  return Array.from(candidates);
}

function anchorPathToken(token, repoRoot) {
  const candidates = resolveCandidates(token.value, repoRoot);
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return { anchored: true, via: 'fs-exists', resolved: c }; }
    catch { /* skip */ }
  }
  return { anchored: false, via: 'fs-exists', reason: 'path-not-found' };
}

function anchorCodeToken(token, toolLogEntries) {
  if (!toolLogEntries || toolLogEntries.length === 0) {
    return { anchored: false, via: 'tool-log', reason: 'no-tool-log' };
  }
  const needle = token.value.toLowerCase();
  for (const e of toolLogEntries) {
    if (typeof e.tool_name === 'string' && e.tool_name === token.value) {
      return { anchored: true, via: 'tool-log', match: 'tool_name' };
    }
    let blob = '';
    try { blob = JSON.stringify(e.tool_input || e.summary || e).toLowerCase(); } catch { /* skip */ }
    if (blob.includes(needle)) return { anchored: true, via: 'tool-log', match: 'tool_input-substring' };
  }
  return { anchored: false, via: 'tool-log', reason: 'no-match' };
}

function anchorLiteralToken(token, toolLogPath) {
  if (!toolLogPath) return { anchored: false, via: 'literal-fs-exists', reason: 'no-tool-log-context' };
  const dir = path.dirname(toolLogPath);
  const map = {
    'tool-log.ndjson':     toolLogPath,
    'decision-log.ndjson': path.join(dir, 'decision-log.ndjson'),
    'run.json':            path.join(dir, 'run.json'),
    'route.json':          path.join(dir, 'route.json')
  };
  const candidate = map[token.value];
  if (candidate && fs.existsSync(candidate)) {
    return { anchored: true, via: 'literal-fs-exists', resolved: candidate };
  }
  return { anchored: false, via: 'literal-fs-exists', reason: 'sibling-not-found' };
}

function anchorTokens(tokens, ctx) {
  const out = [];
  for (const t of tokens) {
    let res;
    if (t.kind === 'path') res = anchorPathToken(t, ctx.repoRoot);
    else if (t.kind === 'code') res = anchorCodeToken(t, ctx.toolLogEntries);
    else res = anchorLiteralToken(t, ctx.toolLogPath);
    out.push({ token: t, ...res });
  }
  return out;
}

function classifyLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'empty' };
  if (/^#{1,6}\s/.test(trimmed)) return { kind: 'heading' };
  if (/^```/.test(trimmed)) return { kind: 'fence' };
  if (/^>\s/.test(trimmed)) return { kind: 'blockquote' };
  if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed) || /^[A-Za-z]/.test(trimmed)) return { kind: 'prose' };
  return { kind: 'prose' };
}

function analyzeFile(content, ctx) {
  const lines = content.split(/\r?\n/);
  let inFence = false;
  const perLine = [];
  let claim_lines = 0, anchored = 0, unanchored = 0;
  const flagged = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const classified = classifyLine(line);
    if (classified.kind === 'fence') { inFence = !inFence; perLine.push({ line_no: i + 1, kind: 'fence' }); continue; }
    if (inFence) { perLine.push({ line_no: i + 1, kind: 'in-fence' }); continue; }
    if (classified.kind !== 'prose') { perLine.push({ line_no: i + 1, kind: classified.kind }); continue; }
    const tokens = extractTokens(line);
    if (tokens.length === 0) { perLine.push({ line_no: i + 1, kind: 'no-claim' }); continue; }
    claim_lines += 1;
    const anchors = anchorTokens(tokens, ctx);
    const anyAnchored = anchors.some(a => a.anchored);
    if (anyAnchored) {
      anchored += 1;
      perLine.push({ line_no: i + 1, kind: 'anchored', tokens: tokens.map(t => ({ kind: t.kind, value: redactString(String(t.value)) })) });
    } else {
      unanchored += 1;
      const entry = {
        line_no: i + 1,
        kind: 'unanchored',
        snippet: redactString(line.trim().slice(0, 240)),
        tokens: tokens.map(t => ({ kind: t.kind, value: redactString(String(t.value)) })),
        reasons: anchors.map(a => a.reason || 'unknown')
      };
      flagged.push(entry);
      perLine.push(entry);
    }
  }
  return {
    schema_version: 1,
    total_lines: lines.length,
    claim_lines,
    anchored,
    unanchored,
    flagged_count: flagged.length,
    flagged,
    per_line: perLine
  };
}

function loadToolLog(p) {
  if (!p) return { entries: [], path: null };
  if (!fs.existsSync(p)) return { entries: [], path: p, missing: true };
  return { entries: readNdjson(p), path: p };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const verification = args.verification;
  if (!verification) { console.error('error: --verification <path> required'); process.exit(2); }
  const repoRoot = path.resolve(args['repo-root'] || process.cwd());
  const toolLogPath = args['tool-log'] ? path.resolve(args['tool-log']) : null;

  let content;
  try { content = fs.readFileSync(verification, 'utf8'); }
  catch (e) { console.error('error: read failed: ' + e.message); process.exit(2); }

  const log = loadToolLog(toolLogPath);
  const ctx = { repoRoot, toolLogPath: log.path, toolLogEntries: log.entries };
  const result = analyzeFile(content, ctx);
  result.file = path.basename(verification);
  result.repo_root = repoRoot;
  result.tool_log = log.path;

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`Claim-support summary for ${result.file}\n`);
    process.stdout.write(`  total lines: ${result.total_lines}\n`);
    process.stdout.write(`  claim lines: ${result.claim_lines}\n`);
    process.stdout.write(`  anchored:    ${result.anchored}\n`);
    process.stdout.write(`  unanchored:  ${result.unanchored}\n`);
    if (result.flagged.length) {
      process.stdout.write(`  flagged:\n`);
      for (const f of result.flagged) {
        process.stdout.write(`    L${f.line_no}: ${f.snippet}\n`);
        process.stdout.write(`           tokens: ${f.tokens.map(t => `${t.kind}:${t.value}`).join(', ')}\n`);
        process.stdout.write(`           reasons: ${f.reasons.join(', ')}\n`);
      }
    }
  }
  // Exit 0 if no unanchored claims; 1 if any unanchored. (Eval driver inspects JSON;
  // CLI users get the exit-code summary.)
  process.exit(result.unanchored === 0 ? 0 : 1);
}

module.exports = { extractTokens, anchorTokens, analyzeFile, classifyLine, isActionableInlineToken };

if (require.main === module) main();
