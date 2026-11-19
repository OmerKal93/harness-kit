#!/usr/bin/env node
// review-authorization.js — REVIEW-INDEPENDENCE-1 core: the pre-dispatch request-to-agent binding
// protocol. A real subagent dispatch (a trusted dispatch_id) proves an actor is real; it does not
// prove that dispatch was AUTHORIZED to review, or that it produced a VALID verdict. This file
// implements the two extra checks that close that gap, kept deliberately separate from actor
// identity (actor-identity.js) and from the final AND-composition (evaluator.js).
//
// PORTABILITY BOUNDARY: pure functions over plain data. No Claude-specific field names, no
// filesystem access, no process/env access. Adapters translate a runtime's real dispatch event
// into the {run_id, execution_id, agent_type, dispatch_id} shape this file consumes.
//
// Documented limitation, stated honestly rather than glossed over: Claude Code does not currently
// provide a pre-dispatch correlation token directly to the Harness -- there is no API to say
// "the subagent I am about to spawn will carry agent_id X" before the spawn happens. So exact
// {request <-> specific future dispatch} correlation is not possible ahead of time. The mitigation
// implemented here is the invariant: "at most one unbound pending review request may exist for a
// given {run_id, execution_id, review_stage} tuple" -- if a SubagentStart event's agent_type
// matches exactly one outstanding request across the run/execution, that is treated as the binding.
// If more than one request could match (e.g. two stages awaiting the same agent_type
// simultaneously), binding fails closed rather than guessing.
'use strict';

const REQUEST_STATUS = Object.freeze(['awaiting_dispatch', 'dispatched', 'completed', 'expired']);

// createReviewRequest(existingRequests, spec) -> { ok:true, request } | { ok:false, reason }
// Enforces "at most one unbound request per {run_id, execution_id, review_stage}" at creation time.
function createReviewRequest(existingRequests, spec) {
  const conflict = (existingRequests || []).find(r =>
    r.run_id === spec.run_id && r.execution_id === spec.execution_id && r.review_stage === spec.review_stage &&
    r.status === 'awaiting_dispatch'
  );
  if (conflict) return { ok: false, reason: 'unbound_request_already_exists_for_run_execution_stage' };
  if (!Array.isArray(spec.allowed_agent_types) || spec.allowed_agent_types.length === 0) {
    return { ok: false, reason: 'allowed_agent_types must be a non-empty array' };
  }
  const request = {
    review_request_id: spec.review_request_id,
    run_id: spec.run_id,
    execution_id: spec.execution_id,
    review_stage: spec.review_stage,
    allowed_agent_types: spec.allowed_agent_types,
    target_scope: spec.target_scope,
    target_diff_hash: spec.target_diff_hash,
    expected_verdict_path: spec.expected_verdict_path,
    status: 'awaiting_dispatch',
    created_at: spec.created_at,
    expires_at: spec.expires_at,
    bound_agent_id: null,
    dispatch_started_at: null,
    completed_at: null
  };
  return { ok: true, request };
}

// bindDispatchToRequest(pendingRequests, {run_id, execution_id, agent_type, dispatch_id, now})
//   -> { ok:true, request_id, updatedRequest } | { ok:false, reason }
// Called from the SubagentStart path. Fails closed on zero matches, ambiguous matches, expiry,
// disallowed agent_type, or a run/execution mismatch -- in every failure case the dispatch is
// still real (an actor stamp may still be recorded elsewhere) but is never treated as authorized.
function bindDispatchToRequest(pendingRequests, ctx) {
  const nowMs = Date.parse(ctx.now);
  const candidates = (pendingRequests || []).filter(r =>
    r.status === 'awaiting_dispatch' && r.bound_agent_id == null &&
    r.run_id === ctx.run_id && r.execution_id === ctx.execution_id
  );
  if (candidates.length === 0) return { ok: false, reason: 'no_run_execution_match' };

  const notExpired = candidates.filter(r => !Number.isFinite(Date.parse(r.expires_at)) || Date.parse(r.expires_at) > nowMs);
  const agentTypeMatched = notExpired.filter(r => Array.isArray(r.allowed_agent_types) && r.allowed_agent_types.includes(ctx.agent_type));

  if (agentTypeMatched.length === 0) {
    if (notExpired.length === 0 && candidates.length > 0) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'no_agent_type_match' };
  }
  if (agentTypeMatched.length > 1) return { ok: false, reason: 'ambiguous_multiple_matches' };

  const match = agentTypeMatched[0];
  const updatedRequest = Object.assign({}, match, {
    status: 'dispatched',
    bound_agent_id: ctx.dispatch_id,
    dispatch_started_at: ctx.now
  });
  return { ok: true, request_id: match.review_request_id, updatedRequest };
}

