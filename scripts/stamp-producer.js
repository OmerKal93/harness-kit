#!/usr/bin/env node
// stamp-producer.js — REVIEW-INDEPENDENCE-1: records a main-thread (non-subagent) producer stamp.
// The only trusted call site for adapter_id:'claude-code' main-thread producer stamps -- no CLI
// flag accepts a caller-supplied dispatch_id/adapter_id/provider_id/execution_id. session_id comes
// from HARNESSKIT_SESSION_ID (the environment, not an argument); model_id is never trusted from the
// environment either (best-effort only, defaults null/unavailable per the anti-spoofing design).
//
//   node scripts/stamp-producer.js --run-id <id>
'use strict';
const crypto = require('crypto');
const { parseArgs, harnessRoot, runDir, nowIso } = require('./_lib.js');
const { isDisabled } = require('./is-disabled.js');
const { recordMainThreadProducer } = require('./review-independence/adapters/cli-stamp.js');

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok: false, disabled: true, reason: dis.reason })); process.exit(0); }
  const a = parseArgs(process.argv.slice(2));
  const runId = a['run-id'];
  if (!runId) { console.log(JSON.stringify({ ok: false, error: '--run-id required' })); process.exit(1); }
  const sessionId = process.env.HARNESSKIT_SESSION_ID;
  if (!sessionId) { console.log(JSON.stringify({ ok: false, error: 'HARNESSKIT_SESSION_ID not set -- session_id is required and is never accepted as a CLI flag' })); process.exit(1); }

  const root = harnessRoot();
  const rd = runDir(runId, root);
  let result;
  try {
    result = recordMainThreadProducer(rd, {
      runId, sessionId,
      adapterId: 'claude-code', providerId: 'anthropic',
      modelId: null, modelObservationStatus: 'unavailable',
      stampId: `stamp-${crypto.randomUUID()}`,
      now: nowIso()
    });
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, run_id: runId, producers_count: (result.producers || []).length }, null, 2));
  process.exit(0);
}

if (require.main === module) main();
