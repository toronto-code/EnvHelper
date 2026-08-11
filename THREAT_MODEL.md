# Threat Model

## Goals

EnvHelper aims to prevent:

- Printing secrets while guiding project setup.
- Committing a plaintext `.env` accidentally after setup or decryption.
- Sending plaintext `.env` files through chat or email.
- Including explicitly excluded multiline assignments in a shared bundle.
- Leaving secret files readable by other local users.
- Partial outputs when a write, encryption, or decryption operation fails.
- Repository-controlled file symlinks redirecting sensitive reads or writes.
- Stale generated profiles hiding newly detected setup requirements.

## Trust boundaries

```txt
Local setup
  scans non-secret project sources
  accepts masked secret input
  optionally validates directly with a selected provider
  writes .env locally

Sender
  reads .env
  reviews included key names
  encrypts with age

Git, chat, or cloud storage
  may carry only .env.team.enc ciphertext

Recipient
  stores a private age identity
  decrypts to a local owner-only file where supported
```

EnvHelper trusts the local operating system, Node.js runtime, `age` executables on `PATH`, intended recipients, provider endpoints declared in the bundled directory, and the upstream tools used to install those components.

## Non-goals

- Preventing an intended recipient from copying a secret after decryption.
- Protecting a machine already controlled by malware or another process running as the same user.
- Revoking old bundles without rotating the secrets they contain.
- Detecting whether a key is personal, optional, or production-specific with certainty.
- Proving that every environment reference in every programming language was discovered.
- Acting as a hosted vault, repository leak scanner, access-control system, or provider key-rotation service.

## Important limitations

Automatic setup classification and sharing exclusions are heuristics. Review the selected setup profile and the key-name sharing preview. `--whole-env` deliberately includes comments and unsupported content omitted by filtered mode.
