# Browser workbench

JARVIS has a local-only Playwright browser workbench. It can open a public `http(s)` URL, inspect title/visible text, save screenshot/artifact files, and run small validated step plans with benign `click`, `type`, and `fill` actions.

It does **not** automate credentials, login, 2FA, CAPTCHA, submits, downloads, purchases/orders, bookings/rides, sends/posts/messages, deletes/cancels, account changes, or financial/legal/medical actions. Those are blocked unless the tool receives an explicit approval object where applicable, and real purchasing/rides/etc. are still not implemented.

## Runtime data

All browser state is host-local and outside git under `~/.jarvis/data/workbench/`:

```text
profile/       persistent Chromium profile
downloads/     Playwright download target
screenshots/   PNG screenshots per run
artifacts/     JSON page snapshots per run
```

Do not put credentials, secrets, 2FA codes, private account data, or payment details in repo docs, prompts, logs, or workflow notes. Login/2FA/CAPTCHA flows stop with human handoff; CAPTCHA bypass is explicitly out of scope.

## Agent tool shape

The `browser_workbench` tool supports:

```json
{ "action": "open_url", "url": "https://example.com", "request": "Open example.com" }
```

and small step plans:

```json
{
  "action": "run_steps",
  "request": "Open a docs page, click a benign link, and type sample text into search.",
  "steps": [
    { "action": "open_url", "url": "https://example.com" },
    { "action": "click", "text": "More information" },
    { "action": "fill", "selector": "input[name=q]", "value": "non-secret sample text" }
  ]
}
```

Outputs are clipped text plus artifact paths, not screenshot bytes or base64 blobs.

## Click/type boundaries

Allowed without special approval:

- `open_url` for public `http(s)` URLs only.
- `click` on benign links/buttons for navigation or page expansion.
- `type`/`fill` with non-secret sample text into generic text/search/email/url/tel/textarea/contenteditable fields.

Blocked/handoff:

- Local/private network URLs and non-HTTP schemes.
- Password, OTP/2FA, CAPTCHA, API key/token/secret, credit-card/CVV/SSN/payment-like fields.
- Login/sign-in pages or requests.
- Submit/send/post/publish/buy/purchase/checkout/pay/place-order/book/reserve/confirm/delete/cancel/account-update/transfer-like targets unless an explicit approval object is supplied; real purchase/ride/order execution is not implemented.
- `submit` and `download` actions are not implemented.

## Smoke test

Install the Chromium browser binary if needed:

```bash
pnpm exec playwright install chromium
```

Then run a deterministic local-fixture smoke test for benign click + fill:

```bash
pnpm run workbench:smoke
```

Or run the legacy public URL open smoke:

```bash
pnpm run workbench:smoke -- https://example.com
```

The command builds the TypeScript project, opens Chromium headlessly, and prints the title, clipped visible text, step summaries, screenshot path, and JSON artifact path.

## Safety gates

Safety checks run before the plan and after each browser action. The tool detects approval-required requests involving purchases/orders, rides/bookings, sends/posts, deletes/cancels, account changes, financial/legal/medical actions, and similar side effects. It detects credential/login/2FA/CAPTCHA-like requests or pages and stops with a human-handoff error.

noVNC/KasmVNC-style human takeover and Docker Compose packaging are future iterations, not implemented here.
