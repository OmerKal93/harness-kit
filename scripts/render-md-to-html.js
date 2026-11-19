#!/usr/bin/env node
// render-md-to-html.js — Phase 3D companion utility.
// Zero-dependency Markdown → HTML renderer. Self-contained output:
//   - inline CSS only (no external CDN, no remote fonts, no tracking)
//   - no <script> tags in output
//   - HTML-escapes all dynamic text
//
// Two modes:
//   --visual (default): extract structured signals only (title, tables, tallies,
//                       status keywords). Render as card grid + colored cells + SVG
//                       bars. DROP narrative paragraphs. Bounded by --max-bytes.
//   --full:             faithful mirror of every Markdown block.
//
// Source-of-truth contract: markdown remains authoritative. If rendering fails,
// exit non-zero so the caller keeps the .md.
//
// CLI:
//   node scripts/render-md-to-html.js --in <path.md> [--out <path.html>]
//                                     [--visual|--full]  (default: visual)
//                                     [--max-bytes <N>]  (default: 30000)
//                                     [--title <s>]
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs } = require('./_lib.js');

const PLANS_ROOT = path.join(os.homedir(), '.claude', 'plans');
const DEFAULT_MAX_BYTES = 30000;

function assertOutputContained(outPath) {
  const abs = path.resolve(outPath);
  const okOwner  = abs.toLowerCase().startsWith(path.resolve(harnessRoot()).toLowerCase() + path.sep);
  const okPlans = abs.toLowerCase().startsWith(path.resolve(PLANS_ROOT).toLowerCase() + path.sep);
  if (!okOwner && !okPlans) {
    throw new Error('output path escapes allowed roots: ' + abs);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inlineTransform(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\[\[([^\]]+?)\]\]/g, '<code>[[$1]]</code>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) => {
    const safe = /^(https?:|mailto:|#|\.\.?\/|\/|file:)/i.test(url) ? url : '#';
    return `<a href="${safe}">${txt}</a>`;
  });
  return s;
}

// =============== Status semantics ===============

const STATUS_PATTERNS = [
  { re: /\b(PASS|✅|GREEN|CLEAN|ACCEPTANCE-CLEAN|OK|TRUE)\b/i,                    cls: 'pass',  symbol: '✓' },
  { re: /\b(FAIL|❌|FAILED|ERROR|BROKEN|FALSE)\b/i,                                cls: 'fail',  symbol: '✗' },
  { re: /\b(NEAR-GREEN|NEAR_GREEN|🟢)\b/i,                                         cls: 'near',  symbol: '◉' },
  { re: /\b(PARTIAL|🟡|YELLOW|IN[_-]?PROGRESS)\b/i,                                cls: 'warn',  symbol: '⚠' },
  { re: /\b(RED|🔴|BLOCKED|NOT[_-]?READY|NOT[_-]?STARTED|⏸|HALT)\b/i,             cls: 'red',   symbol: '✗' },
  { re: /\b(NEAR-GREEN|NEAR_GREEN)\b/i,                                            cls: 'near',  symbol: '◉' }
];

function classifyStatus(text) {
  if (text == null) return null;
  const str = String(text).trim();
  if (!str) return null;
  for (const p of STATUS_PATTERNS) {
    if (p.re.test(str)) return { cls: p.cls, symbol: p.symbol };
  }
  return null;
}

// =============== Block parser ===============

function isTableSep(line) {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function parseBlocks(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    if (/^```/.test(line)) {
      const lang = (line.match(/^```(\w+)?/) || [])[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lang, lines: codeLines });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = [splitRow(line), splitRow(lines[i + 1])];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header: rows[0], body: rows.slice(2) });
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      const qLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', lines: qLines });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
        while (i < lines.length && lines[i].trim() !== ''
              && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])
              && !/^#{1,6}\s+/.test(lines[i]) && !/^```/.test(lines[i]) && !lines[i].includes('|')) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        }
      }
      blocks.push({ type: 'list', items, ordered: false });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'list', items, ordered: true });
      continue;
    }

    const pLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== ''
        && !/^#{1,6}\s+/.test(lines[i]) && !/^```/.test(lines[i])
        && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])
        && !/^\s*>\s?/.test(lines[i]) && !/^\s*(---+|\*\*\*+)\s*$/.test(lines[i])
        && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      pLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', lines: pLines });
  }
  return blocks;
}

// =============== Visual extraction ===============

function extractKeyValueTallies(blocks) {
  // Scan tables for `| Label | Value |` two-col shape with status / numeric values.
  const tallies = [];
  for (const b of blocks) {
    if (b.type !== 'table') continue;
    if (b.header.length === 2) {
      for (const row of b.body) {
        if (row.length !== 2) continue;
        const label = row[0].replace(/[`*]/g, '');
        const value = row[1].replace(/[`*]/g, '');
        const status = classifyStatus(value);
        const numMatch = /(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+))?/.exec(value);
        tallies.push({
          label, value, status,
          number: numMatch ? parseFloat(numMatch[1]) : null,
          denominator: numMatch && numMatch[2] ? parseFloat(numMatch[2]) : null
        });
      }
    }
  }
  return tallies;
}

