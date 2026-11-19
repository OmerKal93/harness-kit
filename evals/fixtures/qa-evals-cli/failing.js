#!/usr/bin/env node
// Fixture for runQaEvals hermetic tests (W11): mimics scripts/run-evals.js's summary JSON shape,
// one category failing. No fs/network access — pure stdout print.
'use strict';
console.log(JSON.stringify({ ok: false, run_id: 'fixture-failing', categories: { demo: { skipped: false, pass: false }, other: { skipped: false, pass: true } } }));
process.exit(1);
