#!/usr/bin/env node
// evaluator.js — REVIEW-INDEPENDENCE-1 core: composes actor-identity + review-authorization into
// the tier ladder. Deliberately keeps three checks separate and AND-composed rather than one
// collapsed boolean, per the explicit requirement that a real subagent dispatch (actor identity)
// does not by itself prove authorization or evidence validity:
//
//   isolated_actor  =  actor_independence  AND  review_authorized  AND  review_evidence_valid
//
// ...always layered under deterministic verification (L0), which this file can never suppress or
// replace -- it only ever adds an ADDITIONAL required condition on top of whatever L0 already
// requires. PORTABILITY BOUNDARY: pure functions over the normalized stamp/request shapes from
// actor-identity.js / review-authorization.js only. No Claude-specific, owner-specific, or
// project-specific references.
'use strict';

const { validateReviewEvidence } = require('./review-authorization.js');

const TIER_LADDER = Object.freeze(['deterministic', 'isolated_actor', 'different_adapter', 'different_provider', 'human']);

function actorIndependent(reviewer, producers) {
  if (reviewer.adapter_id === 'human') return { ok: true, reason: 'human_reviewer_trivially_independent' };
  for (const p of producers) {
    if (p.dispatch_id === reviewer.dispatch_id) return { ok: false, reason: 'dispatch_id_matches_a_producer' };
    if (p.execution_id === reviewer.execution_id) return { ok: false, reason: 'execution_id_matches_a_producer' };
  }
  if (reviewer.context_mode !== 'isolated_subagent') return { ok: false, reason: 'context_mode_not_isolated_subagent' };
  return { ok: true, reason: 'dispatch_and_execution_distinct_with_isolated_context' };
}

// Re-checks evidence shape defensively even though review-authorization.js's finalizeReviewFromStop
// already validated it before the stamp was ever written -- never trust upstream discipline blindly.
function reviewEvidenceValid(reviewer) {
  if (reviewer.adapter_id === 'human') return { ok: true, reason: 'human_reviewer_no_evidence_artifact_required' };
  if (!reviewer.review_evidence) return { ok: false, reason: 'no_review_evidence_on_stamp' };
  const check = validateReviewEvidence(
    { target_diff_hash: reviewer.review_evidence.target_diff_hash, target_scope: reviewer.review_evidence.reviewed_scope },
    reviewer.review_evidence
  );
  return check.ok ? { ok: true, reason: 'evidence_present_and_well_shaped' } : { ok: false, reason: check.reason };
}

// evaluatePair(producer, reviewer, level) -> { level, satisfied, checks: {...} }
function evaluatePair(producer, reviewer, level) {
  const indep = actorIndependent(reviewer, [producer]);
  const evid = reviewEvidenceValid(reviewer);
  // review_authorized: by construction, only a stamp produced via finalizeReviewFromStop's success
  // path carries review_evidence at all -- so evidence presence doubles as the authorization signal
  // here. Human reviewers are authorized by the CLI itself gating who may invoke it with --kind
  // human (mirrors provenance:'cli_human''s hardcoded-literal pattern) -- no file-based evidence
  // artifact is required for that tier, same bypass already applied in actor_independence/
  // reviewEvidenceValid above. Kept as a named, separate field (never merged into one boolean) so a
  // future caller can distinguish "never authorized" from "authorized but evidence invalid".
  const authorized = reviewer.adapter_id === 'human'
    ? { ok: true, reason: 'human_reviewer_authorized_by_cli_gate' }
    : { ok: !!reviewer.review_evidence, reason: reviewer.review_evidence ? 'evidence_present_implies_prior_authorization' : 'no_evidence_no_authorization_signal' };

  const checks = {
    actor_independence: indep,
    review_authorized: authorized,
    review_evidence_valid: evid,
    deterministic_verification_mandatory: true // structural fact, never suppressible by this evaluator
  };

  let tierSatisfied;
  if (level === 'deterministic') {
    tierSatisfied = true; // the always-on floor; not itself an independence claim about actors
  } else if (level === 'isolated_actor') {
    tierSatisfied = indep.ok && authorized.ok && evid.ok;
  } else if (level === 'different_adapter') {
    tierSatisfied = indep.ok && authorized.ok && evid.ok && producer.adapter_id !== reviewer.adapter_id;
  } else if (level === 'different_provider') {
    tierSatisfied = indep.ok && authorized.ok && evid.ok && producer.provider_id !== reviewer.provider_id;
  } else if (level === 'human') {
    tierSatisfied = reviewer.adapter_id === 'human' || reviewer.reviewer_kind === 'human';
  } else {
    tierSatisfied = false;
  }

  return { level, satisfied: tierSatisfied, checks };
}

