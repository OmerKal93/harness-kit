#!/usr/bin/env node
// evals/core/run-lifecycle/run.js — run-lifecycle-hygiene-v1 E2 + Harness v1 G2.
// Exercises _lib.js resolveCurrentRun/runLifecyclePolicy/matchApproval/
// matchingApprovalIndexes, scripts/close-run.js and scripts/grant-approval.js
// against synthetic harnesskit roots built per fixture under .tmp/ — the REAL runs/
// registry is never touched. Codex-review requirements: never-throw (rl-11, rl-12),
// hardcoded policy fallback (rl-12), TTL boundary (rl-13). G2 (rl-14..21): grant
// script + strict approval field enforcement (granted_by/granted_ts/expires_ts
// required, no legacy grace, future-skew guard, optional files scope).
// Matcher calls pass { now } — injected for determinism.
// Contract: prints {category,pass,score,total,passed,failed,...} envelope, exit 0/1.
// Honors kill switch. Zero network.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isDisabled, harnessRoot } = require('../../../scripts/is-disabled.js');
const {
  parseArgs, readJson, readNdjson,
  resolveCurrentRun, runLifecyclePolicy, matchApproval, matchingApprovalIndexes
} = require('../../../scripts/_lib.js');

const CLOSE_RUN = path.join(harnessRoot(), 'scripts', 'close-run.js');
const GRANT = path.join(harnessRoot(), 'scripts', 'grant-approval.js');
const TMP = path.join(__dirname, '.tmp');

function isoAt(nowIso, ageHours) {
  return new Date(new Date(nowIso).getTime() - ageHours * 3600000).toISOString();
}

function buildRoot(id, fx, nowIso) {
  const root = path.join(TMP, id);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  // config: real run_lifecycle block so the normal policy path is exercised.
  // Fixture sub-roots that omit config exercise the hardcoded fallback instead.
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'global-policy.json'), JSON.stringify({
    run_lifecycle: { ttl_hours: 24, inactive_states: ['DONE', 'BLOCKED', 'NEEDS_USER', 'EXPIRED'], pointer_file: 'runs/.current-run' }
  }));
  const idxLines = [];
  for (const [runId, spec] of Object.entries(fx.setup.runs || {})) {
    const rd = path.join(root, 'runs', runId);
    fs.mkdirSync(rd, { recursive: true });
    const lsc = isoAt(nowIso, spec.age_hours);
    const rj = spec.legacy
      ? { run_id: runId, state: spec.state, last_state_change: lsc, approvals: spec.approvals || [] }
      : {
          schema_version: 1, run_id: runId, created: lsc, last_state_change: lsc,
          state: spec.state, prompt: 'fixture', approvals: spec.approvals || [], artifacts: {}, notes: []
        };
    fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify(rj, null, 2));
    idxLines.push(JSON.stringify({ ts: lsc, run_id: runId, state: spec.state, task_type: null, confidence: null }));
  }
  fs.writeFileSync(path.join(root, 'runs', '.index.ndjson'), idxLines.length ? idxLines.join('\n') + '\n' : '');
  // G2 grant fixtures: synthetic project profile so grant-approval.js reads a LIVE
  // trigger vocabulary from <root>/config/project-profiles/ (no hardcoded list).
  if (Array.isArray(fx.setup.profile_triggers)) {
    const pdir = path.join(root, 'config', 'project-profiles');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'fixture.json'), JSON.stringify({
      schema_version: 1, project: 'fixture', project_root: 'C:/example/fixture',
      sensitive_paths: fx.setup.profile_triggers.map(t => ({ glob: 'x/**', trigger: t }))
    }, null, 2));
  }
  if (fx.setup.pointer_raw !== undefined) {
    fs.writeFileSync(path.join(root, 'runs', '.current-run'), String(fx.setup.pointer_raw));
  } else if (fx.setup.pointer) {
    fs.writeFileSync(path.join(root, 'runs', '.current-run'), JSON.stringify({ run_id: fx.setup.pointer, ts: nowIso }));
  }
  return root;
}

