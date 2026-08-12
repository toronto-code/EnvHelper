# EnvHelper

Set up a project's `.env`, then share it without putting plaintext secrets in chat.

EnvHelper has two jobs:

1. **Setup:** detect environment variables, explain where values come from, and save them locally.
2. **Sharing:** encrypt selected `.env` assignments for teammates with [`age`](https://age-encryption.org/).

There is no EnvHelper account, hosted vault, telemetry service, or backend that receives your secrets.

## Install

Install `age` for sharing:

```bash
brew install age
```

Install EnvHelper globally from npm:

```bash
npm install -g envhelper
```

For local development, install it from this repository:

```bash
git clone https://github.com/toronto-code/EnvHelper.git
cd EnvHelper
npm link
```

## Set up a project

Run this inside the project that needs environment variables:

```bash
envhelper setup
```

EnvHelper reads `.env.example`, optional hand-authored `.envhelper.json` requirements, package metadata, and common environment-variable references in source files. It groups credentials into distinct setup profiles and hides values already present in `.env`.

```txt
EnvHelper Setup

Choose what you are setting up:

1. Local demo
   Required credentials only. 2 missing, 3 ready.
2. Real AI
   Required credentials plus detected AI provider keys. 3 missing, 3 ready.
```

Useful setup modes:

```bash
envhelper setup --profile local-demo
envhelper setup --profile real-ai
envhelper setup --profile integrations
envhelper setup --optional
envhelper setup --all
envhelper setup --dry-run
```

`--dry-run` shows the selected scope and provider links without changing files. `--validate` opts into direct provider validation where a validator exists; secrets go directly from your machine to that provider, never to EnvHelper.

Setup writes `.env` atomically with owner-only permissions where the OS supports them, updates `.env.example` with variable names only, and ensures standard `.env` ignore rules are present. Existing comments and assignments are preserved when values are updated.

For requirements that cannot be discovered from source, create `.envhelper.json` manually:

```json
{
  "required": ["ACME_API_KEY"]
}
```

EnvHelper never rewrites this user-owned configuration file and does not use a generated lock file, so newly detected requirements cannot be hidden by stale setup decisions.

## Share a `.env`

Each recipient creates an identity once:

```bash
envhelper invite --out alice.pub
```

The command prints an `age1...` public invite code. The private identity stays at `~/.envhelper/identity.txt` with owner-only permissions where supported.

The sender encrypts `.env` for one or more recipients:

```bash
envhelper share --recipient age1...
envhelper share --recipient age1... --recipient age1...
envhelper share --recipients-dir invites
```

Filtered sharing is the default. It parses complete assignments, omits comments and unsupported content, and excludes keys that look personal or production-specific. It prints key names—but never values—for review before encryption.

```txt
Share preview

Recipients: 2
Output: .env.team.enc
Mode: automatic personal-key exclusions
Included (3): OPENAI_API_KEY, SUPABASE_URL, TEAM_SETTING
Excluded (2): GITHUB_TOKEN, PROD_DATABASE_URL
```

Choose exclusions or preview explicitly:

```bash
envhelper share --recipient age1... --exclude GITHUB_TOKEN,PROD_DATABASE_URL
envhelper share --recipient age1... --dry-run
```

Share the raw file only when you intend to include everything, including comments and nonstandard syntax:

```bash
envhelper share --recipient age1... --whole-env
```

## Receive a bundle

Place `.env.team.enc` in the project and run:

```bash
envhelper join
```

EnvHelper decrypts locally and writes `.env` atomically with owner-only permissions where supported. Existing output requires confirmation; non-interactive use must pass `--yes` to replace it.

Custom paths are supported:

```bash
envhelper join --input secrets/team.enc --output .env.local
```

## Change recipients

Re-encrypt the current `.env` for a new recipient set:

```bash
envhelper rekey --recipients-dir invites
```

This changes access to new bundles only. Rotate upstream keys when a recipient must lose access to old bundles.

## Command surface

```txt
envhelper setup
envhelper share
envhelper invite
envhelper rekey
envhelper join
envhelper help
envhelper version
```

`envhelper start` remains as an alias for `setup`. Leak scanning and repository-audit commands are intentionally outside this focused product.

Read [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md) before committing encrypted bundles containing sensitive production credentials.
