# Background Workers

Use this skill for long-running work, code changes, PRs, research, multi-step ops, or anything likely to block the main Telegram chat for more than about 30 seconds.

## When to spawn

Main JARVIS should delegate when work:

- Needs multiple tool calls or extended research.
- Involves repo changes, PRs, reviews, or substantial ops.
- Can safely proceed asynchronously.

Stay inline only for quick answers, tiny edits, urgent checks/ops, or work needing continuous back-and-forth with the owner.

## Start a task

From the active JARVIS source root:

```bash
cd "$JARVIS_SOURCE_ROOT"
scripts/start-background-task.sh --chat-id <current-telegram-chat-id> "<prompt>"
```

The current chat ID is provided in main JARVIS's runtime transport context.
Never substitute the scheduler notification chat implicitly.

The owner can also use:

```text
/bg <prompt>
```

Tell the owner the task id, worktree, branch, and pipeline.

## Worker layout

Workers use:

- Git worktrees: `$HOME/jarvis-worktrees/<task-id>`
- Task JSON: `$JARVIS_DATA_DIR/data/background/tasks/<task-id>.json`
- Task note: `$JARVIS_DATA_DIR/data/background/notes/<task-id>.md`
- Mailbox: `$JARVIS_DATA_DIR/data/background/mail/<task-id>.jsonl`
- Session: `$JARVIS_DATA_DIR/data/background/sessions/<task-id>.jsonl`
- Logs: `$JARVIS_DATA_DIR/data/background/bootstrap.log`, `worker-errors.log`

Common pipelines:

- `implementer -> reviewer`
- `researcher -> reviewer`
- `researcher -> implementer -> reviewer`

Reviewers do not edit files. They mark work `ready_for_pr` or `needs_fix`.

## Commands

Telegram commands:

```text
/tasks                list recent background tasks
/task <id>            show task status and recent mailbox entries
/answer <id> <text>   answer a worker question and resume it
/fixbg <id> [role]    resume a needs-fix task on the same worktree
/cancelbg <id>        cancel a background worker task
```

Shell entrypoints:

```bash
cd "$JARVIS_SOURCE_ROOT"
scripts/resume-background-task.sh <task-id> [fixer|reviewer]
```

## Main JARVIS responsibilities

- Main JARVIS is the review and publication gate.
- Inspect finished worktrees before integrating or opening PRs.
- Do not assume worker output is correct.
- Background workers never push, merge, deploy, restart services, or edit the main checkout, even if the original request asks for it. They hand reviewed changes to main JARVIS.
- After integration on clean local `main`, main JARVIS may publish and activate the exact commit with `pnpm deploy:self`.

## Cleanup

Dry-run first:

```bash
cd "$JARVIS_SOURCE_ROOT"
scripts/cleanup-background-worktrees.sh --dry-run
scripts/cleanup-background-worktrees.sh --apply --age-days 14
```

The cleanup script removes only old terminal task worktrees (`ready_for_pr`, `cancelled`, `failed`, `done`) and preserves task JSON, notes, mail, sessions, and logs. It skips dirty worktrees unless `--force-dirty` is set. Branch deletion is opt-in with `--delete-branches`.

Suggested weekly scheduled janitor task:

```json
{
  "id": "weekly-janitor",
  "name": "Weekly Janitor",
  "schedule": "0 9 * * 1",
  "notify": "always",
  "prompt": "Run `cd \"$JARVIS_SOURCE_ROOT\" && scripts/cleanup-background-worktrees.sh --dry-run --age-days 14`, report what would be cleaned, identify stale todos/docs/notes, and do not delete ambiguous notes or data without the owner's approval."
}
```
