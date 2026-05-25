#!/usr/bin/env bash
# Clean old JARVIS background-worker git worktrees safely.
#
# Default mode is dry-run. Use --apply to remove eligible clean worktrees.
# Task JSON, notes, mail, and session logs are never removed by this script.

set -euo pipefail

DEFAULT_REPO="$HOME/jarvis"
DEFAULT_DATA_DIR="${JARVIS_DATA_DIR:-$HOME/.jarvis}/data/background"
DEFAULT_WORKTREES_DIR="$HOME/jarvis-worktrees"

repo="$DEFAULT_REPO"
data_dir="$DEFAULT_DATA_DIR"
worktrees_dir="$DEFAULT_WORKTREES_DIR"
age_days=14
apply=0
force_dirty=0
include_orphans=0
delete_branches=0
force_branches=0

terminal_statuses=(ready_for_pr cancelled failed done)

usage() {
  cat <<'EOF'
Usage: scripts/cleanup-background-worktrees.sh [options]

Safely clean old terminal JARVIS background-worker worktrees.
Dry-run is the default; no files or branches are removed unless --apply is set.

Options:
  --dry-run                 Print actions only (default).
  --apply                   Actually remove eligible worktrees and prune metadata.
  --age-days N              Minimum terminal task age in days (default: 14).
  --repo PATH               Main git repository (default: ~/jarvis).
  --data-dir PATH           Background data dir (default: ${JARVIS_DATA_DIR:-~/.jarvis}/data/background).
  --worktrees-dir PATH      Background worktrees dir (default: ~/jarvis-worktrees).
  --include-orphans         Also remove clean orphan directories in --worktrees-dir older than --age-days.
  --force-dirty             Allow removing dirty worktrees/orphans. Dangerous; still requires --apply.
  --delete-branches         After removing a worktree, delete its local branch only if merged into repo HEAD.
  --force-branches          With --delete-branches, use git branch -D for unmerged worker/* branches.
  -h, --help                Show this help.

Terminal statuses: ready_for_pr, cancelled, failed, done.
Kept by design: task JSON, notes, mail, sessions/logs.
EOF
}

log() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
fatal() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) apply=0 ;;
    --apply) apply=1 ;;
    --age-days)
      [[ $# -ge 2 ]] || fatal "--age-days requires a value"
      age_days="$2"; shift
      [[ "$age_days" =~ ^[0-9]+$ ]] || fatal "--age-days must be a non-negative integer"
      ;;
    --repo)
      [[ $# -ge 2 ]] || fatal "--repo requires a path"
      repo="$2"; shift
      ;;
    --data-dir)
      [[ $# -ge 2 ]] || fatal "--data-dir requires a path"
      data_dir="$2"; shift
      ;;
    --worktrees-dir)
      [[ $# -ge 2 ]] || fatal "--worktrees-dir requires a path"
      worktrees_dir="$2"; shift
      ;;
    --include-orphans) include_orphans=1 ;;
    --force-dirty) force_dirty=1 ;;
    --delete-branches) delete_branches=1 ;;
    --force-branches) force_branches=1; delete_branches=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fatal "unknown option: $1" ;;
  esac
  shift
done

[[ -d "$repo/.git" || -f "$repo/.git" ]] || fatal "repo is not a git checkout: $repo"
[[ -d "$data_dir/tasks" ]] || fatal "background task dir not found: $data_dir/tasks"
[[ -d "$worktrees_dir" ]] || warn "worktrees dir not found: $worktrees_dir"

cutoff_epoch=$(( $(date +%s) - age_days * 86400 ))
removed_worktrees=0
removed_branches=0
skipped_dirty=0
skipped_young=0
skipped_status=0
skipped_missing=0
orphan_count=0

is_terminal_status() {
  local status="$1"
  local terminal
  for terminal in "${terminal_statuses[@]}"; do
    [[ "$status" == "$terminal" ]] && return 0
  done
  return 1
}

json_field() {
  local file="$1"
  local field="$2"
  python3 - "$file" "$field" <<'PY'
import json, sys
path, field = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    value = data.get(field, "")
    if value is None:
        value = ""
    print(value)
except Exception:
    print("")
PY
}

to_epoch() {
  local value="$1"
  [[ -n "$value" ]] || return 1
  date -d "$value" +%s 2>/dev/null || return 1
}

path_within_dir() {
  local path="$1"
  local dir="$2"
  python3 - "$path" "$dir" <<'PY'
import os, sys
path = os.path.realpath(sys.argv[1])
dir_ = os.path.realpath(sys.argv[2])
try:
    print("yes" if os.path.commonpath([path, dir_]) == dir_ else "no")
except ValueError:
    print("no")
PY
}

is_dirty_worktree() {
  local wt="$1"
  [[ -d "$wt" ]] || return 1
  if git -C "$wt" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    [[ -n "$(git -C "$wt" status --porcelain --untracked-files=all)" ]]
  else
    # Non-git orphan directory: treat any content as dirty/ambiguous.
    find "$wt" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
  fi
}

remove_worktree() {
  local wt="$1"
  if [[ "$apply" -eq 1 ]]; then
    if [[ "$force_dirty" -eq 1 ]]; then
      git -C "$repo" worktree remove --force "$wt"
    else
      git -C "$repo" worktree remove "$wt"
    fi
  else
    if [[ "$force_dirty" -eq 1 ]]; then
      log "DRY-RUN: git -C '$repo' worktree remove --force '$wt'"
    else
      log "DRY-RUN: git -C '$repo' worktree remove '$wt'"
    fi
  fi
}

is_registered_worktree() {
  local wt_real
  wt_real=$(realpath -m "$1")
  while IFS= read -r git_wt; do
    [[ -n "$git_wt" ]] || continue
    [[ "$(realpath -m "$git_wt")" == "$wt_real" ]] && return 0
  done < <(git -C "$repo" worktree list --porcelain | awk '/^worktree / { sub(/^worktree /, ""); print }')
  return 1
}

remove_orphan_dir() {
  local wt="$1"
  if [[ "$(path_within_dir "$wt" "$worktrees_dir")" != "yes" ]]; then
    fatal "refusing to remove orphan outside worktrees dir: $wt"
  fi
  if is_registered_worktree "$wt"; then
    remove_worktree "$wt"
  elif [[ "$apply" -eq 1 ]]; then
    rm -rf -- "$wt"
  else
    log "DRY-RUN: rm -rf -- '$wt'"
  fi
}

delete_branch_if_safe() {
  local branch="$1"
  [[ "$delete_branches" -eq 1 ]] || return 0
  [[ -n "$branch" ]] || return 0
  if [[ ! "$branch" =~ ^worker/[A-Za-z0-9._-]+$ && "$force_branches" -ne 1 ]]; then
    warn "skip branch deletion for non-worker branch: $branch"
    return 0
  fi
  if ! git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    log "branch already absent: $branch"
    return 0
  fi

  local mode="-d"
  if git -C "$repo" merge-base --is-ancestor "$branch" HEAD; then
    mode="-d"
  elif [[ "$force_branches" -eq 1 ]]; then
    mode="-D"
  else
    warn "skip unmerged branch: $branch (use --force-branches to delete)"
    return 0
  fi

  if [[ "$apply" -eq 1 ]]; then
    git -C "$repo" branch "$mode" "$branch"
  else
    log "DRY-RUN: git -C '$repo' branch $mode '$branch'"
  fi
  removed_branches=$((removed_branches + 1))
}

# Track paths referenced by task JSON so filesystem-orphan detection is deterministic.
referenced_paths_file=$(mktemp)
trap 'rm -f "$referenced_paths_file"' EXIT

log "Mode: $([[ "$apply" -eq 1 ]] && echo apply || echo dry-run)"
log "Repo: $repo"
log "Background data: $data_dir"
log "Worktrees dir: $worktrees_dir"
log "Age threshold: $age_days days"
log ""

shopt -s nullglob
for task_json in "$data_dir"/tasks/*.json; do
  id=$(json_field "$task_json" id)
  status=$(json_field "$task_json" status)
  wt=$(json_field "$task_json" worktree)
  branch=$(json_field "$task_json" branch)
  finished_at=$(json_field "$task_json" finished_at)
  updated_at=$(json_field "$task_json" updated_at)

  [[ -n "$wt" ]] && printf '%s\n' "$(realpath -m "$wt")" >> "$referenced_paths_file"

  if [[ -z "$id" || -z "$status" || -z "$wt" ]]; then
    warn "skip malformed task JSON: $task_json"
    continue
  fi
  if ! is_terminal_status "$status"; then
    skipped_status=$((skipped_status + 1))
    log "keep active/non-terminal task $id ($status): $wt"
    continue
  fi

  age_source="$finished_at"
  [[ -n "$age_source" ]] || age_source="$updated_at"
  if task_epoch=$(to_epoch "$age_source"); then
    :
  else
    task_epoch=$(stat -c %Y "$task_json")
  fi
  if (( task_epoch > cutoff_epoch )); then
    skipped_young=$((skipped_young + 1))
    log "keep young terminal task $id ($status): $wt"
    continue
  fi

  if [[ "$(path_within_dir "$wt" "$worktrees_dir")" != "yes" ]]; then
    warn "skip task $id worktree outside worktrees dir: $wt"
    continue
  fi
  if [[ ! -e "$wt" ]]; then
    skipped_missing=$((skipped_missing + 1))
    log "missing worktree for terminal task $id ($status): $wt"
    delete_branch_if_safe "$branch"
    continue
  fi

  if is_dirty_worktree "$wt" && [[ "$force_dirty" -ne 1 ]]; then
    skipped_dirty=$((skipped_dirty + 1))
    warn "skip dirty terminal worktree $id ($status): $wt"
    continue
  fi

  log "remove terminal worktree $id ($status): $wt"
  remove_worktree "$wt"
  removed_worktrees=$((removed_worktrees + 1))
  delete_branch_if_safe "$branch"
done

# Detect stale git worktree metadata. Actual metadata removal is handled by git worktree prune.
log ""
log "Git worktree metadata check:"
while IFS= read -r git_wt; do
  [[ -n "$git_wt" ]] || continue
  if [[ ! -e "$git_wt" ]]; then
    log "stale metadata path: $git_wt"
  fi
done < <(git -C "$repo" worktree list --porcelain | awk '/^worktree / { sub(/^worktree /, ""); print }')

if [[ "$apply" -eq 1 ]]; then
  git -C "$repo" worktree prune
else
  log "DRY-RUN: git -C '$repo' worktree prune"
fi

# Detect filesystem orphans under the standard background worktrees directory.
log ""
log "Filesystem orphan check:"
if [[ -d "$worktrees_dir" ]]; then
  for wt in "$worktrees_dir"/*; do
    [[ -d "$wt" ]] || continue
    wt_real=$(realpath -m "$wt")
    if grep -Fxq "$wt_real" "$referenced_paths_file"; then
      continue
    fi
    orphan_count=$((orphan_count + 1))
    wt_epoch=$(stat -c %Y "$wt")
    if (( wt_epoch > cutoff_epoch )); then
      log "orphan is young; keep: $wt"
      continue
    fi
    if [[ "$include_orphans" -ne 1 ]]; then
      log "orphan detected; keep unless --include-orphans: $wt"
      continue
    fi
    if is_dirty_worktree "$wt" && [[ "$force_dirty" -ne 1 ]]; then
      skipped_dirty=$((skipped_dirty + 1))
      warn "skip dirty/ambiguous orphan: $wt"
      continue
    fi
    log "remove orphan worktree dir: $wt"
    remove_orphan_dir "$wt"
    removed_worktrees=$((removed_worktrees + 1))
  done
fi

log ""
log "Summary:"
log "  removed worktrees: $removed_worktrees$([[ "$apply" -eq 1 ]] || echo ' planned')"
log "  removed branches: $removed_branches$([[ "$apply" -eq 1 ]] || echo ' planned')"
log "  orphan dirs detected: $orphan_count"
log "  skipped active/non-terminal: $skipped_status"
log "  skipped young terminal: $skipped_young"
log "  skipped missing worktrees: $skipped_missing"
log "  skipped dirty/ambiguous: $skipped_dirty"
log "  task JSON/notes/mail/sessions/logs: kept"
