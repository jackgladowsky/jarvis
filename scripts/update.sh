#!/usr/bin/env bash
# Backwards-compatible alias for the safe deploy flow.
#
# The old implementation restarted JARVIS synchronously, which killed any chat
# response that launched it. Keep this entrypoint for muscle memory, but route
# through safe-deploy.sh so restarts are delayed and announced.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$REPO_ROOT/scripts/safe-deploy.sh" "$@"
