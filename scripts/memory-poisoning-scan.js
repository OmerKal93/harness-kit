#!/usr/bin/env node
// memory-poisoning-scan.js — Reusable poisoning scanner.
// Library: const { scanContent, computeFileClass, loadPoisoningPolicy } = require('./memory-poisoning-scan.js')
// CLI:     node memory-poisoning-scan.js --file <path>  → prints JSON
//
// Per reference/memory-poisoning-policy.md.
// Patterns + classification + file-class rules live in
// config/alignment-risk-policy.json.
//
// Honors kill switch. Zero network. Deterministic.
//
// STATUS (verified 2026-06-26): LIBRARY / CLI / EVAL tooling only. It is NOT automatically
// run on every memory capture or context write — no hook or capture script invokes it in the
// live flow today. `poisoning_scan.enabled: true` in alignment-risk-policy.json only means the
// scanner WILL flag when CALLED; it does not mean writes are scanned automatically. Wiring it
// into the capture path is out of scope for this batch.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, readJson, globMatch } = require('./_lib.js');

const POLICY_PATH = path.join(harnessRoot(), 'config', 'alignment-risk-policy.json');

let _policy = null;
function loadPoisoningPolicy() {
  if (_policy) return _policy;
  _policy = readJson(POLICY_PATH, { poisoning_scan: { enabled: false, patterns: [], classification: {}, file_class_rules: [], default_file_class: 'other', actions_by_file_class: {} } });
  // Compile regexes once
  for (const p of (_policy.poisoning_scan.patterns || [])) {
    try { p._re = new RegExp(p.pattern, p.flags || 'gi'); }
    catch { p._re = null; }
  }
  return _policy;
}

function expandHome(p) {
  if (!p) return p;
  return p.replace(/^~\//, os.homedir() + '/').replace(/^~\\/, os.homedir() + '\\');
}

function computeFileClass(filePath, policy) {
  const norm = String(filePath).replace(/\\/g, '/');
  for (const rule of (policy.poisoning_scan.file_class_rules || [])) {
    const g = expandHome(rule.glob).replace(/\\/g, '/');
    if (globMatch(g, norm)) return rule.class;
  }
  return policy.poisoning_scan.default_file_class || 'other';
}

// Detect fenced code blocks: returns array of [start, end] line-number ranges (1-based).
function findFencedRanges(lines) {
  const ranges = [];
  let openAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      if (openAt === -1) openAt = i + 1;
      else { ranges.push([openAt, i + 1]); openAt = -1; }
    }
  }
  return ranges;
}

