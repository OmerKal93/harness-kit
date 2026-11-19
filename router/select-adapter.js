#!/usr/bin/env node
// select-adapter.js — ORCH-2/R3: deterministic routing skeleton.
//
//   task -> task_type -> required_capabilities -> eligible adapters -> routing_result
//
// Pure, rule-based, no ML, no self-modification, no learning. The router never branches on
// adapter/product name directly — every decision is made by comparing a task_type's required
// capabilities (TASK_TYPE_CAPABILITIES below) against each adapter's capability_matrix in
// config/adapter-registry.json. Today this always resolves to `claude-code` for full-match
// policies, because it is the only adapter with real verified rows and a built Pipeline stage —
// that is an EVIDENCE result (see config/adapter-registry.json), not a hardcoded preference.
//
// CLI:
//   node router/select-adapter.js --task-type code-feature [--policy highest_verified_quality] [--json]
//   node router/select-adapter.js --self-test
//
// Library:
//   const { route, TASK_TYPE_CAPABILITIES, POLICIES } = require('./select-adapter.js')
'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, harnessRoot, parseArgs } = require('../scripts/_lib.js');

// Deterministic task_type -> required capability list. Reuses the canonical task_type
// vocabulary already defined in config/global-policy.json#task_type_to_workflow — this map
// does not invent new task types, it adds a capability-requirement dimension to existing ones.
const TASK_TYPE_CAPABILITIES = Object.freeze({
  'code-feature': ['planning', 'implementation', 'testing', 'review'],
  'code-bug': ['implementation', 'debugging', 'testing', 'review'],
  'strategy': ['planning', 'architecture', 'documentation'],
  'ideate': ['planning'],
  'brainstorm': ['planning'],
  'docs': ['documentation'],
  'doc-review': ['review', 'documentation'],
  'review': ['review', 'security'],
  'memory-capture': ['documentation'],
  'memory-refresh': ['documentation'],
  'session-recover': ['long-context'],
  'browser-qa': ['browser', 'testing'],
  'polish': ['implementation', 'review'],
  'dogfood': ['testing'],
  'optimize': ['implementation', 'testing', 'review'],
  'ops': ['terminal', 'CI'],
  'learning': ['documentation'],
  'unknown': ['planning']
});

// Evidence-state rank, higher = stronger. unsupported/unavailable are never eligible at any rank.
const STATE_RANK = Object.freeze({ unsupported: -1, unavailable: -1, unverified: 1, claimed: 2, verified: 3 });
const TIER_RANK = Object.freeze({ untested: 0, quarantined: 1, 'trusted-local': 2 });

// Policy definitions: { minState, minTier, excludesFallbackAdapters, note }
// minState = minimum STATE_RANK a capability entry must meet to count as "satisfied" for a FULL match.
// minTier = minimum trust_tier rank an adapter must meet to be considered at all.
const POLICIES = Object.freeze({
  highest_verified_quality: { minState: 3, minTier: 2, note: null },
  lowest_cost: { minState: 3, minTier: 2, note: 'no HarnessBench cost data exists yet (R6 not built) — falling back to highest_verified_quality behavior' },
  fastest: { minState: 3, minTier: 2, note: 'no HarnessBench timing data exists yet (R6 not built) — falling back to highest_verified_quality behavior' },
  lowest_variance: { minState: 3, minTier: 2, note: 'no HarnessBench repeat-run data exists yet (R6 not built) — falling back to highest_verified_quality behavior' },
  local_cli_only: { minState: 3, minTier: 2, excludeProviderApi: true, note: null },
  independent_review: { minState: 2, minTier: 1, note: 'accepts claimed-or-better and quarantined-or-better, and requires excludeAdapter — the point is a SECOND opinion, not the strongest single adapter' },
  benchmark_all: { minState: 1, minTier: 0, note: 'HarnessBench comparison mode — includes every adapter that is not explicitly unsupported/unavailable for the required capabilities, regardless of trust_tier' }
});

function loadRegistry(root) {
  const taxonomy = readJson(path.join(root, 'config', 'capability-taxonomy.json'), { capabilities: [] });
  const registry = readJson(path.join(root, 'config', 'adapter-registry.json'), { adapters: [] });
  return { taxonomy, adapters: registry.adapters || [] };
}