function extractStatusTables(blocks) {
  return blocks.filter(b => b.type === 'table' && b.header.length >= 2);
}

function extractTitle(blocks) {
  const h1 = blocks.find(b => b.type === 'heading' && b.level === 1);
  return h1 ? h1.text : 'Document';
}

function extractSubtitle(blocks) {
  // Quote blocks under h1 often carry metadata.
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === 'quote') {
      out.push(blocks[i].lines.slice(0, 6).join(' '));
    } else if (blocks[i].type === 'heading' && blocks[i].level === 2) {
      break;
    }
  }
  return out.join(' ').slice(0, 400);
}

function extractTopLevelSections(blocks) {
  const sections = [];
  let current = null;
  for (const b of blocks) {
    if (b.type === 'heading' && b.level === 2) {
      if (current) sections.push(current);
      current = { title: b.text, blocks: [] };
    } else if (current) {
      current.blocks.push(b);
    }
  }
  if (current) sections.push(current);
  return sections;
}

// =============== Visual renderer ===============

function renderStatusBadge(status, text) {
  if (!status) return escapeHtml(text);
  return `<span class="badge b-${status.cls}">${status.symbol} ${escapeHtml(text)}</span>`;
}

function renderTalliesGrid(tallies) {
  if (tallies.length === 0) return '';
  let out = '<div class="grid">\n';
  let n = 0;
  for (const t of tallies) {
    if (n >= 16) break;
    const cls = t.status ? `card c-${t.status.cls}` : 'card';
    let valueHtml;
    if (t.status) {
      valueHtml = `<div class="cv"><span class="sym">${t.status.symbol}</span></div>`;
    } else if (t.denominator) {
      const pct = Math.round((t.number / t.denominator) * 100);
      valueHtml = `<div class="cv">${escapeHtml(t.value)}</div><div class="bar"><span style="width:${pct}%"></span></div>`;
    } else {
      valueHtml = `<div class="cv">${escapeHtml(t.value)}</div>`;
    }
    out += `<div class="${cls}"><div class="cl">${escapeHtml(t.label)}</div>${valueHtml}</div>\n`;
    n++;
  }
  out += '</div>';
  return out;
}

