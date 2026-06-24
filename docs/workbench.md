# Browser workbench

JARVIS has an initial local-only Playwright browser workbench. This first slice is deliberately read-only: it can open a public `http(s)` URL, inspect title/visible text, and save screenshot/artifact files. It does not click, type, submit forms, log in, bypass CAPTCHA, purchase, book, send, post, delete, cancel, or change accounts.

## Runtime data

All browser state is host-local and outside git under `~/.jarvis/data/workbench/`:

```text
profile/       persistent Chromium profile
downloads/     Playwright download target
screenshots/   PNG screenshots per run
artifacts/     JSON page snapshots per run
```

Do not put credentials, secrets, 2FA codes, or private account data in repo docs, prompts, logs, or workflow notes. Future login/2FA/CAPTCHA flows must stop and ask Jack to complete the step or use a human-takeover channel; CAPTCHA bypass is explicitly out of scope.

## Smoke test

Install the Chromium browser binary if needed:

```bash
pnpm exec playwright install chromium
```

Then run a benign dry-run smoke test:

```bash
pnpm run workbench:smoke -- https://example.com
```

The command builds the TypeScript project, opens the URL in headless Chromium, and prints the title, clipped visible text, screenshot path, and JSON artifact path.

## Safety gates

The `browser_workbench` agent tool is natural-language accessible but read-only. It includes a hard approval classifier for requests involving purchases/orders, rides/bookings, sends/posts, deletes/cancels, account changes, financial/legal/medical actions, and similar side effects. Those requests must be approved by Jack before any future side-effect-capable browser action is added or used.

Local/private network targets are blocked by URL validation in this first slice. noVNC/KasmVNC-style human takeover and Docker Compose packaging are future iterations, not implemented here.
