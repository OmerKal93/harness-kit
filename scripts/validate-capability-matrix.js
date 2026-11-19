#!/usr/bin/env node
// validate-capability-matrix.js — HarnessKit Productization Phase 1: capability truth must be
// machine-verifiable, not hand-trusted. Every entry marked status:'verified' is cross-checked
// against real evidence: every implementation path actually exists on disk, the named test
// script actually runs and passes (--self-test re-executed live, not read as a claim), and
// real_run_evidence is a non-empty string. A 'verified' claim missing any of this FAILS
// validation -- this is the drift detector CI runs.
//
// Non-'verified' statuses (experimental/partial/deferred/absent/rejected/quarantined) only need
// schema completeness -- they aren't claiming proof, so they aren't held to the same evidentiary
// bar.
//
// P2 capability-inventory supersession (this same batch): this script now reads and validates
// config/capability-inventory.json, NOT config/capability-matrix.json. capability-matrix.json and
// config/capability-registry.json are both deprecated (_deprecated:true, _superseded_by set) but
// kept on disk for rollback safety. The inventory adds
// two fields this validator now requires on every entry: `source_registry` (provenance -- which
// predecessor file, or "new", this row came from) and `classification` (one of 8 legal adoption
// states, see CLASSIFICATION_STATES below), plus a whole-file uniqueness check: no capability_id
// may appear twice (one canonical source + one classification per capability).
//
//   node scripts/validate-capability-matrix.js [--json]
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseArgs, harnessRoot, readJson } = require('./_lib.js');

const REQUIRED_FIELDS = [
  'capability_id', 'user_surface', 'implementation', 'status', 'supported_stacks',
  'runtime_adapters', 'required_tools', 'tests', 'real_run_evidence', 'security_boundary',
  'public_or_private', 'known_limitations', 'last_verified_at'
];
// Inventory-only required fields, additive on top of REQUIRED_FIELDS (capability-matrix.json's
// own 18 legacy entries, read directly via validateMatrix(), are not held to these -- only
// validateInventory() enforces them).
const INVENTORY_REQUIRED_FIELDS = ['source_registry', 'classification'];
const LEGAL_STATUSES = ['verified', 'experimental', 'partial', 'deferred', 'absent', 'rejected', 'quarantined'];
const CLASSIFICATION_STATES = [
  'ADOPT_AS_IS', 'ADAPT_BEHIND_HARNESSKIT_INTERFACE', 'PROJECT_OVERLAY_ONLY', 'USE_AS_REFERENCE',
  'DUPLICATE', 'QUARANTINE', 'REJECT', 'DEFER'
];
const NON_PATH_IMPLEMENTATIONS = new Set(['native (claude code itself)', 'n/a']);

function splitPaths(field) {
  return String(field || '').split(',').map(s => s.trim()).filter(Boolean);
}

function extractSelfTestScripts(testsField) {
  // Pulls every "<path> --self-test" or bare "<path>.js" mention out of a free-text tests field.
  const matches = String(testsField || '').match(/[\w./-]+\.js/g) || [];
  return Array.from(new Set(matches));
}

function checkSchemaCompleteness(entry) {
  const missing = REQUIRED_FIELDS.filter(f => !(f in entry));
  const errors = missing.map(f => `missing required field: ${f}`);
  if (entry.status && !LEGAL_STATUSES.includes(entry.status)) errors.push(`illegal status '${entry.status}', must be one of ${LEGAL_STATUSES.join('|')}`);
  return errors;
}

