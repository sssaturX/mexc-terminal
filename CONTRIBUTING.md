# Contributing

Thanks for considering a contribution. Please read this guide, the
[Code of Conduct](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md) first.

## Development setup

Node.js 18+ is required. Python 3.11+ is required only for the spread checker.

```bash
git clone https://github.com/sssaturX/mexc-terminal.git
cd mexc-terminal
npm install
cp .env.example .env
npm test
```

Optional Python environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Do not put real WEB tokens or notification credentials in git. Use `.env` and
`config/settings.json`, both of which are gitignored.

## How to send a change

1. Open an issue describing the bug or feature when the change is non-trivial.
2. Fork the repository and create a branch from the default branch.
3. Keep the change focused. Do not mix refactors with bug fixes.
4. Add or update tests when behavior changes.
5. Run `npm test`.
6. Open a pull request using the template.

## What we will not merge

- Real API keys, WEB tokens, phone numbers, hostnames, or other personal data
- Live-trading “guaranteed profit” claims
- Exploit PoCs against MEXC, Gate.io, or third-party services
- Generated agent attribution in commit messages (no `Co-authored-by: Cursor`)

## Code style

- TypeScript lives under `src/` and `tests/`.
- Python lives at the repo root, `alerts/`, and `exchange_clients/`.
- Match surrounding formatting. Prefer small, named functions over large dumps.
- Keep logs free of secrets. The MEXC client already redacts auth-related errors.

## Commit messages

Write a short imperative subject, for example:

```text
Add dry-run guard when WEB token is missing
```

Do not include trailers that add extra GitHub contributors unless those people
actually authored the patch.
