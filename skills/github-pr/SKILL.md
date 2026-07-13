# GitHub PRs

Use this skill when preparing, reviewing, pushing, or opening GitHub pull requests for JARVIS or the owner's repos.

## Defaults

- Work in the assigned repo/worktree, not a different checkout.
- Inspect `git status`, branch, and diff before making claims.
- Run appropriate checks before handoff.
- `main` is PR-only: never directly push it. Background workers never push, merge, deploy, restart services, or edit the main checkout; main JARVIS is the gate after reviewer approval.
- After review, main JARVIS may push a feature branch, open and watch its PR, fix a failing version gate, and enable auto-merge once all required checks are green. It deploys only the subsequently merged `main` SHA.

## Before opening a PR

1. Confirm the worktree is the intended one and targets `main` through a PR, never a direct `main` push.
2. Review `git diff --stat` and relevant diffs.
3. Run checks appropriate to the change:
   - Docs-only: `git diff --check`
   - TypeScript/code: `pnpm run typecheck`, `pnpm run build`, and tests as relevant.
4. Ensure no secrets, host-local data, or generated junk are staged.
5. Write a concise PR summary and test plan.

## Git commands

```bash
git status --short
git branch --show-current
git diff --stat
git diff --check
git add <files>
git commit -m "<message>"
git push -u origin <branch>
```

Open PR with GitHub CLI if available:

```bash
gh pr create --title "<title>" --body "<body>"
```

If `gh` is unavailable or unauthenticated, report that and provide the branch/summary.

## PR body shape

```markdown
## Summary

- <change>
- <change>

## Tests

- `<command>`
```

## Main-session PR flow

1. Reviewer marks `ready_for_pr`; main JARVIS inspects the finished worktree and runs appropriate checks.
2. Main JARVIS may commit/push the reviewed feature branch and open a PR targeting `main`.
3. Watch required checks. If `Version gate` fails, bump `package.json` to strict SemVer-greater than the PR base and update `CHANGELOG.md`, then push the fix to the PR branch.
4. Enable auto-merge only after every required check is green. Never merge or directly push `main` before that point.
5. After GitHub merges the PR, fast-forward local `main` to the exact remote merge result and run `pnpm deploy:self`; safe deploy never pushes `main`.

Do not assume worker output is correct. That is how tiny fires become scheduled fires.

## Durable CI watch (main JARVIS only)

Immediately **after** the branch push succeeds and `gh pr create` returns an open PR, record its exact head SHA and start the read-only durable watch:

```bash
HEAD_SHA="$(gh pr view <number> --repo <owner>/<repo> --json headRefOid --jq .headRefOid)"
pnpm pr:watch -- start --repo <owner>/<repo> --pr <number> --head "$HEAD_SHA" --chat-id <current-telegram-chat-id>
```

Do not start it before the push/open succeeds. It persists one current watch in `~/.jarvis/data/pr-ci-watch.json`, reconciles changed heads, and emits one internal event for a green exact SHA or a bounded red-check summary. Main JARVIS alone decides any later merge/deploy; the watcher only calls read-only `gh pr view`/`gh api` endpoints.
