#!/usr/bin/env node
// detect-context-drift.js — Phase 5 Batch 2.
// Detects docs-vs-code conflicts and stale sources in a context pack by comparing
// declared provenance (mtime + sha256 + source) against the current filesystem state.
//
// Patterns:
//   stale_source        — declared mtime drift > tier-staleness threshold
//   content_mismatch    — recomputed SHA256 ≠ declared sha256
//   doc_code_conflict   — two sections share a "mentions" identifier without conflict_resolution
//   missing_provenance  — section lacks source/mtime/sha256
//   over_budget         — total_tokens > per_task_type_budget
//   forbidden_glob      — section path matches config/context-policy.json#forbidden_sections
//
// Classification only — exits 0 always. advisory_only: true in every output.
//
// STATUS (verified 2026-06-26): this is a VALIDATOR CAPABILITY, not a live pipeline check.
// It expects a STRUCTURED, PROVENANCE-TAGGED pack (JSON with
// sections[].provenance.{source,sha256,mtime,trust_tier}, plus .mentions / .conflict_resolution).
// The current scripts/build-context-pack.js emits a MARKDOWN context-pack.md WITHOUT those
// provenance fields, so nothing in the live /harness-run flow feeds this detector. Run it
// manually or in evals against a hand-built JSON pack; staleness/provenance is NOT enforced
// end-to-end today. (Emitting provenance is out of scope for this batch.)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, readJson, globMatch } = require('./_lib.js');
const { redactString } = require('./redact.js');

const DEFAULT_STALENESS = {
  source_of_truth:    30,
  curated_memory:     30,
  run_artifact:       14,
  curated_external:    7,
  untrusted_external:  1
};

function loadPolicy(policyPath) {
  const p = policyPath || path.join(harnessRoot(), 'config', 'context-policy.json');
  return readJson(p, {});
}

function resolveSourcePath(rawSource, repoRoot) {
  if (!rawSource) return null;
  if (path.isAbsolute(rawSource)) return rawSource;
  const root = repoRoot || harnessRoot();
  return path.join(root, rawSource);
}

function detectStaleSource(pack, opts) {
  opts = opts || {};
  const policy = opts.policy || {};
  const staleness = policy.drift_staleness_days || DEFAULT_STALENESS;
  const now = pack._now ? new Date(pack._now).getTime() : Date.now();
  const evidence = [];
  for (const s of pack.sections || []) {
    const declared = s.provenance && s.provenance.mtime;
    const tier = s.trust_tier || (s.provenance && s.provenance.trust_tier);
    const threshold = staleness[tier] || 7;
    const src = s.provenance && s.provenance.source;
    if (!declared || !src) continue;
    let currentMtimeMs;
    const resolved = resolveSourcePath(src, opts.repoRoot);
    try {
      currentMtimeMs = fs.statSync(resolved).mtimeMs;
    } catch {
      // Source missing — use declared mtime as fallback so we still detect declared-age staleness.
      currentMtimeMs = null;
    }
    const declaredMs = new Date(declared).getTime();
    if (!Number.isFinite(declaredMs)) continue;
    const refMs = currentMtimeMs != null ? Math.max(currentMtimeMs, declaredMs) : declaredMs;
    const ageDays = (now - refMs) / (1000 * 60 * 60 * 24);
    if (ageDays > threshold) {
      evidence.push({
        section_id: s.id || null,
        source: redactString(src),
        tier,
        age_days: Number(ageDays.toFixed(1)),
        threshold_days: threshold
      });
    }
  }
  if (evidence.length === 0) return { detected: false, severity: 'low', evidence: [] };
  const severity = evidence.length > 2 ? 'high' : 'medium';
  return { detected: true, severity, evidence };
}

function detectContentMismatch(pack, opts) {
  opts = opts || {};
  const evidence = [];
  for (const s of pack.sections || []) {
    const declared = s.provenance && s.provenance.sha256;
    const src = s.provenance && s.provenance.source;
    if (!declared || !src) continue;
    const resolved = resolveSourcePath(src, opts.repoRoot);
    let actual;
    try {
      const buf = fs.readFileSync(resolved);
      actual = crypto.createHash('sha256').update(buf).digest('hex');
    } catch {
      continue;
    }
    if (actual !== declared) {
      evidence.push({
        section_id: s.id || null,
        source: redactString(src),
        declared_sha256: declared.slice(0, 16) + '...',
        actual_sha256: actual.slice(0, 16) + '...'
      });
    }
  }
  if (evidence.length === 0) return { detected: false, severity: 'low', evidence: [] };
  const severity = evidence.length > 1 ? 'high' : 'medium';
  return { detected: true, severity, evidence };
}

