#!/usr/bin/env node
// actor-identity.js — REVIEW-INDEPENDENCE-1 core: normalized producer/reviewer stamp contract.
//
// PORTABILITY BOUNDARY: this file must never reference Claude Code hook payload field names,
// the owner, a downstream project, any private repository name, machine-specific paths, or user-global
// configuration. It knows only the generic concept "a dispatch identity, an execution identity,
// and who claims to be reviewing" -- where that identity comes from (a Claude Code SubagentStart
// hook, a future Codex hook, a CLI flag for a human) is an ADAPTER's job
// (scripts/review-independence/adapters/*), never this file's.
//
// Anti-spoofing pattern, mirrors scripts/workflow-state.js#stampProvenance (this repo's existing,
// working fix for the analogous verdict-provenance-spoofing problem): every identity field is
// either supplied by TRUSTED code at the call site (never read from a model-writable argument) or
// explicitly marked best-effort/unverified. stampProducer/stampReviewer are pure copy-and-overwrite
// -- the caller's own claimed values for trust-sensitive fields are always replaced, never trusted.
'use strict';

const ADAPTER_ID_ALLOW = Object.freeze(['claude-code', 'codex-cli', 'human', 'ci-worker', 'unknown']);
const PROVIDER_ID_ALLOW = Object.freeze(['anthropic', 'openai', 'human', 'ci', 'unknown']);
const ROLE_ALLOW = Object.freeze(['producer', 'reviewer']);
const REVIEWER_KIND_ALLOW = Object.freeze([
  'ce_code_review_subagent', 'native_code_review', 'security_review', 'ponytail_review', 'codex_cli', 'human'
]);
const MODEL_OBSERVATION_STATUS_ALLOW = Object.freeze(['unavailable', 'observed_trusted', 'observed_unverified']);
const CONTEXT_MODE_ALLOW = Object.freeze(['isolated_subagent', 'unknown']);

const REQUIRED_FIELDS = Object.freeze([
  'dispatch_id', 'execution_id', 'parent_run_id', 'role', 'adapter_id', 'provider_id',
  'model_id', 'model_observation_status', 'session_id', 'context_mode', 'stamp_id', 'stamped_at'
]);

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

// Pure validation -- does not stamp, only checks a fully-formed candidate stamp is well-shaped.
// Returns {ok:true} or {ok:false, reason}. Used as the write-time allowlist gate: a stamp failing
// this is never persisted, zero writes on rejection (mirrors appendVerdict's contract).
function validateStamp(stamp) {
  if (!stamp || typeof stamp !== 'object') return { ok: false, reason: 'stamp must be an object' };
  for (const f of REQUIRED_FIELDS) {
    if (!(f in stamp)) return { ok: false, reason: `missing required field: ${f}` };
  }
  if (!isNonEmptyString(stamp.dispatch_id)) return { ok: false, reason: 'dispatch_id must be a non-empty string' };
  if (!isNonEmptyString(stamp.execution_id)) return { ok: false, reason: 'execution_id must be a non-empty string' };
  if (!isNonEmptyString(stamp.parent_run_id)) return { ok: false, reason: 'parent_run_id must be a non-empty string' };
  if (!ROLE_ALLOW.includes(stamp.role)) return { ok: false, reason: `role must be one of ${ROLE_ALLOW.join('|')}` };
  if (!ADAPTER_ID_ALLOW.includes(stamp.adapter_id)) return { ok: false, reason: `adapter_id must be one of ${ADAPTER_ID_ALLOW.join('|')}` };
  if (!PROVIDER_ID_ALLOW.includes(stamp.provider_id)) return { ok: false, reason: `provider_id must be one of ${PROVIDER_ID_ALLOW.join('|')}` };
  if (stamp.model_id !== null && !isNonEmptyString(stamp.model_id)) return { ok: false, reason: 'model_id must be null or a non-empty string' };
  if (!MODEL_OBSERVATION_STATUS_ALLOW.includes(stamp.model_observation_status)) return { ok: false, reason: `model_observation_status must be one of ${MODEL_OBSERVATION_STATUS_ALLOW.join('|')}` };
  if (!isNonEmptyString(stamp.session_id)) return { ok: false, reason: 'session_id must be a non-empty string' };
  if (!CONTEXT_MODE_ALLOW.includes(stamp.context_mode)) return { ok: false, reason: `context_mode must be one of ${CONTEXT_MODE_ALLOW.join('|')}` };
  if (stamp.role === 'reviewer' && !REVIEWER_KIND_ALLOW.includes(stamp.reviewer_kind)) {
    return { ok: false, reason: `reviewer_kind must be one of ${REVIEWER_KIND_ALLOW.join('|')} for role:reviewer` };
  }
  return { ok: true };
}

