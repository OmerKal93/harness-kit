#!/usr/bin/env node
// gbrain-bootstrap-check.js -- HarnessKit install/config lane (Batch 1 Foundation,
// hk/p9b-install-config).
//
// Answers one question concretely: "a genuinely fresh second machine has no ~/gbrain at all --
// what should install/config do about that?"
//
// This is DETECT-AND-WARN, not auto-bootstrap: GBrain is genuinely external, machine-global, shared
// state (its own bun runtime + git clone + pglite database) -- no second-machine
// bootstrap exists. This script does not clone anything, run bun, or write outside its own stdout.
// It reads the SAME GBRAIN_DIR resolution scripts/gbrain-doctor.js already uses (so it never
// invents a second, competing path convention), reports what it finds, and -- when
// config/gbrain-import-policy.json's version_pin/commit_pin are readable -- prints the exact
// manual bootstrap steps a human would run, real repo URL intentionally left as a placeholder
// (this repo does not know it; GBrain's real remote is personal/private, not part of this
// distribution).
//
//   node scripts/gbrain-bootstrap-check.js            -- real detection against this machine
//   node scripts/gbrain-bootstrap-check.js --self-test
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readJson } = require('./_lib.js');

const REPO_ROOT = path.join(__dirname, '..');

// Byte-identical resolution convention to scripts/gbrain-doctor.js's GBRAIN_DIR -- deliberately not
// imported (gbrain-doctor.js does not export it), but must never drift from it. If gbrain-doctor.js
// ever changes this default, this line must change too.
function resolveGbrainDir(homeDir) {
  return process.env.GBRAIN_DIR || path.join(homeDir || os.homedir(), 'gbrain');
}

function detect(opts) {
  opts = opts || {};
  const homeDir = opts.homeDir || os.homedir();
  const gbrainDir = resolveGbrainDir(homeDir);
  const present = fs.existsSync(gbrainDir);
  const policy = readJson(path.join(opts.repoRoot || REPO_ROOT, 'config', 'gbrain-import-policy.json'), null);
  const pin = policy ? { version_pin: policy.version_pin || null, commit_pin: policy.commit_pin || null } : null;

  if (present) {
    return {
      status: 'PRESENT',
      gbrain_dir: gbrainDir,
      pin,
      detail: `${gbrainDir} exists -- GBrain appears already provisioned on this machine. This script does not check its version/commit against the pin; run scripts/gbrain-doctor.js for that.`,
      guidance: []
    };
  }

  const guidance = [
    `${gbrainDir} does not exist on this machine.`,
    'GBrain is genuinely external, machine-global state (own bun runtime + git clone + pglite database) -- it is NOT installed, migrated, or bootstrapped by `npm install` or any HarnessKit script, and this check will not do it for you.',
    'This is expected and non-blocking: core HarnessKit workflow does not depend on GBrain (doctor.js classifies gbrain_runtime as DEGRADED, never BLOCKING, exactly for this reason).'
  ];
  if (pin && pin.commit_pin) {
    guidance.push(
      'If you want GBrain on this machine, the manual bootstrap this repo can concretely point you to (not executed automatically, and the clone URL below is a placeholder -- this repo does not carry GBrain\'s real remote, which is personal/private):',
      `  git clone <your-private-gbrain-remote> ${gbrainDir}`,
      `  cd ${gbrainDir} && git checkout ${pin.commit_pin}` + (pin.version_pin ? `   # pinned version: ${pin.version_pin}` : ''),
      '  (then install GBrain\'s own dependencies per its own README -- out of scope for this repo)',
      'This pin comes from config/gbrain-import-policy.json (version_pin/commit_pin).'
    );
  } else {
    guidance.push('No commit_pin found in config/gbrain-import-policy.json -- cannot even suggest a pinned checkout target. Bootstrapping GBrain today requires out-of-band knowledge this repo does not encode anywhere.');
  }
  return { status: 'ABSENT', gbrain_dir: gbrainDir, pin, detail: guidance[0], guidance };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) { process.exit(selfTest() ? 0 : 1); return; }
  const result = detect({});
  console.log(JSON.stringify(result, null, 2));
  process.exit(0); // never blocking -- matches doctor.js's gbrain_runtime non-blocking classification
}

function selfTest() {
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail: detail === undefined ? '' : JSON.stringify(detail) });

  // 1. A fake home dir with an existing "gbrain" directory -> PRESENT, no guidance needed.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-gbrain-check-selftest-'));
    fs.mkdirSync(path.join(tmp, 'gbrain'));
    const r = detect({ homeDir: tmp });
    push('existing_gbrain_dir_detected_as_present', r.status === 'PRESENT' && r.guidance.length === 0, r);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 2. A fake home dir with NO gbrain directory -> ABSENT, with concrete guidance including the
  //    real commit_pin read from this repo's actual config/gbrain-import-policy.json.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-gbrain-check-selftest-'));
    const r = detect({ homeDir: tmp });
    const mentionsPin = r.pin && r.pin.commit_pin && r.guidance.some(g => g.includes(r.pin.commit_pin));
    push('missing_gbrain_dir_detected_as_absent_with_pin_guidance', r.status === 'ABSENT' && !!mentionsPin, r);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 3. Never crashes/blocks when config/gbrain-import-policy.json is missing entirely (a repoRoot
  //    with no config/ dir at all) -- still reports ABSENT, just without a pin to suggest.
  {
    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-gbrain-check-selftest-repo-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-gbrain-check-selftest-home-'));
    const r = detect({ homeDir: tmpHome, repoRoot: fakeRepo });
    push('missing_policy_file_does_not_crash', r.status === 'ABSENT' && r.pin === null, r);
    fs.rmSync(fakeRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
  // 4. GBRAIN_DIR env override wins over the homeDir-derived default, matching gbrain-doctor.js's
  //    own resolution order exactly.
  {
    const prevEnv = process.env.GBRAIN_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-gbrain-check-selftest-'));
    const overrideDir = path.join(tmp, 'custom-gbrain-location');
    fs.mkdirSync(overrideDir, { recursive: true });
    process.env.GBRAIN_DIR = overrideDir;
    const r = detect({ homeDir: tmp });
    if (prevEnv === undefined) delete process.env.GBRAIN_DIR; else process.env.GBRAIN_DIR = prevEnv;
    push('GBRAIN_DIR_env_override_respected', r.status === 'PRESENT' && r.gbrain_dir === overrideDir, r);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 5. Real machine check: runs against this actual machine without throwing, and returns one of
  //    the two known statuses (does not assert PRESENT or ABSENT -- that's genuinely
  //    machine-dependent, which is the entire point of this tool).
  {
    const r = detect({});
    push('real_machine_check_runs_without_throwing', r.status === 'PRESENT' || r.status === 'ABSENT', r);
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { detect, resolveGbrainDir };
if (require.main === module) main();
