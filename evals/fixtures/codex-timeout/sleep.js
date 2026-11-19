// codex-timeout fixture: sleeps well past any test timeout so the wrapper must kill it. Never exits on time.
setTimeout(function () { process.exit(0); }, 10000);
