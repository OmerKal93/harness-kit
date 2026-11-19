#!/usr/bin/env node
// validate-next-action.js — sanity check next-action.md before allowing DONE/BLOCKED/NEEDS_USER.
// Checks: file exists, non-empty, contains at minimum {what, why, who-or-when}.
//
// Usage: node validate-next-action.js --run-id <id>
// Exit:  0 ok, 2 missing/invalid
'use strict';
const fs = require('fs');
const path = require('path');
const { isDisabled } = require('./is-disabled.js');
const { parseArgs, runDir } = require('./_lib.js');

function main() {
  const dis = isDisabled();
  if (dis.disabled) { console.log(JSON.stringify({ ok:false, disabled:true, reason:dis.reason })); process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  if (!args['run-id']) { console.error('validate-next-action.js: --run-id required'); process.exit(1); }
  const file = path.join(runDir(args['run-id']), 'next-action.md');
  if (!fs.existsSync(file)) {
    console.log(JSON.stringify({ ok: false, reason: 'next-action.md missing' }));
    process.exit(2);
  }
  const txt = fs.readFileSync(file, 'utf8').trim();
  if (txt.length < 20) {
    console.log(JSON.stringify({ ok: false, reason: 'next-action.md too short (<20 chars)' }));
    process.exit(2);
  }
  const lower = txt.toLowerCase();
  const checks = {
    has_what:  /\bwhat\b|##\s*action|##\s*do\b/i.test(txt) || txt.split('\n').some(l => /^\s*[-*]\s+/.test(l)),
    has_why:   /\bwhy\b|\bbecause\b|\brationale\b/.test(lower) || /\bgoal\b/.test(lower),
    has_who_or_when: /\bowner\b|\bwho\b|\bby\b|\bwhen\b|\bnext\b|\bafter\b|\bbefore\b/.test(lower)
  };
  const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  const ok = missing.length === 0;
  console.log(JSON.stringify({ ok, missing, length: txt.length }));
  process.exit(ok ? 0 : 2);
}

main();
