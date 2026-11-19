#!/usr/bin/env node
// Kill switch helper. If DISABLED exists OR env HARNESSKIT_DISABLED=1,
// every workflow-affecting script/hook must exit 0 cleanly.
// Standalone CLI: `node is-disabled.js` exits 0 if disabled, 1 if active.
// Library: const { isDisabled } = require('./is-disabled.js')
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// HARNESS_ROOT seam (Batch 3-impl): overrides the root for a future generic location; unset →
// legacy <harness-root> (no behavior change). Kept INLINE (not imported from _lib.js) on
// purpose, so the kill switch stays a zero-dependency leaf and resolves even if other modules
// fail to load. Must stay byte-identical to _lib.js#harnessRoot.
function harnessRoot() {
  return process.env.HARNESS_ROOT || path.join(os.homedir(), '.harnesskit');
}

function isDisabled() {
  if (process.env.HARNESSKIT_DISABLED === '1') return { disabled: true, reason: 'env HARNESSKIT_DISABLED=1' };
  const flag = path.join(harnessRoot(), 'DISABLED');
  if (fs.existsSync(flag)) {
    let reason = 'DISABLED file present';
    try {
      const txt = fs.readFileSync(flag, 'utf8').trim();
      if (txt) reason = `DISABLED: ${txt.slice(0, 200)}`;
    } catch {}
    return { disabled: true, reason };
  }
  return { disabled: false, reason: null };
}

module.exports = { isDisabled, harnessRoot };

if (require.main === module) {
  const r = isDisabled();
  if (r.disabled) { console.log(r.reason); process.exit(0); }
  console.log('active'); process.exit(1);
}
