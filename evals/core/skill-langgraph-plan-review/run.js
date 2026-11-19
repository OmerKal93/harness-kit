#!/usr/bin/env node
// evals/core/skill-langgraph-plan-review/run.js
// Eval driver for the langgraph-plan-review skillpack helper (skillpack #2, G4 track).
// Loads harness fixtures from evals/fixtures/skill-langgraph-plan-review/cases.json,
// feeds plan_text + in-fixture cited contents to check-langgraph-plan.js analyze(),
// and asserts helper-JSON outcomes deterministically. No LLM-judge. Zero network.
// Contract: prints {category,pass,score,total,passed,failed,...} envelope, exit 0/1.
// Honors kill switch.
'use strict';

const path = require('path');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const { parseArgs, readJson } = require('../../../scripts/_lib.js');
const checker = require('../../../skills/langgraph-plan-review/scripts/check-langgraph-plan.js');

function nonNegatedCategories(r) {
  return [...new Set(r.boundary_hits.filter(h => !h.negated).map(h => h.category))].sort();
}

function evalCase(fx) {
  const fails = [];
  let r;
  try {
    r = checker.analyze({ plan_text: fx.plan_text || '', plan_ref: fx.id, cited: fx.cited || [] });
  } catch (e) {
    return { id: fx.id, label: fx.label || 'positive', pass: false,
             fail_reason: 'analyze-threw: ' + String(e.message).slice(0, 160) };
  }
  const exp = fx.expected || {};

  if (Array.isArray(exp.non_negated_boundary_categories)) {
    const actual = nonNegatedCategories(r);
    const expected = [...exp.non_negated_boundary_categories].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fails.push(`non-negated-cats:actual=[${actual}]/expected=[${expected}]`);
    }
  }
  if (typeof exp.negated_boundary_min === 'number') {
    const n = r.boundary_hits.filter(h => h.negated).length;
    if (n < exp.negated_boundary_min) fails.push(`negated-hits:actual=${n}/min=${exp.negated_boundary_min}`);
  }
  if (typeof exp.unreachable_count === 'number' && r.graph.unreachable.length !== exp.unreachable_count) {
    fails.push(`unreachable:actual=${r.graph.unreachable.length}/expected=${exp.unreachable_count}`);
  }
  for (const n of (exp.unreachable_includes || [])) {
    if (!r.graph.unreachable.includes(n)) fails.push('unreachable-missing:' + n);
  }
  if (typeof exp.no_path_to_end_count === 'number' && r.graph.no_path_to_end.length !== exp.no_path_to_end_count) {
    fails.push(`no-end:actual=${r.graph.no_path_to_end.length}/expected=${exp.no_path_to_end_count}`);
  }
  if (typeof exp.missing_end === 'boolean' && r.graph.missing_end !== exp.missing_end) {
    fails.push(`missing-end:actual=${r.graph.missing_end}/expected=${exp.missing_end}`);
  }
  if (typeof exp.parse_limited === 'boolean' && r.parse_limited !== exp.parse_limited) {
    fails.push(`parse-limited:actual=${r.parse_limited}/expected=${exp.parse_limited}`);
  }
  if (typeof exp.reachability_suppressed === 'boolean' && r.graph.reachability_suppressed !== exp.reachability_suppressed) {
    fails.push(`suppressed:actual=${r.graph.reachability_suppressed}/expected=${exp.reachability_suppressed}`);
  }
  if (typeof exp.mismatch_count === 'number' && r.mismatches.length !== exp.mismatch_count) {
    fails.push(`mismatch:actual=${r.mismatches.length}/expected=${exp.mismatch_count}`);
  }
  if (typeof exp.mismatch_min === 'number' && r.mismatches.length < exp.mismatch_min) {
    fails.push(`mismatch:actual=${r.mismatches.length}/min=${exp.mismatch_min}`);
  }
  if (typeof exp.thin_input === 'boolean' && r.thin_input !== exp.thin_input) {
    fails.push(`thin-input:actual=${r.thin_input}/expected=${exp.thin_input}`);
  }
  if (typeof exp.stategraph_present === 'boolean' && (!r.state_shape || r.state_shape.stategraph_present !== exp.stategraph_present)) {
    fails.push('state-shape:stategraph mismatch');
  }
  if (typeof exp.annotation_root_present === 'boolean' && (!r.state_shape || r.state_shape.annotation_root_present !== exp.annotation_root_present)) {
    fails.push('state-shape:annotation-root mismatch');
  }
  if (typeof exp.any_typed_state === 'boolean' && (!r.state_shape || r.state_shape.any_typed_state !== exp.any_typed_state)) {
    fails.push('state-shape:any-typed mismatch');
  }
  // Boundary rule D: the helper must never produce zone-checking output (that is
  // project-plan-review's lane). Asserted on the carve-out fixture.
  if (exp.no_zone_keys === true) {
    const keys = JSON.stringify(Object.keys(r)).toLowerCase();
    if (keys.includes('zone')) fails.push('boundary-d-violation: zone keys present in helper output');
  }

  return {
    id: fx.id,
    label: fx.label || 'positive',
    pass: fails.length === 0,
    fail_reason: fails.length === 0 ? null : fails.join('|')
  };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] ||
    path.join(harnessRoot(), 'evals', 'fixtures', 'skill-langgraph-plan-review');
  const cases = (readJson(path.join(fixturesDir, 'cases.json'), { fixtures: [] })).fixtures || [];

  const cfg = readJson(path.join(harnessRoot(), 'evals', 'config.json'), { categories: {} });
  const minRatio = (cfg.categories['skill-langgraph-plan-review'] &&
    typeof cfg.categories['skill-langgraph-plan-review'].min_pass_ratio === 'number')
    ? cfg.categories['skill-langgraph-plan-review'].min_pass_ratio : 1.0;

  const results = cases.map(evalCase);
  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failures = results.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  const byLabel = {};
  for (const r of results) {
    byLabel[r.label] = byLabel[r.label] || { total: 0, passed: 0 };
    byLabel[r.label].total++;
    if (r.pass) byLabel[r.label].passed++;
  }

  const out = {
    category: 'skill-langgraph-plan-review',
    pass: total > 0 && score >= minRatio,
    score, total, passed, failed: failures.length,
    min_pass_ratio: minRatio,
    by_label: byLabel,
    failures: failures.slice(0, 30)
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module) main();