// evaluateIndependence({producers, reviewers, minimum_level}) -> full run-level verdict
function evaluateIndependence({ producers, reviewers, minimum_level }) {
  const level = TIER_LADDER.includes(minimum_level) ? minimum_level : 'isolated_actor';
  const prods = producers || [];
  const revs = reviewers || [];

  if (prods.length === 0) return { satisfied: false, minimum_level: level, reason: 'missing_provenance', checked_pairs: [] };
  if (revs.length === 0) return { satisfied: false, minimum_level: level, reason: 'no_eligible_reviewer', checked_pairs: [] };

  const checkedPairs = [];
  let anySatisfied = false;
  for (const producer of prods) {
    for (const reviewer of revs) {
      const result = evaluatePair(producer, reviewer, level);
      checkedPairs.push(Object.assign({ producer_dispatch_id: producer.dispatch_id, reviewer_dispatch_id: reviewer.dispatch_id }, result));
      if (result.satisfied) anySatisfied = true;
    }
  }
  // Independence for the RUN is satisfied if every producer has at least one independent reviewer
  // (not just "some pair somewhere") -- computed per-producer, then AND-ed across all producers.
  const perProducerSatisfied = prods.map(producer =>
    revs.some(reviewer => evaluatePair(producer, reviewer, level).satisfied)
  );
  const satisfied = perProducerSatisfied.every(Boolean);

  return {
    satisfied,
    minimum_level: level,
    reason: satisfied ? null : 'no_independent_reviewer',
    checked_pairs: checkedPairs
  };
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  const validEvidence = { verdict_path: '/tmp/v.json', verdict_status: 'PASS', target_diff_hash: 'h1', reviewed_scope: 'diff', completed_at: '2026-01-01T00:00:00.000Z' };
  const producer = { dispatch_id: 'main:sess-1:exec-1', execution_id: 'exec-1', adapter_id: 'claude-code', provider_id: 'anthropic', model_id: 'claude-sonnet-5' };
  const isolatedReviewer = { dispatch_id: 'agent-real-1', execution_id: 'exec-2', adapter_id: 'claude-code', provider_id: 'anthropic', model_id: 'claude-sonnet-5', context_mode: 'isolated_subagent', review_evidence: validEvidence };

  // 1. Same model, different isolated executions qualify as independent -- model_id identical.
  {
    const r = evaluateIndependence({ producers: [producer], reviewers: [isolatedReviewer], minimum_level: 'isolated_actor' });
    push('same_model_different_isolated_executions_qualify', r.satisfied === true, JSON.stringify(r));
  }
  // 2. Different models in the SAME execution/context do NOT automatically qualify.
  {
    const sameExecDifferentModel = Object.assign({}, isolatedReviewer, { execution_id: producer.execution_id, model_id: 'gpt-5.5' });
    const r = evaluateIndependence({ producers: [producer], reviewers: [sameExecDifferentModel], minimum_level: 'isolated_actor' });
    push('different_model_same_execution_does_not_qualify', r.satisfied === false, JSON.stringify(r));
  }
  // 3. Missing model identity never invalidates otherwise-valid provenance.
  {
    const noModel = Object.assign({}, isolatedReviewer, { model_id: null, model_observation_status: 'unavailable' });
    const r = evaluateIndependence({ producers: [producer], reviewers: [noModel], minimum_level: 'isolated_actor' });
    push('missing_model_identity_does_not_invalidate', r.satisfied === true, JSON.stringify(r));
  }
  // 4. No eligible independent reviewer -> explicit reason, not silently false.
  {
    const sameDispatch = Object.assign({}, isolatedReviewer, { dispatch_id: producer.dispatch_id, execution_id: producer.execution_id, context_mode: 'unknown', review_evidence: null });
    const r = evaluateIndependence({ producers: [producer], reviewers: [sameDispatch], minimum_level: 'isolated_actor' });
    push('no_eligible_reviewer_gives_explicit_reason', r.satisfied === false && r.reason === 'no_independent_reviewer', JSON.stringify(r));
  }
  // 5. Missing provenance fails closed.
  {
    const r = evaluateIndependence({ producers: [], reviewers: [isolatedReviewer], minimum_level: 'isolated_actor' });
    push('missing_producer_provenance_fails_closed', r.satisfied === false && r.reason === 'missing_provenance', JSON.stringify(r));
  }
  // 6. context_mode:'unknown' (no trusted hook evidence) never satisfies isolated_actor even with
  //    a distinct dispatch_id/execution_id.
  {
    const unknownContext = Object.assign({}, isolatedReviewer, { context_mode: 'unknown' });
    const r = evaluateIndependence({ producers: [producer], reviewers: [unknownContext], minimum_level: 'isolated_actor' });
    push('unknown_context_mode_never_satisfies_isolated_actor', r.satisfied === false, JSON.stringify(r));
  }
  // 7. Missing review evidence -> not authorized, isolated_actor fails even with real dispatch isolation.
  {
    const noEvidence = Object.assign({}, isolatedReviewer, { review_evidence: null });
    const r = evaluateIndependence({ producers: [producer], reviewers: [noEvidence], minimum_level: 'isolated_actor' });
    push('missing_review_evidence_fails_isolated_actor', r.satisfied === false, JSON.stringify(r));
    push('review_authorized_and_actor_independence_reported_separately',
      r.checked_pairs[0].checks.actor_independence.ok === true && r.checked_pairs[0].checks.review_authorized.ok === false,
      JSON.stringify(r.checked_pairs[0].checks));
  }
  // 8. Deterministic verification is always reported mandatory, regardless of outcome.
  {
    const r1 = evaluateIndependence({ producers: [producer], reviewers: [isolatedReviewer], minimum_level: 'isolated_actor' });
    const r2 = evaluateIndependence({ producers: [], reviewers: [], minimum_level: 'isolated_actor' });
    const p1 = r1.checked_pairs[0].checks.deterministic_verification_mandatory === true;
    push('deterministic_verification_always_mandatory_regardless_of_outcome', p1 && r2.satisfied === false, JSON.stringify({ p1, r2satisfied: r2.satisfied }));
  }
  // 9. different_adapter tier requires distinct adapter_id on top of isolated_actor.
  {
    const differentAdapter = Object.assign({}, isolatedReviewer, { adapter_id: 'codex-cli' });
    const rSame = evaluateIndependence({ producers: [producer], reviewers: [isolatedReviewer], minimum_level: 'different_adapter' });
    const rDiff = evaluateIndependence({ producers: [producer], reviewers: [differentAdapter], minimum_level: 'different_adapter' });
    push('different_adapter_tier_requires_distinct_adapter', rSame.satisfied === false && rDiff.satisfied === true, JSON.stringify({ rSame: rSame.satisfied, rDiff: rDiff.satisfied }));
  }
  // 10. human tier satisfied by an explicit human reviewer.
  {
    const humanReviewer = { dispatch_id: 'human:owner', execution_id: 'n/a', adapter_id: 'human', provider_id: 'human', reviewer_kind: 'human' };
    const r = evaluateIndependence({ producers: [producer], reviewers: [humanReviewer], minimum_level: 'human' });
    push('human_tier_satisfied_by_human_reviewer', r.satisfied === true, JSON.stringify(r));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { TIER_LADDER, actorIndependent, reviewEvidenceValid, evaluatePair, evaluateIndependence };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('evaluator.js — library. node scripts/review-independence/core/evaluator.js --self-test');
  process.exit(0);
}
