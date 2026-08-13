#!/usr/bin/env bash
# Stop any running GemmaPrompt and start a fresh one in the background.
# Uses a pidfile so it never has to guess from process names.
set -uo pipefail
cd "$(dirname "$0")"

PIDFILE=".gemma.pid"
LOG="${GEMMA_LOG:-/tmp/gemmaprompt.log}"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill "$(cat "$PIDFILE")" && sleep 1
fi
rm -f "$PIDFILE"

nohup python3 server.py "$@" > "$LOG" 2>&1 &
echo $! > "$PIDFILE"
disown

sleep 3
if curl -fsS --max-time 4 http://127.0.0.1:3939/api/health > /dev/null 2>&1; then
  echo "GemmaPrompt up on http://127.0.0.1:3939  (pid $(cat "$PIDFILE"), log $LOG)"
else
  echo "failed to start — log follows:" >&2
  cat "$LOG" >&2
  exit 1
fi
