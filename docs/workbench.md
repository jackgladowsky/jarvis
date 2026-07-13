# Browser workbench

JARVIS defaults to a local Playwright browser workbench. It opens public `http(s)` pages, inspects visible content, saves screenshots/artifacts, and can run small guarded `click`, `type`, `fill`, and `submit` plans. An opt-in Kernel.sh backend can launch the same guarded plan in a hosted browser; if Kernel session acquisition fails before the first step, JARVIS falls back to local Chromium.

## Owner authority

Reading, benign navigation, and non-secret text entry do not need approval. Submit and side-effect-like actions use an owner-authenticated capability:

1. The tool records a hash of the exact normalized action plan and sends Telegram **Approve once** / **Deny** buttons.
2. Only the allowlisted Telegram user in the originating chat can decide it.
3. Approval expires after ten minutes and is valid for exactly that plan.
4. JARVIS supplies the returned `capabilityId` when retrying the identical plan. It is consumed before execution and cannot be replayed, including after a crash.

The model cannot mint or self-assert approval. Changed URLs, selectors, text, values, or actions need a new approval. Purchases/orders/payments, credentials, login, 2FA, and CAPTCHA remain hard-blocked even with approval.

## Network isolation

Every navigation and subresource is intercepted. Hostnames are resolved before access, DNS answers are cached briefly and revalidated, and changed answers are treated as rebinding. Loopback, private, carrier-grade NAT, link-local, metadata, documentation, benchmark, multicast, reserved, IPv4-mapped IPv6, and non-global IPv6 ranges are blocked. Browser redirects are deliberately blocked; JARVIS must validate and open the destination as a new navigation. Intercepted responses are byte-bounded, decoded encoding headers are normalized, and `Set-Cookie` is discarded because the fulfill proxy does not claim transparent browser cookie semantics. `about:blank`, page-local `data:` and `blob:` browser internals are allowed.

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

## Optional Kernel.sh backend and hosted auth

Kernel is opt-in. Put its API key only in `~/.jarvis/.env` (mode 600), then configure only an environment-variable reference in `~/.jarvis/config.yaml`:

```yaml
tools:
  browser:
    backend: kernel
    kernel:
      api_key_env: $KERNEL_API_KEY
      profile_name: jarvis
      save_changes: false
```

Exact owner setup:

1. Create a least-privilege Kernel key and add `KERNEL_API_KEY=...` to `.env`; never paste it into chat or YAML.
2. Set the config above, validate it, then use JARVIS's normal guarded restart path.
3. Ask JARVIS to call `browser_workbench` with `action: "kernel_auth_start"`, a public `domain`, and safe `profileName`. Approve the exact plan in Telegram.
4. Open the returned Kernel-hosted URL yourself and complete all credentials, 2FA, CAPTCHA, and account choices there. JARVIS never types, reads, submits, or stores those values.
5. Ask for `kernel_auth_status` using the returned connection ID, then use ordinary browser actions. Set `backend: local` to disable hosted browsing.

Only safe auth metadata (connection ID, domain, profile name, timestamps/status) is persisted under the workbench data directory. Hosted URLs, handoff/live-view URLs, API keys, cookies, credentials, and raw Kernel responses are not persisted or included in audit fields. JARVIS explicitly disables Kernel credential saving, session recording, health checks, and automatic reauthentication for both new and reused auth connections. Kernel session deletion is explicit so an opted-in `save_changes: true` profile can persist; profile/connection deletion is never automatic.

The same preflight, exact-plan Telegram approval, DOM checks, and public-network policy apply to the Kernel CDP context. Normal browser login/credential/2FA/CAPTCHA steps remain blocked; the narrowly-scoped hosted-auth handoff is the only exception, and it always requires owner approval.

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
