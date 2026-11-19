#!/usr/bin/env node
// update-run-ledger.js — append a structured entry to decision-log.ndjson or tool-log.ndjson,
// applying redaction. Used by hooks AND by router/workflow scripts that record decisions.
//
// CLI usage (all named flags):
//   node update-run-ledger.js --run-id <id> --log decision --entry '{"from":"X","to":"Y","reason":"..."}'
//   node update-run-ledger.js --run-id <id> --log tool     --entry '{"tool":"Bash","input":{...}}'
//
// stdin alt: pipe JSON to stdin and pass --stdin
//
// Library:
//   const { append } = require('./update-run-ledger.js');
//   append(runId, 'decision', { from: 'X', to: 'Y', reason: '...' });
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const {
  parseArgs, nowIso, runDir, appendNdjson, readJson, writeJson,
  runLifecyclePolicy, clearCurrentRunPointer
} = require('./_lib.js');
const { redactToolEvent, redactString } = require('./redact.js');

function append(runId, kind, entry, opts) {
  const root = opts && opts.root ? opts.root : undefined;
  const rd = runDir(runId, root);
  if (!fs.existsSync(rd)) throw new Error(`run not found: ${runId}`);
  const fileName = kind === 'tool' ? 'tool-log.ndjson' : 'decision-log.ndjson';
  const file = path.join(rd, fileName);

  let payload = { ts: nowIso(), run_id: runId, ...entry };

  if (kind === 'tool') {
    payload = redactToolEvent(payload);
  } else {
    if (typeof payload.reason === 'string') payload.reason = redactString(payload.reason);
    if (payload.artifact && typeof payload.artifact === 'string') payload.artifact = redactString(payload.artifact);
  }

  appendNdjson(file, payload);

  // For decision entries that include a state transition, also bump run.json + index
  if (kind === 'decision' && entry.to) {
    try {
      const rj = readJson(path.join(rd, 'run.json'), null);
      if (rj && entry.to !== rj.state) {
        rj.state = entry.to;
        rj.last_state_change = payload.ts;
        writeJson(path.join(rd, 'run.json'), rj);
        const { indexRun } = require('./_lib.js');
        indexRun(runId, entry.to, rj.task_type || null, rj.confidence == null ? null : rj.confidence, root);
      }
      // E2: terminal transition clears the .current-run pointer (only if it
      // references this run) so a closed run can never stay "current".
      if (runLifecyclePolicy(root).inactive_states.includes(entry.to)) {
        clearCurrentRunPointer(runId, root);
      }
    } catch { /* swallow — ledger append succeeded */ }
  }
  return payload;
}

module.exports = { append };

if (require.main === module) {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok:false, disabled:true, reason:dis.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args['run-id']) { console.error('update-run-ledger.js: --run-id required'); process.exit(1); }
  const kind = args.log === 'tool' ? 'tool' : 'decision';
  let entry = null;
  if (args.entry) {
    try { entry = JSON.parse(args.entry); }
    catch { console.error('update-run-ledger.js: --entry is not valid JSON'); process.exit(1); }
  } else if (args.stdin || !process.stdin.isTTY) {
    try { entry = JSON.parse(fs.readFileSync(0, 'utf8')); }
    catch { console.error('update-run-ledger.js: stdin is not valid JSON'); process.exit(1); }
  } else {
    console.error('update-run-ledger.js: --entry JSON or --stdin required'); process.exit(1);
  }
  const out = append(args['run-id'], kind, entry);
  console.log(JSON.stringify({ ok: true, written: out }, null, 2));
}