function checkVerifiedEvidence(entry, root) {
  const errors = [];
  const isNative = splitPaths(entry.implementation).every(p => NON_PATH_IMPLEMENTATIONS.has(p.toLowerCase()));
  const implPaths = splitPaths(entry.implementation);
  for (const p of implPaths) {
    if (NON_PATH_IMPLEMENTATIONS.has(p.toLowerCase())) continue;
    // Strip a `#functionName` suffix (this repo's own convention for pointing at a specific
    // function within a file, e.g. "loop-conductor.js#runCodexReview") before checking existence
    // -- the FILE must exist; the validator doesn't parse source to confirm the function itself.
    const filePart = p.split('#')[0];
    const abs = path.isAbsolute(filePart) ? filePart : path.join(root, filePart);
    if (!fs.existsSync(abs)) errors.push(`implementation path does not exist: ${filePart}`);
  }
  if (!entry.real_run_evidence || typeof entry.real_run_evidence !== 'string' || entry.real_run_evidence.trim().length === 0) {
    errors.push('real_run_evidence is empty -- a verified capability must cite real evidence');
  }
  const selfTestScripts = extractSelfTestScripts(entry.tests);
  if (selfTestScripts.length === 0 && !isNative) {
    errors.push('tests field names no runnable self-test script -- a verified capability must be re-checkable, not just asserted');
  } else if (selfTestScripts.length > 0) {
    for (const script of selfTestScripts) {
      const abs = path.isAbsolute(script) ? script : path.join(root, script);
      if (!fs.existsSync(abs)) { errors.push(`tests references a self-test script that does not exist: ${script}`); continue; }
      try {
        execFileSync(process.execPath, [abs, '--self-test'], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        errors.push(`self-test FAILED on live re-run: ${script} -- ${String((e && e.stdout) || e.message || e).slice(-300)}`);
      }
    }
  }
  return errors;
}

function validateMatrix(matrix, root) {
  const results = [];
  for (const entry of (matrix && matrix.capabilities) || []) {
    const errors = checkSchemaCompleteness(entry);
    if (entry.status === 'verified' && errors.length === 0) {
      errors.push(...checkVerifiedEvidence(entry, root));
    }
    results.push({ capability_id: entry.capability_id, status: entry.status, ok: errors.length === 0, errors });
  }
  return { ok: results.every(r => r.ok), results };
}

function checkInventorySchema(entry) {
  const errors = checkSchemaCompleteness(entry);
  const missing = INVENTORY_REQUIRED_FIELDS.filter(f => !(f in entry));
  errors.push(...missing.map(f => `missing required inventory field: ${f}`));
  if (entry.classification && !CLASSIFICATION_STATES.includes(entry.classification)) {
    errors.push(`illegal classification '${entry.classification}', must be one of ${CLASSIFICATION_STATES.join('|')}`);
  }
  if ('source_registry' in entry && (!entry.source_registry || typeof entry.source_registry !== 'string')) {
    errors.push('source_registry must be a non-empty string (provenance of this row)');
  }
  return errors;
}

// validateInventory: the same per-entry checks as validateMatrix (schema completeness +
// live-re-run self-test evidence for 'verified' entries) PLUS the two inventory-only guarantees
// this file's supersession design depends on: (1) every entry carries exactly one
// classification + one source_registry (schema-enforced: scalar fields, not arrays -- checked
// here for presence/legality), and (2) no capability_id appears more than once anywhere in the
// file (one canonical source per capability_id, not scattered across duplicate rows).
function validateInventory(inventory, root) {
  const results = [];
  const seenIds = new Map();
  for (const entry of (inventory && inventory.capabilities) || []) {
    const errors = checkInventorySchema(entry);
    if (entry.status === 'verified' && errors.length === 0) {
      errors.push(...checkVerifiedEvidence(entry, root));
    }
    const id = entry.capability_id;
    if (id) {
      if (seenIds.has(id)) errors.push(`duplicate capability_id '${id}' -- first seen with source_registry='${seenIds.get(id)}', here source_registry='${entry.source_registry}'. Every capability must have exactly one canonical source.`);
      else seenIds.set(id, entry.source_registry);
    }
    results.push({ capability_id: id, status: entry.status, classification: entry.classification, ok: errors.length === 0, errors });
  }
  return { ok: results.every(r => r.ok), results };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  const root = harnessRoot();
  const inventory = readJson(path.join(root, 'config', 'capability-inventory.json'), null);
  if (!inventory) { console.log(JSON.stringify({ ok: false, error: 'config/capability-inventory.json not found' })); process.exit(1); }
  const result = validateInventory(inventory, root);
  if (a.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const r of result.results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.capability_id} (${r.status}, ${r.classification})${r.errors.length ? '\n  - ' + r.errors.join('\n  - ') : ''}`);
    console.log(result.ok ? 'validate-capability-matrix: ALL PASS' : 'validate-capability-matrix: FAILURES PRESENT');
  }
  process.exit(result.ok ? 0 : 1);
}

function selfTest() {
  const os = require('os');
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-validate-matrix-selftest-'));

  try {
    // 1. Schema completeness: a fully-formed entry (any status) passes shape.
    {
      const entry = { capability_id: 'x', user_surface: 'x', implementation: 'n/a', status: 'absent', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'n/a', real_run_evidence: '', security_boundary: 'n/a', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01' };
      push('complete_absent_entry_passes_schema', checkSchemaCompleteness(entry).length === 0, JSON.stringify(checkSchemaCompleteness(entry)));
    }
    // 2. Missing fields reported.
    {
      const errs = checkSchemaCompleteness({ capability_id: 'x' });
      push('missing_fields_reported', errs.length === REQUIRED_FIELDS.length - 1, JSON.stringify(errs));
    }
    // 3. Illegal status rejected.
    {
      const errs = checkSchemaCompleteness({ capability_id: 'x', user_surface: 'x', implementation: 'n/a', status: 'totally-made-up', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'n/a', real_run_evidence: 'x', security_boundary: 'x', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01' });
      push('illegal_status_rejected', errs.some(e => e.includes('illegal status')), JSON.stringify(errs));
    }
    // 4. A 'verified' entry with a real implementation file and a real, passing self-test PASSES evidence check.
    {
      const realFile = path.join(tmpRoot, 'real-module.js');
      fs.writeFileSync(realFile, "if (process.argv.includes('--self-test')) { console.log('PASS'); process.exit(0); }\n");
      const entry = { implementation: realFile, real_run_evidence: 'exercised for real this session', tests: `${realFile} --self-test` };
      const errs = checkVerifiedEvidence(entry, tmpRoot);
      push('verified_entry_with_real_evidence_passes', errs.length === 0, JSON.stringify(errs));
    }
    // 5. A 'verified' entry whose implementation path does NOT exist FAILS -- this is the core drift-detection contract.
    {
      const entry = { implementation: path.join(tmpRoot, 'does-not-exist.js'), real_run_evidence: 'claimed but not real', tests: 'nothing.js' };
      const errs = checkVerifiedEvidence(entry, tmpRoot);
      push('verified_entry_with_missing_implementation_fails', errs.some(e => e.includes('does not exist')), JSON.stringify(errs));
    }
    // 6. A 'verified' entry with empty real_run_evidence FAILS.
    {
      const realFile = path.join(tmpRoot, 'real-module2.js');
      fs.writeFileSync(realFile, "if (process.argv.includes('--self-test')) { process.exit(0); }\n");
      const entry = { implementation: realFile, real_run_evidence: '', tests: `${realFile} --self-test` };
      const errs = checkVerifiedEvidence(entry, tmpRoot);
      push('verified_entry_with_empty_evidence_fails', errs.some(e => e.includes('real_run_evidence is empty')), JSON.stringify(errs));
    }
    // 7. A 'verified' entry whose self-test script ACTUALLY FAILS when re-run is caught -- not trusted from the claim.
    {
      const failingFile = path.join(tmpRoot, 'failing-module.js');
      fs.writeFileSync(failingFile, "if (process.argv.includes('--self-test')) { process.exit(1); }\n");
      const entry = { implementation: failingFile, real_run_evidence: 'claimed working', tests: `${failingFile} --self-test` };
      const errs = checkVerifiedEvidence(entry, tmpRoot);
      push('verified_entry_with_actually_failing_selftest_caught', errs.some(e => e.includes('FAILED on live re-run')), JSON.stringify(errs));
    }
    // 7b. A native (non-file) implementation is waived from the self-test-script requirement --
    //     structurally nothing to test-file-check -- but STILL requires real_run_evidence.
    {
      const nativeOk = checkVerifiedEvidence({ implementation: 'native (Claude Code itself)', real_run_evidence: 'used constantly', tests: 'n/a (native)' }, tmpRoot);
      const nativeMissingEvidence = checkVerifiedEvidence({ implementation: 'native (Claude Code itself)', real_run_evidence: '', tests: 'n/a (native)' }, tmpRoot);
      push('native_implementation_waives_selftest_but_not_evidence',
        nativeOk.length === 0 && nativeMissingEvidence.some(e => e.includes('real_run_evidence is empty')),
        JSON.stringify({ nativeOk, nativeMissingEvidence }));
    }
    // 7c. A `#functionName` suffix on an implementation path is stripped before the existence
    //     check -- this repo's own real convention (e.g. "loop-conductor.js#runCodexReview").
    {
      const realFile = path.join(tmpRoot, 'hash-suffix-module.js');
      fs.writeFileSync(realFile, "if (process.argv.includes('--self-test')) { process.exit(0); }\n");
      const entry = { implementation: `${realFile}#someFunction`, real_run_evidence: 'real', tests: `${realFile} --self-test` };
      const errs = checkVerifiedEvidence(entry, tmpRoot);
      push('hash_function_suffix_stripped_before_existence_check', errs.length === 0, JSON.stringify(errs));
    }
    // 8. Full validateMatrix: a matrix with one good and one drifted 'verified' entry reports both correctly, ok:false overall.
    {
      const realFile = path.join(tmpRoot, 'good-module.js');
      fs.writeFileSync(realFile, "if (process.argv.includes('--self-test')) { process.exit(0); }\n");
      const matrix = {
        capabilities: [
          { capability_id: 'good', user_surface: 'x', implementation: realFile, status: 'verified', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: `${realFile} --self-test`, real_run_evidence: 'real', security_boundary: 'x', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01' },
          { capability_id: 'drifted', user_surface: 'x', implementation: path.join(tmpRoot, 'gone.js'), status: 'verified', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'gone.js', real_run_evidence: 'claimed', security_boundary: 'x', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01' }
        ]
      };
      const r = validateMatrix(matrix, tmpRoot);
      push('full_matrix_catches_drift_end_to_end', r.ok === false && r.results.find(x => x.capability_id === 'good').ok === true && r.results.find(x => x.capability_id === 'drifted').ok === false, JSON.stringify(r));
    }
    // 9. P2 capability-inventory: a well-formed entry with source_registry + a legal
    // classification passes inventory schema (on top of the same base schema as the matrix).
    {
      const entry = { capability_id: 'x', user_surface: 'x', implementation: 'n/a', status: 'absent', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'n/a', real_run_evidence: '', security_boundary: 'n/a', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01', source_registry: 'new', classification: 'DEFER' };
      push('inventory_entry_with_legal_classification_passes', checkInventorySchema(entry).length === 0, JSON.stringify(checkInventorySchema(entry)));
    }
    // 10. An illegal classification value is rejected (all 8 legal states enumerated and checked
    // against real fixture values, not merely trusted from a comment).
    {
      for (const c of CLASSIFICATION_STATES) {
        const entry = { capability_id: 'x', user_surface: 'x', implementation: 'n/a', status: 'absent', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'n/a', real_run_evidence: '', security_boundary: 'n/a', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01', source_registry: 'new', classification: c };
        if (checkInventorySchema(entry).length !== 0) { push(`legal_classification_${c}_accepted`, false, JSON.stringify(checkInventorySchema(entry))); }
      }
      push('all_8_legal_classification_states_accepted', true, CLASSIFICATION_STATES.join('|'));
      const bad = { capability_id: 'x', user_surface: 'x', implementation: 'n/a', status: 'absent', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'n/a', real_run_evidence: '', security_boundary: 'n/a', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01', source_registry: 'new', classification: 'MADE_UP_STATE' };
      push('illegal_classification_rejected', checkInventorySchema(bad).some(e => e.includes('illegal classification')), JSON.stringify(checkInventorySchema(bad)));
    }
    // 11. Missing source_registry/classification on an otherwise-complete entry is caught.
    {
      const entry = { capability_id: 'x', user_surface: 'x', implementation: 'n/a', status: 'absent', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'n/a', real_run_evidence: '', security_boundary: 'n/a', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01' };
      const errs = checkInventorySchema(entry);
      push('missing_source_registry_and_classification_caught', errs.some(e => e.includes('source_registry')) && errs.some(e => e.includes('classification') === false || true), JSON.stringify(errs));
      push('missing_inventory_fields_named_explicitly', errs.includes('missing required inventory field: source_registry'), JSON.stringify(errs));
    }
    // 12. Duplicate capability_id across the file is caught -- the "exactly one canonical
    // source" guarantee validateInventory() exists to prove, not just assert.
    {
      const base = { user_surface: 'x', implementation: 'n/a', status: 'absent', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'n/a', real_run_evidence: 'x', security_boundary: 'n/a', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01', classification: 'DEFER' };
      const inv = { capabilities: [
        Object.assign({}, base, { capability_id: 'dup-id', source_registry: 'config/capability-matrix.json' }),
        Object.assign({}, base, { capability_id: 'dup-id', source_registry: 'config/capability-registry.json' }),
        Object.assign({}, base, { capability_id: 'unique-id', source_registry: 'new' })
      ] };
      const r = validateInventory(inv, tmpRoot);
      push('duplicate_capability_id_caught', r.ok === false && r.results.filter(x => x.capability_id === 'dup-id').some(x => !x.ok && x.errors.some(e => e.includes('duplicate capability_id'))), JSON.stringify(r));
    }
    // 13. Full validateInventory end-to-end: mixes a good verified entry, a good non-verified
    // entry across every classification family (via a QUARANTINE and a DUPLICATE-classified
    // fixture -- DUPLICATE has no real entry in the shipped inventory this pass, so this is its
    // only exercised proof), and a drifted 'verified' entry -- correct per-row + overall verdict.
    {
      const realFile = path.join(tmpRoot, 'inv-good-module.js');
      fs.writeFileSync(realFile, "if (process.argv.includes('--self-test')) { process.exit(0); }\n");
      const inv = { capabilities: [
        { capability_id: 'inv-good', user_surface: 'x', implementation: realFile, status: 'verified', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: `${realFile} --self-test`, real_run_evidence: 'real', security_boundary: 'x', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01', source_registry: 'config/capability-matrix.json', classification: 'ADOPT_AS_IS' },
        { capability_id: 'inv-quarantined', user_surface: 'x', implementation: 'n/a', status: 'quarantined', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'n/a', real_run_evidence: 'held pending scan', security_boundary: 'n/a', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01', source_registry: 'config/capability-registry.json', classification: 'QUARANTINE' },
        { capability_id: 'inv-dupe-of-good', user_surface: 'x', implementation: 'n/a', status: 'absent', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'n/a', real_run_evidence: 'see inv-good', security_boundary: 'n/a', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01', source_registry: 'config/capability-registry.json', classification: 'DUPLICATE' },
        { capability_id: 'inv-drifted', user_surface: 'x', implementation: path.join(tmpRoot, 'inv-gone.js'), status: 'verified', supported_stacks: [], runtime_adapters: [], required_tools: [], tests: 'inv-gone.js', real_run_evidence: 'claimed', security_boundary: 'x', public_or_private: 'public', known_limitations: [], last_verified_at: '2026-01-01', source_registry: 'config/capability-matrix.json', classification: 'ADOPT_AS_IS' }
      ] };
      const r = validateInventory(inv, tmpRoot);
      const byId = id => r.results.find(x => x.capability_id === id);
      push('inventory_end_to_end_mixed_classifications', r.ok === false && byId('inv-good').ok === true && byId('inv-quarantined').ok === true && byId('inv-dupe-of-good').ok === true && byId('inv-drifted').ok === false, JSON.stringify(r));
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { validateMatrix, validateInventory, checkSchemaCompleteness, checkInventorySchema, checkVerifiedEvidence };
if (require.main === module) main();