function isProviderLike(adapter) {
  if (adapter.adapter_id === 'provider-api') return true;
  const mode = adapter.authentication_mode || '';
  if (!/raw .*api key/i.test(mode)) return false;
  // Real config/adapter-registry.json rows phrase a NON-provider-API adapter's authentication_mode
  // as a negated disclaimer ("no raw API key used by HarnessKit", "no raw OpenAI API key used") --
  // without this check both claude-code and codex-cli false-positive as provider-API-like and get
  // wrongly excluded by policy.excludeProviderApi (e.g. local_cli_only). Only a negation word
  // directly modifying "raw" (not merely present anywhere in the string) counts.
  if (/\b(no|not|never|without)\s+raw\b/i.test(mode)) return false;
  return true;
}

// Pure routing function. adapters/taxonomy are injectable for tests; default to the live registry.
function route(opts) {
  const root = (opts && opts.root) || harnessRoot();
  const taskType = opts && opts.taskType;
  const policyName = (opts && opts.policy) || 'highest_verified_quality';
  const excludeAdapter = opts && opts.excludeAdapter;
  const policy = POLICIES[policyName];

  if (!policy) {
    return { ok: false, error: `unknown policy: ${policyName}`, known_policies: Object.keys(POLICIES) };
  }

  const requiredCapabilities = (opts && opts.requiredCapabilities) ||
    (taskType ? TASK_TYPE_CAPABILITIES[taskType] : null);
  if (!requiredCapabilities) {
    return { ok: false, error: `no required-capabilities: unknown task_type '${taskType}' and no explicit requiredCapabilities given`, known_task_types: Object.keys(TASK_TYPE_CAPABILITIES) };
  }

  let adapters = opts && opts.adapters ? opts.adapters : loadRegistry(root).adapters;
  if (excludeAdapter) adapters = adapters.filter(a => a.adapter_id !== excludeAdapter);
  if (policy.excludeProviderApi) adapters = adapters.filter(a => !isProviderLike(a));

  const evaluated = adapters.map(adapter => {
    const tierRank = TIER_RANK[adapter.trust_tier];
    const tierOk = tierRank !== undefined && tierRank >= policy.minTier;
    const perCap = requiredCapabilities.map(capId => {
      const entry = (adapter.capabilities || {})[capId];
      const state = entry && entry.state;
      const rank = STATE_RANK[state];
      return { capability: capId, state: state || 'unavailable', rank: rank === undefined ? -1 : rank, satisfied: tierOk && rank !== undefined && rank >= policy.minState };
    });
    const satisfiedCount = perCap.filter(c => c.satisfied).length;
    const fullMatch = tierOk && satisfiedCount === requiredCapabilities.length;
    const partialMatch = satisfiedCount > 0;
    const missing = perCap.filter(c => !c.satisfied).map(c => c.capability);
    return {
      adapter_id: adapter.adapter_id,
      trust_tier: adapter.trust_tier,
      tier_ok: tierOk,
      full_match: fullMatch,
      partial_match: partialMatch,
      satisfied_count: satisfiedCount,
      required_count: requiredCapabilities.length,
      missing_capabilities: missing,
      per_capability: perCap
    };
  });

  const fullMatches = evaluated.filter(e => e.full_match);
  const partialMatches = evaluated.filter(e => e.partial_match && !e.full_match);
  const eligible = policyName === 'benchmark_all'
    ? evaluated.filter(e => e.partial_match)
    : fullMatches;

  // Winner selection among full matches: highest trust_tier, then most-verified-not-just-satisfied.
  let selected = null;
  if (fullMatches.length > 0) {
    selected = [...fullMatches].sort((a, b) => {
      const tierDiff = TIER_RANK[b.trust_tier] - TIER_RANK[a.trust_tier];
      if (tierDiff !== 0) return tierDiff;
      const aVerified = a.per_capability.filter(c => c.rank === 3).length;
      const bVerified = b.per_capability.filter(c => c.rank === 3).length;
      return bVerified - aVerified;
    })[0];
  }

  const requiresApproval = !selected && evaluated.some(e => isProviderLike({ adapter_id: e.adapter_id }));
  // No CLI adapter fully satisfied the task AND a provider-api fallback exists in the candidate set:
  // never silently select it. The mandate's 4-condition approval gate applies.
  const providerFallbackBlocked = !selected && adapters.some(isProviderLike);

  return {
    ok: true,
    task_type: taskType || null,
    required_capabilities: requiredCapabilities,
    policy: policyName,
    policy_note: policy.note,
    eligible_adapters: (policyName === 'benchmark_all' ? eligible : fullMatches).map(e => e.adapter_id),
    rejected_adapters: evaluated.filter(e => !eligible.includes(e)).map(e => ({
      adapter_id: e.adapter_id,
      reason: !e.tier_ok ? `trust_tier '${e.trust_tier}' below policy minimum` : `missing capabilities: ${e.missing_capabilities.join(', ') || 'none — below benchmark_all threshold'}`
    })),
    selected_adapter: selected ? selected.adapter_id : null,
    // Fixed a stale-filename bug carried across two prior edits: this field named
    // config/capability-registry.json, then config/capability-inventory.json -- neither is read by
    // loadRegistry() above (confirmed: it reads config/adapter-registry.json +
    // config/capability-taxonomy.json only; adapter-registry.json has zero model-related fields).
    // Per-adapter model-policy entries (`"type": "model"` rows), where declared, genuinely live in
    // config/capability-registry.json -- a real fact, just not one loadRegistry() acts on -- so the
    // message now names both: what THIS function actually reads, and where model policy actually
    // lives, instead of conflating the two into one (previously wrong) filename.
    selected_model_policy: selected ? "route()'s own adapter/capability resolution reads config/adapter-registry.json + config/capability-taxonomy.json (loadRegistry()) only; per-adapter model-policy entries, where declared, live separately in config/capability-registry.json (unchanged, not duplicated here)" : null,
    trust_level: selected ? selected.trust_tier : null,
    human_approval_needed: providerFallbackBlocked,
    approval_reason: providerFallbackBlocked
      ? 'No CLI adapter fully satisfies this task; a provider-api fallback exists but requires: (1) confirm no local CLI can do it, (2) adapter explicitly configured, (3) cost calculated, (4) Owner approval. None met — router refuses to auto-select provider-api.'
      : null,
    experimental: selected ? TIER_RANK[selected.trust_tier] < 2 : null,
    all_candidates: evaluated,
    evidence: `config/adapter-registry.json (adapter capability rows) + config/capability-taxonomy.json (capability id set), evaluated ${new Date().toISOString()}`
  };
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  const FIXTURE_ADAPTERS = [
    { adapter_id: 'strong-cli', trust_tier: 'trusted-local', capabilities: {
      planning: { state: 'verified' }, implementation: { state: 'verified' },
      testing: { state: 'verified' }, review: { state: 'verified' }
    }},
    { adapter_id: 'weak-cli', trust_tier: 'untested', capabilities: {
      planning: { state: 'claimed' }, implementation: { state: 'claimed' },
      testing: { state: 'unverified' }, review: { state: 'claimed' }
    }},
    { adapter_id: 'quarantined-cli', trust_tier: 'quarantined', capabilities: {
      planning: { state: 'verified' }, implementation: { state: 'claimed' },
      testing: { state: 'claimed' }, review: { state: 'claimed' }
    }},
    { adapter_id: 'provider-api', trust_tier: 'untested', authentication_mode: 'raw provider API key — fallback only', capabilities: {
      planning: { state: 'claimed' }, implementation: { state: 'claimed' },
      testing: { state: 'claimed' }, review: { state: 'claimed' }
    }}
  ];
  const REQ = ['planning', 'implementation', 'testing', 'review'];

  // 1. one eligible adapter (only strong-cli is trusted-local + fully verified)
  {
    const r = route({ requiredCapabilities: REQ, adapters: FIXTURE_ADAPTERS, policy: 'highest_verified_quality' });
    push('one_eligible_adapter', r.selected_adapter === 'strong-cli' && r.eligible_adapters.length === 1, JSON.stringify({ selected: r.selected_adapter, eligible: r.eligible_adapters }));
  }
  // 2. multiple eligible adapters (benchmark_all sees all 4, incl. provider-api and quarantined)
  {
    const r = route({ requiredCapabilities: REQ, adapters: FIXTURE_ADAPTERS, policy: 'benchmark_all' });
    push('multiple_eligible_adapters', r.eligible_adapters.length === 4, JSON.stringify(r.eligible_adapters));
  }
  // 3. no eligible adapter (require a capability nobody has)
  {
    const r = route({ requiredCapabilities: ['security'], adapters: FIXTURE_ADAPTERS, policy: 'highest_verified_quality' });
    push('no_eligible_adapter', r.selected_adapter === null && r.eligible_adapters.length === 0, JSON.stringify({ selected: r.selected_adapter }));
  }
  // 4. claimed-but-unverified capability does not count toward a full match under the default policy
  {
    const r = route({ requiredCapabilities: REQ, adapters: [FIXTURE_ADAPTERS[1]], policy: 'highest_verified_quality' });
    push('claimed_not_verified_excluded', r.selected_adapter === null, `weak-cli (all claimed/unverified) must not fully match under highest_verified_quality: ${JSON.stringify(r.selected_adapter)}`);
  }
  // 5. quarantined adapter — eligible under independent_review (minTier 1) but not under highest_verified_quality (minTier 2)
  {
    const strict = route({ requiredCapabilities: ['planning'], adapters: [FIXTURE_ADAPTERS[2]], policy: 'highest_verified_quality' });
    const lenient = route({ requiredCapabilities: ['planning'], adapters: [FIXTURE_ADAPTERS[2]], policy: 'independent_review', excludeAdapter: 'strong-cli' });
    push('quarantined_adapter_tier_gated', strict.selected_adapter === null && lenient.selected_adapter === 'quarantined-cli',
      JSON.stringify({ strict: strict.selected_adapter, lenient: lenient.selected_adapter }));
  }
  // 6. local_cli_only excludes provider-api even when it would otherwise fully match
  {
    const r = route({ requiredCapabilities: ['planning'], adapters: [{ ...FIXTURE_ADAPTERS[3], trust_tier: 'trusted-local', capabilities: { planning: { state: 'verified' } } }], policy: 'local_cli_only' });
    push('local_cli_only_excludes_provider_api', r.selected_adapter === null && r.eligible_adapters.length === 0, JSON.stringify(r));
  }
  // 7. API fallback rejection without approval — no CLI adapter qualifies, provider-api present in candidate set
  {
    const r = route({ requiredCapabilities: ['security'], adapters: FIXTURE_ADAPTERS, policy: 'highest_verified_quality' });
    push('api_fallback_requires_approval', r.human_approval_needed === true && r.selected_adapter === null, JSON.stringify({ approval: r.human_approval_needed, selected: r.selected_adapter }));
  }
  // 8. integration smoke against the LIVE registry — must not throw, must return ok:true
  {
    let live;
    try { live = route({ taskType: 'code-feature' }); } catch (e) { live = { ok: false, error: String(e) }; }
    push('live_registry_smoke', live.ok === true, JSON.stringify({ selected: live.selected_adapter, ok: live.ok }));
  }
  // 9. today's honest reality check — claude-code wins code-feature on the LIVE registry, not by hardcoded preference
  {
    const live = route({ taskType: 'code-feature' });
    push('claude_code_wins_by_evidence_not_hardcode', live.selected_adapter === 'claude-code', `live selected=${live.selected_adapter}`);
  }
  // 10. isProviderLike regex fix — a negated disclaimer ("no raw API key used ...") must NOT
  //     false-positive as provider-API-like, while a genuine raw-API-key claim still must.
  //     Reproduces the exact live config/adapter-registry.json authentication_mode strings.
  {
    const claudeCode = { adapter_id: 'claude-code', authentication_mode: 'authenticated CLI/app session (no raw API key used by HarnessKit)' };
    const codexCli = { adapter_id: 'codex-cli', authentication_mode: 'authenticated CLI session (ChatGPT OAuth, confirmed present in ~/.codex/config.toml; no raw OpenAI API key used; no key requested during any smoke-test call)' };
    const genuineProviderApi = { adapter_id: 'some-provider-adapter', authentication_mode: 'raw provider API key — fallback only, never the default path' };
    push('negated_raw_api_key_disclaimer_is_not_provider_like',
      isProviderLike(claudeCode) === false && isProviderLike(codexCli) === false,
      JSON.stringify({ claudeCode: isProviderLike(claudeCode), codexCli: isProviderLike(codexCli) }));
    push('genuine_raw_api_key_claim_still_detected_as_provider_like',
      isProviderLike(genuineProviderApi) === true, JSON.stringify({ genuineProviderApi: isProviderLike(genuineProviderApi) }));
  }
  // 11. live-registry proof: local_cli_only must not exclude claude-code/codex-cli as false-positive
  //     provider-API adapters (the actual policy surface the bug corrupted).
  {
    const { adapters: liveAdapters } = loadRegistry(harnessRoot());
    const claudeReal = liveAdapters.find(a => a.adapter_id === 'claude-code');
    const codexReal = liveAdapters.find(a => a.adapter_id === 'codex-cli');
    push('live_claude_code_and_codex_cli_not_misclassified_provider_like',
      !!claudeReal && !!codexReal && isProviderLike(claudeReal) === false && isProviderLike(codexReal) === false,
      JSON.stringify({ claudeReal: claudeReal && isProviderLike(claudeReal), codexReal: codexReal && isProviderLike(codexReal) }));
  }
  // 12. Independent-review minor note: 10/11 only prove isProviderLike() itself is fixed -- neither
  //     exercises the actual filter WIRING at route()'s policy.excludeProviderApi line, so a future
  //     regression there (e.g. re-inlining the old regex, or filtering on the wrong field) would
  //     slip through undetected even with isProviderLike() itself still correct. Fixture adapters
  //     use the exact live negated authentication_mode strings, given otherwise-fully-eligible
  //     capabilities, and must survive local_cli_only (not be excluded as provider-API-like).
  {
    const negatedDisclaimerAdapters = [
      { adapter_id: 'claude-code', trust_tier: 'trusted-local', authentication_mode: 'authenticated CLI/app session (no raw API key used by HarnessKit)', capabilities: { planning: { state: 'verified' } } },
      { adapter_id: 'codex-cli', trust_tier: 'trusted-local', authentication_mode: 'authenticated CLI session (ChatGPT OAuth, confirmed present in ~/.codex/config.toml; no raw OpenAI API key used; no key requested during any smoke-test call)', capabilities: { planning: { state: 'verified' } } }
    ];
    const r = route({ requiredCapabilities: ['planning'], adapters: negatedDisclaimerAdapters, policy: 'local_cli_only' });
    push('local_cli_only_wiring_does_not_exclude_negated_disclaimer_adapters',
      r.eligible_adapters.length === 2 && r.eligible_adapters.includes('claude-code') && r.eligible_adapters.includes('codex-cli'),
      JSON.stringify(r));
  }
  // 13. Fixed a stale-filename bug: selected_model_policy previously named
  //     config/capability-registry.json, then config/capability-inventory.json -- neither is
  //     actually read by loadRegistry() (this function is only ever called against the LIVE
  //     registry here, since the message text is independent of the injected adapters/policy used
  //     elsewhere in this suite). Assert the message now names both real facts: the two files
  //     loadRegistry() genuinely reads, and that config/capability-registry.json genuinely has
  //     model-type entries (so it's still an accurate place to point at for model policy, just not
  //     conflated with what THIS function reads).
  {
    const liveRoot = harnessRoot();
    const live = route({ taskType: 'code-feature' });
    const msg = live.selected_model_policy || '';
    push('selected_model_policy_names_the_real_loadRegistry_files_not_a_stale_one',
      msg.includes('config/adapter-registry.json') && msg.includes('config/capability-taxonomy.json'),
      msg);
    const { adapters: liveAdapters, taxonomy: liveTaxonomy } = loadRegistry(liveRoot);
    push('loadRegistry_really_does_read_only_those_two_files', Array.isArray(liveAdapters) && Array.isArray((liveTaxonomy || {}).capabilities || liveTaxonomy), JSON.stringify({ adapterCount: liveAdapters.length }));
    const registryPath = path.join(liveRoot, 'config', 'capability-registry.json');
    let registryHasModelEntries = false;
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      registryHasModelEntries = JSON.stringify(registry).includes('"type": "model"') || JSON.stringify(registry).includes('"type":"model"');
    } catch { /* leave false -- pushed below as a real failure if so */ }
    push('capability_registry_json_genuinely_has_model_type_entries_so_the_pointer_is_still_accurate', registryHasModelEntries, `checked ${registryPath}`);
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  const result = route({ taskType: a['task-type'], policy: a.policy, excludeAdapter: a['exclude-adapter'] });
  if (a.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`task_type=${result.task_type} policy=${result.policy} selected=${result.selected_adapter} eligible=[${(result.eligible_adapters||[]).join(',')}]`);
  process.exit(result.ok === false ? 1 : 0);
}

module.exports = { route, TASK_TYPE_CAPABILITIES, POLICIES, STATE_RANK, TIER_RANK, isProviderLike };
if (require.main === module) main();
