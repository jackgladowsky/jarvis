# Background Workers

Use this skill for long-running work, code changes, PRs, research, multi-step ops, or anything likely to block the main Telegram chat for more than about 30 seconds.

## When to spawn

Main JARVIS should delegate when work:

- Needs multiple tool calls or extended research.
- Involves repo changes, PRs, reviews, or substantial ops.
- Can safely proceed asynchronously.

Stay inline only for quick answers, tiny edits, urgent checks/ops, or work needing continuous back-and-forth with Jack.

## Start a task

From `~/jarvis/`:

```bash
scripts/start-background-task.sh "<prompt>"
```

Jack can also use:

```text
/bg <prompt>
```

Tell Jack the task id, worktree, branch, and pipeline.

## Worker layout

Workers use:

- Git worktrees: `~/jarvis-worktrees/<task-id>`
- Task JSON: `~/.jarvis/data/background/tasks/<task-id>.json`
- Task note: `~/.jarvis/data/background/notes/<task-id>.md`
- Mailbox: `~/.jarvis/data/background/mail/<task-id>.jsonl`
- Session: `~/.jarvis/data/background/sessions/<task-id>.jsonl`
- Logs: `~/.jarvis/data/background/bootstrap.log`, `worker-errors.log`

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
scripts/resume-background-task.sh <task-id> [fixer|reviewer]
```

## Main JARVIS responsibilities

- Main JARVIS is the review gate.
- Inspect finished worktrees before pushing or opening PRs.
- Do not assume worker output is correct.
- Do not deploy worker changes unless Jack explicitly asks.

## Cleanup

Dry-run first:

```bash
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
  "prompt": "Run `cd ~/jarvis && scripts/cleanup-background-worktrees.sh --dry-run --age-days 14`, report what would be cleaned, identify stale todos/docs/notes, and do not delete ambiguous notes or data without Jack's approval."
}
```
