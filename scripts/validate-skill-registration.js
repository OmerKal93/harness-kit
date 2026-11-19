#!/usr/bin/env node
// validate-skill-registration.js — Skill Registry Security v1.
// Deterministic, read-only validator for config/skill-registry.json records.
// Two-hash attestation model (closed-by-default partition of skills/<id>/):
//   validation_hash <- tests/** + evals/** (skill-local validation suite)
//   runtime_hash    <- everything else (SKILL.md, resolver.*, scripts/**, resources/**, examples/**, any other file)
//   README*         <- runtime_hash by default; excluded ONLY when the record sets
//                      readme_excluded_from_runtime_hash: true (explicitly not loaded).
// No trust_hash anywhere — a single hash domain is forbidden by design.
// Advisory only: reports violations, mutates nothing, gates nothing.
// Honors kill switch. No execSync. No network.
//
// Library:
//   const v = require('./validate-skill-registration.js');
//   v.validateRecord(skillDirOrStub, record) -> { ok, violations[], computed: {runtime_hash, validation_hash} }
// CLI:
//   node scripts/validate-skill-registration.js [--skill <id>]
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDisabled, harnessRoot } = require('./is-disabled.js');
const { parseArgs, readJson } = require('./_lib.js');

const REQUIRED_FRONTMATTER = [
  'id', 'name', 'version', 'description', 'category', 'status', 'owner',
  'source_of_truth', 'allowed_tools', 'forbidden_tools', 'risk_level',
  'requires_approval', 'implicit_invocation_allowed', 'evidence_required',
  'rollback', 'deprecation_policy', 'last_reviewed_at'
];

const WRITE_EXEC_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit'];
const BROAD_TRIGGERS = ['*', '.*', 'any', 'all', 'everything', 'match-all'];

// ---------- file map ----------

function readSkillDirAsFileMap(skillDir) {
  const map = {};
  function walk(dir, rel) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) map[r] = fs.readFileSync(abs);
    }
  }
  walk(skillDir, '');
  return map;
}

function isReadme(relpath) {
  return /^readme(\.|$)/i.test(path.posix.basename(relpath));
}

function isValidationPath(relpath) {
  return relpath.startsWith('tests/') || relpath.startsWith('evals/');
}

// Closed-by-default partition: tests/** + evals/** -> validation, everything else -> runtime.
function partitionFiles(fileMap, opts) {
  const readmeExcluded = !!(opts && opts.readmeExcluded);
  const runtime = [], validation = [];
  for (const rel of Object.keys(fileMap)) {
    const norm = rel.replace(/\\/g, '/');
    if (isValidationPath(norm)) { validation.push(norm); continue; }
    if (isReadme(norm) && readmeExcluded) continue;
    runtime.push(norm);
  }
  runtime.sort();
  validation.sort();
  return { runtime, validation };
}

function hashDomain(fileMap, relpaths) {
  const h = crypto.createHash('sha256');
  for (const rel of relpaths) {
    const content = fileMap[rel] !== undefined ? fileMap[rel] : fileMap[rel.replace(/\//g, '\\')];
    const fileSha = crypto.createHash('sha256')
      .update(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'))
      .digest('hex');
    h.update(rel + '\n' + fileSha + '\n');
  }
  return 'sha256:' + h.digest('hex');
}

function computeHashes(fileMap, opts) {
  const norm = {};
  for (const [k, v] of Object.entries(fileMap)) norm[k.replace(/\\/g, '/')] = v;
  const { runtime, validation } = partitionFiles(norm, opts);
  return {
    runtime_hash: hashDomain(norm, runtime),
    validation_hash: hashDomain(norm, validation),
    runtime_files: runtime,
    validation_files: validation
  };
}

// ---------- minimal frontmatter parser (YAML subset used by SKILL.md) ----------

function parseScalar(raw) {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map(x => x.trim()) : [];
  }
  return s;
}

function parseFrontmatter(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = {};
  let nest = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indented = /^\s+/.test(line);
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1);
    if (!indented) {
      if (val.trim() === '') { nest = key; out[key] = {}; }
      else { nest = null; out[key] = parseScalar(val); }
    } else if (nest) {
      out[nest][key] = parseScalar(val);
    }
  }
  return out;
}

// ---------- validation ----------

function vio(code, severity, recommended_action, detail) {
  return { code, severity, recommended_action, detail };
}

