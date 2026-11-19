#!/usr/bin/env node
// validate-approval-token.js — Phase 5 Batch 1.
// Validates a typed approval line against config/approval-registry.json.
// Exact-match first; template expansion second with placeholder regex per entry.
// Classification only — recognition does NOT execute the approved action.
//
// Library:
//   const { validate, listTokens } = require('./validate-approval-token.js')
//   validate("approve harnesskit gbrain mcp")
//     → { recognized: true, entry: {...}, match_type: "exact" }
//   validate("approve harnesskit tier L1")
//     → { recognized: true, entry: {...}, match_type: "template", placeholders: { "<N>": "1" } }
//   validate("approve gbrain import")
//     → { recognized: false, entry: null, reason: "no-match" }
//
// CLI:
//   node scripts/validate-approval-token.js --token "<literal line>" [--json]
//
// Exit codes: 0 recognized, 1 not recognized. Honors kill switch (exit 0 silently).
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs } = require('./_lib.js');
const { redactString } = require('./redact.js');

const REGISTRY_PATH = path.join(harnessRoot(), 'config', 'approval-registry.json');
let _registryCache = null;

function loadRegistry(injected) {
  if (injected) return injected;
  if (_registryCache) return _registryCache;
  try {
    _registryCache = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (e) {
    _registryCache = { schema_version: 1, tokens: [], _load_error: e.message };
  }
  return _registryCache;
}

function listTokens(injected) {
  const reg = loadRegistry(injected);
  return (reg.tokens || []).map(t => ({ id: t.id, token: t.token, template: !!t.template }));
}

function exactMatch(line, entry) {
  if (entry.template) return false;
  return entry.token === line;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function templateMatch(line, entry) {
  if (!entry.template) return null;
  const placeholders = entry.placeholders || [];
  if (placeholders.length === 0) return null;
  // Build regex from the entry's token literal, escaping non-placeholder text
  // and substituting each placeholder with its per-entry pattern (default \S+).
  let pattern = entry.token;
  // Replace placeholders with sentinels first so escapeRegex doesn't mangle them.
  const sentinels = {};
  for (let i = 0; i < placeholders.length; i++) {
    const ph = placeholders[i];
    const sentinel = `PH${i}`;
    sentinels[sentinel] = ph;
    pattern = pattern.split(ph).join(sentinel);
  }
  pattern = escapeRegex(pattern);
  // Restore sentinels into capture groups using each placeholder's pattern.
  const phPatterns = entry.placeholder_patterns || {};
  const orderedPlaceholders = [];
  for (const [sentinel, ph] of Object.entries(sentinels)) {
    const esc = escapeRegex(sentinel);
    const phPat = phPatterns[ph] || '\\S+';
    // The phPat may carry ^ and $ anchors meaning "at full placeholder span"; strip them
    // since we are embedding the pattern in the middle of the line.
    const inner = phPat.replace(/^\^/, '').replace(/\$$/, '');
    pattern = pattern.replace(esc, '(' + inner + ')');
    orderedPlaceholders.push(ph);
  }
  const re = new RegExp('^' + pattern + '$');
  const m = re.exec(line);
  if (!m) return null;
  const placeholdersOut = {};
  for (let i = 0; i < orderedPlaceholders.length; i++) {
    placeholdersOut[orderedPlaceholders[i]] = m[i + 1];
  }
  return placeholdersOut;
}

function validate(line, injectedRegistry) {
  if (typeof line !== 'string' || line.length === 0) {
    return { recognized: false, entry: null, reason: 'empty-input' };
  }
  if (line !== line.trim()) {
    return { recognized: false, entry: null, reason: 'whitespace-padding' };
  }
  if (/\s{2,}/.test(line)) {
    return { recognized: false, entry: null, reason: 'multiple-internal-whitespace' };
  }
  const reg = loadRegistry(injectedRegistry);
  const tokens = reg.tokens || [];
  // Exact match first
  for (const entry of tokens) {
    if (exactMatch(line, entry)) {
      return { recognized: true, entry, match_type: 'exact' };
    }
  }
  // Template match second
  for (const entry of tokens) {
    if (!entry.template) continue;
    const placeholders = templateMatch(line, entry);
    if (placeholders) {
      return { recognized: true, entry, match_type: 'template', placeholders };
    }
  }
  return { recognized: false, entry: null, reason: 'no-match' };
}

function redactEntry(entry) {
  if (!entry) return null;
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === 'string') out[k] = redactString(v);
    else out[k] = v;
  }
  return out;
}

function redactResult(result) {
  const out = { recognized: result.recognized };
  if (result.match_type) out.match_type = result.match_type;
  if (result.entry) out.entry = redactEntry(result.entry);
  if (result.placeholders) {
    out.placeholders = {};
    for (const [k, v] of Object.entries(result.placeholders)) {
      out.placeholders[k] = typeof v === 'string' ? redactString(v) : v;
    }
  }
  if (result.reason) out.reason = result.reason;
  return out;
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args.token || args.token === true) {
    console.error('error: --token "<literal line>" required');
    process.exit(2);
  }
  const result = validate(String(args.token));
  const redacted = redactResult(result);

  if (args.json !== false) {
    process.stdout.write(JSON.stringify(redacted, null, 2) + '\n');
  } else {
    if (result.recognized) {
      process.stdout.write(`RECOGNIZED (${result.match_type}): ${result.entry.id}\n`);
      if (result.placeholders) {
        for (const [k, v] of Object.entries(result.placeholders)) {
          process.stdout.write(`  ${k} = ${v}\n`);
        }
      }
    } else {
      process.stdout.write(`NOT RECOGNIZED — ${result.reason}\n`);
    }
  }
  process.exit(result.recognized ? 0 : 1);
}

module.exports = { validate, listTokens, loadRegistry };

if (require.main === module) main();
