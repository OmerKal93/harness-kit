#!/usr/bin/env node
// validate-config.js -- HarnessKit install/config lane (Batch 1 Foundation, hk/p9b-install-config).
//
// Validates config/global-policy.json and every config/project-profiles/*.json against the two
// JSON Schema (draft-07 subset) files this same lane adds: config/global-policy.schema.json and
// config/project-profile.schema.json. Closes a real, known gap:
// "config_schema's doctor check only validates package.json's version field shape -- it does not
// validate against config/harnesskit-lock.schema.json or any other schema file." This script does
// not touch scripts/doctor.js; it is a new, additive, standalone tool.
//
// Deliberately resolves paths relative to THIS repo checkout (path.join(__dirname, '..')), not via
// HARNESS_ROOT -- its subject is this HarnessKit installation's own config files, not a target
// project's. See the design doc, "Two kinds of root" section.
//
//   node scripts/validate-config.js            -- validate this repo's config/ tree
//   node scripts/validate-config.js --self-test
'use strict';

const fs = require('fs');
const path = require('path');
const { readJson } = require('./_lib.js');

const REPO_ROOT = path.join(__dirname, '..');

// --- Minimal JSON Schema (draft-07 subset) interpreter --------------------------------------
// Supports exactly what config/global-policy.schema.json and config/project-profile.schema.json
// use: type (incl. "integer"), required, properties, additionalProperties (bool or schema),
// items, enum, const, minimum/exclusiveMinimum/maximum/exclusiveMaximum, minLength. No $ref,
// no allOf/anyOf/oneOf, no pattern. Zero new dependencies (matches this repo's existing
// hand-rolled-validator convention, e.g. scripts/validate-harnesskit-lock.js), and it is a real
// generic interpreter (not a hardcoded per-field checklist) -- it reads the schema file, it does
// not just mirror its shape by hand.
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
}

function matchesType(v, t) {
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  return typeOf(v) === t;
}

function validateAgainstSchema(data, schema, at) {
  at = at || '$';
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchesType(data, t))) {
      errors.push(`${at}: expected type ${types.join('|')}, got ${typeOf(data)}`);
      return errors; // further checks would be meaningless against the wrong shape
    }
  }

  if (schema.const !== undefined && JSON.stringify(data) !== JSON.stringify(schema.const)) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  }
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(data))) {
    errors.push(`${at}: value ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${at}: ${data} < minimum ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) errors.push(`${at}: ${data} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${at}: ${data} > maximum ${schema.maximum}`);
    if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) errors.push(`${at}: ${data} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
  }

  if (typeof data === 'string' && schema.minLength !== undefined && data.length < schema.minLength) {
    errors.push(`${at}: string shorter than minLength ${schema.minLength} ("${data}")`);
  }

  if (Array.isArray(data) && schema.items) {
    data.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, `${at}[${i}]`)));
  }

  if (data !== null && typeOf(data) === 'object') {
    for (const req of (schema.required || [])) {
      if (!(req in data)) errors.push(`${at}: missing required property "${req}"`);
    }
    const knownProps = schema.properties || {};
    for (const key of Object.keys(data)) {
      if (key in knownProps) {
        errors.push(...validateAgainstSchema(data[key], knownProps[key], `${at}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}.${key}: additional property not allowed by schema`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateAgainstSchema(data[key], schema.additionalProperties, `${at}.${key}`));
      }
      // additionalProperties === true or undefined -> no further check, key is allowed as-is
    }
  }

  return errors;
}

// --- Real repo-config validation runner ------------------------------------------------------

function validateGlobalPolicy(root) {
  root = root || REPO_ROOT;
  const schema = readJson(path.join(root, 'config', 'global-policy.schema.json'), null);
  const dataPath = path.join(root, 'config', 'global-policy.json');
  if (!fs.existsSync(dataPath)) return { file: 'config/global-policy.json', ok: true, status: 'NOT_APPLICABLE', errors: [], note: 'no global-policy.json in this tree -- nothing to validate' };
  if (!schema) return { file: 'config/global-policy.json', ok: false, status: 'BLOCKING', errors: ['config/global-policy.schema.json missing or unreadable'] };
  const data = readJson(dataPath, null);
  if (!data) return { file: 'config/global-policy.json', ok: false, status: 'BLOCKING', errors: ['file present but not valid JSON'] };
  const errors = validateAgainstSchema(data, schema);
  return { file: 'config/global-policy.json', ok: errors.length === 0, status: errors.length ? 'FAIL' : 'PASS', errors };
}

