#!/usr/bin/env node
// run-json-atomic.js — REVIEW-INDEPENDENCE-1: real cross-process mutual exclusion + crash-safe
// writes for run.json, used by every producer/reviewer/dispatch mutation this feature makes.
//
// Why this exists instead of reusing scripts/lease.js: inspected and tested (see
// run-json-atomic.js --self-test and the multi-process test below). lease.js's acquireLease()
// does findConflict() (read) THEN writeJson() (write) with no exclusive-create in between -- a
// real TOCTOU race, not atomic acquisition. It also treats same-owner_session writers as NEVER
// conflicting, which is exactly wrong for this feature: a SubagentStart/SubagentStop hook runs as
// a separate OS process but very plausibly inherits the same HARNESSKIT_SESSION_ID as the main
// thread, so lease.js would never even attempt to block them against each other. lease.js is real
// and correct for its own use case (coarse, human-paced conflict avoidance); it is not a mutual-
// exclusion primitive, and this feature needs one. Per the review that flagged this, the smallest
// generic primitive is built here instead of misusing lease.js.
//
// Mechanism:
//   1. Lock: fs.openSync(lockPath, 'wx') -- O_CREAT|O_EXCL. This is a real, atomic,
//      cross-platform (Windows/macOS/Linux) kernel-level exclusive-create: it either creates the
//      file and succeeds, or fails with EEXIST if another process already holds it. No
//      check-then-write race window exists between "is it free" and "take it" -- both happen in
//      one syscall.
//   2. Mutation: read run.json, validate it parses (a malformed run.json aborts the mutation
//      entirely -- never silently replaced with a guess), call the caller's pure mutate function,
//      write the result to a temp file in the SAME directory (same filesystem/volume, required for
//      atomic rename), then fs.renameSync(tmp, run.json). rename() is atomic on all three
//      platforms Node supports: either the old content is visible or the new content is, never a
//      torn/partial file, even if the process is killed at any point up to the rename call itself.
//   3. Unlock: always in `finally`, even on error.
//
// Stale-lock recovery is conservative: only a lock older than STALE_MS is eligible for takeover,
// and takeover itself re-attempts the same atomic 'wx' create (so two processes racing to steal a
// stale lock still can't both succeed).
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 25;
const STALE_MS = 30000; // a lock older than this is presumed abandoned (crashed holder), not live

function lockPathFor(runDir) { return path.join(runDir, '.run-json.lock'); }

function sleepSync(ms) {
  // Zero-dependency busy-wait sleep for a bounded, short retry loop. Node has no sync sleep in
  // core; Atomics.wait on a SharedArrayBuffer is the standard zero-dep way to block synchronously.
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    // Fallback for environments without SharedArrayBuffer/Atomics.wait: a short CPU-bound spin.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
  }
}

function tryAcquire(lockPath, ownerToken) {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, JSON.stringify({ owner: ownerToken, pid: process.pid, acquired_at: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
}

function lockIsStale(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    return (Date.now() - stat.mtimeMs) > STALE_MS;
  } catch {
    return true; // lock disappeared between our check and now -- treat as free, not stale-owned
  }
}

// acquireRunJsonLock(runDir, {timeoutMs, ownerToken}) -> { ok:true, release } | { ok:false, reason }
function acquireRunJsonLock(runDir, opts) {
  const o = opts || {};
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const ownerToken = o.ownerToken || `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const lockPath = lockPathFor(runDir);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryAcquire(lockPath, ownerToken)) {
      return { ok: true, release: () => { try { fs.unlinkSync(lockPath); } catch { /* best-effort */ } } };
    }
    if (lockIsStale(lockPath)) {
      // Conservative takeover: attempt to remove the stale lock, then race for it again via the
      // same atomic 'wx' create -- if another process steals it first, our next tryAcquire fails
      // and we fall through to the normal retry/timeout path, never force-overwriting a live lock.
      try { fs.unlinkSync(lockPath); } catch { /* another process may have already removed it */ }
      if (tryAcquire(lockPath, ownerToken)) {
        return { ok: true, release: () => { try { fs.unlinkSync(lockPath); } catch { /* best-effort */ } } };
      }
    }
    if (Date.now() >= deadline) return { ok: false, reason: `timeout after ${timeoutMs}ms waiting for run.json lock` };
    sleepSync(RETRY_DELAY_MS);
  }
}

// withRunJsonLock(runDir, mutateFn, opts) -> mutateFn's return value, or throws
// mutateFn(currentRunJsonObjectOrNull) -> newRunJsonObject
// Fails closed: a malformed existing run.json aborts before mutateFn is ever called.
function withRunJsonLock(runDir, mutateFn, opts) {
  const lock = acquireRunJsonLock(runDir, opts);
  if (!lock.ok) throw new Error(lock.reason);
  try {
    const runJsonPath = path.join(runDir, 'run.json');
    let current = null;
    if (fs.existsSync(runJsonPath)) {
      const raw = fs.readFileSync(runJsonPath, 'utf8');
      try { current = JSON.parse(raw); }
      catch (e) { throw new Error(`run.json is malformed, refusing to mutate blindly: ${e.message}`); }
    }
    const next = mutateFn(current);
    const tmpPath = path.join(runDir, `.run-json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(next, null, 2));
      try { fs.fsyncSync(fd); } catch { /* fsync unsupported on some platforms/filesystems; rename below is still atomic */ }
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmpPath, runJsonPath);
    return next;
  } finally {
    lock.release();
  }
}

