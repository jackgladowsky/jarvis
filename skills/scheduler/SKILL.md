# Scheduler

Use this skill for recurring scheduled tasks, one-time reminders, task notes, job sessions, and scheduler troubleshooting.

## Sources

Scheduler config lives in `~/.jarvis/config.yaml`:

```yaml
scheduler:
  enabled: true
  timezone: UTC
  telegram_chat_id: 123456789
  tasks: []
```

Dynamic tasks created from chat live in:

```text
~/.jarvis/data/jobs/tasks.json
```

The scheduler hot-reloads dynamic tasks roughly every 30 seconds.

Built-in recurring tasks may also be registered by source code. Config and dynamic tasks with the same `id` override built-ins. Current built-in: `nightly-memory-review` at `30 2 * * *`, using `notify: on_issue`.

## Dynamic task format

```json
{
  "tasks": [
    {
      "id": "short-slug",
      "name": "Human name",
      "schedule": "0 8 * * *",
      "notify": "always",
      "provider": "openrouter",
      "model": "google/gemini-2.5-flash",
      "prompt": "What the scheduled agent should do."
    },
    {
      "id": "one-time-reminder",
      "name": "One-time reminder",
      "run_at": "2026-05-11T14:30:00-04:00",
      "notify": "always",
      "prompt": "Remind the owner to do the thing."
    }
  ]
}
```

Recurring tasks use `schedule` with a cron expression. One-time tasks use `run_at` with an absolute timestamp including timezone/offset. After a one-time task runs, the scheduler removes it.

`provider` + `model` are optional per-task model overrides; omit them to use the current global agent model. Use both fields together.

`notify` may be `always`, `on_issue`, or `never`.

## Creating tasks from chat

- For recurring tasks, edit `~/.jarvis/data/jobs/tasks.json` directly with a valid cron expression.
- For one-time reminders, add a task with `run_at` instead of `schedule`.
- Use absolute timestamps with timezone/offset, e.g. `2026-05-11T14:30:00-04:00`.

## Per-task state

Each task has:

- Transcript: `~/.jarvis/data/jobs/sessions/<task-id>.jsonl`
- Note: `~/.jarvis/data/jobs/notes/<task-id>.md`
- Logs: `~/.jarvis/data/jobs/scheduler.log`

## Scheduled-task behavior

When running as a scheduled task:

1. Follow the task prompt.
2. Read the task note before doing substantive work.
3. Update the task note before finishing.
4. Keep the note concise: current status, latest run summary, durable observations, and next things to watch.

Task notes are for cross-run continuity, not prose archives.

## Troubleshooting

Useful commands:

```bash
tail -f ~/.jarvis/data/jobs/scheduler.log
jq . ~/.jarvis/data/jobs/tasks.json
journalctl -fu jarvis
```

### Context-window failures

If a scheduled task fails with `input exceeds the context window` / token-limit errors:

1. Inspect the log and session size:
   ```bash
   tail -n 120 ~/.jarvis/data/jobs/scheduler.log
   ls -lh ~/.jarvis/data/jobs/sessions/<task-id>.jsonl
   ```
2. Preserve debugging context but reset the next run by moving the oversized session:
   ```bash
   mkdir -p ~/.jarvis/data/jobs/sessions/archive
   mv ~/.jarvis/data/jobs/sessions/<task-id>.jsonl \
     ~/.jarvis/data/jobs/sessions/archive/<task-id>-context-overflow-$(date -u +%Y-%m-%dT%H-%M-%SZ).jsonl
   ```
3. Add a terse note in `~/.jarvis/data/jobs/notes/<task-id>.md` with the failure time, archive path, and whether a durable code fix is pending.

Task notes are the durable cross-run state; transcripts are safe to archive/reset when oversized.
