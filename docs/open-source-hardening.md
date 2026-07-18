# Open-source hardening backlog

This PR-sized slice makes the repo installable and reviewable as an MIT project, but a few items should stay explicit before calling it fully public-polished.

## Done in this slice

- Added MIT `LICENSE` and package license metadata.
- Added lint, format, coverage, and aggregate check scripts.
- Expanded CI to run format, lint, typecheck, and coverage on supported Node 22 and 24 releases.
- Generalized first-run templates and public README onboarding.
- Added `scripts/install.sh`, an interactive curl-friendly installer.
- Generalized hard-coded default background-worker repo path to `$HOME/jarvis`.
- Added exact-model context preflight, bounded streamed reads, and a context-aware backstop for every tool result.
- Made compaction checkpoints append-only with canonical source references and legacy transcript compatibility.
- Added a correlated, bounded, secret-safe lifecycle trace for runs, model attempts, tools, persistence, recovery, and Telegram delivery.

## Still worth doing

- Finish sweeping historical `DESIGN.md` and skill examples for owner-specific language. Some examples intentionally still describe the original deployment; decide whether to rewrite it as a generic design doc or move personal history to private notes.
- Replace placeholder curl URL and clone URL after the public GitHub repo location is final.
- Add installer tests using a temp `$HOME`, mocked `sudo`, and a local bare git repo.
- Add a minimum coverage threshold once the current baseline is accepted.
- Add shell linting (`shellcheck`) for scripts and fix any portability issues.
- Add contribution docs (`CONTRIBUTING.md`, issue templates, security policy) before inviting outside contributors.
- Consider publishing a sanitized default skill pack separate from the owner's live operating style.

## Non-goals for now

- Do not migrate host-local data into the repo.
- Do not make setup overwrite existing `~/.jarvis` files.
- Do not add autonomous self-improvement loops without explicit bounded controls.
- Do not restrict normal trusted host operations with a broad sandbox. Untrusted web code should use the future opt-in disposable lab described in `docs/untrusted-code-lab.md`.