function validateProjectProfiles(root) {
  root = root || REPO_ROOT;
  const schema = readJson(path.join(root, 'config', 'project-profile.schema.json'), null);
  const dir = path.join(root, 'config', 'project-profiles');
  if (!fs.existsSync(dir)) return [];
  if (!schema) return [{ file: 'config/project-profiles/*', ok: false, status: 'BLOCKING', errors: ['config/project-profile.schema.json missing or unreadable'] }];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const data = readJson(path.join(dir, f), null);
    const rel = ['config', 'project-profiles', f].join('/');
    if (!data) return { file: rel, ok: false, status: 'FAIL', errors: ['file present but not valid JSON'] };
    const errors = validateAgainstSchema(data, schema);
    return { file: rel, ok: errors.length === 0, status: errors.length ? 'FAIL' : 'PASS', errors };
  });
}

function runAll(root) {
  const results = [validateGlobalPolicy(root), ...validateProjectProfiles(root)];
  const ok = results.every(r => r.ok);
  return { ok, results };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) { process.exit(selfTest() ? 0 : 1); return; }
  const rootFlagIdx = args.indexOf('--root');
  const root = rootFlagIdx !== -1 ? args[rootFlagIdx + 1] : REPO_ROOT;
  const report = runAll(root);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail: detail === undefined ? '' : JSON.stringify(detail) });

  // 1. Generic interpreter: a well-formed object against a simple schema validates clean.
  {
    const schema = { type: 'object', required: ['a'], properties: { a: { type: 'integer', minimum: 1 } }, additionalProperties: false };
    const errs = validateAgainstSchema({ a: 5 }, schema);
    push('well_formed_object_validates_clean', errs.length === 0, errs);
  }
  // 2. Missing required field is caught.
  {
    const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
    const errs = validateAgainstSchema({}, schema);
    push('missing_required_field_caught', errs.length === 1 && errs[0].includes('a'), errs);
  }
  // 3. Wrong type is caught (integer vs string).
  {
    const schema = { type: 'object', properties: { a: { type: 'integer' } } };
    const errs = validateAgainstSchema({ a: 'not-a-number' }, schema);
    push('wrong_type_caught', errs.length === 1, errs);
  }
  // 4. additionalProperties:false rejects an unknown key; true/undefined allows it.
  {
    const strict = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    const loose = { type: 'object', properties: { a: { type: 'string' } } };
    const errsStrict = validateAgainstSchema({ a: 'x', b: 1 }, strict);
    const errsLoose = validateAgainstSchema({ a: 'x', b: 1 }, loose);
    push('additionalProperties_false_rejects_unknown_key_true_allows_it', errsStrict.length === 1 && errsLoose.length === 0, { errsStrict, errsLoose });
  }
  // 5. additionalProperties as a schema validates every extra key's value against it (used by
  //    on_trigger / classifier_keyword_hints-shaped maps in global-policy.schema.json).
  {
    const schema = { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } };
    const good = validateAgainstSchema({ trigger_a: ['x', 'y'] }, schema);
    const bad = validateAgainstSchema({ trigger_a: ['x', 2] }, schema);
    push('additionalProperties_schema_validates_extra_keys', good.length === 0 && bad.length === 1, { good, bad });
  }
  // 6. Array items are validated element-by-element with indexed error paths.
  {
    const schema = { type: 'array', items: { type: 'object', required: ['glob', 'trigger'] } };
    const errs = validateAgainstSchema([{ glob: 'x', trigger: 'y' }, { glob: 'x' }], schema);
    push('array_items_validated_with_index', errs.length === 1 && errs[0].includes('[1]'), errs);
  }
  // 7. Real repo data: this repo's own config/global-policy.json validates clean against the
  //    schema this lane just wrote for it (proves the schema actually matches real content, not
  //    just a synthetic fixture).
  {
    const r = validateGlobalPolicy(REPO_ROOT);
    push('real_global_policy_validates_clean', r.ok === true, r);
  }
  // 8. Real repo data: every real config/project-profiles/*.json validates clean.
  {
    const rs = validateProjectProfiles(REPO_ROOT);
    const allOk = rs.length > 0 && rs.every(r => r.ok);
    push('real_project_profiles_validate_clean', allOk, rs);
  }
  // 9. A deliberately broken fixture (missing required "trigger" in sensitive_paths) is rejected,
  //    not silently accepted -- fail-closed intent, mirroring this repo's stated philosophy.
  {
    const schema = readJson(path.join(REPO_ROOT, 'config', 'project-profile.schema.json'), null);
    const broken = { schema_version: 1, project: 'x', sensitive_paths: [{ glob: '**/*.key' }] };
    const errs = validateAgainstSchema(broken, schema);
    push('broken_fixture_missing_trigger_rejected', errs.length >= 1, errs);
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { validateAgainstSchema, validateGlobalPolicy, validateProjectProfiles, runAll };
if (require.main === module) main();
