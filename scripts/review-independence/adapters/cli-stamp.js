#!/usr/bin/env node
// cli-stamp.js — REVIEW-INDEPENDENCE-1 adapter: the non-subagent path (main-thread Claude Code,
// Codex once reachable, external/CI actors, explicit human confirmation). Actors covered by the
// Claude Code subagent hooks (claude-code-hooks.js) never go through here -- a subagent proving
// its own independence by calling stamp-reviewer.js from inside itself would be exactly the
// self-reported-claim pattern this whole feature exists to defeat.
//
// No CLI flag here accepts a caller-supplied dispatch_id/execution_id/adapter_id/provider_id --
// there is no argument surface for a model to inject a claimed identity through. adapter_id/
// provider_id are hardcoded literals at each call site (mirrors provenance:'live_codex''s
// "unreachable except past the real call site" pattern already used elsewhere in this repo).
'use strict';

const { withRunJsonLock } = require('../run-json-atomic.js');
const { stampProducer, stampReviewer } = require('../core/actor-identity.js');

function mainThreadDispatchId(sessionId, executionId) {
  return `main:${sessionId}:${executionId}`;
}

// recordMainThreadProducer(runDir, {runId, sessionId, adapterId, providerId, stampId, now}) -> stamp
function recordMainThreadProducer(runDir, ctx) {
  return withRunJsonLock(runDir, (current) => {
    if (!current) throw new Error(`run.json not found`);
    const dispatchId = mainThreadDispatchId(ctx.sessionId, current.active_execution_id);
    // Idempotent: this exact actor already has the most recent producer entry for this run -> no-op.
    const producers = current.producers || [];
    const last = producers[producers.length - 1];
    if (last && last.dispatch_id === dispatchId && last.execution_id === current.active_execution_id) {
      return current;
    }
    const stamp = stampProducer({
      dispatch_id: dispatchId,
      execution_id: current.active_execution_id,
      parent_run_id: ctx.runId,
      adapter_id: ctx.adapterId,
      provider_id: ctx.providerId,
      model_id: ctx.modelId != null ? ctx.modelId : null,
      model_observation_status: ctx.modelObservationStatus || 'unavailable',
      session_id: ctx.sessionId,
      context_mode: 'unknown', // main-thread actions have no SubagentStart/Stop correlation
      stamp_id: ctx.stampId,
      stamped_at: ctx.now
    }, {});
    return Object.assign({}, current, { producers: [...producers, stamp] });
  });
}

// recordHumanReviewer(runDir, {runId, sessionId, stampId, now, reviewEvidence}) -> stamp
// The 'human' tier's escape hatch, mirrors provenance:'cli_human''s hardcoded-literal pattern:
// this call site is the only place a 'human' reviewer stamp can be written.
function recordHumanReviewer(runDir, ctx) {
  return withRunJsonLock(runDir, (current) => {
    if (!current) throw new Error(`run.json not found`);
    const stamp = stampReviewer({
      dispatch_id: `human:${ctx.sessionId}`,
      execution_id: current.active_execution_id,
      parent_run_id: ctx.runId,
      adapter_id: 'human',
      provider_id: 'human',
      model_id: null,
      model_observation_status: 'unavailable',
      session_id: ctx.sessionId,
      context_mode: 'unknown',
      reviewer_kind: 'human',
      review_evidence: ctx.reviewEvidence || null,
      stamp_id: ctx.stampId,
      stamped_at: ctx.now
    }, {});
    return Object.assign({}, current, { reviewers: [...(current.reviewers || []), stamp] });
  });
}

module.exports = { mainThreadDispatchId, recordMainThreadProducer, recordHumanReviewer };
