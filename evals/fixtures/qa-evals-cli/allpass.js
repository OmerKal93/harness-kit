#!/usr/bin/env node
// Fixture for runQaEvals hermetic tests (W11): mimics scripts/run-evals.js's summary JSON shape,
// all categories passing. No fs/network access — pure stdout print.
'use strict';
console.log(JSON.stringify({ ok: true, run_id: 'fixture-allpass', categories: { demo: { skipped: false, pass: true } } }));
process.exit(0);
