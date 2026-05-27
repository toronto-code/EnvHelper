# EnvHelper

Stop sending `.env` files in chat.

EnvHelper is a local-first CLI for setting up, checking, and sharing project environment variables. It helps solo developers and small teams figure out which values a repo needs, where to get provider keys, what can be skipped, and how to share `.env` without plaintext copy-paste.

No accounts. No hosted vault. No EnvHelper server. No plaintext secret sharing.

## Why

Most project setup docs eventually become:

```txt
cp .env.example .env
go get an OpenAI key
go get a Supabase key
ask someone for the Slack token
do not commit anything
good luck
```

EnvHelper turns that into a guided local flow:

```bash
envhelper start
```

```txt
Setup profiles:

1. Local demo
   Required values only. Best for getting the app running locally.
   0 missing, 8 set
2. Real AI mode
   Required values plus AI provider keys such as OpenAI or Anthropic.
   0 missing, 10 set
3. Integrations mode
   Required values plus GitHub, Jira, Slack, and similar integration keys.
   2 missing, 11 set

Choose setup profile [1]:
```

Then EnvHelper shows one focused action screen:

```txt
EnvHelper setup

Profile: Integrations mode

! GitHub: 1/2 set
  ! GITHUB_WEBHOOK_SECRET
! Slack: 2/3 set
  ! SLACK_SIGNING_SECRET
✓ Supabase: 6/6 set

What do you want to do?
1. Fill missing values
2. Show key links
3. Share current .env
4. Save decisions to .envhelper.lock
5. Pick a different profile
6. Exit
```

## Install

From this repo:

```bash
git clone https://github.com/toronto-code/EnvHelper.git
cd EnvHelper
npm link
```

Then run EnvHelper inside any project:

```bash
envhelper start
```

After the package is published to npm:

```bash
npm install -g envhelper
```

Team sharing uses [`age`](https://age-encryption.org/):

```bash
brew install age
```

## Core Commands

```bash
envhelper start
```

Open the guided setup flow. EnvHelper scans `.env.example`, docs, code references, and local `.env` variable names. Secret values are never printed.

Useful shortcuts:

```bash
envhelper start --profile local-demo
envhelper start --profile real-ai
envhelper start --profile integrations
```

```bash
envhelper needs
```

Show what still needs action. Already-set values are hidden by default.

```bash
envhelper needs --show-set
envhelper needs --optional
envhelper needs --all
envhelper needs --verbose
```

```bash
envhelper doctor
```

Check `.env` hygiene, `.gitignore`, likely leaked secret values, team bundle presence, and real frontend runtime exposure.

Doctor is intentionally conservative. It does not treat `.env.example`, docs, or UI copy that merely mentions `OPENAI_API_KEY` as proof of a leak. It only flags frontend exposure when a secret env var is referenced in frontend runtime code.

Example:

```txt
✓ .env is ignored
✓ .env.example exists
✓ .env exists locally
✓ .env has all likely setup values (90 optional/default/config value(s) not set)
✓ No team bundle found; sharing is optional
✓ Detected 103 env var(s)
```

```bash
envhelper share
```

Open the sharing wizard:

```txt
EnvHelper Share

What are you doing?

1. I want to receive a shared .env
2. I want to share my .env with teammates
3. I received .env.team.enc and want to decrypt it
```

When sharing, EnvHelper asks what to include:

```txt
1. Share .env excluding likely personal keys
2. Share whole .env
3. Choose keys to exclude
```

More explicit sharing commands:

```bash
envhelper invite
envhelper share --recipient age1...
envhelper share --recipient age1... --whole-env
envhelper share --recipient age1... --exclude GITHUB_TOKEN,PROD_DATABASE_URL
envhelper share --recipients-dir invites
envhelper join
```

```bash
envhelper link stripe
envhelper link ACME_API_KEY --copy
envhelper link ACME_API_KEY --open
```

Find a provider key page. Known providers use curated official links. Unknown names get a Google search URL.

## Smarter Setup Guidance

EnvHelper gives less advice rather than wrong advice.

It uses variable names to choose conservative instructions:

- `*_WEBHOOK_SECRET`: generate a long random shared secret; do not use an access token.
- `*_SIGNING_SECRET`: copy the provider signing secret; do not use a bot/API token.
- `*_TOKEN`: token-specific guidance only.
- `*_URL`: copy the URL value only.
- `*_PUBLISHABLE_*` / `NEXT_PUBLIC_*`: warns to confirm the value is intended to be public.
- unknown names: links to search/docs and avoids guessing.

Example:

```txt
GitHub setup

Value: GITHUB_WEBHOOK_SECRET
Where: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
Steps:
  1. Generate a long random string, for example with a password manager or `openssl rand -hex 32`.
  2. Paste that same string into the provider's webhook Secret field.
  3. Paste the same string here as GITHUB_WEBHOOK_SECRET.
  4. Do not use an access token for this value.
Note: This is not a GitHub access token. It is used only to verify webhook signatures.
```

## Setup Profiles

EnvHelper builds profiles from detected variables:

- `local-demo`: required values only
- `real-ai`: required values plus AI provider keys
- `integrations`: required values plus GitHub/Jira/Slack-style integrations
- `known-optional`: required values plus known optional provider keys referenced by the repo

You can save decisions:

```txt
Save these setup decisions to .envhelper.lock? [Y/n]
```

`.envhelper.lock` contains env var names and profile choices only. It never contains secret values.

## Provider Directory

EnvHelper ships with curated provider metadata for 52 common services, including Stripe, Supabase, Anthropic, OpenAI, Clerk, Resend, Twilio, Firebase, GitHub, Jira, Google Maps, AWS, Cloudflare, Vercel, Neon, Pinecone, MongoDB Atlas, Groq, Replicate, Deepgram, Slack, Discord, Plaid, Square, PayPal, and Airtable.

Provider entries must use official docs or official dashboards as sources. The provider audit rejects duplicate env vars, generic mappings like `DATABASE_URL`, invalid URLs, and guessed search-result sources.

When EnvHelper does not know a provider, it falls back to a Google search URL instead of hallucinating a key page.

## Security Model

EnvHelper does not run a backend and does not receive your secrets.

Secrets are:

- entered locally
- written locally to `.env`
- validated only after explicit consent
- encrypted locally with `age`
- decrypted locally by the recipient

EnvHelper never asks you to paste secrets into a website.

Honest limitation:

> Once a teammate decrypts the bundle, they have the real API key. EnvHelper prevents accidental leaking during setup and sharing; it cannot stop a trusted teammate from intentionally copying the key.

Read [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md) for the design rules.

## Other Commands

```bash
envhelper add stripe
envhelper add ACME_API_KEY
envhelper providers
envhelper providers --json
envhelper validate
envhelper doctor --fix
envhelper commands
```

`envhelper validate` only sends a value directly from your machine to that provider after asking for confirmation. Values are never sent to EnvHelper.