function validateRecord(skillInput, record) {
  const violations = [];
  let fileMap;
  if (typeof skillInput === 'string') fileMap = readSkillDirAsFileMap(skillInput);
  else fileMap = {};
  if (skillInput && typeof skillInput === 'object' && skillInput.files) {
    for (const [k, v] of Object.entries(skillInput.files)) fileMap[k.replace(/\\/g, '/')] = v;
  }

  const rec = record || {};
  const surface = rec.attested_surface || {};
  const hashOpts = { readmeExcluded: rec.readme_excluded_from_runtime_hash === true };
  const computed = computeHashes(fileMap, hashOpts);

  // 1+2. Two-hash attestation (asymmetric consequences).
  if (rec.runtime_hash !== computed.runtime_hash) {
    violations.push(vio('runtime_hash_mismatch', 'critical', 'quarantine',
      'attestation void: recorded=' + String(rec.runtime_hash).slice(0, 24) + '… recomputed=' + computed.runtime_hash.slice(0, 24) + '…'));
  }
  if (rec.validation_hash !== computed.validation_hash) {
    violations.push(vio('validation_hash_mismatch', 'warn', 're-review_or_re-baseline',
      'validation suite changed since attestation: recorded=' + String(rec.validation_hash).slice(0, 24) + '… recomputed=' + computed.validation_hash.slice(0, 24) + '…'));
  }

  // Frontmatter.
  const skillMd = fileMap['SKILL.md'];
  const fm = skillMd !== undefined ? parseFrontmatter(skillMd) : null;
  if (!fm) {
    violations.push(vio('frontmatter_overreach', 'critical', 'quarantine', 'SKILL.md missing or has no parseable frontmatter'));
  } else {
    const missing = REQUIRED_FRONTMATTER.filter(k => fm[k] === undefined);
    const overreach = [];
    if (missing.length) overreach.push('missing required frontmatter: ' + missing.join(','));
    if (rec.id && fm.id && fm.id !== rec.id) overreach.push('frontmatter id "' + fm.id + '" != registry id "' + rec.id + '"');

    const allowed = Array.isArray(fm.allowed_tools) ? fm.allowed_tools : [];
    const forbidden = Array.isArray(fm.forbidden_tools) ? fm.forbidden_tools : [];
    const sec = fm.security && typeof fm.security === 'object' ? fm.security : {};

    // Declared read-only surface must not allow write/exec tools.
    const declaredScopes = [sec.file_write_scope, surface.file_write_scope].filter(s => s !== undefined);
    const readOnlyDeclared = declaredScopes.length > 0 && declaredScopes.every(s => s === 'none');
    const writeExecAllowed = allowed.filter(t => WRITE_EXEC_TOOLS.includes(t));
    if (readOnlyDeclared && writeExecAllowed.length) {
      overreach.push('write/exec tools allowed (' + writeExecAllowed.join(',') + ') while file_write_scope is none');
    }
    if (overreach.length) {
      violations.push(vio('frontmatter_overreach', 'critical', 'quarantine', overreach.join(' | ')));
    }

    // 3. Tool contradictions.
    const contradictions = [];
    const both = allowed.filter(t => forbidden.includes(t));
    if (both.length) contradictions.push('tool in both allowed and forbidden: ' + both.join(','));
    if (Array.isArray(surface.allowed_tools)) {
      const beyond = allowed.filter(t => !surface.allowed_tools.includes(t));
      if (beyond.length) contradictions.push('allowed_tools exceed attested surface: ' + beyond.join(','));
    }
    if (contradictions.length) {
      violations.push(vio('tool_contradiction', 'critical', 'quarantine', contradictions.join(' | ')));
    }

    // 6. Network access requires explicit review.
    const netDecls = [sec.network_permission, surface.network_permission].filter(s => s !== undefined);
    const hasNetwork = netDecls.some(n => n !== 'none');
    if (hasNetwork && !rec.reviewed_by) {
      violations.push(vio('unreviewed_network', 'critical', 'quarantine',
        'network_permission != none without an explicit reviewer'));
    }

    // 7. Third-party external content requires an injection eval.
    const extDecls = [sec.external_content_handling, surface.external_content_handling].filter(s => s !== undefined);
    const thirdParty = extDecls.some(e => /third[-_ ]?party/i.test(String(e)));
    if (thirdParty) {
      const evalsReq = []
        .concat(Array.isArray(sec.required_evals) ? sec.required_evals : [])
        .concat(Array.isArray(surface.required_evals) ? surface.required_evals : []);
      const hasInjection = evalsReq.some(e => /injection/i.test(String(e)));
      if (!hasInjection) {
        violations.push(vio('missing_injection_eval', 'critical', 'quarantine',
          'skill reads third-party external content but required_evals has no injection eval'));
      }
    }

    // 10. Resolver overreach.
    const resolverRaw = fileMap['resolver.json'];
    if (resolverRaw !== undefined) {
      let resolver = null;
      try { resolver = JSON.parse(Buffer.isBuffer(resolverRaw) ? resolverRaw.toString('utf8') : String(resolverRaw)); } catch {}
      if (resolver) {
        const implicit = !!(resolver.invocation && resolver.invocation.implicit_allowed);
        const reasons = [];
        if (implicit && fm.risk_level === 'security-sensitive') {
          reasons.push('implicit invocation allowed on a security-sensitive skill');
        }
        const phrases = Array.isArray(resolver.trigger_phrases) ? resolver.trigger_phrases : [];
        const broad = phrases.some(p => BROAD_TRIGGERS.includes(String(p).trim().toLowerCase()));
        if (implicit && broad) reasons.push('match-all/broad trigger phrase with implicit invocation');
        if (implicit && phrases.length === 0) reasons.push('implicit invocation with empty trigger set (confidence uncomputable)');
        if (reasons.length) {
          violations.push(vio('resolver_overreach', 'critical', 'quarantine', reasons.join(' | ')));
        }
      } else {
        violations.push(vio('resolver_overreach', 'warn', 're-review_or_re-baseline', 'resolver.json present but unparseable'));
      }
    }
  }

  // 5. Executable helper without explicit review. Robust against record under-declaration:
  // actual scripts/** presence counts even when helper_present is false.
  const helperActuallyPresent = Object.keys(fileMap).some(r => r.replace(/\\/g, '/').startsWith('scripts/'));
  const helperPresent = rec.helper_present === true || helperActuallyPresent;
  if (helperPresent && rec.helper_reviewed !== true && rec.enable_state === 'enabled') {
    violations.push(vio('unreviewed_helper_enabled', 'critical', 'quarantine',
      'executable helper present (' + (helperActuallyPresent ? 'scripts/** on disk' : 'declared') + ') but not reviewed while enabled'));
  }

  // 8. Imported/generated never auto-enable.
  const origin = String(rec.origin || '');
  const importedOrGenerated =
    ['imported', 'generated'].includes(rec.trust_level) ||
    origin === 'generated' || origin.startsWith('imported:');
  if (importedOrGenerated && rec.enable_state === 'enabled' && !rec.reviewed_by) {
    violations.push(vio('auto_enable_forbidden', 'critical', 'quarantine',
      'imported/generated skill enabled without an explicit reviewer'));
  }

  // 9. Blocked is sticky — frontmatter edits cannot clear it.
  const incidents = Array.isArray(rec.incidents) ? rec.incidents : [];
  const openBlocked = incidents.some(i => i && i.blocked === true && !i.cleared_at);
  if ((openBlocked || rec.trust_level === 'blocked') && rec.enable_state !== 'blocked') {
    violations.push(vio('blocked_escape', 'critical', 'quarantine',
      'open blocked incident (or blocked tier) while enable_state is "' + rec.enable_state + '"'));
  }

  return { ok: violations.length === 0, violations, computed: { runtime_hash: computed.runtime_hash, validation_hash: computed.validation_hash } };
}

