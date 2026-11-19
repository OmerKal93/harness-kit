#!/usr/bin/env node
// stamp-reviewer.js — REVIEW-INDEPENDENCE-1: records a non-subagent reviewer stamp. Real subagent
// reviewers (dispatched via Claude Code's Task tool) are handled entirely by the SubagentStart/
// SubagentStop hooks (scripts/review-independence/adapters/claude-code-hooks.js) -- a subagent
// must never call this script on itself to claim its own independence.
//
// This script covers: explicit human confirmation (the 'human' tier's only legal write path,
// mirrors provenance:'cli_human''s hardcoded-literal pattern), and, honestly, a fallback for any
// future non-subagent reviewer action (e.g. a native review command run inline in the main
// thread). The fallback path is recorded for audit visibility but can never satisfy
// 'isolated_actor' -- inline main-thread review has no SubagentStart/Stop hook evidence, so
// context_mode stays 'unknown' by construction, same as any other main-thread action.
//
//   node scripts/stamp-reviewer.js --run-id <id> --kind human
//     [--verdict-path <p> --verdict-status <s> --target-diff-hash <h> --reviewed-scope <s>]
'use strict';
const crypto = require('crypto');
const { parseArgs, harnessRoot, runDir, nowIso } = require('./_lib.js');
const { isDisabled } = require('./is-disabled.js');
const { recordHumanReviewer } = require('./review-independence/adapters/cli-stamp.js');

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok: false, disabled: true, reason: dis.reason })); process.exit(0); }
  const a = parseArgs(process.argv.slice(2));
  const runId = a['run-id'];
  const kind = a.kind;
  if (!runId) { console.log(JSON.stringify({ ok: false, error: '--run-id required' })); process.exit(1); }
  if (kind !== 'human') { console.log(JSON.stringify({ ok: false, error: "only --kind human is supported by this CLI; subagent reviewers are recorded exclusively via the SubagentStart/SubagentStop hooks, never this script" })); process.exit(1); }
  const sessionId = process.env.HARNESSKIT_SESSION_ID;
  if (!sessionId) { console.log(JSON.stringify({ ok: false, error: 'HARNESSKIT_SESSION_ID not set' })); process.exit(1); }

  const reviewEvidence = (a['verdict-path'] && a['verdict-status'])
    ? { verdict_path: a['verdict-path'], verdict_status: a['verdict-status'], target_diff_hash: a['target-diff-hash'] || null, reviewed_scope: a['reviewed-scope'] || null, completed_at: nowIso() }
    : null;

  const root = harnessRoot();
  const rd = runDir(runId, root);
  let result;
  try {
    result = recordHumanReviewer(rd, { runId, sessionId, stampId: `stamp-${crypto.randomUUID()}`, now: nowIso(), reviewEvidence });
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, run_id: runId, reviewers_count: (result.reviewers || []).length }, null, 2));
  process.exit(0);
}

if (require.main === module) main();
