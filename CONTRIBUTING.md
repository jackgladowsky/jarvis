# Contributing

JARVIS is a small TypeScript service meant to be self-hosted on a trusted Linux machine. Contributions that keep it understandable, portable, and easy to operate are welcome.

## Development setup

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

For local runs, keep data out of the checkout:

```bash
JARVIS_DATA_DIR=$PWD/.jarvis-dev scripts/setup-host.sh
JARVIS_DATA_DIR=$PWD/.jarvis-dev node --env-file=$PWD/.jarvis-dev/.env dist/index.js
```

Do not commit secrets, host-local `~/.jarvis/` data, session logs, OAuth credentials, or real Telegram IDs.

## Style

- Prefer plain files and simple operational flows over databases/services until clearly needed.
- Keep repo-tracked docs and templates generic. Put host-specific facts in `~/.jarvis/AGENTS.md`.
- Keep the tool surface small. New tools need a strong reason.
- Update docs/templates when behavior or config changes.

## Pull requests

Include:

- What changed and why.
- Any setup or migration notes.
- Exact checks run and their results.

## Security/privacy

Please report security issues privately to the repository owner instead of opening a public issue with exploit details.
