# GitHub PRs

Use this skill when preparing, reviewing, pushing, or opening GitHub pull requests for JARVIS or the owner's repos.

## Defaults

- Work in the assigned repo/worktree, not a different checkout.
- Inspect `git status`, branch, and diff before making claims.
- Run appropriate checks before handoff.
- In the main session, do not push, merge, or deploy unless the owner explicitly asked or the task stage allows it.
- Background workers never push, merge, deploy, restart services, or edit the main checkout; main JARVIS is the gate after reviewer approval.

## Before opening a PR

1. Confirm the worktree is the intended one.
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

## Background-worker flow

- Reviewer marks `ready_for_pr` or `needs_fix`.
- Main JARVIS inspects the finished worktree before pushing/opening PR.
- Do not assume worker output is correct. That is how tiny fires become scheduled fires.
