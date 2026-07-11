# Browser workbench

JARVIS has a local-only Playwright browser workbench. It opens public `http(s)` pages, inspects visible content, saves screenshots/artifacts, and can run small guarded `click`, `type`, `fill`, and `submit` plans.

## Owner authority

Reading, benign navigation, and non-secret text entry do not need approval. Submit and side-effect-like actions use an owner-authenticated capability:

1. The tool records a hash of the exact normalized action plan and sends Telegram **Approve once** / **Deny** buttons.
2. Only the allowlisted Telegram user in the originating chat can decide it.
3. Approval expires after ten minutes and is valid for exactly that plan.
4. JARVIS supplies the returned `capabilityId` when retrying the identical plan. It is consumed before execution and cannot be replayed, including after a crash.

The model cannot mint or self-assert approval. Changed URLs, selectors, text, values, or actions need a new approval. Purchases/orders/payments, credentials, login, 2FA, and CAPTCHA remain hard-blocked even with approval.

## Network isolation

Every navigation, redirect, and subresource is intercepted. Hostnames are resolved before access, DNS answers are cached briefly and revalidated, and changed answers are treated as rebinding. Loopback, private, carrier-grade NAT, link-local, metadata, documentation, benchmark, multicast, reserved, IPv4-mapped IPv6, and non-global IPv6 ranges are blocked. `about:blank`, page-local `data:` and `blob:` browser internals are allowed.

## Runtime data

All state is host-local under `~/.jarvis/data/workbench/`:

```text
profile/       persistent Chromium profile
screenshots/   PNG screenshots per run
artifacts/     JSON page snapshots per run
approvals/     short-lived approval records and replay state
downloads/     reserved target; download actions remain unimplemented
```

Do not put credentials, secrets, private account data, or payment details into browser requests.

## Agent tool shape

Read a page:

```json
{ "action": "open_url", "url": "https://example.com", "request": "Open example.com" }
```

Run a benign plan:

```json
{
  "action": "run_steps",
  "request": "Open documentation and search for retries.",
  "steps": [
    { "action": "open_url", "url": "https://example.com/docs" },
    { "action": "fill", "selector": "input[name=q]", "value": "retries" }
  ]
}
```

When approval is required, the tool returns `PENDING_OWNER_APPROVAL` and sends Telegram buttons. After approval, it retries the same plan with the returned `capabilityId`.

Before click/submit, JARVIS inspects the resolved DOM element's role, visible text, accessible label, input/button type, link, and enclosing form action/method. This prevents a benign-looking selector from bypassing side-effect or sensitive-target checks. Submit defaults to denied without a capability.

## Smoke test

```bash
pnpm exec playwright install chromium
pnpm run workbench:smoke
pnpm run workbench:smoke -- https://example.com
```

The local fixture uses a test-only capability flag; it does not mint a production approval.
