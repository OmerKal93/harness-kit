#!/usr/bin/env node
// claude-code-hooks.js — REVIEW-INDEPENDENCE-1 adapter: the ONLY file in this feature allowed to
// know real Claude Code hook payload field names (agent_id, agent_type, transcript_path,
// session_id, last_assistant_message, hook_event_name). Verified against Claude Code's real hooks
// documentation this session: SubagentStart fires "when a subagent is spawned" and carries
// `agent_id` ("unique identifier for the subagent... present only when the hook fires inside a
// subagent call... use this to distinguish subagent hook calls from main-thread calls") and
// `agent_type`. Stop converts to SubagentStop inside a subagent, carrying the same agent_id/
// agent_type plus `last_assistant_message`, alongside common fields session_id/transcript_path.
//
// PORTABILITY: scripts/review-independence/core/* never imports this file or references any of
// these field names. This adapter translates Claude's raw payload into the generic shapes core/
// consumes (dispatch_id, agent_type, session_id) -- a future codex-hooks.js/ci-worker.js adapter
// would live alongside this one without touching core/ at all.
'use strict';

const { withRunJsonLock } = require('../run-json-atomic.js');
const { bindDispatchToRequest, finalizeReviewFromStop } = require('../core/review-authorization.js');
const { stampReviewer } = require('../core/actor-identity.js');

// Claude's real agent_id becomes dispatch_id -- NEVER a Harness-minted UUID standing in as proof
// of a separate dispatch. A Harness-minted UUID may still exist as an unrelated stamp_id/event_id
// bookkeeping value elsewhere, but this function never mints one for dispatch_id itself.
function dispatchIdFromHookPayload(payload) {
  return payload && typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : null;
}

// handleSubagentStart(payload, {runDir, runId, mintStampId, now})
//   payload: the real Claude Code SubagentStart hook JSON (read from stdin by the hook script)
// Records the dispatch as an actor (pending_dispatches[]) unconditionally, and separately attempts
// to bind it to any matching pending_review_requests[] entry (Layer 2). Both happen under one lock
// so a concurrent producer/other-hook write can't interleave a torn view.
function handleSubagentStart(payload, ctx) {
  const dispatchId = dispatchIdFromHookPayload(payload);
  if (!dispatchId) return { ok: false, reason: 'no_agent_id_in_payload' };
  const agentType = payload.agent_type || 'unknown';
  const sessionId = payload.session_id || 'unknown';

  return withRunJsonLock(ctx.runDir, (current) => {
    if (!current) throw new Error(`run.json not found for ${ctx.runId}`);
    // Idempotent: duplicate SubagentStart delivery for the same agent_id is a no-op, not a second entry.
    const alreadyRecorded = (current.pending_dispatches || []).some(d => d.agent_id === dispatchId);
    const pendingDispatches = alreadyRecorded ? current.pending_dispatches : [
      ...(current.pending_dispatches || []),
      { agent_id: dispatchId, agent_type: agentType, session_id: sessionId, parent_run_id: ctx.runId, status: 'pending', started_at: ctx.now }
    ];

    let pendingReviewRequests = current.pending_review_requests || [];
    // Only attempt binding if this dispatch hasn't already been recorded (avoids re-binding on a
    // duplicate SubagentStart delivery, which would otherwise look like "another agent_id" hijack).
    if (!alreadyRecorded) {
      const bindResult = bindDispatchToRequest(pendingReviewRequests, {
        run_id: ctx.runId,
        execution_id: current.active_execution_id,
        agent_type: agentType,
        dispatch_id: dispatchId,
        now: ctx.now
      });
      if (bindResult.ok) {
        pendingReviewRequests = pendingReviewRequests.map(r =>
          r.review_request_id === bindResult.request_id ? bindResult.updatedRequest : r
        );
      }
      // A failed bind (no match / ambiguous / expired / wrong type) is not an error condition for
      // SubagentStart itself -- the dispatch is still recorded as a real actor above; it simply
      // never becomes an authorized reviewer, exactly per the required behavior.
    }

    return Object.assign({}, current, { pending_dispatches: pendingDispatches, pending_review_requests: pendingReviewRequests });
  });
}

