#!/usr/bin/env node
// score-context-pack.js — Phase 5 Batch 2.
// Scores a context pack across 8 dimensions per reference/context-engineering.md rubric +
// the operational policy in config/context-policy.json.
//
// Dimensions (1-5 each, weighted to 0-100 total):
//   authority           (15) — mean trust tier of sections
//   relevance           (15) — task-overlap heuristic
//   sufficiency         (15) — required-source coverage per task_type
//   freshness           (10) — oldest section vs staleness threshold per tier
//   provenance          (12) — completeness of provenance.{source,mtime,sha256}
//   economy             (10) — total_tokens vs per_task_type_budget
//   conflict_handling    (8) — % conflicts with conflict_resolution field
//   omission_discipline (15) — zero forbidden-section glob hits
//
// Tier signal: exemplary ≥ 90, clean 65–89, rough 40–64, bad < 40.
// Classification only — exits 0 always. advisory_only: true in every output.
'use strict';

const fs = require('fs');
const path = require('path');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, readJson, globMatch } = require('./_lib.js');
const { redactString } = require('./redact.js');

const WEIGHTS = {
  authority:           15,
  relevance:           15,
  sufficiency:         15,
  freshness:           10,
  provenance:          12,
  economy:             10,
  conflict_handling:    8,
  omission_discipline: 15
};

const TIER_VALUE = {
  source_of_truth:    4,
  curated_memory:     3,
  run_artifact:       2,
  curated_external:   1,
  untrusted_external: 0
};

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

function tokenize(text) {
  if (typeof text !== 'string') return new Set();
  return new Set(
    text.toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter(t => t.length >= 3)
  );
}

function scoreAuthority(pack) {
  const reasons = [];
  const sections = pack.sections || [];
  if (sections.length === 0) {
    reasons.push('no sections');
    return { score: 1, reasons };
  }
  let total = 0;
  let counted = 0;
  for (const s of sections) {
    const tier = s.trust_tier || (s.provenance && s.provenance.trust_tier);
    if (typeof TIER_VALUE[tier] === 'number') {
      total += TIER_VALUE[tier];
      counted++;
    }
  }
  if (counted === 0) {
    reasons.push('no recognized trust tiers');
    return { score: 1, reasons };
  }
  const mean = total / counted;
  reasons.push(`mean trust tier ${mean.toFixed(2)} across ${counted}/${sections.length} sections`);
  let s;
  if (mean >= 3.5) s = 5;
  else if (mean >= 2.5) s = 4;
  else if (mean >= 1.5) s = 3;
  else if (mean >= 0.5) s = 2;
  else s = 1;
  return { score: s, reasons };
}

function scoreRelevance(pack) {
  const reasons = [];
  const sections = pack.sections || [];
  if (sections.length === 0) return { score: 1, reasons: ['no sections'] };
  const taskText = pack.task_description || pack.task || '';
  const taskTokens = tokenize(taskText);
  if (taskTokens.size === 0) {
    reasons.push('no task_description tokens');
    return { score: 2, reasons };
  }
  let overlapSum = 0;
  let counted = 0;
  for (const s of sections) {
    const sectionText = s.content_excerpt || s.content || '';
    const sectionTokens = tokenize(sectionText);
    if (sectionTokens.size === 0) continue;
    let inter = 0;
    for (const t of taskTokens) if (sectionTokens.has(t)) inter++;
    const overlap = inter / taskTokens.size;
    overlapSum += overlap;
    counted++;
  }
  if (counted === 0) {
    reasons.push('no section content tokens');
    return { score: 2, reasons };
  }
  const mean = overlapSum / counted;
  reasons.push(`mean overlap ${mean.toFixed(2)} across ${counted} sections`);
  let s;
  if (mean >= 0.5) s = 5;
  else if (mean >= 0.3) s = 4;
  else if (mean >= 0.15) s = 3;
  else if (mean >= 0.05) s = 2;
  else s = 1;
  return { score: s, reasons };
}

