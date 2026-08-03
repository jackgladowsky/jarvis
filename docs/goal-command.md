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

Each child uses one finite background worker. Its system prompt requires an adaptive investigate, plan, execute, verify, and handoff workflow rather than spawning role pipelines.

## Safety constraints

- No self-rescheduling by default.
- No unbounded loops like "keep improving yourself forever."
- Goal children never push, merge, deploy, restart services, or edit the main checkout. No original-command or mailbox exception can override this boundary; committed changes return to main JARVIS for publication.
- Credential changes and destructive filesystem actions require explicit owner approval in the task mailbox.
- Any ambiguity that affects product/security/destructive behavior goes to the task mailbox and pauses as `waiting_on_main`.
- A child with committed changes can mark `ready_for_pr`; main JARVIS remains the publication and CI gate.

## Minimal implementation plan

1. Add a `/goal` Telegram command that parses the objective and optional flags like `--hours`, `--turns`, `--repo`, and `--no-code`.
2. Store the goal contract in the background task JSON.
3. Teach worker prompt construction to include the contract and hard caps.
4. Add watchdog logic that stops a task when caps are exceeded and marks it `waiting_on_main` or `failed` with a note.
5. Add tests for parsing, cap enforcement, and mailbox waiting behavior.

## Recommendation

Do not implement autonomous recurring improvement yet. Ship `/goal` as syntactic sugar over finite background tasks first; then observe failure modes before adding any scheduler integration.
