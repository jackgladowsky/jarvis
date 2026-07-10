# Future `/goal` command design

A `/goal` command could let the owner ask JARVIS to pursue a bounded improvement objective without creating an unsafe infinite loop.

## Proposed shape

```text
/goal <objective>
```

The transport would create a background task with an explicit goal contract:

- objective text
- success criteria
- max wall-clock duration
- max worker turns
- max tool calls or budget hint
- allowed repos/paths
- disallowed actions
- review requirement before push/deploy/destructive changes

The background pipeline should be finite, for example:

```text
researcher -> implementer -> reviewer
```

or, for non-code goals:

```text
researcher -> reviewer
```

## Safety constraints

- No self-rescheduling by default.
- No unbounded loops like "keep improving yourself forever."
- Goal children never push, merge, deploy, restart services, or edit the main checkout. No original-command or mailbox exception can override this boundary; reviewed changes return to main JARVIS.
- Credential changes and destructive filesystem actions require explicit owner approval in the task mailbox.
- Any ambiguity that affects product/security/destructive behavior goes to the task mailbox and pauses as `waiting_on_main`.
- Reviewer is a gate, not a rubber stamp. It can mark `needs_fix`, `ready_for_pr`, or `blocked`.

## Minimal implementation plan

1. Add a `/goal` Telegram command that parses the objective and optional flags like `--hours`, `--turns`, `--repo`, and `--no-code`.
2. Store the goal contract in the background task JSON.
3. Teach worker prompt construction to include the contract and hard caps.
4. Add watchdog logic that stops a task when caps are exceeded and marks it `awaiting_review` or `blocked` with a note.
5. Add tests for parsing, cap enforcement, and mailbox waiting behavior.

## Recommendation

Do not implement autonomous recurring improvement yet. Ship `/goal` as syntactic sugar over finite background tasks first; then observe failure modes before adding any scheduler integration.