function renderColoredTable(t) {
  let html = '<table><thead><tr>';
  for (const c of t.header) html += `<th>${inlineTransform(c)}</th>`;
  html += '</tr></thead><tbody>';
  for (const row of t.body) {
    html += '<tr>';
    for (const c of row) {
      const status = classifyStatus(c);
      if (status) {
        html += `<td class="s-${status.cls}"><span class="sym">${status.symbol}</span> ${inlineTransform(c)}</td>`;
      } else {
        html += `<td>${inlineTransform(c)}</td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

function renderSvgBar(label, ratio, max) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const w = 300;
  const fill = Math.round((ratio) * w);
  return `<div class="svg-row"><div class="sl">${escapeHtml(label)}</div>` +
    `<svg width="${w}" height="14" viewBox="0 0 ${w} 14"><rect width="${w}" height="14" rx="2" fill="#eee"/>` +
    `<rect width="${fill}" height="14" rx="2" fill="${pct >= 80 ? '#2e7d32' : pct >= 50 ? '#f57c00' : '#c62828'}"/></svg>` +
    `<div class="sv">${pct}%</div></div>`;
}

function pickCharts(tallies) {
  // Pick numeric tallies with denominator → render SVG bars.
  const charts = [];
  for (const t of tallies) {
    if (t.number != null && t.denominator) {
      charts.push(renderSvgBar(t.label, t.number / t.denominator));
      if (charts.length >= 6) break;
    }
  }
  return charts.length ? `<div class="charts">${charts.join('')}</div>` : '';
}

function renderSection(section, budget) {
  if (budget.remaining <= 200) return '';
  const tables = section.blocks.filter(b => b.type === 'table');
  if (tables.length === 0 && !/\b(status|gate|invariant|score|result|summary)\b/i.test(section.title)) {
    // Skip prose-only sections to preserve visual budget.
    return '';
  }
  let html = `<section><h2>${escapeHtml(section.title)}</h2>\n`;
  for (const t of tables) {
    if (budget.remaining <= 200) break;
    const piece = renderColoredTable(t);
    if (piece.length > budget.remaining) break;
    html += piece + '\n';
    budget.remaining -= piece.length;
  }
  html += '</section>';
  return html;
}

function buildVisual(md, opts) {
  const blocks = parseBlocks(md);
  const title = extractTitle(blocks);
  const subtitle = extractSubtitle(blocks);
  const tallies = extractKeyValueTallies(blocks);
  const sections = extractTopLevelSections(blocks);

  const headerStatus = classifyStatus(subtitle) || classifyStatus(title);

  const budget = { remaining: (opts.maxBytes || DEFAULT_MAX_BYTES) - 3500 };

  let body = `<header><h1>${escapeHtml(title)}</h1>`;
  if (headerStatus) body += `<div class="hero-badge badge b-${headerStatus.cls}">${headerStatus.symbol} ${escapeHtml(headerStatus.cls.toUpperCase())}</div>`;
  if (subtitle) body += `<p class="sub">${inlineTransform(subtitle.slice(0, 240))}</p>`;
  body += '</header>';
  budget.remaining -= body.length;

  const charts = pickCharts(tallies);
  if (charts) { body += charts; budget.remaining -= charts.length; }

  const grid = renderTalliesGrid(tallies);
  if (grid) { body += grid; budget.remaining -= grid.length; }

  for (const sec of sections) {
    if (budget.remaining <= 200) break;
    const html = renderSection(sec, budget);
    body += html;
  }

  body += `<footer>visual mirror — source-of-truth: <code>${escapeHtml(path.basename(opts.sourceMdPath || ''))}</code> · rendered ${escapeHtml(new Date().toISOString())} · mode <code>visual</code> · cap ${opts.maxBytes || DEFAULT_MAX_BYTES} bytes</footer>`;
  return body;
}

// =============== Full-fidelity renderer (legacy) ===============

function renderFull(md) {
  const blocks = parseBlocks(md);
  const out = [];
  for (const b of blocks) {
    if (b.type === 'heading') out.push(`<h${b.level}>${inlineTransform(b.text)}</h${b.level}>`);
    else if (b.type === 'paragraph') out.push(`<p>${b.lines.map(inlineTransform).join('<br>\n')}</p>`);
    else if (b.type === 'hr') out.push('<hr>');
    else if (b.type === 'code') out.push(`<pre><code>${b.lines.map(escapeHtml).join('\n')}</code></pre>`);
    else if (b.type === 'table') out.push(renderColoredTable(b));
    else if (b.type === 'quote') out.push(`<blockquote>${b.lines.map(l => `<p>${inlineTransform(l)}</p>`).join('')}</blockquote>`);
    else if (b.type === 'list') {
      const tag = b.ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${b.items.map(it => `<li>${inlineTransform(it)}</li>`).join('')}</${tag}>`);
    }
  }
  return out.join('\n');
}

// =============== Style ===============

const STYLE_VISUAL = `
  body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; max-width: 70rem; margin: 1.5rem auto; padding: 0 1rem; color: #1a1a1a; background: #f5f5f7; line-height: 1.4; }
  header { background: linear-gradient(135deg, #2c3e50, #34495e); color: #fff; padding: 1.2rem 1.5rem; border-radius: 8px; margin-bottom: 1rem; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  header h1 { margin: 0 0 0.4rem 0; font-size: 1.4rem; line-height: 1.2; }
  header .sub { font-size: 0.78rem; opacity: 0.85; margin: 0; }
  header .hero-badge { display: inline-block; margin: 0.3rem 0; font-size: 0.85rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.6rem; margin: 1rem 0; }
  .card { background: #fff; padding: 0.7rem 0.8rem; border-radius: 6px; border: 1px solid #e0e0e0; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .card .cl { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: #666; margin-bottom: 0.3rem; }
  .card .cv { font-size: 1.1rem; font-weight: 600; color: #222; }
  .card .sym { font-size: 1.4rem; }
  .card.c-pass { border-left: 4px solid #2e7d32; }
  .card.c-fail { border-left: 4px solid #c62828; }
  .card.c-warn { border-left: 4px solid #f57c00; }
  .card.c-near { border-left: 4px solid #558b2f; }
  .card.c-red  { border-left: 4px solid #b71c1c; }
  .card .bar { background: #eee; height: 6px; border-radius: 3px; margin-top: 0.4rem; overflow: hidden; }
  .card .bar span { display: block; height: 100%; background: #1976d2; }
  .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.72rem; font-weight: 600; }
  .b-pass { background: #c8e6c9; color: #1b5e20; }
  .b-fail { background: #ffcdd2; color: #b71c1c; }
  .b-warn { background: #ffe0b2; color: #e65100; }
  .b-near { background: #dcedc8; color: #33691e; }
  .b-red  { background: #ef9a9a; color: #b71c1c; }
  section { margin: 1.2rem 0; background: #fff; padding: 0.8rem 1rem; border-radius: 6px; border: 1px solid #e8e8e8; }
  section h2 { margin: 0 0 0.6rem 0; font-size: 0.95rem; color: #2c3e50; padding-bottom: 0.3rem; border-bottom: 1px solid #eee; }
  table { border-collapse: collapse; width: 100%; font-size: 0.78rem; }
  th, td { border: 1px solid #e0e0e0; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
  th { background: #f0f3f7; font-weight: 600; color: #34495e; }
  td.s-pass { background: #e8f5e8; }
  td.s-fail { background: #ffebee; }
  td.s-warn { background: #fff3e0; }
  td.s-near { background: #f1f8e9; }
  td.s-red  { background: #ffcdd2; }
  td .sym  { font-weight: 700; margin-right: 0.2rem; }
  code { background: #f0f0f0; padding: 0.1em 0.25em; border-radius: 2px; font-family: ui-monospace, Consolas, monospace; font-size: 0.85em; }
  .charts { margin: 1rem 0; }
  .svg-row { display: flex; align-items: center; gap: 0.6rem; margin: 0.25rem 0; font-size: 0.75rem; }
  .svg-row .sl { flex: 0 0 12rem; color: #444; }
  .svg-row .sv { color: #222; font-weight: 600; width: 3rem; text-align: right; }
  footer { margin-top: 1.5rem; padding: 0.6rem 0; font-size: 0.7rem; color: #888; border-top: 1px solid #ddd; text-align: center; }
`;