function noThrow(fn) {
  try { return { threw: false, value: fn() }; }
  catch (e) { return { threw: true, error: String(e && e.message).slice(0, 200) }; }
}

function evalCase(fx, nowIso) {
  const fails = [];
  const root = buildRoot(fx.id, fx, nowIso);
  const a = fx.assert;

  const expectResolve = (expected, opts, tag) => {
    const r = noThrow(() => resolveCurrentRun({ root: (opts && opts.root) || root, now: nowIso }));
    if (r.threw) { fails.push(`${tag}:THREW ${r.error}`); return; }
    const got = r.value === null ? null : r.value.run_id;
    if (got !== expected) fails.push(`${tag}:actual=${got}/expected=${expected}`);
  };

  if ('resolve' in a) expectResolve(a.resolve, null, 'resolve');

  if (a.match_trigger) {
    const cur = resolveCurrentRun({ root, now: nowIso });
    const approvals = cur ? cur.run.approvals : [];
    const m = noThrow(() => matchApproval(approvals, a.match_trigger, [], { now: nowIso }));
    if (m.threw) fails.push('match:THREW ' + m.error);
    else if (m.value !== a.match_expected) fails.push(`match:actual=${m.value}/expected=${a.match_expected}`);
  }

  // G2: file-scope matrix — same approvals, varying writtenPath (absent = Bash/no-path).
  if (a.match_cases) {
    const cur = resolveCurrentRun({ root, now: nowIso });
    const approvals = cur ? cur.run.approvals : [];
    a.match_cases.forEach((c, n) => {
      const m = noThrow(() => matchApproval(approvals, approvals[0] ? approvals[0].action : '', [], { now: nowIso, writtenPath: c.written_path }));
      if (m.threw) fails.push(`case${n}:THREW ${m.error}`);
      else if (m.value !== c.expected) fails.push(`case${n}(${c.written_path || 'no-path'}):actual=${m.value}/expected=${c.expected}`);
    });
  }

  if (a.flip_trigger) {
    const cur = resolveCurrentRun({ root, now: nowIso });
    const approvals = cur.run.approvals;
    const before = matchApproval(approvals, a.flip_trigger, [], { now: nowIso });
    if (before !== a.match_before) fails.push(`flip-before:actual=${before}/expected=${a.match_before}`);
    for (const i of matchingApprovalIndexes(approvals, a.flip_trigger, [], { now: nowIso })) {
      approvals[i].consumed = true; // same flip the ledger hook performs
    }
    const after = matchApproval(approvals, a.flip_trigger, [], { now: nowIso });
    if (after !== a.match_after_flip) fails.push(`flip-after:actual=${after}/expected=${a.match_after_flip}`);
  }

  // G2: grant-approval.js fixtures (rl-14/15/19/21). Runs the real script with
  // --root/--now injection; asserts exit code, append target, stamped fields,
  // matcher acceptance, optional e2e flip.
  if (a.grant) {
    const g = a.grant;
    const argv = [GRANT, '--root', root, '--now', nowIso, '--action', g.args.action, '--scope', g.args.scope];
    if (g.args.files) argv.push('--files', g.args.files);
    if (g.args.expires_hours !== undefined) argv.push('--expires-hours', String(g.args.expires_hours));
    let exitCode = 0;
    try { execFileSync('node', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { exitCode = e.status == null ? 1 : e.status; }
    if (exitCode !== g.expect_exit) fails.push(`grant-exit:actual=${exitCode}/expected=${g.expect_exit}`);

    const rj = readJson(path.join(root, 'runs', g.check_run, 'run.json'), null);
    const approvals = (rj && rj.approvals) || [];
    if ('approvals_count' in g && approvals.length !== g.approvals_count) {
      fails.push(`grant-count:actual=${approvals.length}/expected=${g.approvals_count}`);
    }
    if (g.other_run_untouched) {
      const other = readJson(path.join(root, 'runs', g.other_run_untouched, 'run.json'), null);
      if (((other && other.approvals) || []).length !== 0) fails.push('grant-leak:approval appended to non-pointer run');
    }
    const last = approvals[approvals.length - 1];
    if (g.fields_stamped) {
      if (!last) fails.push('grant-fields:no approval appended');
      else {
        if (last.granted_by !== 'owner') fails.push('grant-fields:granted_by!=owner');
        if (!Number.isFinite(Date.parse(last.granted_ts || ''))) fails.push('grant-fields:granted_ts unparseable');
        if (!Number.isFinite(Date.parse(last.expires_ts || ''))) fails.push('grant-fields:expires_ts unparseable');
        if (typeof last.granted_via !== 'string' || !last.granted_via.includes('grant-approval.js')) fails.push('grant-fields:granted_via missing');
        if ('uses' in last) fails.push('grant-fields:uses field present (v1 is single-use only)');
      }
    }
    if (g.expires_delta_hours && last) {
      const delta = (Date.parse(last.expires_ts) - Date.parse(last.granted_ts)) / 3600000;
      if (Math.abs(delta - g.expires_delta_hours) > 0.001) fails.push(`grant-expiry:delta=${delta}/expected=${g.expires_delta_hours}`);
    }
    if (g.match_trigger) {
      const m = matchApproval(approvals, g.match_trigger, [], { now: nowIso, writtenPath: g.match_written_path });
      if (m !== g.match_expected) fails.push(`grant-match:actual=${m}/expected=${g.match_expected}`);
      if (g.then_flip) {
        for (const i of matchingApprovalIndexes(approvals, g.match_trigger, [], { now: nowIso, writtenPath: g.match_written_path })) {
          approvals[i].consumed = true; // ledger-equivalent flip
        }
        const after = matchApproval(approvals, g.match_trigger, [], { now: nowIso, writtenPath: g.match_written_path });
        if (after !== false) fails.push('grant-e2e:re-match after flip should be false');
      }
    }
  }

  if (a.close_run) {
    let closeOk = true;
    try {
      execFileSync('node', [CLOSE_RUN, '--run-id', a.close_run.run_id, '--to', a.close_run.to, '--reason', 'fixture close', '--root', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { closeOk = false; fails.push('close-run:exit!=0 ' + String(e.stdout || e.message).slice(0, 200)); }
    if (closeOk && a.after) {
      if ('resolve' in a.after) expectResolve(a.after.resolve, null, 'after-resolve');
      if ('pointer_exists' in a.after) {
        const exists = fs.existsSync(path.join(root, 'runs', '.current-run'));
        if (exists !== a.after.pointer_exists) fails.push(`after-pointer:actual=${exists}/expected=${a.after.pointer_exists}`);
      }
      if ('next_action_exists' in a.after) {
        const exists = fs.existsSync(path.join(root, 'runs', a.close_run.run_id, 'next-action.md'));
        if (exists !== a.after.next_action_exists) fails.push(`after-artifact:actual=${exists}/expected=${a.after.next_action_exists}`);
      }
      if (a.after.index_last_state) {
        const lines = readNdjson(path.join(root, 'runs', '.index.ndjson')).filter(e => e.run_id === a.close_run.run_id);
        const last = lines[lines.length - 1];
        if (!last || last.state !== a.after.index_last_state) fails.push(`after-index:actual=${last && last.state}/expected=${a.after.index_last_state}`);
      }
    }
  }

  if (a.policy_includes_expired) {
    const pol = noThrow(() => runLifecyclePolicy(root));
    if (pol.threw || !pol.value.inactive_states.includes('EXPIRED')) fails.push('policy:EXPIRED missing from inactive set');
  }

  if (a.close_already_terminal_fails) {
    let exited1 = false;
    try {
      execFileSync('node', [CLOSE_RUN, '--run-id', a.close_already_terminal_fails.run_id, '--to', a.close_already_terminal_fails.to, '--reason', 'should fail', '--root', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { exited1 = true; }
    if (!exited1) fails.push('close-terminal:expected non-zero exit on already-terminal run');
  }

  if ('corrupt_run_json_resolve' in a) {
    // sub-root: valid pointer to a run whose run.json is garbage bytes + NO config dir (fallback path)
    const sub = path.join(TMP, fx.id + '-subroot');
    fs.rmSync(sub, { recursive: true, force: true });
    fs.mkdirSync(path.join(sub, 'runs', 'run-c'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'runs', 'run-c', 'run.json'), String((fx.setup.also_corrupt_run_json_variant || {}).run_json_raw || '<<<garbage'));
    fs.writeFileSync(path.join(sub, 'runs', '.current-run'), JSON.stringify({ run_id: 'run-c', ts: nowIso }));
    expectResolve(a.corrupt_run_json_resolve, { root: sub }, 'corrupt-run-json');
  }

  if ('resolve_at_exact_ttl' in a) {
    expectResolve(a.resolve_at_exact_ttl, null, 'ttl-exact'); // age == ttl → valid
    const over = (fx.setup.epsilon_variant || {}).age_hours_over || 24.0003;
    const sub = path.join(TMP, fx.id + '-over');
    fs.rmSync(sub, { recursive: true, force: true });
    fs.mkdirSync(path.join(sub, 'runs', 'run-a'), { recursive: true });
    const lsc = isoAt(nowIso, over);
    fs.writeFileSync(path.join(sub, 'runs', 'run-a', 'run.json'), JSON.stringify({ run_id: 'run-a', state: 'INTAKE', last_state_change: lsc, approvals: [] }));
    fs.writeFileSync(path.join(sub, 'runs', '.current-run'), JSON.stringify({ run_id: 'run-a', ts: nowIso }));
    expectResolve(a.resolve_just_over_ttl, { root: sub }, 'ttl-over');
  }

  if (a.no_throw && fails.some(f => f.includes('THREW'))) {
    // already recorded; explicit marker for the never-throw contract
    fails.push('never-throw-contract:VIOLATED');
  }

  return { id: fx.id, label: fx.label || 'positive', pass: fails.length === 0, fail_reason: fails.length ? fails.join('|') : null };
}

function main() {
  const ks = isDisabled();
  if (ks.disabled) { process.exit(0); }

  const args = parseArgs(process.argv.slice(2));
  const fixturesDir = args['fixtures-dir'] || path.join(harnessRoot(), 'evals', 'fixtures', 'run-lifecycle');
  const data = readJson(path.join(fixturesDir, 'cases.json'), { fixtures: [] });
  const nowIso = data.now || '2026-06-05T12:00:00.000Z';
  const cases = data.fixtures || [];

  const cfg = readJson(path.join(harnessRoot(), 'evals', 'config.json'), { categories: {} });
  const minRatio = (cfg.categories['run-lifecycle'] && typeof cfg.categories['run-lifecycle'].min_pass_ratio === 'number')
    ? cfg.categories['run-lifecycle'].min_pass_ratio : 1.0;

  fs.mkdirSync(TMP, { recursive: true });
  const results = cases.map(fx => evalCase(fx, nowIso));
  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failures = results.filter(r => !r.pass);
  const score = total > 0 ? passed / total : 0;

  if (failures.length === 0) fs.rmSync(TMP, { recursive: true, force: true });

  const byLabel = {};
  for (const r of results) {
    byLabel[r.label] = byLabel[r.label] || { total: 0, passed: 0 };
    byLabel[r.label].total++;
    if (r.pass) byLabel[r.label].passed++;
  }

  const out = {
    category: 'run-lifecycle',
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
