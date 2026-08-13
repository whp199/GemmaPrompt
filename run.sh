#!/usr/bin/env bash
# MikuPrompt launcher — stdlib Python only, nothing to install.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 server.py "$@"