function scoreSufficiency(pack, policy) {
  const reasons = [];
  const taskType = pack.task_type || 'research';
  const required = (policy.required_sources_per_task_type && policy.required_sources_per_task_type[taskType]) || [];
  if (required.length === 0) {
    reasons.push(`no required sources defined for task_type=${taskType}`);
    return { score: 4, reasons };
  }
  const sectionIds = new Set((pack.sections || []).map(s => s.section_type || s.id || ''));
  const missing = required.filter(r => !sectionIds.has(r));
  reasons.push(`required=${required.length} missing=${missing.length}`);
  if (missing.length > 0) reasons.push('missing: ' + missing.join(','));
  const score = Math.max(1, 5 - missing.length);
  return { score, reasons };
}

function scoreFreshness(pack, policy) {
  const reasons = [];
  const sections = pack.sections || [];
  if (sections.length === 0) return { score: 1, reasons: ['no sections'] };
  const staleness = policy.drift_staleness_days || DEFAULT_STALENESS;
  const now = pack._now ? new Date(pack._now).getTime() : Date.now();
  let worstRatio = 0;
  let withMtime = 0;
  for (const s of sections) {
    const m = s.provenance && s.provenance.mtime;
    const tier = s.trust_tier || (s.provenance && s.provenance.trust_tier);
    const threshold = staleness[tier] || 7;
    if (!m) continue;
    const t = new Date(m).getTime();
    if (!Number.isFinite(t)) continue;
    withMtime++;
    const ageDays = (now - t) / (1000 * 60 * 60 * 24);
    const ratio = ageDays / threshold;
    if (ratio > worstRatio) worstRatio = ratio;
  }
  if (withMtime === 0) {
    reasons.push('no section mtimes available');
    return { score: 2, reasons };
  }
  reasons.push(`worst staleness ratio ${worstRatio.toFixed(2)} (oldest section vs tier threshold)`);
  let s;
  if (worstRatio <= 0.25) s = 5;
  else if (worstRatio <= 0.5) s = 4;
  else if (worstRatio <= 1.0) s = 3;
  else if (worstRatio <= 2.0) s = 2;
  else s = 1;
  return { score: s, reasons };
}

function scoreProvenance(pack) {
  const reasons = [];
  const sections = pack.sections || [];
  if (sections.length === 0) return { score: 1, reasons: ['no sections'] };
  let complete = 0;
  for (const s of sections) {
    const p = s.provenance || {};
    if (p.source && p.mtime && p.sha256) complete++;
  }
  const ratio = complete / sections.length;
  reasons.push(`provenance-complete ${complete}/${sections.length} (${(ratio*100).toFixed(0)}%)`);
  let s;
  if (ratio >= 0.95) s = 5;
  else if (ratio >= 0.80) s = 4;
  else if (ratio >= 0.60) s = 3;
  else if (ratio >= 0.30) s = 2;
  else s = 1;
  return { score: s, reasons };
}

function scoreEconomy(pack, policy) {
  const reasons = [];
  const taskType = pack.task_type || 'research';
  const budgets = policy.per_task_type_budgets || {};
  const budget = budgets[taskType] || budgets._default_total_tokens || 32000;
  let total = pack.total_tokens;
  if (typeof total !== 'number') {
    total = (pack.sections || []).reduce((acc, s) => acc + (typeof s.tokens === 'number' ? s.tokens : 0), 0);
  }
  const usage = total / budget;
  reasons.push(`tokens=${total} budget=${budget} usage=${(usage*100).toFixed(0)}%`);
  let s;
  if (total === 0) s = 1;
  else if (usage <= 0.50) s = 5;
  else if (usage <= 0.80) s = 4;
  else if (usage <= 1.00) s = 3;
  else if (usage <= 1.20) s = 2;
  else s = 1;
  return { score: s, reasons };
}