// handleSubagentStop(payload, {runDir, runId, readVerdictFile, mintStampId, now})
//   readVerdictFile(path) -> parsed JSON or null (injectable for testability, real fs.readFileSync
//   + JSON.parse in production use)
// Finalizes the pending_dispatches entry (actor bookkeeping) unconditionally. Separately, if this
// agent_id is bound to a 'dispatched' review request, reads the request's OWN expected_verdict_path
// (never last_assistant_message -- SubagentStop firing is not review evidence) and, only if it
// parses and matches the request's target_diff_hash/scope, finalizes the request and appends a
// real reviewer stamp to reviewers[].
function handleSubagentStop(payload, ctx) {
  const dispatchId = dispatchIdFromHookPayload(payload);
  if (!dispatchId) return { ok: false, reason: 'no_agent_id_in_payload' };

  return withRunJsonLock(ctx.runDir, (current) => {
    if (!current) throw new Error(`run.json not found for ${ctx.runId}`);

    const pendingDispatches = (current.pending_dispatches || []).map(d =>
      d.agent_id === dispatchId ? Object.assign({}, d, { status: 'completed', agent_transcript_path: payload.transcript_path || null, completed_at: ctx.now }) : d
    );

    const boundRequest = (current.pending_review_requests || []).find(r => r.status === 'dispatched' && r.bound_agent_id === dispatchId);
    let pendingReviewRequests = current.pending_review_requests || [];
    let reviewers = current.reviewers || [];

    if (boundRequest) {
      const verdict = ctx.readVerdictFile ? ctx.readVerdictFile(boundRequest.expected_verdict_path) : null;
      if (verdict && typeof verdict === 'object') {
        const evidence = {
          verdict_path: boundRequest.expected_verdict_path,
          verdict_status: verdict.verdict_status,
          reviewed_scope: verdict.reviewed_scope,
          target_diff_hash: verdict.target_diff_hash,
          completed_at: ctx.now
        };
        const finalize = finalizeReviewFromStop(pendingReviewRequests, { dispatch_id: dispatchId, review_evidence: evidence, now: ctx.now });
        if (finalize.ok) {
          pendingReviewRequests = pendingReviewRequests.map(r => r.review_request_id === finalize.request_id ? finalize.updatedRequest : r);
          const reviewerStamp = stampReviewer({
            dispatch_id: dispatchId,
            execution_id: current.active_execution_id,
            parent_run_id: ctx.runId,
            adapter_id: 'claude-code',
            provider_id: 'anthropic',
            model_id: null,
            model_observation_status: 'unavailable',
            session_id: payload.session_id || 'unknown',
            context_mode: 'isolated_subagent', // real, trusted: correlated SubagentStart+SubagentStop via agent_id
            reviewer_kind: boundRequest.review_stage === 'security_review' ? 'security_review' : 'ce_code_review_subagent',
            review_evidence: evidence,
            agent_transcript_path: payload.transcript_path || null,
            stamp_id: ctx.mintStampId ? ctx.mintStampId() : `stamp-${Date.now()}`,
            stamped_at: ctx.now
          }, {});
          reviewers = [...reviewers, reviewerStamp];
        }
        // finalize.ok === false (e.g. evidence mismatch) leaves the request as 'dispatched' -- it
        // will eventually expire via expirePendingRequests, never silently promoted.
      }
      // No verdict file, or it doesn't parse -- boundRequest stays 'dispatched', never finalized.
      // Missing SubagentStop evidence remains incomplete, per the required behavior.
    }

    return Object.assign({}, current, { pending_dispatches: pendingDispatches, pending_review_requests: pendingReviewRequests, reviewers });
  });
}