// stampProducer/stampReviewer: pure copy-and-overwrite, same shape as stampProvenance. `trusted`
// carries every field this function will itself decide (adapter_id, provider_id, dispatch_id,
// execution_id, session_id, context_mode, stamp_id, stamped_at) -- values that MUST come from the
// call site's own trusted knowledge or from run-json state, never from `claimed`. `claimed` (if
// present at all) represents whatever a less-trusted input might assert (e.g. a model-influenced
// text field); every field this function controls is unconditionally overwritten on top of it, so
// nothing in `claimed` can ever survive into the returned stamp for a trust-sensitive field.
function buildStamp(role, trusted, claimed) {
  const base = Object.assign({}, claimed || {});
  return Object.assign(base, {
    role,
    dispatch_id: trusted.dispatch_id,
    execution_id: trusted.execution_id,
    parent_run_id: trusted.parent_run_id,
    adapter_id: trusted.adapter_id,
    provider_id: trusted.provider_id,
    model_id: trusted.model_id != null ? trusted.model_id : null,
    model_observation_status: trusted.model_observation_status || 'unavailable',
    session_id: trusted.session_id,
    context_mode: trusted.context_mode || 'unknown',
    stamp_id: trusted.stamp_id,
    stamped_at: trusted.stamped_at
  });
}

function stampProducer(trusted, claimed) {
  return buildStamp('producer', trusted, claimed);
}

function stampReviewer(trusted, claimed) {
  const stamp = buildStamp('reviewer', trusted, claimed);
  stamp.reviewer_kind = trusted.reviewer_kind;
  if (trusted.review_evidence !== undefined) stamp.review_evidence = trusted.review_evidence;
  if (trusted.agent_transcript_path !== undefined) stamp.agent_transcript_path = trusted.agent_transcript_path;
  return stamp;
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  const trustedProducer = {
    dispatch_id: 'main:sess-1:exec-1', execution_id: 'exec-1', parent_run_id: 'run-1',
    adapter_id: 'claude-code', provider_id: 'anthropic', model_id: null,
    model_observation_status: 'unavailable', session_id: 'sess-1', context_mode: 'unknown',
    stamp_id: 'stamp-1', stamped_at: '2026-01-01T00:00:00.000Z'
  };

  // 1. Basic stamp shape is valid.
  {
    const s = stampProducer(trustedProducer, {});
    push('producer_stamp_validates', validateStamp(s).ok === true, JSON.stringify(validateStamp(s)));
  }
  // 2. Model output cannot spoof any trusted field -- claimed values are overwritten, not merged in
  //    for the fields this function controls.
  {
    const spoofed = {
      dispatch_id: 'FAKE-INJECTED', execution_id: 'FAKE', parent_run_id: 'FAKE',
      adapter_id: 'codex-cli', provider_id: 'openai', session_id: 'FAKE', context_mode: 'isolated_subagent'
    };
    const s = stampProducer(trustedProducer, spoofed);
    push('claimed_values_cannot_override_trusted_fields',
      s.dispatch_id === 'main:sess-1:exec-1' && s.adapter_id === 'claude-code' && s.context_mode === 'unknown',
      JSON.stringify(s));
  }
  // 3. Reviewer stamp requires a legal reviewer_kind.
  {
    const bad = stampReviewer(Object.assign({}, trustedProducer, { reviewer_kind: 'not-a-real-kind' }), {});
    push('reviewer_stamp_rejects_unknown_reviewer_kind', validateStamp(bad).ok === false, JSON.stringify(validateStamp(bad)));
    const good = stampReviewer(Object.assign({}, trustedProducer, { reviewer_kind: 'security_review' }), {});
    push('reviewer_stamp_accepts_known_reviewer_kind', validateStamp(good).ok === true, JSON.stringify(validateStamp(good)));
  }
  // 4. Missing model identity never invalidates an otherwise-valid stamp.
  {
    const s = stampProducer(trustedProducer, {});
    push('missing_model_identity_does_not_invalidate_stamp',
      s.model_id === null && s.model_observation_status === 'unavailable' && validateStamp(s).ok === true,
      JSON.stringify(s));
  }
  // 5. validateStamp fails closed on a missing required field.
  {
    const incomplete = Object.assign({}, stampProducer(trustedProducer, {}));
    delete incomplete.execution_id;
    push('missing_required_field_fails_closed', validateStamp(incomplete).ok === false, JSON.stringify(validateStamp(incomplete)));
  }
  // 6. Unknown adapter_id/provider_id rejected (allowlist, not free text).
  {
    const bad = Object.assign({}, stampProducer(trustedProducer, {}), { adapter_id: 'totally-made-up' });
    push('unknown_adapter_id_rejected', validateStamp(bad).ok === false, JSON.stringify(validateStamp(bad)));
  }
  // 7. Two stamps from the same trusted context (same dispatch_id) are recognizable as the same actor.
  {
    const s1 = stampProducer(trustedProducer, {});
    const s2 = stampProducer(trustedProducer, {});
    push('same_trusted_context_yields_same_dispatch_id', s1.dispatch_id === s2.dispatch_id, JSON.stringify({ s1: s1.dispatch_id, s2: s2.dispatch_id }));
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = {
  ADAPTER_ID_ALLOW, PROVIDER_ID_ALLOW, ROLE_ALLOW, REVIEWER_KIND_ALLOW,
  MODEL_OBSERVATION_STATUS_ALLOW, CONTEXT_MODE_ALLOW, REQUIRED_FIELDS,
  validateStamp, stampProducer, stampReviewer
};

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('actor-identity.js — library. node scripts/review-independence/core/actor-identity.js --self-test');
  process.exit(0);
}
