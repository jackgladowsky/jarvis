#!/bin/bash
# Install git hooks for the JARVIS repo.
# Run this after clone or when hooks are updated.

set -e
cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
echo "✅ Git hooks path set to .githooks/"
echo "   Pre-push hook: runs typecheck + lint before pushing"