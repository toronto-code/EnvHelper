# Security Policy

EnvHelper handles setup and encrypted sharing locally. There is no backend that can receive, store, proxy, or log user secrets.

## Rules

- No hosted backend, accounts, telemetry, or crash-report uploads.
- No website or EnvHelper API receives secret values.
- No custom cryptography; sharing delegates to the official `age` CLI.
- Secret prompts are masked and values are never printed in status or previews.
- Provider validation is opt-in and sends a value only to that provider's documented endpoint.
- Private identities, `.env`, and decrypted output use mode `0600` where the OS supports POSIX permissions.
- Sensitive files are read only when they are regular files, not symbolic links.
- Sensitive output is written to a temporary file and atomically renamed into place.
- Filtered sharing contains only parsed environment assignments; comments and unsupported syntax are omitted.

## Local identity

Each recipient has an age identity at:

```txt
~/.envhelper/identity.txt
```

EnvHelper creates the directory with mode `0700` and the identity with mode `0600`. The public `age1...` code is safe to share; the identity file is not.

## Encrypted bundles in Git

Committing `.env.team.enc` may be acceptable, but removing a recipient from the newest bundle does not remove their access to older bundles in Git history.

When an identity is compromised or access must be revoked:

1. Rotate the upstream API keys and passwords.
2. Remove the recipient from the invite set.
3. Run `envhelper rekey` for future bundles.

## Trusted local tools

EnvHelper trusts the local Node.js runtime and executes `age` and `age-keygen` from `PATH`. Install them from a trusted source. Avoid running EnvHelper with a project-controlled `node_modules/.bin` ahead of the intended system `age` installation.

## Reporting a vulnerability

Never include real secrets, private identities, or decrypted `.env` content in a report. Use fake values in a minimal reproduction.
