#!/usr/bin/env node
'use strict';
// hooks/policy/guard-policy.js -- host-neutral policy core for HarnessKit's "guard" hook family.
//
// Origin: adapted from gstack's careful/freeze/guard PreToolUse hooks
// (github.com/garrytan/gstack @ pinned commit 7c9df1c568a9ea745508f679a329332b2c338063, GPG-signed,
// MIT license -- see docs/plans/GSTACK_CAPABILITY_ANALYSIS.md and
// docs/plans/GSTACK_SECURITY_ANALYSIS.md, a separate repo, for the vetting evidence). Extraction
// scope: the destructive-command pattern table + safe-exception list (careful/bin/check-careful.sh)
// and the boundary-match logic (freeze/bin/check-freeze.sh) only. The gstack telemetry line in both
// scripts (an unconditional append to ~/.gstack/analytics/skill-usage.jsonl on every hook fire) was
// dropped entirely, not ported in any form or gated behind a flag -- see
// docs/GSTACK_POLICY_CORE_REPORT.md "What was stripped".
//
// This module is intentionally host-blind: no "permissionDecision", no Claude-Code-specific JSON
// shape, no stdin/stdout/exit-code handling. It returns plain {decision, pattern, reason} objects.
// Host adapters (see ../pre_tool_use_guard.js for the Claude Code / exit-code adapter) are
// responsible for translating a decision into whatever their host expects.

const SAFE_RM_TARGETS = new Set([
  'node_modules', '.next', 'dist', '__pycache__', '.cache', 'build', '.turbo', 'coverage'
]);

// Splits a shell command line on top-level chain/pipe operators so a destructive segment can't
// hide behind a benign prefix (e.g. "cd /tmp && git reset --hard HEAD~1" or
// "git checkout . ; echo done"). gstack's own check-careful.sh/check-freeze.sh did not do this --
// they ran a single grep -E over the whole raw string. This is a deliberate hardening on top of the
// extracted logic, not a straight port; see docs/GSTACK_POLICY_CORE_REPORT.md.
function splitSegments(cmd) {
  return String(cmd || '')
    .split(/&&|\|\||;|\n|\|/)
    .map(s => s.trim())
    .filter(Boolean);
}

// Mirrors check-careful.sh's safe-exception scan: every non-flag token after `rm` must be a known
// build-artifact directory (by basename) for the whole command to be treated as safe.
function isSafeRmTarget(cmd) {
  const m = String(cmd || '').match(/rm\s+(?:-[a-zA-Z]+\s+)*(.+)$/);
  if (!m) return false;
  const rest = m[1].replace(/--recursive/g, '').trim();
  const targets = rest.split(/\s+/).filter(Boolean).filter(t => !t.startsWith('-'));
  if (targets.length === 0) return false;
  return targets.every(t => {
    const base = t.replace(/\/+$/, '').split('/').filter(Boolean).pop() || t;
    return SAFE_RM_TARGETS.has(base);
  });
}

// Bash destructive-command rules. `decision` is 'block' (hard stop) or 'ask' (soft, overridable
// warning) -- a tri-state gstack itself only ever used as 'ask' (permissionDecision:"ask" for every
// pattern it detects, including git reset --hard). HarnessKit tightens exactly the four
// "discard all uncommitted changes" patterns (git checkout ./--, git restore ./--staged .,
// git reset --hard) to a hard 'block'. Two independent reasons, not a stylistic preference:
//   1. This project's own operating rules (see CLAUDE.md: stash/commit before any discard-capable
//      command) already treat this exact class of command as needing a hard stop, not a warning.
//   2. evals/fixtures/guard-triggers/cases.json -- pre-existing in this repo, not authored by this
//      change -- already
//      encodes expect:"block" for exactly these 8 fixtures (gt-01..gt-08). That eval contract came
//      first; this rule table is built to satisfy it, not the other way around.
const BASH_RULES = [
  {
    id: 'git_checkout_discard',
    decision: 'block',
    reason: 'Destructive: discards all uncommitted changes in the working tree.',
    test: (cmd, segs) => segs.some(s => /^git\s+checkout\s+(--\s+)?\.$/.test(s))
  },
  {
    id: 'git_restore_discard',
    decision: 'block',
    reason: 'Destructive: discards all uncommitted changes in the working tree.',
    test: (cmd, segs) => segs.some(s => /^git\s+restore\s+(--staged\s+)?\.$/.test(s))
  },
  {
    id: 'git_reset_hard',
    decision: 'block',
    reason: 'Destructive: git reset --hard discards all uncommitted changes.',
    test: (cmd) => /git\s+reset\s+--hard/.test(cmd)
  },
  {
    id: 'rm_recursive',
    decision: 'ask',
    reason: 'Destructive: recursive delete (rm -r). This permanently removes files.',
    test: (cmd) => /rm\s+(?:-[a-zA-Z]*r|--recursive)/.test(cmd) && !isSafeRmTarget(cmd)
  },
  {
    id: 'drop_table',
    decision: 'ask',
    reason: 'Destructive: SQL DROP detected. This permanently deletes database objects.',
    test: (cmd) => /drop\s+(table|database)/i.test(cmd)
  },
  {
    id: 'truncate',
    decision: 'ask',
    reason: 'Destructive: SQL TRUNCATE detected. This deletes all rows from a table.',
    test: (cmd) => /\btruncate\b/i.test(cmd)
  },
  {
    id: 'git_force_push',
    decision: 'ask',
    reason: 'Destructive: git force-push rewrites remote history. Other contributors may lose work.',
    test: (cmd) => /git\s+push\s+.*(-f\b|--force)/.test(cmd)
  },
  {
    id: 'kubectl_delete',
    decision: 'ask',
    reason: 'Destructive: kubectl delete removes Kubernetes resources. May impact production.',
    test: (cmd) => /kubectl\s+delete/.test(cmd)
  },
  {
    id: 'docker_destructive',
    decision: 'ask',
    reason: 'Destructive: Docker force-remove or prune. May delete running containers or cached images.',
    test: (cmd) => /docker\s+(rm\s+-f|system\s+prune)/.test(cmd)
  }
];