// finalizeReviewFromStop(pendingRequests, {dispatch_id, review_evidence, now})
//   -> { ok:true, request_id, updatedRequest } | { ok:false, reason }
// Finalizes ONLY the request already bound to this exact dispatch_id. Never selects or infers a
// request retroactively -- if no request is bound to this dispatch_id, there is nothing to
// finalize, and this dispatch never becomes an authorized reviewer no matter what it did.
function finalizeReviewFromStop(pendingRequests, ctx) {
  const bound = (pendingRequests || []).find(r => r.status === 'dispatched' && r.bound_agent_id === ctx.dispatch_id);
  if (!bound) return { ok: false, reason: 'no_request_bound_to_this_dispatch_id' };

  const evidenceCheck = validateReviewEvidence(bound, ctx.review_evidence);
  if (!evidenceCheck.ok) return { ok: false, reason: evidenceCheck.reason, request_id: bound.review_request_id };

  const updatedRequest = Object.assign({}, bound, {
    status: 'completed',
    completed_at: ctx.now,
    review_evidence: ctx.review_evidence
  });
  return { ok: true, request_id: bound.review_request_id, updatedRequest };
}

// validateReviewEvidence(request, evidence) -> {ok, reason?}
// SubagentStop firing is NOT review evidence by itself -- a finalized reviewer stamp must
// reference real evidence that matches what the request was created to expect.
function validateReviewEvidence(request, evidence) {
  if (!evidence || typeof evidence !== 'object') return { ok: false, reason: 'missing_review_evidence' };
  if (typeof evidence.verdict_path !== 'string' || !evidence.verdict_path) return { ok: false, reason: 'missing_verdict_path' };
  if (typeof evidence.verdict_status !== 'string' || !evidence.verdict_status) return { ok: false, reason: 'missing_verdict_status' };
  if (evidence.target_diff_hash !== request.target_diff_hash) return { ok: false, reason: 'target_diff_hash_mismatch' };
  if (request.target_scope != null && evidence.reviewed_scope !== request.target_scope) return { ok: false, reason: 'reviewed_scope_mismatch' };
  if (typeof evidence.completed_at !== 'string' || !evidence.completed_at) return { ok: false, reason: 'missing_completed_at' };
  return { ok: true };
}

