#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  decryptBundleContent,
  ensureAgeIdentity,
  encryptBundleContent,
  hasAge
} from "./crypto-age.js";
import {
  ensureEnvIgnored,
  filterEnvAssignments,
  likelyPersonalShareEntries,
  parseEnvAssignments,
  parseEnvFile,
  upsertEnvFile,
  writeEnvExample
} from "./envfile.js";
import { formatLink, googleSearchUrl } from "./links.js";
import {
  envVarClientSafe,
  isKnownProviderEnvVar,
  isLikelyCredentialEnvVar,
  loadProviders,
  providerForEnvVar
} from "./providers.js";
import { scanProject } from "./scanner.js";
import { assertSafeFile, readRegularFile, safeWriteFile } from "./safe-file.js";
import { canValidateEnvVar, validateEnvValue } from "./validators.js";

const cwd = process.cwd();
let pipedInputLines = null;
let pipedInputIndex = 0;

const commands = {
  setup,
  start: setup,
  invite,
  share,
  rekey: share,
  join,
  version,
  help
};

const command = process.argv[2] || "help";
const args = process.argv.slice(3);

try {
  if (command === "--help" || command === "-h") {
    help();
  } else if (command === "--version" || command === "-v") {
    await version();
  } else if (!commands[command]) {
    throw new Error(`Unknown command: ${command}. Run \`envhelper help\` for usage.`);
  } else if (args.includes("--help") || args.includes("-h")) {
    commandHelp(command);
  } else {
    await commands[command](args);
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (process.stdin.isTTY) process.stdin.pause();
}

async function setup(argv = []) {
  const options = parseOptions(argv, {
    "--profile": { key: "profile", value: true },
    "--optional": { key: "optional" },
    "--all": { key: "all" },
    "--validate": { key: "validate" },
    "--no-validate": { key: "noValidate" },
    "--dry-run": { key: "dryRun" }
  });
  if (options.validate && options.noValidate) throw new Error("Choose either --validate or --no-validate, not both.");
  if ([options.profile, options.optional, options.all].filter(Boolean).length > 1) {
    throw new Error("Choose only one setup scope: --profile, --optional, or --all.");
  }

  console.log("EnvHelper Setup\n");
  const providers = await loadProviders();
  const scan = await scanProject(cwd);
  const envPath = path.join(cwd, ".env");
  const existing = existsSync(envPath) ? await parseEnvFile(envPath) : {};
  const rows = enrichSetupRows(scan, providers, existing);

  if (!rows.length) {
    console.log("No environment variables found. Add a .env.example or reference an environment variable in code.");
    return;
  }

  const allProfiles = buildSetupProfiles(rows);
  const profile = await chooseSetupProfile(allProfiles, options);
  const selectedRows = profile.items;
  const missing = selectedRows.filter((row) => row.status === "missing");

  printSetupStatus(profile, selectedRows);
  if (!missing.length) {
    console.log("\nEverything in this setup scope is ready (set locally or supplied by a template default).");
    return;
  }

  console.log("\nMissing values:");
  for (const row of missing) {
    console.log(`- ${row.name} (${providerLabel(row)})`);
    if (row.url) console.log(`  ${formatLink(row.provider ? "open key page" : "search provider docs", row.url)}`);
  }

  if (options.dryRun) {
    console.log("\nDry run only; no files were changed.");
    return;
  }

  await ensureEnvIgnored(cwd);
  const exampleChanged = await writeEnvExample(path.join(cwd, ".env.example"), rows.map((row) => row.name));
  if (exampleChanged) console.log("\nUpdated .env.example with detected variable names.");

  const updates = {};
  for (const row of missing) {
    printProviderCard(row);
    const value = await promptSecret(`Paste ${row.name}, or press Enter to skip: `);
    if (value === "") continue;
    if (!await acceptValidatedValue(row, value, options)) continue;
    updates[row.name] = value;
  }

  if (!Object.keys(updates).length) {
    console.log("\nNo new values saved.");
    return;
  }

  await upsertEnvFile(envPath, updates);
  console.log(`\nSaved ${Object.keys(updates).length} value(s) to .env${permissionSuffix()}.`);
  console.log("Next: run `envhelper setup --dry-run` to review status or `envhelper share` to encrypt the file.");
}

function enrichSetupRows(scan, providers, existing) {
  return scan.envVars.map((item) => {
    const provider = providerForEnvVar(item.name, providers, scan.packageNames);
    const template = summarizeTemplates(item.templates || []);
    const kind = classifyEnvVar(item.name, provider, template);
    return {
      ...item,
      provider,
      template,
      kind,
      status: existing[item.name] ? "set" : template.allHaveDefaults ? "default" : "missing",
      url: provider ? bestEnvUrl(provider, item.name) : kind.includes("credential") ? googleSearchUrl(item.name) : null
    };
  });
}

function buildSetupProfiles(rows) {
  const required = rows.filter((row) => row.kind === "required credential");
  const credentials = rows.filter((row) => row.kind === "required credential" || row.kind === "optional credential");
  return [
    {
      id: "local-demo",
      name: "Local demo",
      description: "Required credentials only.",
      items: required
    },
    {
      id: "real-ai",
      name: "Real AI",
      description: "Required credentials plus detected AI provider keys.",
      items: uniqueRows([...required, ...credentials.filter(isAiCredential)])
    },
    {
      id: "integrations",
      name: "Integrations",
      description: "Required credentials plus detected integration keys.",
      items: uniqueRows([...required, ...credentials.filter(isIntegrationCredential)])
    },
    {
      id: "all-credentials",
      name: "All credentials",
      description: "Every detected credential, including unknown providers.",
      items: credentials
    },
    {
      id: "all",
      name: "Everything",
      description: "All detected credentials and configuration values.",
      items: rows
    }
  ];
}

async function chooseSetupProfile(profiles, options) {
  if (options.all) return profiles.find((profile) => profile.id === "all");
  if (options.optional) return profiles.find((profile) => profile.id === "all-credentials");
  if (options.profile) {
    const selected = profiles.find((profile) => profile.id === options.profile);
    if (!selected) throw new Error(`Unknown setup profile: ${options.profile}.`);
    return selected;
  }

  const useful = dedupeProfiles(profiles.filter((profile) => profile.items.length));
  if (!process.stdin.isTTY) return useful[0] || profiles.find((profile) => profile.id === "all");
  if (useful.length <= 1) return useful[0] || profiles.find((profile) => profile.id === "all");

  console.log("Choose what you are setting up:\n");
  useful.forEach((profile, index) => {
    const missing = profile.items.filter((item) => item.status === "missing").length;
    console.log(`${index + 1}. ${profile.name}`);
    console.log(`   ${profile.description} ${missing} missing, ${profile.items.length - missing} ready.`);
  });
  const choices = useful.map((_, index) => String(index + 1));
  const choice = await promptChoice("\nChoose [1]: ", choices, "1");
  return useful[Number(choice) - 1];
}

function dedupeProfiles(profiles) {
  const seen = new Set();
  return profiles.filter((profile) => {
    const signature = profile.items.map((item) => item.name).sort().join("\n");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function printSetupStatus(profile, rows) {
  console.log(`Profile: ${profile.name}`);
  console.log(profile.description);
  const groups = new Map();
  for (const row of rows) {
    const label = providerLabel(row);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }
  for (const [label, items] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const ready = items.filter((item) => item.status !== "missing").length;
    console.log(`${ready === items.length ? "✓" : "!"} ${label}: ${ready}/${items.length} ready`);
    for (const item of items.filter((entry) => entry.status === "missing")) console.log(`  ! ${item.name}`);
  }
}

function printProviderCard(row) {
  console.log(`\n${row.provider ? row.provider.name : "Unknown provider"}: ${row.name}`);
  if (row.url) console.log(`Where: ${formatLink("open", row.url)}`);
  console.log("Steps:");
  for (const step of providerSteps(row.provider, row.name)) console.log(`  ${step}`);
  if (row.provider && envVarClientSafe(row.name, row.provider) === false && looksFrontendPublic(row.name)) {
    console.log("Warning: this name looks public, but the provider marks the value as secret.");
  }
}

function providerSteps(provider, name) {
  const id = provider?.id?.toLowerCase();
  const upper = name.toUpperCase();
  if (!provider) return [
    "1. Check the source files or project documentation that reference this variable.",
    `2. Determine the value expected for ${name}.`,
    "3. Paste it here, or skip it until the relevant project mode is needed."
  ];
  if (upper.includes("WEBHOOK_SECRET")) return [
    "1. Generate a long random string with a password manager or `openssl rand -hex 32`.",
    "2. Put the same string in the provider's webhook Secret field.",
    `3. Paste it here as ${name}; do not use an access token.`
  ];
  if (upper.includes("SIGNING_SECRET")) return [
    "1. Open the provider's signing or webhook settings.",
    "2. Copy the signing secret, not an API or bot token.",
    `3. Paste it here as ${name}.`
  ];
  if (id === "github" && upper.includes("TOKEN")) return [
    "1. Create a fine-grained token for the target repository or organization.",
    "2. Grant only the scopes the project needs.",
    "3. Copy the token once and paste it here."
  ];
  if (upper.endsWith("_URL") || upper.includes("_URL_")) return [
    "1. Open the linked project settings or documentation.",
    `2. Copy the URL requested by ${name}.`,
    "3. Paste only the URL value here."
  ];
  if (upper.includes("PUBLISHABLE") || upper.includes("PUBLIC")) return [
    "1. Open the linked project settings or documentation.",
    `2. Copy the publishable value for ${name}.`,
    "3. Confirm it is intended to be public before using it in frontend code."
  ];
  return [
    "1. Open the linked provider page or documentation.",
    `2. Create, reveal, or copy the value for ${name}.`,
    "3. Paste it here; EnvHelper will not print it."
  ];
}

async function acceptValidatedValue(row, value, options) {
  if (!row.provider || !canValidateEnvVar(row.name, row.provider) || options.noValidate) return true;
  let allowed = Boolean(options.validate);
  if (!allowed && process.stdin.isTTY) {
    allowed = await promptYesNo(`Validate ${row.name} directly with ${row.provider.name}? `);
  }
  if (!allowed) return true;

  const result = await validateEnvValue(row.name, value, row.provider);
  const icon = result.ok === true ? "✓" : result.ok === false ? "✗" : "!";
  console.log(`${icon} ${result.message}`);
  if (result.ok !== false) return true;
  if (!process.stdin.isTTY) return false;
  return promptYesNo(`Save ${row.name} anyway? `);
}

function classifyEnvVar(name, provider, template) {
  const credentialLike = isKnownProviderEnvVar(name, provider) || isLikelyCredentialEnvVar(name);
  if (!credentialLike) return "config";
  if (template.hasTemplate) {
    if (template.required) return "required credential";
    if (template.blankOptional) return "optional credential";
    return "defaulted credential";
  }
  return isKnownProviderEnvVar(name, provider) ? "required credential" : "optional credential";
}

function summarizeTemplates(templates) {
  const hasTemplate = templates.length > 0;
  const blank = templates.filter((template) => !template.hasDefault);
  const required = hasTemplate && blank.length > 0 && blank.every((template) => !template.optional);
  return {
    hasTemplate,
    required,
    blankOptional: hasTemplate && !required && blank.length > 0,
    allHaveDefaults: hasTemplate && templates.every((template) => template.hasDefault)
  };
}

function isAiCredential(row) {
  const label = providerLabel(row).toLowerCase();
  return ["openai", "anthropic", "groq", "mistral", "cohere", "replicate", "pinecone"]
    .some((name) => label.includes(name)) || /(?:LLM|AI|EMBEDDING|MODEL)/.test(row.name);
}

function isIntegrationCredential(row) {
  const label = providerLabel(row).toLowerCase();
  return ["github", "jira", "slack", "discord", "linear", "notion", "airtable", "twilio"]
    .some((name) => label.includes(name));
}

function uniqueRows(rows) {
  const seen = new Set();
  return rows.filter((row) => !seen.has(row.name) && seen.add(row.name));
}

function providerLabel(row) {
  return row.provider?.name || "Unknown provider";
}

function looksFrontendPublic(name) {
  return name.startsWith("NEXT_PUBLIC_") || name.startsWith("VITE_") || name.startsWith("PUBLIC_");
}

function bestEnvUrl(provider, name) {
  const id = provider?.id?.toLowerCase();
  const upper = name.toUpperCase();
  if (id === "github" && upper.includes("WEBHOOK_SECRET")) {
    return "https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries";
  }
  if (id === "slack" && upper.includes("SIGNING_SECRET")) {
    return "https://docs.slack.dev/authentication/verifying-requests-from-slack/";
  }
  return provider?.keyUrl || provider?.docsUrl || provider?.sourceUrl || null;
}

async function invite(argv = []) {
  requireAge();
  const options = parseOptions(argv, {
    "--out": { key: "output", value: true },
    "--output": { key: "output", value: true }
  });
  const identity = await ensureAgeIdentity();

  console.log("Your EnvHelper invite code:\n");
  console.log(identity.publicKey);
  console.log("\nSend this public code to the person sharing the .env.");
  console.log(`Keep your private identity secret: ${identity.identityPath}`);

  if (options.output) {
    const outputPath = path.resolve(cwd, options.output);
    await safeWriteFile(outputPath, `${identity.publicKey}\n`, { mode: 0o644 });
    console.log(`\nWrote public invite file: ${path.relative(cwd, outputPath) || path.basename(outputPath)}`);
  }
}

async function share(argv = []) {
  requireAge();
  const options = parseOptions(argv, {
    "--recipient": { key: "recipients", value: true, multiple: true },
    "-r": { key: "recipients", value: true, multiple: true },
    "--recipients-file": { key: "recipientsFile", value: true },
    "--recipients-dir": { key: "recipientsDir", value: true },
    "--exclude": { key: "exclude", value: true, multiple: true },
    "--whole-env": { key: "wholeEnv" },
    "--interactive": { key: "interactive" },
    "--yes": { key: "yes" },
    "-y": { key: "yes" },
    "--dry-run": { key: "dryRun" },
    "--out": { key: "output", value: true },
    "--output": { key: "output", value: true }
  });

  if (options.wholeEnv && options.exclude?.length) {
    throw new Error("--whole-env cannot be combined with --exclude.");
  }
  if (options.interactive && !process.stdin.isTTY) {
    throw new Error("--interactive requires a terminal.");
  }

  const hasRecipients = options.recipients?.length || options.recipientsFile || options.recipientsDir;
  if (process.stdin.isTTY && !hasRecipients && !options.interactive && !existsSync(path.join(cwd, "invites"))) {
    return shareWizard(options);
  }
  return shareWithOptions(options);
}

async function shareWizard(options) {
  console.log("EnvHelper Share\n");
  console.log("1. Receive an invite code");
  console.log("2. Encrypt my .env for teammates");
  console.log("3. Decrypt a received .env.team.enc");
  console.log("4. Exit");

  const choice = await promptChoice("\nChoose [1]: ", ["1", "2", "3", "4"], "1");
  if (choice === "1") return invite([]);
  if (choice === "3") return join([]);
  if (choice === "4") return;
  return shareWithOptions({ ...options, interactive: true });
}

async function shareWithOptions(options) {
  const envPath = path.join(cwd, ".env");
  const outputPath = path.resolve(cwd, options.output || ".env.team.enc");
  const recipients = await collectRecipients(options);
  if (!recipients.length) {
    throw new Error("No recipients supplied. Ask each teammate to run `envhelper invite`, then use `envhelper share --recipient age1...`.");
  }

  let content;
  try {
    content = await readRegularFile(envPath, { encoding: "utf8", maxBytes: 10 * 1024 * 1024 });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("No .env file found in this directory.");
    throw error;
  }

  const payload = await prepareSharePayload(content, options);
  printSharePreview(payload, recipients.length, outputPath);

  if (options.dryRun) {
    console.log("\nDry run only; no encrypted bundle was written.");
    return;
  }

  if (process.stdin.isTTY && !options.yes) {
    const confirmed = await promptYesNo("\nEncrypt this payload? ");
    if (!confirmed) {
      console.log("Cancelled; no encrypted bundle was written.");
      return;
    }
  }

  const encrypted = encryptBundleContent({ content: payload.content, recipients });
  await safeWriteFile(outputPath, encrypted, { mode: 0o644 });
  console.log(`\nCreated ${path.relative(cwd, outputPath) || path.basename(outputPath)} for ${recipients.length} recipient(s).`);
  console.log("Share only the encrypted file. Rotate upstream keys when a recipient should lose access.");
}

async function prepareSharePayload(content, options) {
  if (!content.length) throw new Error(".env is empty; there is nothing to share.");
  if (options.wholeEnv) {
    let included = [];
    try {
      included = uniqueNames(parseEnvAssignments(content).map((entry) => entry.key));
    } catch {
      included = ["raw .env content"];
    }
    return {
      content,
      included,
      excluded: [],
      mode: "whole .env (including comments and unrecognized content)",
      wholeEnv: true
    };
  }

  const entries = parseEnvAssignments(content);
  let excluded;
  let mode;

  if (options.exclude?.length) {
    excluded = collectExcludedNames(options.exclude);
    mode = "custom exclusions";
  } else if (options.interactive || process.stdin.isTTY) {
    const choice = await chooseShareMode(entries);
    if (choice === null) throw new Error("Sharing cancelled.");
    if (choice.wholeEnv) {
      return {
        content,
        included: uniqueNames(entries.map((entry) => entry.key)),
        excluded: [],
        mode: "whole .env (including comments and unrecognized content)",
        wholeEnv: true
      };
    }
    excluded = choice.excluded;
    mode = choice.mode;
  } else {
    excluded = likelyPersonalShareEntries(entries).map((entry) => entry.key);
    mode = "automatic personal-key exclusions";
  }

  const filtered = filterEnvAssignments(entries, excluded);
  if (!filtered.included.length) {
    throw new Error("No environment assignments remain after exclusions.");
  }

  return {
    ...filtered,
    mode,
    wholeEnv: false
  };
}

async function chooseShareMode(entries) {
  const likelyPersonal = likelyPersonalShareEntries(entries);
  console.log("\nWhat should the encrypted bundle include?\n");
  console.log(`1. Environment assignments except likely personal keys (${likelyPersonal.length} detected)`);
  console.log("2. The whole .env, including comments and unrecognized content");
  console.log("3. Choose keys to exclude");
  console.log("4. Cancel");
  const choice = await promptChoice("\nChoose [1]: ", ["1", "2", "3", "4"], "1");

  if (choice === "4") return null;
  if (choice === "2") {
    return { mode: "whole .env", excluded: [], wholeEnv: true };
  }
  if (choice === "3") {
    return { mode: "custom exclusions", excluded: await promptForExcludedKeys(entries) };
  }
  return {
    mode: "automatic personal-key exclusions",
    excluded: likelyPersonal.map((entry) => entry.key)
  };
}

async function promptForExcludedKeys(entries) {
  const keys = uniqueNames(entries.map((entry) => entry.key));
  console.log("\nEnvironment keys:");
  keys.forEach((key, index) => console.log(`${index + 1}. ${key}`));
  const answer = await prompt("\nExclude which keys? Enter numbers or names, comma-separated: ");
  const excluded = [];
  for (const token of answer.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (/^\d+$/.test(token)) {
      const key = keys[Number(token) - 1];
      if (!key) throw new Error(`Unknown key number: ${token}`);
      excluded.push(key);
    } else {
      excluded.push(token);
    }
  }
  return uniqueNames(excluded);
}

function printSharePreview(payload, recipientCount, outputPath) {
  console.log("\nShare preview\n");
  console.log(`Recipients: ${recipientCount}`);
  console.log(`Output: ${path.relative(cwd, outputPath) || path.basename(outputPath)}`);
  console.log(`Mode: ${payload.mode}`);
  console.log(`Included (${payload.included.length}): ${summarizeNames(payload.included)}`);
  console.log(`Excluded (${payload.excluded.length}): ${payload.excluded.length ? summarizeNames(payload.excluded) : "none"}`);
  if (payload.wholeEnv) {
    console.log("Warning: whole-env mode can include secrets in comments or nonstandard syntax.");
  } else {
    console.log("Comments and unrecognized content are omitted from filtered bundles.");
  }
}

async function join(argv = []) {
  requireAge();
  const options = parseOptions(argv, {
    "--in": { key: "input", value: true },
    "--input": { key: "input", value: true },
    "--out": { key: "output", value: true },
    "--output": { key: "output", value: true },
    "--yes": { key: "yes" },
    "-y": { key: "yes" }
  });
  const identity = await ensureAgeIdentity({ create: false });
  if (!identity) throw new Error("No EnvHelper identity found. Run `envhelper invite` first.");

  const inputPath = path.resolve(cwd, options.input || ".env.team.enc");
  const outputPath = path.resolve(cwd, options.output || ".env");
  await assertSafeFile(outputPath, { allowMissing: true });

  if (existsSync(outputPath) && !options.yes) {
    if (!process.stdin.isTTY) throw new Error(`${path.basename(outputPath)} already exists; pass --yes to replace it.`);
    const confirmed = await promptYesNo(`${path.basename(outputPath)} already exists. Replace it? `);
    if (!confirmed) {
      console.log("Cancelled; the existing file was not changed.");
      return;
    }
  }

  let encrypted;
  try {
    encrypted = await readRegularFile(inputPath, { maxBytes: 32 * 1024 * 1024 });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`No ${path.basename(inputPath)} found.`);
    throw error;
  }

  if (outputPath === path.join(cwd, ".env")) await ensureEnvIgnored(cwd);
  const decrypted = decryptBundleContent({ encrypted, identityPath: identity.identityPath });
  await safeWriteFile(outputPath, decrypted, { mode: 0o600 });
  console.log(`Decrypted locally to ${path.relative(cwd, outputPath) || path.basename(outputPath)}${permissionSuffix()}.`);
}

async function collectRecipients(options) {
  const recipients = [...(options.recipients || [])];

  if (options.recipientsFile) {
    recipients.push(...await readRecipientsFile(path.resolve(cwd, options.recipientsFile)));
  }
  if (options.recipientsDir) {
    recipients.push(...await readRecipientsDir(path.resolve(cwd, options.recipientsDir)));
  }
  if (!recipients.length && existsSync(path.join(cwd, "invites"))) {
    recipients.push(...await readRecipientsDir(path.join(cwd, "invites")));
  }
  if (!recipients.length && options.interactive) {
    console.log("\nPaste teammate invite codes, one per line. Submit a blank line to finish.");
    while (true) {
      const value = await prompt("> ");
      if (!value.trim()) break;
      recipients.push(value.trim());
    }
  }

  return uniqueRecipients(recipients);
}

async function readRecipientsFile(filePath) {
  const content = await readRegularFile(filePath, { encoding: "utf8", maxBytes: 1024 * 1024 });
  return parseRecipientLines(content);
}

async function readRecipientsDir(dirPath) {
  const stat = await fs.lstat(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Recipient directory must be a real directory, not a symlink: ${dirPath}`);
  }
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const recipients = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".pub")) continue;
    recipients.push(...await readRecipientsFile(path.join(dirPath, entry.name)));
  }
  return recipients;
}

function parseRecipientLines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function uniqueRecipients(recipients) {
  const unique = uniqueNames(recipients);
  for (const recipient of unique) {
    if (!/^age1[0-9a-z]+$/.test(recipient)) {
      throw new Error(`Invalid age recipient: ${recipient}. Expected an age1... invite code.`);
    }
  }
  return unique;
}

function collectExcludedNames(values) {
  return uniqueNames(values.flatMap((value) => value.split(",")));
}

function uniqueNames(names) {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function summarizeNames(names, limit = 12) {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")}, ...and ${names.length - limit} more`;
}

function permissionSuffix() {
  return process.platform === "win32" ? "" : " with owner-only permissions";
}

function requireAge() {
  if (!hasAge()) {
    throw new Error("EnvHelper requires the `age` and `age-keygen` CLIs. Install them from https://age-encryption.org/ or run `brew install age`.");
  }
}

function parseOptions(argv, specs) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index];
    const equals = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inlineValue = equals === -1 ? null : raw.slice(equals + 1);
    const spec = specs[flag];
    if (!spec) throw new Error(`Unknown option: ${flag}`);

    let value = true;
    if (spec.value) {
      value = inlineValue;
      if (value === null) {
        value = argv[++index];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`${flag} requires a value.`);
        }
      }
      if (!value) throw new Error(`${flag} requires a non-empty value.`);
    } else if (inlineValue !== null) {
      throw new Error(`${flag} does not take a value.`);
    }

    if (spec.multiple) {
      if (!options[spec.key]) options[spec.key] = [];
      options[spec.key].push(value);
    } else {
      if (options[spec.key] !== undefined) throw new Error(`${flag} was provided more than once.`);
      options[spec.key] = value;
    }
  }
  return options;
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function promptSecret(question) {
  if (!process.stdin.isTTY) return readPipedLine(question);
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let value = "";
  let masked = false;
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          const error = new Error("Setup cancelled.");
          error.code = "ABORTED";
          reject(error);
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length) value = [...value].slice(0, -1).join("");
          continue;
        }
        if (/^[\u0000-\u001f]$/.test(char)) continue;
        value += char;
        if (!masked) {
          process.stdout.write("••••••••");
          masked = true;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

function readPipedLine(question) {
  process.stdout.write(question);
  if (!pipedInputLines) pipedInputLines = readFileSync(0, "utf8").split(/\r?\n/);
  return pipedInputLines[pipedInputIndex++] ?? "";
}

async function promptChoice(question, choices, defaultChoice) {
  while (true) {
    const answer = (await prompt(question)).trim() || defaultChoice;
    if (choices.includes(answer)) return answer;
    console.log(`Choose one of: ${choices.join(", ")}.`);
  }
}

async function promptYesNo(question) {
  const answer = (await prompt(`${question}[y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function version(argv = []) {
  if (argv.length) throw new Error(`Unexpected argument: ${argv[0]}`);
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  console.log(pkg.version);
}

function help(argv = []) {
  if (argv.length) throw new Error(`Unexpected argument: ${argv[0]}`);
  console.log(`EnvHelper - local .env setup and encrypted sharing

Main commands:
  envhelper setup                     Find required values and configure .env
  envhelper share                     Encrypt or receive a team .env

Sharing shortcuts:
  envhelper invite                    Create your public age1... invite code
  envhelper rekey                     Re-encrypt .env for a new recipient set
  envhelper join                      Decrypt .env.team.enc locally to .env

Common examples:
  envhelper setup
  envhelper setup --profile real-ai
  envhelper setup --dry-run
  envhelper invite --out alice.pub
  envhelper share --recipient age1...
  envhelper share --recipients-dir invites
  envhelper share --exclude GITHUB_TOKEN,PROD_DATABASE_URL
  envhelper share --whole-env
  envhelper share --dry-run --recipient age1...
  envhelper join

No EnvHelper server receives your secrets.`);
}

function commandHelp(name) {
  const helpText = {
    setup: "Usage: envhelper setup [--profile local-demo|real-ai|integrations|all-credentials|all] [--optional|--all] [--validate|--no-validate] [--dry-run]\n\nDiscover environment variables, show source-backed provider guidance, and save selected values locally to .env.",
    start: "Usage: envhelper start [setup options]\n\nAlias for envhelper setup.",
    invite: "Usage: envhelper invite [--out FILE]\n\nCreate or reuse a local age identity and print its public invite code.",
    share: "Usage: envhelper share [--recipient age1...] [--recipients-file FILE] [--recipients-dir DIR] [--exclude NAME[,NAME...]] [--whole-env] [--output FILE] [--dry-run] [--yes]\n\nEncrypt .env locally. Filtered mode omits comments and unrecognized content; --whole-env includes the raw file.",
    rekey: "Usage: envhelper rekey [share options]\n\nRe-encrypt the current .env for a fresh recipient set.",
    join: "Usage: envhelper join [--input FILE] [--output FILE] [--yes]\n\nDecrypt an age bundle locally. The output is written atomically with mode 0600.",
    version: "Usage: envhelper version\n\nPrint the EnvHelper version.",
    help: "Usage: envhelper help\n\nShow the command overview."
  };
  console.log(helpText[name] || helpText.share);
}
