// codex-timeout fixture: exits 0 but prints content with no VERDICT token. The timeout/retry wrapper is
// content-agnostic (judging output is codex_verdict_parser's job) → outcome is 'success' here.
process.stdout.write('<<< no VERDICT token in this output >>>\n');
process.exit(0);
