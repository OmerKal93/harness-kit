#!/usr/bin/env node
// gbrain-export-curated.js — Phase 3B Step 4 + hotfix (path-scoped + poisoning + trust_level).
//
// Reads config/gbrain-import-policy.json (schema_v2) →
// resolves harness_allowlist → computes trust_level per file → applies
// path_blocklist, then path-scoped content_blocklist, then memory-poisoning
// scan, then global redactString → writes staged .md files to
// $TMP/gbrain-staging/<run-id>/ with trust_level injected into frontmatter.
//
// Diff report at runs/<run-id>/gbrain-import-diff.md has
// INCLUDED + EXCLUDED + WARN + Poisoning-scan sections.
//
// Honors kill switch. Does NOT call upstream `gbrain import`. Stages only.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, readJson, nowIso, ensureRunDir, globMatch } = require('./_lib.js');
const { redactString } = require('./redact.js');
const { scanContent: poisoningScan, loadPoisoningPolicy } = require('./memory-poisoning-scan.js');

function expandHome(p) {
  if (!p) return p;
  return p.replace(/^~\//, os.homedir() + '/').replace(/^~\\/, os.homedir() + '\\');
}

function listFilesGlob(globExpr) {
  const expanded = expandHome(globExpr);
  const star = expanded.indexOf('*');
  if (star === -1) {
    if (fs.existsSync(expanded) && fs.statSync(expanded).isFile()) return [expanded];
    return [];
  }
  const before = expanded.slice(0, star);
  const lastSep = Math.max(before.lastIndexOf('/'), before.lastIndexOf('\\'));
  const rootDir = before.slice(0, lastSep);
  if (!fs.existsSync(rootDir)) return [];
  const norm = p => p.replace(/\\/g, '/');
  const target = norm(expanded);
  const out = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { if (globMatch(target, norm(full))) out.push(full); }
    }
  }
  walk(rootDir);
  return out;
}

function matchesPathBlocklist(p, blocklist) {
  const norm = p.replace(/\\/g, '/');
  for (const g of blocklist) {
    const expandedG = expandHome(g).replace(/\\/g, '/');
    if (globMatch(expandedG, norm)) return g;
  }
  return null;
}

// Path-scoped content rule evaluation. Returns
//   { hits: [{rule_id, action, severity}], action: 'exclude'|'redact'|'warn'|null }
function evaluateContentRules(content, filePath, contentBlocklist) {
  const norm = String(filePath).replace(/\\/g, '/');
  const hits = [];
  for (const r of (contentBlocklist || [])) {
    const appliesTo = (r.applies_to_paths && r.applies_to_paths.length) ? r.applies_to_paths : ['**'];
    const applies = appliesTo.some(g => globMatch(expandHome(g).replace(/\\/g, '/'), norm));
    if (!applies) continue;
    const excluded = (r.excludes_paths || []).some(g => globMatch(expandHome(g).replace(/\\/g, '/'), norm));
    if (excluded) continue;
    try {
      const re = new RegExp(r.pattern, 'g');
      if (re.test(content)) {
        hits.push({ rule_id: r.id, action: r.action || 'exclude', severity: r.severity || 'medium' });
      }
    } catch { /* skip bad regex */ }
  }
  const order = { exclude: 3, redact: 2, warn: 1 };
  let strictest = null;
  for (const h of hits) {
    if (!strictest || order[h.action] > order[strictest.action]) strictest = h;
  }
  return { hits, action: strictest ? strictest.action : null };
}

// trust_level: walk alignment-risk-policy.json trust_level.assignments[]; default = untrusted_external
function computeTrustLevel(filePath, alignmentPolicy) {
  const tl = (alignmentPolicy && alignmentPolicy.trust_level) || {};
  const norm = String(filePath).replace(/\\/g, '/');
  for (const a of (tl.assignments || [])) {
    if (globMatch(expandHome(a.glob).replace(/\\/g, '/'), norm)) return a.level;
  }
  return tl.default_level || 'untrusted_external';
}

function evaluateCondition(condition, runDirPath) {
  if (!condition) return true;
  if (condition === 'run.state == DONE') {
    const runJson = readJson(path.join(runDirPath, 'run.json'), null);
    return runJson && runJson.state === 'DONE';
  }
  if (condition === 'not flagged draft') return true; // applied per-file
  return true;
}

function isDraft(content) {
  const head = content.slice(0, 500);
  if (/^---[\s\S]*?\bstatus:\s*draft\b/i.test(head)) return true;
  if (/^DRAFT\b/i.test(content)) return true;
  return false;
}

