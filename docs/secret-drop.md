# Owner secret drop

`/secretdrop KERNEL_API_KEY [5-10]` creates a one-time browser form for the allowlisted Kernel key. The key never transits Telegram, the model, normal tool/audit logs, or the public URL query. For safe systemd EnvironmentFile storage, the current Kernel key flow accepts only a 1–4096-character token made of ASCII letters/digits plus `._~+/:=@-`; whitespace, quotes, backslashes, `$`, `#`, and other shell-like syntax are rejected. The process binds only `127.0.0.1`; it is disabled by default.

Set `secret_drop.enabled`, an unused loopback `port`, and the exact public HTTPS Funnel origin in `config.yaml`, then restart JARVIS. Configure Tailscale Funnel separately to forward that public hostname to `http://127.0.0.1:<port>`; JARVIS never enables Funnel. Host rewriting, `X-Forwarded-*`, HTTP, and path-prefixed public origins are rejected. On submission it atomically updates `~/.jarvis/.env` with mode `0600`; restart JARVIS afterwards to load the new environment.

Do not forward a generated link. It expires in 5–10 minutes, is one-use, and a restart invalidates pending links. The listener uses no request access logging; its separate durable audit contains only event/key/opaque id metadata, never links, tokens, CSRF values, or submitted values.
