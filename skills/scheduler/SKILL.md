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

Built-in recurring tasks may also be registered by source code. Built-in/config IDs are reserved: dynamic tasks cannot silently override them. Current built-in: `nightly-memory-review` at `30 2 * * *`, using `notify: on_issue`.

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

Recurring tasks use `schedule` with a cron expression. One-time tasks use `run_at` with an absolute timestamp including timezone/offset. Completed, failed, and cancelled one-time tasks are retained as durable history. Dynamic records include an IANA `timezone`, monotonic `revision`, and optional idempotency metadata.

`provider` + `model` are optional per-task model overrides; omit them to use the current global agent model. Use both fields together.

`notify` may be `always`, `on_issue`, or `never`.

## Managing tasks conversationally

Use the `scheduler_control` tool for normal owner requests; do not edit `tasks.json` directly. It creates, lists, updates, snoozes, and cancels dynamic tasks with file locking and immediate in-process reconciliation. Use a stable `idempotency_key` when retrying and pass the listed `revision` as `expected_revision` when changing a task.

Accepted one-time grammar is deliberately bounded: strict ISO with `Z`/offset, `in N minutes|hours|days`, `tomorrow at HH[:MM]`, or `[next] weekday at HH[:MM]`. Accepted recurrence grammar is validated five-field cron, `daily at`, `every weekday at`, `every <weekday> at`, `hourly`, or bounded `every N minutes|hours`. Times use the task's IANA timezone (default: scheduler timezone). Ask for clarification rather than guessing rejected or daylight-saving-ambiguous times.

Examples: “remind me tomorrow at 09:00 to call Sam”, “check backups every weekday at 08:30 and only notify on issues”, “snooze the Sam reminder for two hours”, and “cancel the backup check”.

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
