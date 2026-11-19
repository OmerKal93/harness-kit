#!/usr/bin/env node
// capability-resolver.js — HarnessKit Productization Phase 1: resolves a normalized capability ID
// to a real, available adapter. This is the seam between workflow INTENT (a stage names what it
// needs) and RUNTIME (which adapter actually provides it) — the workflow graph never names a
// script path, a Windows path, or a product name directly; it names a capability, and this file
// decides what satisfies it, today, on this machine, for this repo.
//
// Two capability namespaces, deliberately kept distinct:
//   - `repo.*` (repo.test, repo.lint, repo.typecheck, repo.build, ...): satisfied by a command
//     DETECTED IN THE TARGET REPO ITSELF (inspect-repo.js's repo-profile.json), never guessed.
//     Adapter name for these is always the literal 'detected-repository-command'.
//   - everything else (planning, implementation, review, security, ...): the existing 20-capability
//     adapter taxonomy (config/capability-taxonomy.json), resolved via router/select-adapter.js's
//     real route() — reused, not reimplemented.
//
// Fails closed: a capability with no real, verified provider returns { ok:false,
// reason:'missing_capability' } — never a guess, never a silent skip.
'use strict';

const { route } = require('../router/select-adapter.js');

function resolveRepoCapability(capabilityId, repoProfile) {
  const cmdKey = capabilityId.slice('repo.'.length);
  const detected = repoProfile && repoProfile.commands && repoProfile.commands[cmdKey];
  if (detected && typeof detected.command === 'string' && detected.command) {
    return {
      ok: true, capability_id: capabilityId, selected_adapter: 'detected-repository-command',
      command: detected.command, source: detected.source || null, confidence: detected.confidence || 'unknown'
    };
  }
  return {
    ok: false, capability_id: capabilityId, reason: 'missing_capability',
    detail: `no detected repo.${cmdKey} command in repo-profile.json for this target repo`
  };
}

function resolveAdapterCapability(capabilityId, opts) {
  const r = route({
    requiredCapabilities: [capabilityId],
    policy: (opts && opts.policy) || 'highest_verified_quality',
    root: opts && opts.root,
    adapters: opts && opts.adapters,
    excludeAdapter: opts && opts.excludeAdapter
  });
  if (r.ok === false) {
    return { ok: false, capability_id: capabilityId, reason: 'missing_capability', detail: r.error || 'route() failed' };
  }
  if (!r.selected_adapter) {
    return {
      ok: false, capability_id: capabilityId, reason: 'missing_capability',
      detail: r.human_approval_needed ? `requires human approval: ${r.approval_reason}` : 'no eligible adapter for this capability at the configured policy'
    };
  }
  return { ok: true, capability_id: capabilityId, selected_adapter: r.selected_adapter, trust_level: r.trust_level, route: r };
}

// resolveCapability(capabilityId, {repoProfile, policy, root, adapters, excludeAdapter}) -> result
function resolveCapability(capabilityId, opts) {
  const o = opts || {};
  if (typeof capabilityId !== 'string' || !capabilityId) {
    return { ok: false, capability_id: capabilityId, reason: 'missing_capability', detail: 'capability_id must be a non-empty string' };
  }
  if (capabilityId.startsWith('repo.')) return resolveRepoCapability(capabilityId, o.repoProfile);
  return resolveAdapterCapability(capabilityId, o);
}

// resolveStage(stage, opts) -> { ok, results:[...], selected_adapter }
// A stage is satisfied only if EVERY required capability resolves. selected_adapter reports the
// first resolved adapter for convenience (stages with multiple capabilities may span adapters --
// callers that need per-capability adapters should read `results` directly, not this shorthand).
function resolveStage(stage, opts) {
  const required = (stage && stage.required_capabilities) || [];
  const results = required.map(c => resolveCapability(c, opts));
  const ok = results.length > 0 && results.every(r => r.ok);
  return { ok, results, selected_adapter: ok ? results[0].selected_adapter : null };
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  // 1. repo.* capability resolves when repo-profile has the command.
  {
    const repoProfile = { commands: { test: { command: 'pytest', source: 'pyproject.toml', confidence: 'high' } } };
    const r = resolveCapability('repo.test', { repoProfile });
    push('repo_capability_resolves_when_detected', r.ok === true && r.selected_adapter === 'detected-repository-command' && r.command === 'pytest', JSON.stringify(r));
  }
  // 2. repo.* capability fails closed when not detected -- never guesses.
  {
    const repoProfile = { commands: {} };
    const r = resolveCapability('repo.typecheck', { repoProfile });
    push('repo_capability_fails_closed_when_undetected', r.ok === false && r.reason === 'missing_capability', JSON.stringify(r));
  }
  // 3. repo.* capability fails closed with no repoProfile at all.
  {
    const r = resolveCapability('repo.build', {});
    push('repo_capability_fails_closed_with_no_profile', r.ok === false && r.reason === 'missing_capability', JSON.stringify(r));
  }
  // 4. Adapter capability resolves via the real route() for a known-verified capability/adapter.
  {
    const r = resolveCapability('implementation', { policy: 'highest_verified_quality' });
    push('adapter_capability_resolves_via_real_route', r.ok === true && !!r.selected_adapter, JSON.stringify(r));
  }
  // 5. Adapter capability fails closed for a capability nothing provides.
  {
    const fakeAdapters = [{ adapter_id: 'fake', trust_tier: 'trusted-local', capabilities: {} }];
    const r = resolveCapability('some-nonexistent-capability-xyz', { adapters: fakeAdapters });
    push('adapter_capability_fails_closed_when_unsatisfied', r.ok === false && r.reason === 'missing_capability', JSON.stringify(r));
  }
  // 6. resolveStage: all-satisfied stage is ok.
  {
    const repoProfile = { commands: { test: { command: 'pytest' }, lint: { command: 'ruff check .' } } };
    const stage = { stage_id: 'verify-target-repo', required_capabilities: ['repo.test', 'repo.lint'] };
    const r = resolveStage(stage, { repoProfile });
    push('stage_resolves_when_all_capabilities_satisfied', r.ok === true && r.results.length === 2, JSON.stringify(r));
  }
  // 7. resolveStage: one missing capability fails the whole stage, does not silently drop it.
  {
    const repoProfile = { commands: { test: { command: 'pytest' } } };
    const stage = { stage_id: 'verify-target-repo', required_capabilities: ['repo.test', 'repo.lint'] };
    const r = resolveStage(stage, { repoProfile });
    push('stage_fails_when_any_capability_missing', r.ok === false && r.results[1].ok === false, JSON.stringify(r));
  }
  // 8. Empty required_capabilities is not silently "satisfied" -- a stage must name real capabilities.
  {
    const r = resolveStage({ stage_id: 'empty', required_capabilities: [] }, {});
    push('empty_required_capabilities_never_satisfied', r.ok === false, JSON.stringify(r));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { resolveCapability, resolveStage, resolveRepoCapability, resolveAdapterCapability };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('capability-resolver.js — library. node scripts/capability-resolver.js --self-test');
  process.exit(0);
}