const STYLE_FULL = `
  body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1.5rem; color: #1d1d1d; line-height: 1.55; background: #fafafa; }
  h1, h2, h3 { line-height: 1.25; margin-top: 1.5em; margin-bottom: 0.5em; }
  h1 { border-bottom: 2px solid #ccc; padding-bottom: .3em; }
  code { background: #f0f0f0; padding: 0.15em 0.3em; border-radius: 3px; font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; }
  pre { background: #f4f4f4; padding: 1em; border-radius: 5px; overflow-x: auto; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; font-size: 0.9em; }
  th, td { border: 1px solid #ccc; padding: 0.5em 0.8em; text-align: left; }
  th { background: #efefef; }
  td.s-pass { background: #e8f5e8; } td.s-fail { background: #ffebee; }
  td.s-warn { background: #fff3e0; } td.s-near { background: #f1f8e9; }
  td.s-red  { background: #ffcdd2; }
  td .sym { font-weight: 700; margin-right: 0.2rem; }
  blockquote { border-left: 4px solid #ccc; margin: 1em 0; padding: 0.4em 1em; background: #f5f5f5; color: #555; }
  hr { border: none; border-top: 1px solid #ccc; margin: 2em 0; }
`;

function wrapHtml(title, body, style) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${style}</style></head>
<body>${body}</body></html>
`;
}

function render(md, opts) {
  opts = opts || {};
  const mode = opts.mode || 'visual';
  const title = opts.title || 'Document';
  if (mode === 'full') {
    return wrapHtml(title, renderFull(md), STYLE_FULL);
  }
  const body = buildVisual(md, opts);
  let html = wrapHtml(title, body, STYLE_VISUAL);
  const cap = opts.maxBytes || DEFAULT_MAX_BYTES;
  if (html.length > cap) {
    // Hard cap: drop trailing characters cleanly + close tags.
    html = html.slice(0, cap - 200) + '\n<footer>[truncated to ' + cap + ' bytes]</footer></body></html>';
  }
  return html;
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args.in || args.in === true) {
    console.error('error: --in <path.md> required');
    process.exit(2);
  }
  const inPath = String(args.in);
  let outPath = args.out && args.out !== true ? String(args.out) : null;
  if (!outPath) outPath = inPath.replace(/\.md$/i, '') + '.html';

  let md;
  try { md = fs.readFileSync(inPath, 'utf8'); }
  catch (e) { console.error('error: cannot read input: ' + e.message); process.exit(1); }

  const h1 = /^#\s+(.+)$/m.exec(md);
  const title = args.title && args.title !== true ? String(args.title) : (h1 ? h1[1].trim() : path.basename(inPath, '.md'));

  const mode = args.full ? 'full' : 'visual';
  const maxBytes = args['max-bytes'] ? parseInt(String(args['max-bytes']), 10) : DEFAULT_MAX_BYTES;

  let html;
  try { html = render(md, { title, sourceMdPath: inPath, mode, maxBytes }); }
  catch (e) { console.error('error: render failed: ' + e.message); process.exit(1); }

  try {
    assertOutputContained(outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html);
  } catch (e) { console.error('error: write failed: ' + e.message); process.exit(1); }

  process.stdout.write(JSON.stringify({
    ok: true, in: inPath, out: outPath, title, mode,
    bytes_written: html.length, max_bytes: maxBytes,
    under_cap: html.length <= maxBytes
  }, null, 2) + '\n');
  process.exit(0);
}

module.exports = { render, parseBlocks, classifyStatus };

if (require.main === module) main();
