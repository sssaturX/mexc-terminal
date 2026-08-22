# Security Policy

## Supported Versions

Only the latest commit on the default branch is supported with security fixes.

## Reporting a Vulnerability

Do **not** open a public issue for secrets, token leaks, or remote-code issues.

1. Use GitHub **Security Advisories** on this repository (Security → Advisories → New draft advisory).
2. Include steps to reproduce, affected files, and impact.
3. Wait for a maintainer response before disclosing publicly.

If the advisory form is unavailable, describe the issue in a private email listed on the maintainer GitHub profile. Do not paste live tokens or session cookies.

## Secrets and credentials

This project never needs real secrets in git.

| File | Purpose |
| --- | --- |
| `.env.example` | Empty placeholders only |
| `config/settings.example.json` | Example bot profile without tokens |
| `config.example.yaml` | Spread-checker example without credentials |

Never commit:

- `.env`, `.env.local`, `config/settings.json`, `config.yaml`
- MEXC WEB session tokens
- Twilio, Pushover, ntfy, SMTP passwords
- TLS private keys or nginx certificates
- VPS IPs, personal domains, or phone numbers

If a secret was committed (including in git history):

1. Revoke and rotate it immediately on the provider.
2. Treat the old value as public.
3. See [docs/GOING_PUBLIC.md](docs/GOING_PUBLIC.md) before changing repository visibility.

## Trading disclaimer

This software talks to unofficial MEXC Futures endpoints using a browser WEB token. Live trading can lose money, leak a session, or fail after exchange changes. Default mode is dry-run. You are responsible for how you run it.