function evaluateBashCommand(command) {
  const cmd = String(command || '');
  const segs = splitSegments(cmd);
  for (const rule of BASH_RULES) {
    if (rule.test(cmd, segs)) {
      return { decision: rule.decision, pattern: rule.id, reason: rule.reason };
    }
  }
  return { decision: 'allow', pattern: null, reason: null };
}

// Freeze: block Edit/Write outside a chosen boundary directory. Mirrors check-freeze.sh's
// trailing-boundary match (so "/src" does not match "/src-old"). No freeze boundary configured =>
// allow everything -- fail-open on missing configuration, matching gstack's own default ("not yet
// configured" = allow). This is a scope-discipline aid, explicitly NOT a security boundary (same
// caveat gstack's own freeze/SKILL.md states: a Bash `sed`/`node -e` write is not intercepted here).
function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function evaluateFileWrite(filePath, freezeBoundary) {
  if (!freezeBoundary) return { decision: 'allow', pattern: null, reason: null };
  const file = normalizePath(filePath);
  const boundary = normalizePath(freezeBoundary);
  if (!file) return { decision: 'allow', pattern: null, reason: null };
  if (file === boundary || file.startsWith(boundary + '/')) {
    return { decision: 'allow', pattern: null, reason: null };
  }
  return {
    decision: 'block',
    pattern: 'freeze_boundary',
    reason: `[freeze] Blocked: ${filePath} is outside the freeze boundary (${freezeBoundary}). Only edits within the frozen directory are allowed.`
  };
}

module.exports = { evaluateBashCommand, evaluateFileWrite, splitSegments, isSafeRmTarget, BASH_RULES };

// --- Self-test (pure logic only -- no subprocess, no host, no filesystem state) ---
// Deliberately hardcodes the same 8 bash cases as evals/fixtures/guard-triggers/cases.json's
// bash-type fixtures (gt-01..gt-08) as an independent witness: this test and that eval fixture file
// are not derived from one another, so drift between them is a real signal, not silently masked.
function selfTest() {
  const cases = [
    // [command, expected decision]
    ['git checkout .', 'block'],
    ['git checkout -- .', 'block'],
    ['git checkout main', 'allow'],
    ['git checkout file.txt', 'allow'],
    ['git restore .', 'block'],
    ['git restore --staged .', 'block'],
    ['git restore --help', 'allow'],
    ['git reset --hard HEAD~1', 'block'],
    // extended coverage beyond the repo eval's 8 fixtures
    ['rm -rf /var/data', 'ask'],
    ['rm -rf node_modules', 'allow'],
    ['rm -rf ./dist ./node_modules', 'allow'],
    ['rm -rf ./dist ./secrets', 'ask'],
    ['DROP TABLE users;', 'ask'],
    ['drop database prod;', 'ask'],
    ['TRUNCATE orders;', 'ask'],
    ['git push -f origin main', 'ask'],
    ['git push --force origin main', 'ask'],
    ['kubectl delete pod x', 'ask'],
    ['docker system prune -a', 'ask'],
    ['docker rm -f my_container', 'ask'],
    ['echo hello', 'allow'],
    ['git status', 'allow'],
    // chained-command hardening (beyond gstack's own naive whole-string grep)
    ['cd /tmp && git reset --hard HEAD~1', 'block'],
    ['echo ok && git checkout .', 'block'],
    ['git checkout . && rm -rf important', 'block']
  ];

  let pass = 0;
  const failures = [];
  for (const [cmd, expected] of cases) {
    const { decision } = evaluateBashCommand(cmd);
    if (decision === expected) pass++;
    else failures.push(`bash:"${cmd}" expected=${expected} actual=${decision}`);
  }

  const freezeCases = [
    // [filePath, boundary, expected]
    ['/repo/src/a.ts', '/repo/src', 'allow'],
    ['/repo/src-old/a.ts', '/repo/src', 'block'],
    ['/repo/other/b.ts', '/repo/src', 'block'],
    ['/repo/src', '/repo/src', 'allow'],
    ['/repo/anything.ts', null, 'allow'],
    ['C:\\repo\\src\\c.ts', 'C:\\repo\\src', 'allow'],
    ['C:\\repo\\other\\c.ts', 'C:\\repo\\src', 'block']
  ];
  for (const [file, boundary, expected] of freezeCases) {
    const { decision } = evaluateFileWrite(file, boundary);
    if (decision === expected) pass++;
    else failures.push(`freeze:"${file}" boundary="${boundary}" expected=${expected} actual=${decision}`);
  }

  const total = cases.length + freezeCases.length;
  const out = { module: 'guard-policy', pass: failures.length === 0, total, passed: pass, failed: failures.length, failures };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.pass ? 0 : 1);
}

if (require.main === module && process.argv.includes('--self-test')) {
  selfTest();
}