// Inject trust_level into frontmatter. For .md → YAML. For .json → top-level `_meta.trust_level`.
function injectTrustLevel(content, filePath, trustLevel) {
  if (filePath.endsWith('.json')) {
    try {
      const j = JSON.parse(content);
      j._meta = j._meta || {};
      j._meta.trust_level = trustLevel;
      j._meta.staged_at = nowIso();
      return JSON.stringify(j, null, 2);
    } catch { return content; /* leave as-is if not parseable */ }
  }
  const fmRe = /^---\n([\s\S]*?)\n---\n/;
  if (fmRe.test(content)) {
    return content.replace(fmRe, (full, body) => {
      if (/^trust_level:\s*/m.test(body)) return full; // already set, leave
      return `---\n${body}\ntrust_level: ${trustLevel}\n---\n`;
    });
  }
  // no frontmatter → prepend one
  return `---\ntrust_level: ${trustLevel}\nstaged_at: ${nowIso()}\n---\n` + content;
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const runId = args['run-id'];
  if (!runId) {
    console.error('error: --run-id <id> required');
    process.exit(2);
  }

  const policy = readJson(path.join(harnessRoot(), 'config', 'gbrain-import-policy.json'), null);
  if (!policy) { console.error('error: gbrain-import-policy.json missing'); process.exit(2); }

  const alignmentPolicy = loadPoisoningPolicy();

  const runDirPath = ensureRunDir(runId);
  const stagingDir = path.join(os.tmpdir(), 'gbrain-staging', runId);
  fs.mkdirSync(stagingDir, { recursive: true });

  const included = [];
  const warned = [];
  const excluded = [];
  const poisoningResults = [];
  const sampleRedactions = [];

  for (const entry of (policy.harness_allowlist || [])) {
    if (entry.include === false) {
      const files = listFilesGlob(entry.glob);
      for (const f of files) {
        excluded.push({ path: f, reason: `allowlist.include=false (${entry.reason || 'no reason'})`, allowlist_entry: entry.glob });
      }
      continue;
    }

    const files = listFilesGlob(entry.glob);
    for (const f of files) {
      // 1. path_blocklist
      const pbHit = matchesPathBlocklist(f, policy.path_blocklist || []);
      if (pbHit) { excluded.push({ path: f, reason: `path_blocklist: ${pbHit}`, allowlist_entry: entry.glob }); continue; }

      // 2. condition
      if (entry.condition && !evaluateCondition(entry.condition, path.dirname(f))) {
        excluded.push({ path: f, reason: `condition not met: ${entry.condition}`, allowlist_entry: entry.glob });
        continue;
      }

      // 3. trust_level — forbidden tiers
      const trustLevel = computeTrustLevel(f, alignmentPolicy);
      const forbidden = policy.trust_levels_forbidden_in_phase_3b || ['untrusted_external'];
      if (forbidden.includes(trustLevel)) {
        excluded.push({ path: f, reason: `trust_level=${trustLevel} forbidden in Phase 3B`, allowlist_entry: entry.glob, trust_level: trustLevel });
        continue;
      }

      // 4. read
      let content;
      try { content = fs.readFileSync(f, 'utf8'); }
      catch (e) {
        excluded.push({ path: f, reason: `read error: ${String(e.message || e).slice(0, 80)}`, allowlist_entry: entry.glob });
        continue;
      }

      // 5. draft check
      if (entry.condition === 'not flagged draft' && isDraft(content)) {
        excluded.push({ path: f, reason: 'flagged as draft (frontmatter or DRAFT marker)', allowlist_entry: entry.glob });
        continue;
      }

      // 6. path-scoped content rules
      const contentEval = evaluateContentRules(content, f, policy.content_blocklist || []);

      // 7. poisoning scan
      const poison = poisoningScan(content, f, alignmentPolicy);
      poisoningResults.push({
        path: f,
        file_class: poison.file_class,
        total_hits: poison.hits.length,
        instruction_hits: poison.instruction_hits,
        example_hits: poison.example_hits || 0,
        security_marker_present: poison.security_marker_present,
        action: poison.action,
        sample_hits: poison.hits.slice(0, 3).map(h => ({ rule_id: h.rule_id, line: h.line, classification: h.classification, snippet: h.snippet }))
      });

      // 8. combine strictest action across content_rules + poisoning
      const order = { exclude: 3, redact: 2, warn: 1, clean: 0, null: 0 };
      const contentAction = contentEval.action || 'clean';
      const poisonAction = poison.action || 'clean';
      const effective = (order[contentAction] >= order[poisonAction]) ? contentAction : poisonAction;

      const reasons = [];
      if (contentEval.hits.length) reasons.push('content_blocklist: ' + contentEval.hits.map(h => `${h.rule_id}[${h.action}]`).join(','));
      if (poison.hits.length) reasons.push(`poisoning_scan: ${poison.hits.length} hits / ${poison.instruction_hits} instruction / ${poison.action}`);

      if (effective === 'exclude') {
        excluded.push({ path: f, reason: reasons.join(' | '), allowlist_entry: entry.glob, trust_level: trustLevel });
        continue;
      }

      // 9. apply redact action from content rules (replace pattern hits)
      let processed = content;
      if (contentAction === 'redact') {
        for (const h of contentEval.hits.filter(x => x.action === 'redact')) {
          const rule = (policy.content_blocklist || []).find(r => r.id === h.rule_id);
          if (rule) {
            try { processed = processed.replace(new RegExp(rule.pattern, 'g'), `[REDACTED:${rule.id}]`); }
            catch {}
          }
        }
      }

      // 10. global redaction layer (unchanged)
      const bytesBefore = Buffer.byteLength(processed, 'utf8');
      const redacted = redactString(processed);
      const bytesAfter = Buffer.byteLength(redacted, 'utf8');

      if (sampleRedactions.length < 5 && bytesBefore !== bytesAfter) {
        const beforeLines = processed.split('\n');
        const afterLines = redacted.split('\n');
        for (let i = 0; i < Math.min(beforeLines.length, afterLines.length); i++) {
          if (beforeLines[i] !== afterLines[i]) {
            sampleRedactions.push({
              file: path.relative(os.homedir(), f),
              line: i + 1,
              before: beforeLines[i].slice(0, 80),
              after: afterLines[i].slice(0, 80)
            });
            break;
          }
        }
      }

      // 11. inject trust_level into frontmatter
      const stamped = injectTrustLevel(redacted, f, trustLevel);

      // 12. stage
      const stageRel = path.relative(harnessRoot(), f).replace(/[\\/]/g, '_');
      const stagePath = path.join(stagingDir, stageRel.endsWith('.md') || stageRel.endsWith('.json') ? stageRel : stageRel + '.md');
      fs.writeFileSync(stagePath, stamped, 'utf8');

      const rec = {
        path: f,
        bytes_before: bytesBefore,
        bytes_after: bytesAfter,
        bytes_delta: bytesAfter - bytesBefore,
        allowlist_entry: entry.glob,
        staged_as: stagePath,
        trust_level: trustLevel
      };

      if (effective === 'warn') {
        warned.push({ ...rec, warn_reasons: reasons.join(' | ') });
      } else {
        included.push(rec);
      }
    }
  }

  // diff report
  const reportPath = path.join(runDirPath, 'gbrain-import-diff.md');
  const allStaged = included.concat(warned);
  const totalBefore = allStaged.reduce((s, e) => s + e.bytes_before, 0);
  const totalAfter = allStaged.reduce((s, e) => s + e.bytes_after, 0);
  const policySha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(harnessRoot(), 'config', 'gbrain-import-policy.json'))).digest('hex').slice(0, 16);
  const alignmentSha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(harnessRoot(), 'config', 'alignment-risk-policy.json'))).digest('hex').slice(0, 16);

  const trustLevelCounts = {};
  for (const r of allStaged) trustLevelCounts[r.trust_level] = (trustLevelCounts[r.trust_level] || 0) + 1;
  const trustLevelExcludedCount = excluded.filter(e => /trust_level=/.test(e.reason)).length;
  const poisoningInstructionHits = poisoningResults.reduce((s, p) => s + (p.instruction_hits || 0), 0);
  const poisoningExampleHits = poisoningResults.reduce((s, p) => s + (p.example_hits || 0), 0);
  const poisoningExcludedCount = excluded.filter(e => /poisoning_scan/.test(e.reason)).length;

  const md = [];
  md.push('# GBrain Import Diff — Dry Run (schema v2 / Phase 3B hotfix)');
  md.push('');
  md.push(`- **Generated:** ${nowIso()}`);
  md.push(`- **Run ID:** ${runId}`);
  md.push(`- **Mode:** dry-run (no upstream \`gbrain import\` call)`);
  md.push(`- **Staging dir:** ${stagingDir}`);
  md.push(`- **Policy version_pin:** ${policy.version_pin}`);
  md.push(`- **Policy commit_pin:** ${policy.commit_pin}`);
  md.push(`- **gbrain-import-policy.json SHA256 (16):** ${policySha}`);
  md.push(`- **alignment-risk-policy.json SHA256 (16):** ${alignmentSha}`);
  md.push('');
  md.push('## Summary');
  md.push('');
  md.push(`- **Allowlist entries considered:** ${(policy.harness_allowlist || []).length}`);
  md.push(`- **Files included clean:** ${included.length}`);
  md.push(`- **Files included with WARN:** ${warned.length}`);
  md.push(`- **Files excluded:** ${excluded.length}`);
  md.push(`- **Files staged (clean+warn):** ${allStaged.length}`);
  md.push(`- **Total bytes before redaction:** ${totalBefore}`);
  md.push(`- **Total bytes after redaction:** ${totalAfter}`);
  md.push(`- **Redaction delta (bytes):** ${totalAfter - totalBefore}`);
  md.push(`- **trust_level distribution:** ${JSON.stringify(trustLevelCounts)}`);
  md.push(`- **trust_level excluded count:** ${trustLevelExcludedCount}`);
  md.push(`- **Poisoning scan: total instruction hits:** ${poisoningInstructionHits}`);
  md.push(`- **Poisoning scan: total example hits:** ${poisoningExampleHits}`);
  md.push(`- **Poisoning scan: files excluded:** ${poisoningExcludedCount}`);
  md.push('');

  md.push('## Files INCLUDED (clean)');
  md.push('');
  md.push('| Path | trust_level | Bytes before | Bytes after | Δ | Allowlist entry |');
  md.push('|---|---|---:|---:|---:|---|');
  for (const e of included) {
    md.push(`| ${e.path} | ${e.trust_level} | ${e.bytes_before} | ${e.bytes_after} | ${e.bytes_delta} | ${e.allowlist_entry} |`);
  }
  if (!included.length) md.push('| _(none)_ | | | | | |');
  md.push('');

  md.push('## Files INCLUDED with WARN annotation');
  md.push('');
  md.push('| Path | trust_level | Warn reasons | Allowlist entry |');
  md.push('|---|---|---|---|');
  for (const e of warned) {
    md.push(`| ${e.path} | ${e.trust_level} | ${e.warn_reasons} | ${e.allowlist_entry} |`);
  }
  if (!warned.length) md.push('| _(none)_ | | | |');
  md.push('');

  md.push('## Files EXCLUDED');
  md.push('');
  md.push('| Path | Reason | Allowlist entry |');
  md.push('|---|---|---|');
  for (const e of excluded) {
    md.push(`| ${e.path} | ${e.reason} | ${e.allowlist_entry} |`);
  }
  if (!excluded.length) md.push('| _(none)_ | | |');
  md.push('');

  md.push('## Poisoning scan results');
  md.push('');
  md.push('| Path | File class | Hits (total / instruction / example) | Security marker | Action | Sample rule_ids |');
  md.push('|---|---|---|---|---|---|');
  for (const r of poisoningResults) {
    const samples = r.sample_hits.map(h => `${h.rule_id}@L${h.line}/${h.classification}`).join(', ') || '_(none)_';
    md.push(`| ${r.path} | ${r.file_class} | ${r.total_hits} / ${r.instruction_hits} / ${r.example_hits} | ${r.security_marker_present ? 'yes' : 'no'} | ${r.action} | ${samples} |`);
  }
  if (!poisoningResults.length) md.push('| _(none scanned)_ | | | | | |');
  md.push('');

  md.push('## Sample redactions (first 5)');
  md.push('');
  if (!sampleRedactions.length) {
    md.push('_No redaction-altering bytes detected._');
  } else {
    for (const s of sampleRedactions) {
      md.push(`- **${s.file}:${s.line}**`);
      md.push(`  - before: \`${s.before.replace(/`/g, "'")}\``);
      md.push(`  - after:  \`${s.after.replace(/`/g, "'")}\``);
    }
  }
  md.push('');

  md.push('## Verification checklist for the owner (G2 review)');
  md.push('');
  md.push('- [ ] Every INCLUDED row has trust_level ∈ {source_of_truth, curated_memory, run_artifact}; zero untrusted_external.');
  md.push('- [ ] Every WARN row reason is acceptable for inclusion.');
  md.push('- [ ] Every EXCLUDED reason is correct (no false negatives that should have imported).');
  md.push('- [ ] Zero rows in INCLUDED/WARN contain `tool-log.ndjson`, `decision-log.ndjson`, or `context-pack.md`.');
  md.push('- [ ] Zero rows in INCLUDED/WARN contain any external private-project paths.');
  md.push('- [ ] Poisoning instruction-class hits = 0 across run/memory files (or files explicitly marked security_example).');
  md.push('- [ ] Sample redactions look correct (no over-redaction).');
  md.push('');

  fs.writeFileSync(reportPath, md.join('\n'), 'utf8');

  console.log(JSON.stringify({
    ok: true,
    run_id: runId,
    diff_report: reportPath,
    staging_dir: stagingDir,
    included_count: included.length,
    warn_count: warned.length,
    excluded_count: excluded.length,
    staged_total: allStaged.length,
    bytes_before: totalBefore,
    bytes_after: totalAfter,
    bytes_delta: totalAfter - totalBefore,
    sample_redactions: sampleRedactions.length,
    trust_level_distribution: trustLevelCounts,
    trust_level_excluded_count: trustLevelExcludedCount,
    poisoning_instruction_hits: poisoningInstructionHits,
    poisoning_example_hits: poisoningExampleHits,
    poisoning_excluded_count: poisoningExcludedCount
  }, null, 2));

  process.exit(0);
}

if (require.main === module) main();
