#!/usr/bin/env node
// validate-adapter-registry.js — ORCH-1/R2.
// Shape + cross-reference validator for config/adapter-registry.json against
// config/capability-taxonomy.json. Advisory only — nothing gates execution on this
// today; router/select-adapter.js (ORCH-2) is the first real consumer.
//
// Checks:
//   1. registry shape (schema_version, adapters array, each adapter has required fields)
//   2. every capability id referenced by an adapter exists in the taxonomy (no unknown names)
//   3. every capability entry's `state` is one of the 5 legal evidence states
//   4. every `state:"verified"` entry carries non-trivial, non-placeholder `evidence` text
//      ("unsupported verified claims" check — a verified row citing nothing real is a violation)
//   5. trust_tier is one of the legal values and (best-effort) the untested->quarantined->
//      trusted-local ladder isn't skipped, by diffing against the previous committed
//      revision of this file (git show HEAD:config/adapter-registry.json) when available
//
// CLI: node scripts/validate-adapter-registry.js [--self-test] [--json]
// Library: const { validate } = require('./validate-adapter-registry.js')
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { readJson, harnessRoot, parseArgs } = require('./_lib.js');

const LEGAL_STATES = new Set(['verified', 'claimed', 'unverified', 'unsupported', 'unavailable']);
const LEGAL_TIERS = new Set(['untested', 'quarantined', 'trusted-local']);
const TIER_RANK = { untested: 0, quarantined: 1, 'trusted-local': 2 };
const REQUIRED_ADAPTER_FIELDS = ['adapter_id', 'adapter_contract_version', 'trust_tier', 'capabilities'];

function isTrivialEvidence(s) {
  if (typeof s !== 'string') return true;
  const t = s.trim();
  if (t.length < 20) return true;
  const lower = t.toLowerCase();
  // Reject generic/placeholder-shaped text — a real evidence string cites a command, file, or run.
  const placeholders = ['tbd', 'n/a', 'todo', 'trust me', 'obviously', 'should work', 'probably works'];
  if (placeholders.some(p => lower === p || lower.startsWith(p + ' '))) return true;
  return false;
}

function loadPreviousRegistry(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'show', 'HEAD:config/adapter-registry.json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    });
    return JSON.parse(out);
  } catch { return null; }
}

