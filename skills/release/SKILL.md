# Releases

Use this skill when cutting a release of JARVIS — bumping `package.json`, updating `CHANGELOG.md`, and opening the PR. Releases are **manual**; release-please is gone.

## When to bump

Per [semver.org](https://semver.org/) (verbatim):

> Given a version number MAJOR.MINOR.PATCH, increment the:
>
> **MAJOR** version when you make incompatible API changes
> **MINOR** version when you add functionality in a backward compatible manner
> **PATCH** version when you make backward compatible bug fixes

Quick heuristics for JARVIS:

| Change                                                                                                                  | Bump    |
| ----------------------------------------------------------------------------------------------------------------------- | ------- |
| Bug fix, refactor, docs, internal cleanup, deps                                                                         | `patch` |
| New Telegram command, new skill, new feature, new env knob                                                              | `minor` |
| Breaking CLI flag rename, removed config key, schema-incompatible changes to scheduler/skills layout, Node version bump | `major` |

If in doubt, ask the owner. When unsure, `patch` is the safe default — it's always easy to add another.

Pre-release labels (`-rc.1`, `-beta.2`) and build metadata (`+sha.abc`) are allowed by the semver regex in `scripts/bump-version.mjs` and `src/lib/version.ts`; use `--set=` for those (the bump subcommand can't construct them).

## Workflow

1. **Decide the bump type** from the diff scope (see table above).
2. **Make sure the working tree is clean** (`git status --short`) — the version bump should be its own commit.
3. **Run the orchestrator**:
   ```bash
   node skills/release/scripts/release.mjs patch --message="fix: foo no longer crashes on empty input"
   # or
   node skills/release/scripts/release.mjs minor --message-file=notes.md
   # or for an explicit version (pre-release, build meta, etc.)
   node skills/release/scripts/release.mjs --set=0.2.0-rc.1 --message="release candidate"
   ```
   This:
   - bumps `package.json` via `scripts/bump-version.mjs`
   - prepends a new `## <version>` section to `CHANGELOG.md` in the existing format
   - leaves a `- _Describe changes_` placeholder if no `--message` was given (and warns about it)
   - prints the new version + a suggested commit message
4. **Review the diff**:
   ```bash
   git diff --stat
   git diff -- CHANGELOG.md package.json
   ```
   If the placeholder was used, edit `CHANGELOG.md` now to describe the change.
5. **Run checks**:
   ```bash
   pnpm run check
   ```
6. **Commit** (version bump + CHANGELOG together — never split):
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore(release): v<version>"
   ```
7. **Push + open PR** via the `github-pr` skill, **after owner approval**. PR body should mention the version and link the CHANGELOG entry.
8. **Tagging + publishing** is separate. After the PR merges, the owner decides whether to tag (`git tag v<version>`) and push the tag.

## Notes

- `scripts/bump-version.mjs` is the single source of truth for version arithmetic. Don't edit `package.json`'s `version` field by hand.
- The runtime version reader (`src/lib/version.ts`) reads only from `package.json`. There is no other version file to keep in sync.
- Never edit a section under `## <version>` in `CHANGELOG.md` after it's been released — release a new version instead.
- For multi-line changelog entries, use `--message-file` or use `\n` in `--message`; the script splits on newlines and prefixes each with `- `.
- The script is idempotent only in the "you haven't committed yet" sense: re-running with `--set=<same>` is fine, but re-running with `patch` after a successful bump will increment again.

## Files in this skill

- `SKILL.md` — this file
- `scripts/release.mjs` — the orchestrator
