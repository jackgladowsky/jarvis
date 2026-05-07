#!/usr/bin/env bash
# Pull, install, build, restart. Idempotent; safe to re-run.
#
# Fails LOUD before restarting — if the new code doesn't build, the running
# service keeps serving the old binary. The "seamlessness" of this flow is
# that you only ever restart with a binary that compiled cleanly.
#
# Open question #11 (DESIGN.md): when JARVIS itself runs this via the bash
# tool, it kills its own process at the systemctl restart. systemd brings
# it back. v1 accepts the brief silence; the "be right back" Telegram
# notice is Phase 7 polish.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Refuse to update on a dirty tree — local edits would either be clobbered
# (bad) or block the merge (confusing in this script's output). Stash or
# commit them first.
if ! git diff --quiet HEAD; then
  echo "Refusing to update: working tree has uncommitted changes." >&2
  echo "Stash or commit them first, then re-run." >&2
  exit 1
fi

OLD_REV="$(git rev-parse HEAD)"

echo "Fetching..."
git fetch origin

echo "Fast-forwarding to origin/main..."
# --ff-only refuses anything other than a clean fast-forward — surfaces
# branch divergence before we touch anything else.
git merge --ff-only origin/main

NEW_REV="$(git rev-parse HEAD)"
if [[ "$OLD_REV" == "$NEW_REV" ]]; then
  echo "Already up to date ($OLD_REV)."
  exit 0
fi

echo "Installing deps..."
pnpm install

echo "Building..."
# If this step fails, we exit before restarting — the running service keeps
# the old binary alive. set -e takes care of the abort.
pnpm run build

echo "Restarting jarvis..."
sudo systemctl restart jarvis

echo "Updated $OLD_REV → $NEW_REV."
