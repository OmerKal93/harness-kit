// codex-timeout fixture: non-zero exit (3). Hard fail, no retry, never PASS.
process.stdout.write('boom\n');
process.exit(3);
