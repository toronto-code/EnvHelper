# Contributing

EnvHelper is intentionally limited to two workflows: local environment setup and encrypted environment sharing.

Before changing secret-handling behavior, read `SECURITY.md` and `THREAT_MODEL.md`.

## Requirements

- Do not add a backend, telemetry, secret logging, leak scanner, or custom cryptography.
- Treat repository files as untrusted and reject symbolic links for sensitive reads and writes.
- Write secret files atomically with mode `0600`.
- Never print environment values in status, previews, errors, or tests.
- Keep `.envhelper.json` user-owned; do not generate or overwrite setup requirements.
- Add regression tests for every security-sensitive bug.

## Provider guidance

Provider entries live in `providers/providers.json`. Use official documentation or dashboard URLs, scope HTTP validators to exact environment variables, and run:

```bash
npm run providers:audit
npm test
```