// ---------- CLI ----------

function main() {
  const ks = isDisabled();
  if (ks.disabled) { console.log(JSON.stringify({ disabled: true, reason: ks.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const root = harnessRoot();
  const registryPath = path.join(root, 'config', 'skill-registry.json');
  const registry = readJson(registryPath, null);
  if (!registry || !Array.isArray(registry.skills)) {
    console.log(JSON.stringify({ ok: false, error: 'registry missing or invalid', registry_path: registryPath }));
    process.exit(1);
  }

  const only = args.skill ? String(args.skill) : null;
  const out = { ok: true, registry_path: registryPath, enforcement_status: registry._enforcement_status || null, skills: {} };
  for (const rec of registry.skills) {
    if (only && rec.id !== only) continue;
    const skillDir = path.join(root, 'skills', rec.id);
    if (!fs.existsSync(skillDir)) {
      out.skills[rec.id] = { ok: false, violations: [vio('runtime_hash_mismatch', 'critical', 'quarantine', 'skill directory missing: ' + skillDir)] };
      out.ok = false;
      continue;
    }
    const r = validateRecord(skillDir, rec);
    out.skills[rec.id] = r;
    if (!r.ok) out.ok = false;
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}

module.exports = { readSkillDirAsFileMap, partitionFiles, computeHashes, parseFrontmatter, validateRecord };

if (require.main === module) main();