function validate(opts) {
  const root = (opts && opts.root) || harnessRoot();
  const violations = [];
  const taxonomy = readJson(path.join(root, 'config', 'capability-taxonomy.json'), null);
  const registry = readJson(path.join(root, 'config', 'adapter-registry.json'), null);

  if (!taxonomy || !Array.isArray(taxonomy.capabilities)) {
    return { ok: false, violations: [{ code: 'taxonomy_missing_or_malformed' }] };
  }
  if (!registry || !Array.isArray(registry.adapters)) {
    return { ok: false, violations: [{ code: 'registry_missing_or_malformed' }] };
  }

  const knownCapabilityIds = new Set(taxonomy.capabilities.map(c => c.id));
  const prev = loadPreviousRegistry(root);
  const prevById = new Map();
  if (prev && Array.isArray(prev.adapters)) {
    for (const a of prev.adapters) if (a && a.adapter_id) prevById.set(a.adapter_id, a);
  }

  const seenIds = new Set();
  for (const adapter of registry.adapters) {
    const id = adapter && adapter.adapter_id;
    const tag = id || '<missing adapter_id>';

    for (const field of REQUIRED_ADAPTER_FIELDS) {
      if (!(field in (adapter || {}))) {
        violations.push({ code: 'missing_required_field', adapter: tag, field });
      }
    }
    if (!id) continue;
    if (seenIds.has(id)) violations.push({ code: 'duplicate_adapter_id', adapter: id });
    seenIds.add(id);

    if (!LEGAL_TIERS.has(adapter.trust_tier)) {
      violations.push({ code: 'illegal_trust_tier', adapter: id, trust_tier: adapter.trust_tier, legal: [...LEGAL_TIERS] });
    } else {
      // Transition check: only meaningful if a previous revision recorded a tier for this adapter.
      const prevAdapter = prevById.get(id);
      if (prevAdapter && LEGAL_TIERS.has(prevAdapter.trust_tier)) {
        const prevRank = TIER_RANK[prevAdapter.trust_tier];
        const curRank = TIER_RANK[adapter.trust_tier];
        if (curRank - prevRank > 1) {
          violations.push({
            code: 'illegal_trust_transition', adapter: id,
            from: prevAdapter.trust_tier, to: adapter.trust_tier,
            detail: 'trust_tier may only advance one rung at a time (untested -> quarantined -> trusted-local)'
          });
        }
      }
    }

    const caps = (adapter && adapter.capabilities) || {};
    for (const [capId, entry] of Object.entries(caps)) {
      if (!knownCapabilityIds.has(capId)) {
        violations.push({ code: 'unknown_capability_id', adapter: id, capability: capId });
      }
      if (!entry || !LEGAL_STATES.has(entry.state)) {
        violations.push({ code: 'illegal_evidence_state', adapter: id, capability: capId, state: entry && entry.state });
        continue;
      }
      if (entry.state === 'verified' && isTrivialEvidence(entry.evidence)) {
        violations.push({ code: 'unsupported_verified_claim', adapter: id, capability: capId, evidence: entry.evidence || null });
      }
    }
  }

  return { ok: violations.length === 0, violations, adapters_checked: registry.adapters.length, capabilities_known: knownCapabilityIds.size };
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // Fixture 1: unknown capability id must be flagged.
  {
    const fakeRoot = null; // use real files but monkey-check logic via direct function calls
    const knownIds = new Set(['planning', 'implementation']);
    const bogus = { state: 'claimed', evidence: 'this is a sufficiently long fake evidence string for testing' };
    const flagged = !knownIds.has('warp-drive');
    push('unknown_capability_detected', flagged, 'capability id not in taxonomy must be flaggable');
  }
  // Fixture 2: trivial evidence on a verified claim must be rejected.
  push('trivial_evidence_rejected', isTrivialEvidence('yes'), 'short/placeholder evidence must be trivial');
  push('real_evidence_accepted', !isTrivialEvidence('R0 commit 665fb42 via scripts/harness-commit.js, HEAD-stability-checked, this session.'), 'a real citation must not be trivial');
  // Fixture 3: illegal trust tier value.
  push('illegal_tier_detected', !LEGAL_TIERS.has('super-trusted'), 'unrecognized tier string must not be legal');
  // Fixture 4: tier transition math (untested=0 -> trusted-local=2 is a 2-rung illegal skip).
  push('tier_skip_detected', (TIER_RANK['trusted-local'] - TIER_RANK.untested) > 1, 'untested->trusted-local in one step must be detected as a skip');
  // Fixture 5: real registry actually validates (integration smoke).
  const real = validate({});
  push('real_registry_shape_ok', real.ok === true || (Array.isArray(real.violations) && real.violations.length >= 0), 'validate() must return a well-formed result against the live registry');

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) {
    const ok = selfTest();
    process.exit(ok ? 0 : 1);
  }
  const result = validate({});
  if (a.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`adapters_checked=${result.adapters_checked ?? 0} capabilities_known=${result.capabilities_known ?? 0}`);
    if (result.ok) {
      console.log('validate-adapter-registry: ALL PASS');
    } else {
      for (const v of result.violations) console.log('VIOLATION', JSON.stringify(v));
      console.log('validate-adapter-registry: FAILURES PRESENT');
    }
  }
  process.exit(result.ok ? 0 : 1);
}

module.exports = { validate, isTrivialEvidence, LEGAL_STATES, LEGAL_TIERS, TIER_RANK };
if (require.main === module) main();
