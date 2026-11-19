#!/usr/bin/env node
// index.js — barrel export for all 6 security-broker wrappers + the provenance-token primitive.
// Convenience only: every function here is a thin re-export from this directory's own modules,
// nothing new is defined in this file. Consumers may require the specific broker module directly
// (e.g. require('./security-brokers/commit-broker.js')) or this barrel -- both resolve to the
// same functions.
//
// CLI: node scripts/security-brokers/index.js --self-test  runs every sub-module's self-test in
// sequence and reports one combined pass/fail (a convenience aggregate; each module remains
// independently runnable and independently correct).
'use strict';

const { scanBeforeIngestion } = require('./ingestion-broker.js');
const { scanBeforeContextTransfer } = require('./context-transfer-broker.js');
const { scanAfterToolOutput } = require('./tool-output-broker.js');
const { scanBeforeEvidencePersist } = require('./evidence-persist-broker.js');
const { scanBeforeCommit } = require('./commit-broker.js');
const { scanBeforeRemoteAction } = require('./remote-action-broker.js');
const { mintToken, verifyToken, contentHash } = require('./provenance-token.js');

module.exports = {
  scanBeforeIngestion,
  scanBeforeContextTransfer,
  scanAfterToolOutput,
  scanBeforeEvidencePersist,
  scanBeforeCommit,
  scanBeforeRemoteAction,
  mintToken,
  verifyToken,
  contentHash
};

function selfTest() {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const modules = [
    'provenance-token.js', 'commit-broker.js', 'tool-output-broker.js',
    'ingestion-broker.js', 'context-transfer-broker.js', 'evidence-persist-broker.js', 'remote-action-broker.js'
  ];
  let allPass = true;
  for (const m of modules) {
    const modPath = path.join(__dirname, m);
    try {
      const out = execFileSync(process.execPath, [modPath, '--self-test'], { encoding: 'utf8', env: process.env });
      process.stdout.write(out);
    } catch (e) {
      allPass = false;
      process.stdout.write(String((e && e.stdout) || '') + String((e && e.stderr) || ''));
      console.log(`FAIL  ${m}  exited non-zero`);
    }
  }
  console.log(allPass ? 'security-brokers/index.js self-test: ALL MODULES PASS' : 'security-brokers/index.js self-test: FAILURES PRESENT');
  return allPass;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.log('security-brokers/index.js — barrel library. node scripts/security-brokers/index.js --self-test');
  process.exit(0);
}