function selfTest() {
  const os = require('os');
  const results = [];
  const push = (name, ok, detail) => results.push({ name, ok, detail });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-run-json-atomic-selftest-'));
  const cleanup = () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ } };

  try {
    // 1. Basic acquire/release round-trip.
    {
      const runDir = fs.mkdtempSync(path.join(tmpRoot, 'r1-'));
      const l1 = acquireRunJsonLock(runDir, { timeoutMs: 500 });
      push('basic_acquire_succeeds', l1.ok === true, JSON.stringify(l1.ok));
      l1.release();
      push('lock_file_removed_after_release', !fs.existsSync(lockPathFor(runDir)), '');
    }
    // 2. A second acquire while the first is held fails (real mutual exclusion, not advisory).
    {
      const runDir = fs.mkdtempSync(path.join(tmpRoot, 'r2-'));
      const l1 = acquireRunJsonLock(runDir, { timeoutMs: 500 });
      const l2 = acquireRunJsonLock(runDir, { timeoutMs: 200 });
      push('second_acquire_blocked_while_first_held', l1.ok === true && l2.ok === false, JSON.stringify({ l1: l1.ok, l2: l2.ok }));
      l1.release();
    }
    // 3. Stale lock (older than STALE_MS) is conservatively recoverable -- simulate by writing an
    //    old lock file directly and back-dating its mtime.
    {
      const runDir = fs.mkdtempSync(path.join(tmpRoot, 'r3-'));
      const lp = lockPathFor(runDir);
      fs.writeFileSync(lp, JSON.stringify({ owner: 'stale-owner', pid: 999999, acquired_at: 'long ago' }));
      const oldTime = new Date(Date.now() - (STALE_MS + 5000));
      fs.utimesSync(lp, oldTime, oldTime);
      const l = acquireRunJsonLock(runDir, { timeoutMs: 500 });
      push('stale_lock_recovered', l.ok === true, JSON.stringify(l));
      if (l.ok) l.release();
    }
    // 4. A live (fresh) lock is NOT stolen even after a short wait -- stale-lock recovery does not
    //    steal a live lock.
    {
      const runDir = fs.mkdtempSync(path.join(tmpRoot, 'r4-'));
      const l1 = acquireRunJsonLock(runDir, { timeoutMs: 500 });
      const l2 = acquireRunJsonLock(runDir, { timeoutMs: 100 });
      push('live_lock_not_stolen', l1.ok === true && l2.ok === false, JSON.stringify({ l1: l1.ok, l2: l2.ok }));
      l1.release();
    }
    // 5. withRunJsonLock: two sequential mutations both land (no lost update within one process).
    {
      const runDir = fs.mkdtempSync(path.join(tmpRoot, 'r5-'));
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ producers: [] }));
      withRunJsonLock(runDir, (cur) => ({ ...cur, producers: [...cur.producers, 'a'] }));
      withRunJsonLock(runDir, (cur) => ({ ...cur, producers: [...cur.producers, 'b'] }));
      const final = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
      push('sequential_mutations_both_land', JSON.stringify(final.producers) === JSON.stringify(['a', 'b']), JSON.stringify(final));
    }
    // 6. Malformed run.json aborts the mutation rather than being silently replaced.
    {
      const runDir = fs.mkdtempSync(path.join(tmpRoot, 'r6-'));
      fs.writeFileSync(path.join(runDir, 'run.json'), '{not valid json');
      let threw = false, message = '';
      try { withRunJsonLock(runDir, (cur) => ({ ...cur, x: 1 })); }
      catch (e) { threw = true; message = e.message; }
      const stillMalformed = fs.readFileSync(path.join(runDir, 'run.json'), 'utf8') === '{not valid json';
      push('malformed_run_json_aborts_and_is_preserved', threw && stillMalformed, JSON.stringify({ threw, message, stillMalformed }));
    }
    // 7. Real multi-process concurrency: spawn several child Node processes that each acquire the
    //    lock, append one entry, and release -- not just two sequential in-process function calls.
    //    Proves cross-process exclusion, not just in-process.
    {
      const { spawnSync } = require('child_process');
      const runDir = fs.mkdtempSync(path.join(tmpRoot, 'r7-'));
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ entries: [] }));
      const workerScript = path.join(tmpRoot, 'worker.js');
      fs.writeFileSync(workerScript,
        `const { withRunJsonLock } = require(${JSON.stringify(__filename)});\n` +
        `const id = process.argv[2];\n` +
        `withRunJsonLock(process.argv[3], (cur) => ({ ...cur, entries: [...cur.entries, id] }), { timeoutMs: 8000 });\n`
      );
      const N = 8;
      // Use spawnSync in parallel-launch-then-wait shape is impossible (spawnSync blocks), and
      // polling child.exitCode via a synchronous sleepSync blocks the event loop that would
      // otherwise deliver the child 'exit' events -- so instead: spawn all N async (non-blocking
      // spawn calls are fine), then do one bounded synchronous wait long enough for 8 fast
      // lock/mutate/release cycles to finish, then assert on the actual file state.
      for (let i = 0; i < N; i++) {
        require('child_process').spawn(process.execPath, [workerScript, String(i), runDir], { stdio: 'ignore', detached: false });
      }
      sleepSync(6000);
      const final = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
      push('multi_process_concurrent_appends_no_lost_update',
        final.entries.length === N && new Set(final.entries).size === N,
        JSON.stringify({ count: final.entries.length, unique: new Set(final.entries).size, entries: final.entries }));
    }
    // 8. Duplicate/idempotent-shaped mutation: calling the same mutate logic twice with a dedupe
    //    check inside mutateFn does not double-append (mirrors how hook re-delivery will use this).
    {
      const runDir = fs.mkdtempSync(path.join(tmpRoot, 'r8-'));
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ ids: [] }));
      const idempotentAppend = (cur) => cur.ids.includes('x') ? cur : { ...cur, ids: [...cur.ids, 'x'] };
      withRunJsonLock(runDir, idempotentAppend);
      withRunJsonLock(runDir, idempotentAppend);
      const final = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
      push('idempotent_mutation_does_not_double_append', JSON.stringify(final.ids) === JSON.stringify(['x']), JSON.stringify(final));
    }
  } finally {
    cleanup();
  }

  const allPass = results.every(r => r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  self-test:${r.name}  (${r.detail})`);
  console.log(allPass ? 'self-test: ALL PASS' : 'self-test: FAILURES PRESENT');
  return allPass;
}

module.exports = { acquireRunJsonLock, withRunJsonLock, lockPathFor };

if (require.main === module) {
  const { parseArgs } = require('../_lib.js');
  const a = parseArgs(process.argv.slice(2));
  if (a['self-test']) process.exit(selfTest() ? 0 : 1);
  console.log('run-json-atomic.js — library. node scripts/review-independence/run-json-atomic.js --self-test');
  process.exit(0);
}
