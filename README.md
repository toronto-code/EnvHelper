# EnvHelper

[![CI](https://github.com/toronto-code/EnvHelper/actions/workflows/ci.yml/badge.svg)](https://github.com/toronto-code/EnvHelper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Set up a project's `.env`, then share it without pasting plaintext secrets into chat.**

EnvHelper is a local command-line tool. It has no accounts, hosted vault, telemetry, or backend. Your secrets stay on your computer unless you explicitly ask EnvHelper to validate one directly with its provider.

## What it does

- Finds environment variables used by a project.
- Explains where missing values come from.
- Copies safe defaults and asks only for values that need input.
- Writes `.env` locally and adds it to `.gitignore`.
- Encrypts selected settings for teammates with [`age`](https://age-encryption.org/).
- Shows key names—but never their values—before sharing.

## Quick start

Requires Node.js 18 or newer. Until the first npm release, install EnvHelper directly from GitHub:

```bash
npm install -g github:toronto-code/EnvHelper
```

After EnvHelper is published to npm, the install command will be `npm install -g envhelper`.

Confirm the installation:

```bash
envhelper --version
envhelper --help
```

Run setup inside a project:

```bash
cd your-project
envhelper setup
```

EnvHelper scans common source files, `.env.example`, package metadata, and optional `.envhelper.json` requirements. It then guides you through only the values needed for the setup profile you choose.

```text
EnvHelper Setup

Profile: Everything
All detected credentials and configuration values.
! OpenAI: 0/1 ready
  ! OPENAI_API_KEY
~ Unknown provider: 0/1 ready, 1 default available
  ~ PORT (template default will be copied)
```

Safe, unambiguous defaults such as `PORT=3000` are copied automatically. Credentials, placeholders such as `your-key-here`, secret-bearing URLs, and conflicting defaults still require input.

Preview setup without changing anything:

```bash
envhelper setup --dry-run
```

## Share with a teammate

Sharing uses the external `age` and `age-keygen` commands. Install them from the [official age project](https://age-encryption.org/) first. On macOS with Homebrew:

```bash
brew install age
```

### 1. Your teammate creates an invite

```bash
envhelper invite --out teammate.pub
```

This creates a public `age1...` invite code. Their private identity stays at `~/.envhelper/identity.txt` and must never be shared.

### 2. You encrypt the settings

```bash
envhelper share --recipient age1...
```

Multiple recipients and invite directories are supported:

```bash
envhelper share --recipient age1... --recipient age1...
envhelper share --recipients-dir invites
```

Before encrypting, EnvHelper displays the names of included and excluded settings. Filtered sharing omits comments and unsupported syntax and automatically excludes keys that look personal or production-specific.

```text
Share preview

Recipients: 2
Output: .env.team.enc
Included (3): OPENAI_API_KEY, SUPABASE_URL, TEAM_SETTING
Excluded (2): GITHUB_TOKEN, PROD_DATABASE_URL
```

Review this list. Automatic exclusions are a safety aid, not a substitute for human review.

### 3. Your teammate decrypts locally

```bash
envhelper join
```

This decrypts `.env.team.enc` to `.env`. EnvHelper asks before replacing an existing file.

## Why trust EnvHelper?

EnvHelper is designed so that you do not need to trust an EnvHelper server—there is no server.

| Question | Answer |
| --- | --- |
| Does EnvHelper upload `.env`? | No. |
| Does EnvHelper have accounts or telemetry? | No. |
| Does it invent its own encryption? | No. It runs the official `age` CLI locally. |
| Does it print secret values? | No. Prompts are masked and previews contain key names only. |
| Can validation use the network? | Only when you opt in. The value goes directly to that provider's documented endpoint. |
| How are sensitive files written? | With owner-only permissions where supported, using a temporary file and atomic replacement. |
| Does it follow file symlinks? | Sensitive reads and writes reject symbolic links. |
| Can I inspect the security assumptions? | Yes. Read [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md). |

The security-sensitive behavior has automated regression tests and runs in CI on supported Node versions. EnvHelper has not yet received an independent third-party security audit, so do not treat it as a replacement for a managed secret vault or your organization's security controls.

## Useful commands

```bash
# Choose a setup scope
envhelper setup --profile local-demo
envhelper setup --profile real-ai
envhelper setup --profile integrations
envhelper setup --optional
envhelper setup --all

# Validate supported values directly with their providers
envhelper setup --validate

# Preview or customize sharing
envhelper share --recipient age1... --dry-run
envhelper share --recipient age1... --exclude GITHUB_TOKEN,PROD_DATABASE_URL

# Include the raw file only when you truly want everything in it
envhelper share --recipient age1... --whole-env

# Use custom paths
envhelper join --input secrets/team.enc --output .env.local

# Encrypt a new bundle for a changed recipient list
envhelper rekey --recipients-dir invites
```

Run `envhelper help` or `envhelper <command> --help` for the full command reference.

## Important limits

- EnvHelper cannot protect a computer already controlled by malware.
- Anyone who decrypted an old bundle may still know its secrets. Rotate the original API keys or passwords to revoke access.
- Detection and automatic exclusions use careful heuristics, but they cannot understand every project perfectly.
- `--whole-env` deliberately includes comments and syntax omitted by filtered sharing.
- EnvHelper is not a hosted vault, access-control system, leak scanner, or key-rotation service.

## Project-specific requirements

If a required value cannot be discovered from source, add a hand-written `.envhelper.json`:

```json
{
  "required": ["ACME_API_KEY"]
}
```

EnvHelper reads this file but never generates or overwrites it.

## Contributing and security

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before changing secret-handling behavior.
- Read [SECURITY.md](./SECURITY.md) before reporting a security issue.
- Never include real secrets, private identities, or decrypted `.env` content in issues or test cases.

MIT licensed.
