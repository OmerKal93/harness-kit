#!/bin/bash
# isolated-eval-run.sh — ORCH-4/R6. Companion shell script for isolated-eval-batch.js.
#
# Invoked by Node via execFileSync('bash', [thisScript, adapter, mode, cwd, outFile], { input: prompt }),
# NEVER via shell:true and NEVER with untrusted content in argv — the prompt arrives on stdin only.
# All of $1..$4 are developer-controlled strings constructed by isolated-eval-batch.js, never
# diff/model-generated text. This mirrors runs/20260705-*/run_one.sh's proven isolation shape
# (fresh dir, unique output path, foreground, no session persistence) but generalized across adapters.
#
# Usage: isolated-eval-run.sh <adapter: claude-code|codex-cli> <mode: review|implement> <cwd> <outFile>
# Stdin: the prompt text.
set -u
ADAPTER="$1"
MODE="$2"
CWD="$3"
OUTFILE="$4"

cd "$CWD" || { echo '{"ok":false,"error":"cwd_not_found"}'; exit 1; }
PROMPT="$(cat -)"

case "$ADAPTER" in
  claude-code)
    # --no-session-persistence + fresh cwd = isolation; --output-format json for structured capture.
    echo "$PROMPT" | claude -p --output-format json --no-session-persistence > "$OUTFILE.raw" 2> "$OUTFILE.stderr"
    ;;
  codex-cli)
    SANDBOX="read-only"
    [ "$MODE" = "implement" ] && SANDBOX="workspace-write"
    printf '%s' "$PROMPT" | codex exec --sandbox "$SANDBOX" --skip-git-repo-check -C "$CWD" \
      --output-last-message "$OUTFILE.codexmsg" - > "$OUTFILE.raw" 2> "$OUTFILE.stderr"
    ;;
  *)
    echo '{"ok":false,"error":"unknown_adapter"}'
    exit 1
    ;;
esac
EXIT_CODE=$?
echo "$EXIT_CODE" > "$OUTFILE.exitcode"
exit 0
