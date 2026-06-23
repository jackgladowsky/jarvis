# Security Policy

JARVIS is designed for a trusted, single-user/self-hosted environment. It intentionally gives the assistant real shell and filesystem access on the host. Do not expose it to untrusted users.

## Supported versions

The `main` branch is the only supported line unless a maintainer says otherwise.

## Reporting a vulnerability

Report vulnerabilities privately to the repository owner. Include reproduction steps, affected configuration, and any logs with secrets redacted.

## Operational expectations

- Restrict Telegram access with numeric user IDs in `TELEGRAM_ALLOWED_USER_IDS`.
- Keep `~/.jarvis/.env`, OAuth credentials, config, prompts, sessions, notes, and audit logs private.
- Run on a host you are comfortable letting the assistant operate.
- Review templates before copying them into production.