function detectDocCodeConflict(pack) {
  const sections = pack.sections || [];
  const byMention = new Map();
  for (const s of sections) {
    const mentions = Array.isArray(s.mentions) ? s.mentions : [];
    for (const m of mentions) {
      if (!byMention.has(m)) byMention.set(m, []);
      byMention.get(m).push(s);
    }
  }
  const evidence = [];
  for (const [m, group] of byMention) {
    if (group.length < 2) continue;
    const kinds = new Set(group.map(s => s.kind || 'unknown'));
    if (!(kinds.has('doc') && kinds.has('code'))) continue;
    const hasResolution = group.every(s => !!s.conflict_resolution);
    if (hasResolution) continue;
    evidence.push({
      identifier: redactString(m),
      section_ids: group.map(s => s.id || null),
      kinds: Array.from(kinds)
    });
  }
  if (evidence.length === 0) return { detected: false, severity: 'low', evidence: [] };
  return { detected: true, severity: evidence.length > 1 ? 'high' : 'medium', evidence };
}

function detectMissingProvenance(pack) {
  const evidence = [];
  const sections = pack.sections || [];
  for (const s of sections) {
    const p = s.provenance || {};
    const missing = [];
    if (!p.source) missing.push('source');
    if (!p.mtime) missing.push('mtime');
    if (!p.sha256) missing.push('sha256');
    if (missing.length > 0) {
      evidence.push({ section_id: s.id || null, missing });
    }
  }
  if (evidence.length === 0) return { detected: false, severity: 'low', evidence: [] };
  const ratio = evidence.length / sections.length;
  const severity = ratio > 0.5 ? 'high' : (ratio > 0.2 ? 'medium' : 'low');
  return { detected: true, severity, evidence };
}

function detectOverBudget(pack, opts) {
  opts = opts || {};
  const policy = opts.policy || {};
  const budgets = policy.per_task_type_budgets || {};
  const taskType = pack.task_type || 'research';
  const budget = budgets[taskType] || budgets._default_total_tokens || 32000;
  let total = pack.total_tokens;
  if (typeof total !== 'number') {
    total = (pack.sections || []).reduce((acc, s) => acc + (typeof s.tokens === 'number' ? s.tokens : 0), 0);
  }
  if (total <= budget) return { detected: false, severity: 'low', evidence: [] };
  const severity = total > budget * 1.5 ? 'high' : 'medium';
  return {
    detected: true,
    severity,
    evidence: [{ task_type: taskType, total_tokens: total, budget, overage_pct: Number((((total / budget) - 1) * 100).toFixed(0)) }]
  };
}

function detectForbiddenGlob(pack, opts) {
  opts = opts || {};
  const policy = opts.policy || {};
  const forbidden = (policy.forbidden_sections || []).map(e => e.glob || e);
  const evidence = [];
  for (const s of pack.sections || []) {
    const src = (s.provenance && s.provenance.source) || s.source || '';
    if (!src) continue;
    for (const g of forbidden) {
      if (globMatch(g, src)) {
        evidence.push({ section_id: s.id || null, source: redactString(src), glob: g });
        break;
      }
    }
  }
  if (evidence.length === 0) return { detected: false, severity: 'low', evidence: [] };
  return { detected: true, severity: 'high', evidence };
}

function detectDrift(pack, opts) {
  opts = opts || {};
  const policy = opts.policy || loadPolicy(opts.policyPath);
  const ctx = { policy, repoRoot: opts.repoRoot };
  const patterns = {
    stale_source:       detectStaleSource(pack, ctx),
    content_mismatch:   detectContentMismatch(pack, ctx),
    doc_code_conflict:  detectDocCodeConflict(pack),
    missing_provenance: detectMissingProvenance(pack),
    over_budget:        detectOverBudget(pack, ctx),
    forbidden_glob:     detectForbiddenGlob(pack, ctx)
  };
  const detected = Object.values(patterns).filter(p => p.detected).length;
  let recommended_action = 'advisory';
  if (patterns.forbidden_glob.detected) {
    recommended_action = 'rebuild_pack';
  } else if (patterns.content_mismatch.detected || patterns.over_budget.detected) {
    recommended_action = 'refresh_pack';
  }
  return {
    schema_version: 1,
    advisory_only: true,
    pack_path: redactString(opts.packPath || pack.pack_path || ''),
    drift_detected: detected,
    patterns,
    recommended_action,
    warnings: []
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args.pack || args.pack === true) {
    console.error('error: --pack <path-to-context-pack.json> required');
    process.exit(2);
  }
  const packPath = String(args.pack);
  let pack;
  try { pack = JSON.parse(fs.readFileSync(packPath, 'utf8')); }
  catch (e) {
    console.log(JSON.stringify({ schema_version: 1, advisory_only: true, error: 'pack unreadable: ' + e.message }, null, 2));
    process.exit(0);
  }
  const result = detectDrift(pack, { repoRoot: args['repo-root'], policyPath: args.policy, packPath });
  if (args.json !== false) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`drift: ${result.drift_detected} patterns; action: ${result.recommended_action}\n`);
  }
  process.exit(0);
}

module.exports = {
  detectDrift,
  detectStaleSource,
  detectContentMismatch,
  detectDocCodeConflict,
  detectMissingProvenance,
  detectOverBudget,
  detectForbiddenGlob
};

if (require.main === module) main();