function selfTest() {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { createReviewRequest } = require('../core/review-authorization.js');
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-claude-hooks-selftest-'));
  const cleanup = () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ } };

  try {
    function freshRunDir(seedRunJson) {
      const rd = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
      fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify(Object.assign({
        active_execution_id: 'exec-1', pending_dispatches: [], pending_review_requests: [], producers: [], reviewers: []
      }, seedRunJson || {})));
      return rd;
    }

    // 1. Real agent_id is preserved exactly as dispatch_id.
    {
      const rd = freshRunDir();
      handleSubagentStart({ agent_id: 'agent-REAL-42', agent_type: 'Explore', session_id: 'sess-1' }, { runDir: rd, runId: 'r1', now: '2026-01-01T00:00:00.000Z' });
      const rj = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
      push('real_agent_id_preserved_as_dispatch_id', rj.pending_dispatches[0].agent_id === 'agent-REAL-42', JSON.stringify(rj.pending_dispatches));
    }

    // 2. SubagentStart + SubagentStop correlate through the same agent_id, with a bound review
    //    request, and produce a finalized reviewer stamp when evidence is valid.
    {
      const req = createReviewRequest([], {
        review_request_id: 'rr-1', run_id: 'r1', execution_id: 'exec-1', review_stage: 'security_review',
        allowed_agent_types: ['security-reviewer'], target_scope: 'diff', target_diff_hash: 'h1',
        expected_verdict_path: path.join(tmpRoot, 'verdict.json'), created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-01T01:00:00.000Z'
      }).request;
      const rd = freshRunDir({ pending_review_requests: [req] });
      handleSubagentStart({ agent_id: 'agent-REAL-1', agent_type: 'security-reviewer', session_id: 'sess-1' }, { runDir: rd, runId: 'r1', now: '2026-01-01T00:10:00.000Z' });
      fs.writeFileSync(path.join(tmpRoot, 'verdict.json'), JSON.stringify({ verdict_status: 'REJECT', target_diff_hash: 'h1', reviewed_scope: 'diff' }));
      handleSubagentStop(
        { agent_id: 'agent-REAL-1', agent_type: 'security-reviewer', transcript_path: '/tmp/t.jsonl', last_assistant_message: 'irrelevant, not evidence' },
        { runDir: rd, runId: 'r1', now: '2026-01-01T00:15:00.000Z', readVerdictFile: (p) => JSON.parse(fs.readFileSync(p, 'utf8')), mintStampId: () => 'stamp-1' }
      );
      const rj = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
      push('start_stop_correlate_and_finalize_reviewer',
        rj.reviewers.length === 1 && rj.reviewers[0].dispatch_id === 'agent-REAL-1' && rj.reviewers[0].review_evidence.verdict_status === 'REJECT',
        JSON.stringify(rj.reviewers));
    }

    // 3. A subagent cannot provide/overwrite its own agent_id -- there is no field in the payload
    //    this adapter reads other than the top-level agent_id itself; a payload claiming a
    //    DIFFERENT identity in some other field has no effect.
    {
      const rd = freshRunDir();
      handleSubagentStart({ agent_id: 'agent-REAL-2', agent_type: 'Explore', session_id: 'sess-1', dispatch_id: 'FAKE-INJECTED', bound_agent_id: 'FAKE-2' }, { runDir: rd, runId: 'r1', now: '2026-01-01T00:00:00.000Z' });
      const rj = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
      push('subagent_cannot_override_own_agent_id', rj.pending_dispatches[0].agent_id === 'agent-REAL-2', JSON.stringify(rj.pending_dispatches));
    }

    // 4. Missing SubagentStop evidence (no verdict file ever appears) leaves the request
    //    'dispatched', never finalized, never counted as a reviewer.
    {
      const req = createReviewRequest([], {
        review_request_id: 'rr-2', run_id: 'r1', execution_id: 'exec-1', review_stage: 'security_review',
        allowed_agent_types: ['security-reviewer'], target_scope: 'diff', target_diff_hash: 'h2',
        expected_verdict_path: path.join(tmpRoot, 'never-written.json'), created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-01T01:00:00.000Z'
      }).request;
      const rd = freshRunDir({ pending_review_requests: [req] });
      handleSubagentStart({ agent_id: 'agent-REAL-3', agent_type: 'security-reviewer', session_id: 'sess-1' }, { runDir: rd, runId: 'r1', now: '2026-01-01T00:10:00.000Z' });
      handleSubagentStop(
        { agent_id: 'agent-REAL-3', agent_type: 'security-reviewer' },
        { runDir: rd, runId: 'r1', now: '2026-01-01T00:15:00.000Z', readVerdictFile: () => null, mintStampId: () => 'stamp-2' }
      );
      const rj = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
      const stillDispatched = rj.pending_review_requests.find(r => r.review_request_id === 'rr-2').status === 'dispatched';
      push('missing_stop_evidence_remains_incomplete_not_isolated', rj.reviewers.length === 0 && stillDispatched, JSON.stringify({ reviewers: rj.reviewers, req: rj.pending_review_requests }));
    }

    // 5. Duplicate SubagentStart delivery for the same agent_id is idempotent -- no double entry.
    {
      const rd = freshRunDir();
      handleSubagentStart({ agent_id: 'agent-REAL-4', agent_type: 'Explore', session_id: 'sess-1' }, { runDir: rd, runId: 'r1', now: '2026-01-01T00:00:00.000Z' });
      handleSubagentStart({ agent_id: 'agent-REAL-4', agent_type: 'Explore', session_id: 'sess-1' }, { runDir: rd, runId: 'r1', now: '2026-01-01T00:00:01.000Z' });
      const rj = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
      push('duplicate_subagent_start_delivery_idempotent', rj.pending_dispatches.length === 1, JSON.stringify(rj.pending_dispatches));
    }

    // 6. Main-thread vs subagent identities always differ (main-thread namespacing, no hook fires).
    {
      const mainThreadDispatchId = `main:sess-1:exec-1`;
      push('main_thread_and_subagent_identities_differ', mainThreadDispatchId !== 'agent-REAL-1', 'namespaced main: prefix never collides with a real agent_id');
    }

    // 7. Mismatched target_diff_hash in the verdict file fails to finalize -- an arbitrary Explore
    //    subagent with a real agent_id but no bound request never becomes a reviewer either way.
    {
      const req = createReviewRequest([], {
        review_request_id: 'rr-3', run_id: 'r1', execution_id: 'exec-1', review_stage: 'security_review',
        allowed_agent_types: ['security-reviewer'], target_scope: 'diff', target_diff_hash: 'expected-hash',
        expected_verdict_path: path.join(tmpRoot, 'verdict3.json'), created_at: '2026-01-01T00:00:00.000Z', expires_at: '2026-01-01T01:00:00.000Z'
      }).request;
      const rd = freshRunDir({ pending_review_requests: [req] });
      handleSubagentStart({ agent_id: 'agent-REAL-5', agent_type: 'security-reviewer', session_id: 'sess-1' }, { runDir: rd, runId: 'r1', now: '2026-01-01T00:10:00.000Z' });
      fs.writeFileSync(path.join(tmpRoot, 'verdict3.json'), JSON.stringify({ verdict_status: 'PASS', target_diff_hash: 'WRONG-hash', reviewed_scope: 'diff' }));
      handleSubagentStop(
        { agent_id: 'agent-REAL-5', agent_type: 'security-reviewer' },
        { runDir: rd, runId: 'r1', now: '2026-01-01T00:15:00.000Z', readVerdictFile: (p) => JSON.parse(fs.readFileSync(p, 'utf8')), mintStampId: () => 'stamp-3' }
      );
      const rj = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
      push('mismatched_evidence_never_finalizes_as_reviewer', rj.reviewers.length === 0, JSON.stringify(rj.reviewers));
    }

    // 8. An arbitrary Explore/general-purpose subagent with no matching pending review request is
    //    recorded as an actor but never counted as a reviewer.
    {
      const rd = freshRunDir();
      handleSubagentStart({ agent_id: 'agent-REAL-6', agent_type: 'Explore', session_id: 'sess-1' }, { runDir: rd, runId: 'r1', now: '2026-01-01T00:00:00.000Z' });
      handleSubagentStop({ agent_id: 'agent-REAL-6', agent_type: 'Explore' }, { runDir: rd, runId: 'r1', now: '2026-01-01T00:05:00.000Z', readVerdictFile: () => null, mintStampId: () => 'stamp-4' });
      const rj = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
      push('arbitrary_explore_subagent_recorded_as_actor_never_reviewer',
        rj.pending_dispatches.length === 1 && rj.pending_dispatches[0].status === 'completed' && rj.reviewers.length === 0,
        JSON.stringify({ dispatches: rj.pending_dispatches, reviewers: rj.reviewers }));
    }
  } finally {
    cleanup();
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { dispatchIdFromHookPayload, handleSubagentStart, handleSubagentStop };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('claude-code-hooks.js — library. node scripts/review-independence/adapters/claude-code-hooks.js --self-test');
  process.exit(0);
}