// expirePendingRequests(requests, now) -> requests with any past-due 'awaiting_dispatch' or
// 'dispatched' entries moved to status:'expired'. Never promotes anything to valid; only stops
// indefinite ambiguity and makes stale entries reportable/cleanable.
function expirePendingRequests(requests, now) {
  const nowMs = Date.parse(now);
  return (requests || []).map(r => {
    if ((r.status === 'awaiting_dispatch' || r.status === 'dispatched') &&
        Number.isFinite(Date.parse(r.expires_at)) && Date.parse(r.expires_at) <= nowMs) {
      return Object.assign({}, r, { status: 'expired' });
    }
    return r;
  });
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });
  const NOW = '2026-01-01T00:10:00.000Z';
  const FUTURE = '2026-01-01T01:00:00.000Z';
  const PAST = '2026-01-01T00:00:00.000Z';

  const baseSpec = {
    review_request_id: 'rr-1', run_id: 'run-1', execution_id: 'exec-1', review_stage: 'security_review',
    allowed_agent_types: ['security-reviewer'], target_scope: 'diff', target_diff_hash: 'hash-abc',
    expected_verdict_path: '/tmp/verdict.json', created_at: PAST, expires_at: FUTURE
  };

  // 1. Creation succeeds, second unbound request for the same tuple is refused.
  {
    const r1 = createReviewRequest([], baseSpec);
    push('first_request_creation_succeeds', r1.ok === true, JSON.stringify(r1));
    const r2 = createReviewRequest([r1.request], Object.assign({}, baseSpec, { review_request_id: 'rr-2' }));
    push('second_unbound_request_same_tuple_refused', r2.ok === false && r2.reason.includes('already_exists'), JSON.stringify(r2));
  }

  // 2. Exactly one matching request binds.
  {
    const created = createReviewRequest([], baseSpec).request;
    const bind = bindDispatchToRequest([created], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-1', now: NOW });
    push('exactly_one_matching_request_binds', bind.ok === true && bind.updatedRequest.bound_agent_id === 'agent-real-1' && bind.updatedRequest.status === 'dispatched', JSON.stringify(bind));
  }
  // 3. Zero matching requests do not bind.
  {
    const bind = bindDispatchToRequest([], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-2', now: NOW });
    push('zero_matching_requests_do_not_bind', bind.ok === false && bind.reason === 'no_run_execution_match', JSON.stringify(bind));
  }
  // 4. Two matching requests fail closed (ambiguous).
  {
    const req1 = createReviewRequest([], baseSpec).request;
    const req2 = createReviewRequest([req1], Object.assign({}, baseSpec, { review_request_id: 'rr-2', review_stage: 'ce_code_review' })).request;
    const bind = bindDispatchToRequest([req1, req2], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-3', now: NOW });
    push('two_matching_requests_fail_closed', bind.ok === false && bind.reason === 'ambiguous_multiple_matches', JSON.stringify(bind));
  }
  // 5. Wrong agent type does not bind.
  {
    const created = createReviewRequest([], baseSpec).request;
    const bind = bindDispatchToRequest([created], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'Explore', dispatch_id: 'agent-real-4', now: NOW });
    push('wrong_agent_type_does_not_bind', bind.ok === false && bind.reason === 'no_agent_type_match', JSON.stringify(bind));
    push('arbitrary_explore_subagent_never_counts_as_reviewer', bind.ok === false, 'Explore-type dispatch against a security_review request refused');
  }
  // 6. Expired request does not bind.
  {
    const expiredSpec = Object.assign({}, baseSpec, { expires_at: PAST });
    const created = createReviewRequest([], expiredSpec).request;
    const bind = bindDispatchToRequest([created], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-5', now: NOW });
    push('expired_request_does_not_bind', bind.ok === false && bind.reason === 'expired', JSON.stringify(bind));
  }
  // 7. Duplicate SubagentStart (same dispatch_id binding twice) is idempotent: second bind attempt
  //    against an already-'dispatched' (no longer 'awaiting_dispatch') request finds no candidate.
  {
    const created = createReviewRequest([], baseSpec).request;
    const first = bindDispatchToRequest([created], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-6', now: NOW });
    const second = bindDispatchToRequest([first.updatedRequest], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-6', now: NOW });
    push('duplicate_subagent_start_is_idempotent', first.ok === true && second.ok === false && second.reason === 'no_run_execution_match', JSON.stringify({ first, second }));
  }
  // 8. Another agent_id cannot replace the bound agent.
  {
    const created = createReviewRequest([], baseSpec).request;
    const first = bindDispatchToRequest([created], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-7', now: NOW });
    const hijack = bindDispatchToRequest([first.updatedRequest], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-DIFFERENT', now: NOW });
    push('another_agent_id_cannot_replace_bound_agent', hijack.ok === false, JSON.stringify(hijack));
  }
  // 9. SubagentStop finalizes only the request bound to that exact agent_id.
  {
    const created = createReviewRequest([], baseSpec).request;
    const bound = bindDispatchToRequest([created], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-8', now: NOW }).updatedRequest;
    const evidence = { verdict_path: '/tmp/verdict.json', verdict_status: 'REJECT', target_diff_hash: 'hash-abc', reviewed_scope: 'diff', completed_at: NOW };
    const finalize = finalizeReviewFromStop([bound], { dispatch_id: 'agent-real-8', review_evidence: evidence, now: NOW });
    push('subagent_stop_finalizes_only_bound_request', finalize.ok === true && finalize.updatedRequest.status === 'completed', JSON.stringify(finalize));
  }
  // 10. SubagentStop cannot finalize a request bound to another agent.
  {
    const created = createReviewRequest([], baseSpec).request;
    const bound = bindDispatchToRequest([created], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-9', now: NOW }).updatedRequest;
    const finalize = finalizeReviewFromStop([bound], { dispatch_id: 'agent-WRONG', review_evidence: {}, now: NOW });
    push('subagent_stop_cannot_finalize_wrong_agent_request', finalize.ok === false && finalize.reason === 'no_request_bound_to_this_dispatch_id', JSON.stringify(finalize));
  }
  // 11. Mismatched target_diff_hash in review evidence fails to finalize.
  {
    const created = createReviewRequest([], baseSpec).request;
    const bound = bindDispatchToRequest([created], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-10', now: NOW }).updatedRequest;
    const badEvidence = { verdict_path: '/tmp/v.json', verdict_status: 'PASS', target_diff_hash: 'WRONG-HASH', reviewed_scope: 'diff', completed_at: NOW };
    const finalize = finalizeReviewFromStop([bound], { dispatch_id: 'agent-real-10', review_evidence: badEvidence, now: NOW });
    push('mismatched_diff_hash_fails_to_finalize', finalize.ok === false && finalize.reason === 'target_diff_hash_mismatch', JSON.stringify(finalize));
  }
  // 12. Missing review evidence (SubagentStop alone) fails to finalize -- completion is not evidence.
  {
    const created = createReviewRequest([], baseSpec).request;
    const bound = bindDispatchToRequest([created], { run_id: 'run-1', execution_id: 'exec-1', agent_type: 'security-reviewer', dispatch_id: 'agent-real-11', now: NOW }).updatedRequest;
    const finalize = finalizeReviewFromStop([bound], { dispatch_id: 'agent-real-11', review_evidence: null, now: NOW });
    push('missing_review_evidence_fails_to_finalize', finalize.ok === false && finalize.reason === 'missing_review_evidence', JSON.stringify(finalize));
  }
  // 13. Expiry moves a stale pending request to 'expired' without ever promoting it.
  {
    const created = createReviewRequest([], Object.assign({}, baseSpec, { expires_at: PAST })).request;
    const expired = expirePendingRequests([created], NOW);
    push('expiry_moves_to_expired_never_promotes', expired[0].status === 'expired', JSON.stringify(expired));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = {
  REQUEST_STATUS, createReviewRequest, bindDispatchToRequest, finalizeReviewFromStop,
  validateReviewEvidence, expirePendingRequests
};

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('review-authorization.js — library. node scripts/review-independence/core/review-authorization.js --self-test');
  process.exit(0);
}