function scoreConflictHandling(pack) {
  const reasons = [];
  const conflicts = pack.detected_conflicts || pack.conflicts || [];
  if (!Array.isArray(conflicts) || conflicts.length === 0) {
    reasons.push('no conflicts detected');
    return { score: 5, reasons };
  }
  const resolved = conflicts.filter(c => c && c.conflict_resolution).length;
  const ratio = resolved / conflicts.length;
  reasons.push(`conflicts=${conflicts.length} resolved=${resolved} ratio=${ratio.toFixed(2)}`);
  let s;
  if (ratio >= 1.0) s = 5;
  else if (ratio >= 0.75) s = 4;
  else if (ratio >= 0.5) s = 3;
  else if (ratio >= 0.25) s = 2;
  else s = 1;
  return { score: s, reasons };
}

function scoreOmissionDiscipline(pack, policy) {
  const reasons = [];
  const forbidden = (policy.forbidden_sections || []).map(e => e.glob || e);
  const sections = pack.sections || [];
  if (sections.length === 0) return { score: 1, reasons: ['no sections'] };
  let hits = 0;
  const evidence = [];
  for (const s of sections) {
    const src = (s.provenance && s.provenance.source) || s.source || '';
    if (!src) continue;
    for (const g of forbidden) {
      if (globMatch(g, src)) {
        hits++;
        if (evidence.length < 5) evidence.push({ source: redactString(src), glob: g });
        break;
      }
    }
  }
  if (hits > 0) {
    reasons.push(`forbidden-glob hits=${hits}`);
    reasons.push('evidence: ' + JSON.stringify(evidence));
    return { score: 1, reasons };
  }
  reasons.push('zero forbidden-glob hits');
  return { score: 5, reasons };
}

function weightedTotal(dims) {
  let total = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const d = dims[k];
    if (!d) continue;
    total += (d.score / 5) * w;
  }
  return Math.round(total * 10) / 10;
}

// Critical-failure cap: if many evidence-bearing dims simultaneously fail,
// the pack is bad regardless of "free" wins on conflict/omission.
function applyCriticalCap(total, dims) {
  const criticalKeys = ['authority', 'relevance', 'sufficiency', 'freshness', 'provenance', 'economy'];
  const criticalFails = criticalKeys.filter(k => dims[k] && dims[k].score <= 2).length;
  if (criticalFails >= 4) return Math.min(total, 35);
  if (dims.omission_discipline && dims.omission_discipline.score === 1) return Math.min(total, 35);
  return total;
}

function tierSignal(total) {
  if (total >= 90) return 'exemplary';
  if (total >= 65) return 'clean';
  if (total >= 40) return 'rough';
  return 'bad';
}

function scorePack(pack, opts) {
  opts = opts || {};
  const policy = opts.policy || loadPolicy(opts.policyPath);
  const dims = {
    authority:           scoreAuthority(pack),
    relevance:           scoreRelevance(pack),
    sufficiency:         scoreSufficiency(pack, policy),
    freshness:           scoreFreshness(pack, policy),
    provenance:          scoreProvenance(pack),
    economy:             scoreEconomy(pack, policy),
    conflict_handling:   scoreConflictHandling(pack),
    omission_discipline: scoreOmissionDiscipline(pack, policy)
  };
  for (const d of Object.values(dims)) {
    d.reasons = (d.reasons || []).map(r => redactString(String(r)));
    d.weight = WEIGHTS[Object.keys(dims).find(k => dims[k] === d)] || 0;
  }
  // Re-bind weight by key (loop above was a hack; fix here).
  for (const [k, d] of Object.entries(dims)) d.weight = WEIGHTS[k];
  const rawTotal = weightedTotal(dims);
  const total = applyCriticalCap(rawTotal, dims);
  return {
    schema_version: 1,
    advisory_only: true,
    pack_path: redactString(opts.packPath || pack.pack_path || ''),
    task_type: pack.task_type || null,
    dimensions: dims,
    total_weighted: total,
    tier_signal: tierSignal(total),
    thresholds_applied: { exemplary: 90, clean: 65, rough: 40 },
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
  const result = scorePack(pack, { policyPath: args.policy, packPath });
  if (args.json !== false) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(`tier: ${result.tier_signal} (${result.total_weighted}/100)\n`);
  }
  process.exit(0);
}

module.exports = { scorePack, tierSignal, weightedTotal, WEIGHTS };

if (require.main === module) main();