// v2 marker-FP refinement (Phase 4 Batch 1):
// - frontmatter check is unchanged (frontmatter is the start of the file).
// - HTML-comment marker is only honored when it is NOT inside a fenced code
//   block OR an inline backtick span. Otherwise a doc that *describes* the
//   marker syntax inside an example block (e.g. memory-poisoning-policy.md)
//   falsely flips security_marker_present, which short-circuits poisoning
//   classification for run/memory artifacts and can be exploited.
function hasSecurityExampleMarker(content) {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (fm && /\bsecurity_example:\s*true\b/i.test(fm[1])) return true;
  const markerRe = /<!--\s*security-example\s*-->/gi;
  const lines = content.split(/\r?\n/);
  const fencedRanges = findFencedRanges(lines);
  let m;
  while ((m = markerRe.exec(content)) !== null) {
    // line of this match (1-based)
    let lineIdx = 0;
    for (let i = 0; i < m.index; i++) if (content[i] === '\n') lineIdx++;
    const lineNum = lineIdx + 1;
    let insideFence = false;
    for (const [s, e] of fencedRanges) {
      if (lineNum > s && lineNum < e) { insideFence = true; break; }
    }
    if (insideFence) continue;
    // inline backtick: count backticks before the match start on this line
    const line = lines[lineIdx] || '';
    const lineStart = m.index - (m.index - content.lastIndexOf('\n', m.index - 1) - 1);
    const colInLine = m.index - lineStart;
    const prefix = line.slice(0, colInLine);
    const ticks = (prefix.match(/`/g) || []).length;
    if (ticks % 2 === 1) continue; // inside inline-code span
    return true; // honored marker
  }
  return false;
}

function classifyMatch(content, lines, lineIdx, matchStart, matchEnd, fencedRanges, securityMarker) {
  const markers = [];
  if (securityMarker) markers.push('security_example_marker');
  // fenced code
  const lineNum = lineIdx + 1;
  for (const [s, e] of fencedRanges) {
    if (lineNum > s && lineNum < e) { markers.push('inside_code_fence'); break; }
  }
  const line = lines[lineIdx] || '';
  // inline backtick spans on this line
  // crude: split by backtick; matched substring positions in line span an odd number of segments → inside
  const beforeMatchInLine = line.indexOf(content.slice(matchStart, matchEnd));
  if (beforeMatchInLine >= 0) {
    const prefix = line.slice(0, beforeMatchInLine);
    const ticks = (prefix.match(/`/g) || []).length;
    if (ticks % 2 === 1) markers.push('inside_inline_code');
  }
  // preceded by example markers in same line
  if (/\b(e\.g\.|i\.e\.|example:|such as)\b/i.test(line)) markers.push('preceded_by_eg_example_such_as');
  // blockquote line
  if (/^\s*>/.test(line)) markers.push('blockquote_line');
  // quoted string: simple heuristic — match preceded by " or ' on same line, with closing quote after
  if (beforeMatchInLine > 0) {
    const before = line.slice(0, beforeMatchInLine);
    const after  = line.slice(beforeMatchInLine);
    if ((/["][^"]*$/.test(before) && /^[^"]*"/.test(after)) ||
        (/['][^']*$/.test(before) && /^[^']*'/.test(after))) {
      markers.push('inside_quoted_string');
    }
  }
  const classification = markers.length > 0 ? 'example' : 'instruction';
  return { classification, markers };
}

function scanContent(content, filePath, policyArg) {
  const policy = policyArg || loadPoisoningPolicy();
  const scan = policy.poisoning_scan || {};
  if (!scan.enabled) return { enabled: false, file_class: 'other', hits: [], action: 'clean' };

  const file_class = computeFileClass(filePath, policy);
  const lines = content.split(/\r?\n/);
  const fencedRanges = findFencedRanges(lines);
  const securityMarker = hasSecurityExampleMarker(content);

  const hits = [];
  for (const pat of (scan.patterns || [])) {
    if (!pat._re) continue;
    pat._re.lastIndex = 0;
    let m;
    while ((m = pat._re.exec(content)) !== null) {
      // resolve to line + position
      const idx = m.index;
      // count newlines before idx
      let lineStart = 0;
      let lineIdx = 0;
      for (let i = 0; i < idx; i++) {
        if (content[i] === '\n') { lineIdx++; lineStart = i + 1; }
      }
      const matchEnd = idx + m[0].length;
      const cls = classifyMatch(content, lines, lineIdx, idx, matchEnd, fencedRanges, securityMarker);
      hits.push({
        rule_id: pat.id,
        line: lineIdx + 1,
        snippet: m[0].slice(0, 80),
        classification: cls.classification,
        markers_matched: cls.markers
      });
      if (!pat._re.global) break;
      if (hits.length > 200) break; // safety cap
    }
    if (hits.length > 200) break;
  }

  // determine action per file_class
  const rules = scan.actions_by_file_class || {};
  const fc = rules[file_class] || {};
  let action = 'clean';

  const anyInstruction = hits.some(h => h.classification === 'instruction');
  const anyExample = hits.some(h => h.classification === 'example');

  if (file_class === 'reference_or_security_doc') {
    action = hits.length > 0 ? 'warn' : 'clean';
  } else if (file_class === 'run_or_memory_artifact') {
    if (anyInstruction) action = 'exclude';
    else if (anyExample) action = 'warn';
    else action = 'clean';
  } else {
    // other
    if (anyInstruction) action = 'warn';
    else action = 'clean';
  }

  return {
    enabled: true,
    file_class,
    hits,
    action,
    instruction_hits: hits.filter(h => h.classification === 'instruction').length,
    example_hits: anyExample ? hits.filter(h => h.classification === 'example').length : 0,
    security_marker_present: securityMarker
  };
}

module.exports = { scanContent, computeFileClass, loadPoisoningPolicy };

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args.file) { console.error('error: --file <path> required'); process.exit(2); }
  const filePath = String(args.file);
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { console.error('error: read failed: ' + e.message); process.exit(2); }
  const result = scanContent(content, filePath);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.action === 'exclude' ? 2 : 0);
}

if (require.main === module) main();
