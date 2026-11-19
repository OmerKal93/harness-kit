#!/usr/bin/env node
// create-review-request.js — REVIEW-INDEPENDENCE-1 Layer 2: called by trusted orchestration
// BEFORE dispatching an approved reviewer subagent. Mints review_request_id/timestamps via
// trusted code (crypto.randomUUID(), nowIso()) -- no CLI flag accepts a caller-supplied
// review_request_id. Enforces "at most one unbound pending review request per
// {run_id, execution_id, review_stage}" via review-authorization.js#createReviewRequest.
//
//   node scripts/create-review-request.js --run-id <id> --review-stage <stage>
//     --allowed-agent-types <csv> --target-scope <scope> --target-diff-hash <hash>
//     --expected-verdict-path <path> [--ttl-minutes N=60]
'use strict';
const crypto = require('crypto');
const { parseArgs, harnessRoot, runDir, nowIso } = require('./_lib.js');
const { isDisabled } = require('./is-disabled.js');
const { withRunJsonLock } = require('./review-independence/run-json-atomic.js');
const { createReviewRequest } = require('./review-independence/core/review-authorization.js');

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok: false, disabled: true, reason: dis.reason })); process.exit(0); }
  const a = parseArgs(process.argv.slice(2));
  const runId = a['run-id'];
  const reviewStage = a['review-stage'];
  const allowedAgentTypes = a['allowed-agent-types'] ? String(a['allowed-agent-types']).split(',').map(s => s.trim()).filter(Boolean) : [];
  const targetScope = a['target-scope'];
  const targetDiffHash = a['target-diff-hash'];
  const expectedVerdictPath = a['expected-verdict-path'];
  const ttlMinutes = Number.isFinite(Number(a['ttl-minutes'])) ? Number(a['ttl-minutes']) : 60;

  if (!runId) { console.log(JSON.stringify({ ok: false, error: '--run-id required' })); process.exit(1); }
  if (!reviewStage) { console.log(JSON.stringify({ ok: false, error: '--review-stage required' })); process.exit(1); }
  if (allowedAgentTypes.length === 0) { console.log(JSON.stringify({ ok: false, error: '--allowed-agent-types required (comma-separated, non-empty)' })); process.exit(1); }
  if (!targetDiffHash) { console.log(JSON.stringify({ ok: false, error: '--target-diff-hash required' })); process.exit(1); }
  if (!expectedVerdictPath) { console.log(JSON.stringify({ ok: false, error: '--expected-verdict-path required' })); process.exit(1); }

  const root = harnessRoot();
  const rd = runDir(runId, root);
  const now = nowIso();
  const expiresAt = new Date(Date.parse(now) + ttlMinutes * 60000).toISOString();

  let createdRequest = null;
  try {
    withRunJsonLock(rd, (current) => {
      if (!current) throw new Error(`run.json not found for ${runId}`);
      const spec = {
        review_request_id: `rr-${crypto.randomUUID()}`,
        run_id: runId,
        execution_id: current.active_execution_id,
        review_stage: reviewStage,
        allowed_agent_types: allowedAgentTypes,
        target_scope: targetScope || null,
        target_diff_hash: targetDiffHash,
        expected_verdict_path: expectedVerdictPath,
        created_at: now,
        expires_at: expiresAt
      };
      const created = createReviewRequest(current.pending_review_requests || [], spec);
      if (!created.ok) { const e = new Error(created.reason); e.creationFailure = created; throw e; }
      createdRequest = created.request;
      return Object.assign({}, current, { pending_review_requests: [...(current.pending_review_requests || []), created.request] });
    });
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, review_request_id: createdRequest.review_request_id, expires_at: createdRequest.expires_at }, null, 2));
  process.exit(0);
}

if (require.main === module) main();
