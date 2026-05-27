#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { decryptBundle, ensureAgeIdentity, encryptBundleContent, hasAge } from "./crypto-age.js";
import { ensureEnvIgnored, parseEnvFile, upsertEnvFile, writeEnvExample } from "./envfile.js";
import { copyText, formatLink, googleSearchUrl, openUrl } from "./links.js";
import {
  envVarClientSafe,
  isKnownProviderEnvVar,
  isLikelyCredentialEnvVar,
  loadProviders,
  providerByQuery,
  providerForEnvVar,
  providerTable
} from "./providers.js";
import { doctor, scanProject } from "./scanner.js";
import { canValidateEnvVar, validateEnvValue } from "./validators.js";

const cwd = process.cwd();
let pipedInputLines = null;
let pipedInputIndex = 0;

const commands = {
  start,
  init: start,
  setup: start,
  needs: needsCommand,
  scan: needsCommand,
  add,
  link,
  links: link,
  doctor: doctorCommand,
  check: doctorCommand,
  example,
  validate: validateCommand,
  invite,
  share,
  rekey: share,
  join,
  providers: providersCommand,
  commands: commandsCommand,
  directory: commandsCommand,
  version,
  help
};

const command = process.argv[2] || "help";
const args = process.argv.slice(3);

if (command === "--help" || command === "-h") {
  help();
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  await version();
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  help();
  process.exit(1);
}

if (args.includes("--help") || args.includes("-h")) {
  commandHelp(command);
  process.exit(0);
}

try {
  await commands[command](args);
} finally {
  if (process.stdin.isTTY) process.stdin.pause();
}

async function start(argv = []) {
  banner();
  const options = parseArgs(argv);
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  const envPath = path.join(cwd, ".env");
  const existing = existsSync(envPath) ? await parseEnvFile(envPath) : {};
  const decisionLock = await readDecisionLock(cwd);
  const enriched = appendLocalEnvNames(enrichEnvVars(scan, providers), existing, providers, scan.packageNames).map((item) => ({
    ...item,
    status: existing[item.name] ? "set" : "missing"
  }));
  const profiles = buildSetupProfiles(enriched, decisionLock);
  const selectedProfile = await maybeChooseSetupProfile(profiles, options, decisionLock);
  const setupCandidates = selectedProfile
    ? selectedProfile.items
    : filterEnvRows(enriched, options);
  let setupItems = setupCandidates.filter((item) => item.status !== "set");

  while (selectedProfile && process.stdin.isTTY) {
    printSetupSummary(selectedProfile, enriched);
    const action = await chooseSetupAction(selectedProfile, setupItems, options);
    if (action === "profiles") {
      return start(["--choose-profile", ...argv.filter((arg) => arg !== "--profile" && arg !== selectedProfile.id)]);
    }
    if (action === "exit") {
      await maybeSaveDecisionLock(cwd, selectedProfile, profiles, decisionLock);
      return;
    }
    if (action === "links") {
      printProfileLinks(selectedProfile);
      await maybeSaveDecisionLock(cwd, selectedProfile, profiles, decisionLock);
      return;
    }
    if (action === "share") return share([]);
    if (action === "save") {
      await writeDecisionLock(cwd, selectedProfile, profiles);
      console.log("Saved .envhelper.lock decisions.");
      return;
    }
    break;
  }

  if (enriched.length === 0) {
    console.log("No env vars found. Add a .env.example or reference process.env.MY_KEY in code, then run again.");
    return;
  }

  const skipped = enriched.length - setupCandidates.length;
  const alreadySet = setupCandidates.length - setupItems.length;
  console.log(`Found ${enriched.length} env var(s).`);
  if (!options.all && !selectedProfile) {
    const scope = options.optional ? "required/optional credential" : "required setup value";
    console.log(`Missing ${setupItems.length} ${scope}(s); ${alreadySet} already set.`);
    if (skipped > 0) console.log(`Skipping ${skipped} optional/default/config value(s).`);
  } else if (selectedProfile) {
    console.log(`Using profile: ${selectedProfile.name}`);
    console.log(`Missing ${setupItems.length} value(s); ${alreadySet} already set.`);
  }

  if (setupItems.length) {
    console.log("\nSetup queue:\n");
    for (const item of setupItems) {
      const label = item.provider ? item.provider.name : "Unknown provider";
      console.log(`- ${item.name} (${label})`);
    }
    printOptionalPreview(enriched, options, "start");
  } else {
    const optionalMissing = enriched.filter((item) =>
      item.kind === "optional credential" &&
      item.status !== "set" &&
      shouldIncludeOptional(item, options)
    );
    const unknownOptionalMissing = enriched.filter((item) =>
      item.kind === "optional credential" &&
      item.status !== "set" &&
      !item.provider
    ).length;
    const templateOptionalMissing = enriched.filter((item) =>
      item.kind === "optional credential" &&
      item.status !== "set" &&
      item.provider &&
      isTemplateOnly(item)
    ).length;
    console.log("Nothing missing in the current setup scope.");
    if (!selectedProfile && !options.optional && !options.all && optionalMissing.length && process.stdin.isTTY) {
      printOptionalPreview(enriched, options, "start");
      const fillOptional = await promptYesNo("Fill optional credentials now? ");
      if (fillOptional) {
        options.optional = true;
        setupItems = filterEnvRows(enriched, options).filter((item) => item.status !== "set");
      }
    }
    if (setupItems.length) {
      console.log("\nSetup queue:\n");
      for (const item of setupItems) {
        const label = item.provider ? item.provider.name : "Unknown provider";
        console.log(`- ${item.name} (${label})`);
      }
    }
    if (!setupItems.length && optionalMissing.length) {
      console.log(`Found ${optionalMissing.length} optional missing credential(s). Run \`envhelper start --optional\` to fill them.`);
    }
    if (!setupItems.length && unknownOptionalMissing) {
      console.log(`Hidden: ${unknownOptionalMissing} unknown optional credential(s). Add \`--unknown\` if you really want those too.`);
    }
    if (!setupItems.length && templateOptionalMissing) {
      console.log(`Hidden: ${templateOptionalMissing} template-only optional credential(s). Add \`--template\` to include them.`);
    }
    if (!setupItems.length) console.log("Run `envhelper needs --all` to inspect optional/default/config values.");
  }

  await ensureEnvIgnored(cwd);
  const examplePath = path.join(cwd, ".env.example");
  if (!existsSync(examplePath)) {
    const created = await writeEnvExample(examplePath, setupItems.map((item) => item.name));
    if (created) console.log("Created .env.example with detected env vars.");
  }

  const updates = {};

  for (const item of setupItems) {
    if (existing[item.name]) continue;
    const provider = item.provider;
    printProviderCard(item);

    const value = await promptSecret(`Paste value for ${item.name}, or leave blank to skip: `);
    if (value.trim()) {
      const trimmed = value.trim();
      if (shouldValidate(options, item.name, provider)) {
        const save = await maybeValidateValue(item.name, trimmed, provider, options);
        if (!save) continue;
      }
      updates[item.name] = trimmed;
    }
  }

  if (Object.keys(updates).length) {
    await upsertEnvFile(envPath, updates);
    console.log(`\nSaved ${Object.keys(updates).length} value(s) to .env`);
  } else {
    console.log("\nNo new values saved.");
  }

  await writeMetadata(cwd, scan, providers);
  if (selectedProfile && process.stdin.isTTY) await maybeSaveDecisionLock(cwd, selectedProfile, profiles, decisionLock);
  console.log("\nNext: run `envhelper doctor` to check for leaks, or `envhelper share` to encrypt for teammates.");
}

async function add(argv = []) {
  const target = argv[0];
  if (!target) {
    console.error("Usage: envhelper add <provider-or-env-var>");
    process.exitCode = 1;
    return;
  }

  const options = parseArgs(argv.slice(1));
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  const provider = providerByQuery(target, providers) || providerForEnvVar(target, providers, scan.packageNames);
  const names = provider && !looksEnvVar(target)
    ? await chooseProviderVars(provider)
    : [target.toUpperCase()];

  if (!names.length) return;
  await ensureEnvIgnored(cwd);

  const envPath = path.join(cwd, ".env");
  const updates = {};

  for (const name of names) {
    const resolvedProvider = providerForEnvVar(name, providers, scan.packageNames) || provider;
    printProviderCard({ name, provider: resolvedProvider });
    const value = await promptSecret(`Paste value for ${name}, or leave blank to skip: `);
    if (!value.trim()) continue;
    const trimmed = value.trim();
    if (shouldValidate(options, name, resolvedProvider)) {
      const save = await maybeValidateValue(name, trimmed, resolvedProvider, options);
      if (!save) continue;
    }
    updates[name] = trimmed;
  }

  if (!Object.keys(updates).length) {
    console.log("No values saved.");
    return;
  }

  await upsertEnvFile(envPath, updates);
  await writeEnvExample(path.join(cwd, ".env.example"), Object.keys(updates));
  await mergeMetadata(cwd, Object.keys(updates), providers, scan.packageNames);
  console.log(`\nSaved ${Object.keys(updates).length} value(s), updated .env.example, and wrote .envhelper.json metadata.`);
}

async function needsCommand(argv = []) {
  const options = parseArgs(argv);
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  const envPath = path.join(cwd, ".env");
  const values = existsSync(envPath) ? await parseEnvFile(envPath) : {};
  const decisionLock = await readDecisionLock(cwd);
  const detectedRows = scan.envVars.map((item) => {
    const provider = providerForEnvVar(item.name, providers, scan.packageNames);
    const template = summarizeTemplates(item.templates || []);
    const kind = classifyEnvVar(item.name, provider, template);
    return {
      name: item.name,
      status: values[item.name] ? "set" : "missing",
      provider: provider?.name || null,
      providerId: provider?.id || null,
      kind,
      link: provider ? bestEnvUrl(provider, item.name) : kind.includes("credential") ? fallbackSearchUrl(item.name) : null,
      sources: item.sources
    };
  });
  const rows = appendLocalEnvNames(detectedRows, values, providers, scan.packageNames).map((row) => ({
    ...row,
    provider: row.provider && typeof row.provider === "object" ? row.provider.name : row.provider,
    providerId: row.provider && typeof row.provider === "object" ? row.provider.id : row.providerId,
    link: row.link || (row.provider && typeof row.provider === "object" ? bestEnvUrl(row.provider, row.name) : row.link),
    status: values[row.name] ? "set" : row.status || "missing"
  }));
  const needsProfile = selectLockedProfile(buildSetupProfiles(rows, decisionLock), options, decisionLock);
  if (needsProfile && !options.optional && !options.all) options.profileName = needsProfile.name;
  const visibleRows = needsProfile && !options.optional && !options.all
    ? needsProfile.items
    : filterEnvRows(rows, options);
  const missingRows = visibleRows.filter((row) => row.status !== "set");
  const setRows = visibleRows.filter((row) => row.status === "set");
  const displayRows = options.showSet ? visibleRows : missingRows;

  if (options.json) {
    console.log(JSON.stringify(visibleRows, null, 2));
    return;
  }

  if (!rows.length) {
    console.log("No env vars detected. Add a .env.example or run `envhelper add <provider>`.");
    return;
  }

  if (!visibleRows.length) {
    const optionalCount = rows.filter((row) => row.kind === "optional credential" && row.status !== "set" && shouldIncludeOptional(row, options)).length;
    console.log(`Found ${rows.length} env var(s), but none look required for setup.`);
    if (optionalCount) {
      console.log(`There are ${optionalCount} optional missing credential(s).`);
      printOptionalPreview(rows, options, "needs");
    }
    console.log("Run `envhelper needs --all` to show optional/default/config values too.");
    return;
  }

  const hidden = rows.length - visibleRows.length;
  console.log(needsHeading(options, missingRows.length, setRows.length));
  for (const row of displayRows) {
    printNeedsRow(row, options);
  }
  if (!options.showSet && setRows.length > 0) {
    console.log(`\nAlready set: ${setRows.length} hidden. Run \`envhelper needs ${needsFlagHint(options)}--show-set\` to include them.`);
  }
  if (!options.all && hidden > 0) {
    console.log(`\nSkipped ${hidden} optional/default/config value(s). Run \`envhelper needs --all\` to show them.`);
    printOptionalPreview(rows, options, "needs");
  }
}

async function link(argv = []) {
  const target = argv[0];
  if (!target) {
    console.error("Usage: envhelper link <provider-or-env-var> [--copy] [--open]");
    process.exitCode = 1;
    return;
  }

  const options = parseArgs(argv.slice(1));
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  const provider = providerByQuery(target, providers) || providerForEnvVar(target, providers, scan.packageNames);
  const url = provider ? bestProviderUrl(provider) : fallbackSearchUrl(target);
  const label = provider ? `${provider.name} key page` : `Google search for ${target}`;

  console.log(formatLink(label, url));

  if (options.copy) {
    console.log(copyText(url) ? "Copied link to clipboard." : "Could not copy link on this system.");
  }
  if (options.open) {
    console.log(openUrl(url) ? "Opened link in browser." : "Could not open link on this system.");
  }
}

async function doctorCommand(argv = []) {
  const providers = await loadProviders();
  if (argv.includes("--fix")) {
    const scan = await scanProject(cwd, providers);
    await ensureEnvIgnored(cwd);
    await writeEnvExample(path.join(cwd, ".env.example"), scan.envVars.map((item) => item.name));
    console.log("Applied safe fixes: ensured .env ignore rules and .env.example where possible.\n");
  }
  const result = await doctor(cwd, providers, { history: argv.includes("--history") || argv.includes("--full") });
  for (const check of result.checks) {
    const icon = check.level === "ok" ? "✓" : check.level === "warn" ? "!" : check.level === "info" ? "i" : "✗";
    console.log(`${icon} ${check.message}`);
  }
  if (result.findings.length) {
    console.log("\nFindings:");
    for (const finding of result.findings) {
      console.log(`- ${finding.file}:${finding.line} ${finding.message}`);
    }
  }
  if (result.exitCode) process.exitCode = result.exitCode;
}

async function example() {
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  if (!scan.envVars.length) {
    console.log("No env vars detected. Add references or .envhelper.json first.");
    return;
  }
  const created = await writeEnvExample(path.join(cwd, ".env.example"), scan.envVars.map((item) => item.name));
  console.log(created ? "Created .env.example" : ".env.example already exists");
}

async function validateCommand() {
  const providers = await loadProviders();
  const scan = await scanProject(cwd, providers);
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    console.error("No .env found. Run `envhelper start` first.");
    process.exitCode = 1;
    return;
  }
  const values = await parseEnvFile(envPath);
  let failures = 0;
  for (const item of scan.envVars) {
    if (!values[item.name]) continue;
    const provider = providerForEnvVar(item.name, providers, scan.packageNames);
    if (!canValidateEnvVar(item.name, provider)) {
      console.log(`! ${item.name}: no validator available`);
      continue;
    }
    const ok = await promptYesNo(`Validate ${item.name} with ${provider.name}? This sends the value directly to the provider. `);
    if (!ok) continue;
    const result = await validateEnvValue(item.name, values[item.name], provider);
    const icon = result.ok === true ? "✓" : result.ok === false ? "✗" : "!";
    console.log(`${icon} ${item.name}: ${result.message}`);
    if (result.ok === false) failures++;
  }
  if (failures) process.exitCode = 1;
}

async function invite(argv = []) {
  if (!hasAge()) {
    printAgeInstall();
    process.exitCode = 1;
    return;
  }
  const identity = await ensureAgeIdentity();
  console.log("Your EnvHelper invite code:\n");
  console.log(identity.publicKey);
  console.log("\nSend this public code to your team lead. Keep the private identity file secret:");
  console.log(identity.identityPath);
  const options = parseArgs(argv);
  if (options.out) {
    await fs.writeFile(path.resolve(cwd, options.out), `${identity.publicKey}\n`, "utf8");
    console.log(`\nWrote public invite file: ${options.out}`);
  }
}

async function share(argv = []) {
  if (!hasAge()) {
    printAgeInstall();
    process.exitCode = 1;
    return;
  }
  const options = parseArgs(argv);
  if (options.invite || options.out) return invite(argv);
  if (options.join) return join();
  if (process.stdin.isTTY && !hasExplicitRecipients(argv) && !options.interactive) {
    return shareWizard(argv);
  }

  const envPath = path.join(cwd, ".env");
  const bundlePath = path.join(cwd, ".env.team.enc");
  if (!existsSync(envPath) && existsSync(bundlePath)) return join();
  if (!existsSync(envPath) && !existsSync(bundlePath)) return invite(argv);

  if (!existsSync(envPath)) {
    console.error("No .env file found. Run `envhelper start` first.");
    process.exitCode = 1;
    return;
  }

  const recipients = await collectRecipients(argv, { interactive: options.interactive });
  if (!recipients.length) {
    await printShareNextStep(argv);
    return;
  }

  const outPath = path.join(cwd, ".env.team.enc");
  const payload = await prepareSharePayload(envPath, {
    interactive: process.stdin.isTTY || options.interactive,
    options
  });
  if (!payload) return;
  await encryptBundleContent({ content: payload.content, outputPath: outPath, recipients });
  console.log(`Created ${path.basename(outPath)} encrypted for ${recipients.length} recipient(s).`);
  printShareSummary(payload);
  console.log("Safe to share as ciphertext. Rotate upstream keys if a recipient should lose access later.");
}

async function shareWizard(argv = []) {
  console.log("EnvHelper Share\n");
  console.log("What are you doing?\n");
  console.log("1. I want to receive a shared .env");
  console.log("2. I want to share my .env with teammates");
  console.log("3. I received .env.team.enc and want to decrypt it");
  const answer = await prompt("\nChoose [1]: ");
  const choice = answer.trim() || "1";
  if (choice === "1") return invite(argv);
  if (choice === "3") return join();
  if (choice !== "2") return invite(argv);

  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    console.error("No .env file found. Run `envhelper start` first.");
    process.exitCode = 1;
    return;
  }
  console.log("\nTo share, each teammate first runs:");
  console.log("  envhelper invite");
  console.log("\nThey send you the age1... public invite code. Paste those below.");
  const recipients = await collectRecipients(argv, { interactive: true });
  if (!recipients.length) {
    console.log("No recipients entered. Nothing encrypted.");
    return;
  }
  const outPath = path.join(cwd, ".env.team.enc");
  const payload = await prepareSharePayload(envPath, { interactive: true, options: parseArgs(argv) });
  if (!payload) return;
  await encryptBundleContent({ content: payload.content, outputPath: outPath, recipients });
  console.log(`Created ${path.basename(outPath)} encrypted for ${recipients.length} recipient(s).`);
  printShareSummary(payload);
  console.log("Send .env.team.enc to teammates, or commit it if that is acceptable for your repo.");
}

async function prepareSharePayload(envPath, { interactive, options }) {
  const content = await fs.readFile(envPath, "utf8");
  const entries = collectEnvEntries(content);
  const explicitExcluded = collectExcludedNames(options);
  let excluded = [];
  let mode = "excluding likely personal keys";

  if (options.wholeEnv) {
    mode = "whole .env";
  } else if (explicitExcluded.length) {
    mode = "custom exclusions";
    excluded = explicitExcluded;
  } else if (interactive) {
    const choice = await chooseShareMode(entries);
    if (choice === "cancel") return null;
    mode = choice.mode;
    excluded = choice.excluded;
  } else {
    excluded = likelyPersonalShareEntries(entries).map((entry) => entry.key);
  }

  const filtered = filterEnvContent(content, excluded);
  if (!filtered.included.length) {
    console.log("No env values left to share after exclusions. Nothing encrypted.");
    return null;
  }

  return {
    content: filtered.content,
    included: filtered.included,
    excluded: filtered.excluded,
    mode
  };
}

async function chooseShareMode(entries) {
  const likelyPersonal = likelyPersonalShareEntries(entries);
  console.log("\nWhat should EnvHelper include?\n");
  console.log("1. Share .env excluding likely personal keys");
  console.log("2. Share whole .env");
  console.log("3. Choose keys to exclude");
  const answer = await prompt("\nChoose [1]: ");
  const choice = answer.trim() || "1";

  if (choice === "2") return { mode: "whole .env", excluded: [] };
  if (choice === "3") {
    const excluded = await promptForExcludedKeys(entries);
    return { mode: "custom exclusions", excluded };
  }
  if (choice !== "1") return { mode: "excluding likely personal keys", excluded: likelyPersonal.map((entry) => entry.key) };
  return { mode: "excluding likely personal keys", excluded: likelyPersonal.map((entry) => entry.key) };
}

async function promptForExcludedKeys(entries) {
  if (!entries.length) return [];
  console.log("\nEnv values in this file:");
  entries.forEach((entry, index) => {
    console.log(`${index + 1}. ${entry.key}`);
  });
  const answer = await prompt("\nExclude which keys? Enter numbers or names, comma-separated: ");
  const tokens = answer.split(",").map((token) => token.trim()).filter(Boolean);
  const excluded = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const entry = entries[Number(token) - 1];
      if (entry) excluded.push(entry.key);
      continue;
    }
    excluded.push(token);
  }
  return uniqueNames(excluded);
}

function printShareSummary(payload) {
  console.log(`Shared ${payload.included.length} env value(s) using ${payload.mode}.`);
  if (!payload.excluded.length) return;
  console.log(`Excluded ${payload.excluded.length}: ${payload.excluded.join(", ")}`);
}

function collectEnvEntries(content) {
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    entries.push({ key: match[1], value: unquoteEnvValue(match[2].trim()) });
  }
  return entries;
}

function filterEnvContent(content, excludedNames) {
  const excluded = new Set(excludedNames.map((name) => name.trim()).filter(Boolean));
  const included = [];
  const removed = [];
  const lines = content.split(/\r?\n/);
  const kept = [];

  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      kept.push(line);
      continue;
    }
    const key = match[1];
    if (excluded.has(key)) {
      removed.push(key);
      continue;
    }
    included.push(key);
    kept.push(line);
  }

  return {
    content: kept.join("\n").replace(/\s*$/, "\n"),
    included: uniqueNames(included),
    excluded: uniqueNames(removed)
  };
}

function collectExcludedNames(options) {
  const values = options.exclude || [];
  return uniqueNames(values.flatMap((value) => value.split(",").map((name) => name.trim())));
}

function likelyPersonalShareEntries(entries) {
  return entries.filter((entry) => isLikelyPersonalShareKey(entry.key, entry.value));
}

function isLikelyPersonalShareKey(name, value = "") {
  const upper = name.toUpperCase();
  const normalizedValue = value.trim();
  if (upper.includes("PERSONAL")) return true;
  if (upper.includes("PROD") || upper.includes("PRODUCTION")) return true;
  if (upper.endsWith("_PRIVATE_KEY") || upper === "PRIVATE_KEY" || upper === "SSH_PRIVATE_KEY") return true;
  if (/^(GH|GITHUB|GITLAB|NPM|VERCEL|NETLIFY|RAILWAY|RENDER|CLOUDFLARE)_(TOKEN|AUTH_TOKEN|API_TOKEN|ACCESS_TOKEN)$/.test(upper)) return true;
  if (/^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)$/.test(upper)) return true;
  if (/^(GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CREDENTIALS|AZURE_CLIENT_SECRET)$/.test(upper)) return true;
  if (/^(DOCKER_PASSWORD|DOCKER_TOKEN|HOMEBREW_GITHUB_API_TOKEN)$/.test(upper)) return true;
  if (normalizedValue.startsWith("sk_live_") || normalizedValue.startsWith("rk_live_")) return true;
  return false;
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

async function join() {
  if (!hasAge()) {
    printAgeInstall();
    process.exitCode = 1;
    return;
  }
  const identity = await ensureAgeIdentity({ create: false });
  if (!identity) {
    console.error("No EnvHelper identity found. Run `envhelper invite` first.");
    process.exitCode = 1;
    return;
  }
  const inputPath = path.join(cwd, ".env.team.enc");
  if (!existsSync(inputPath)) {
    console.error("No .env.team.enc found in this directory.");
    process.exitCode = 1;
    return;
  }
  const outputPath = path.join(cwd, ".env");
  if (existsSync(outputPath)) {
    const ok = await promptYesNo(".env already exists. Overwrite it? ");
    if (!ok) return;
  }
  await decryptBundle({ inputPath, outputPath, identityPath: identity.identityPath });
  await ensureEnvIgnored(cwd);
  console.log("Decrypted locally and wrote .env");
}

async function providersCommand(argv = []) {
  const options = parseArgs(argv);
  const providers = await loadProviders();
  const table = providerTable(providers);
  if (options.json) {
    console.log(JSON.stringify(table, null, 2));
    return;
  }
  for (const row of table) {
    console.log(`${row.name}`);
    console.log(`  id: ${row.id}`);
    console.log(`  env: ${row.env.join(", ") || "(patterns only)"}`);
    console.log(`  key: ${row.keyUrl || row.docsUrl || "(none)"}`);
    console.log(`  source: ${row.sourceUrl || row.docsUrl || "(none)"}`);
  }
}

function commandsCommand() {
  banner();
  console.log(`Main commands:
  envhelper start       Set up this repo's .env locally
  envhelper needs       Show what env vars are needed and where to get them
  envhelper share       Share or receive an encrypted .env
  envhelper doctor      Check for missing docs and likely secret leaks
  envhelper link        Find a provider's API key page
  envhelper commands    Show this command directory

Useful extras:
  envhelper start --profile real-ai
  envhelper needs --profile integrations
  envhelper add <provider-or-env-var>
  envhelper providers
  envhelper validate

Explicit sharing aliases:
  envhelper invite --out alice.pub
  envhelper share --recipients-dir invites
  envhelper share --exclude GITHUB_TOKEN,PROD_DATABASE_URL
  envhelper share --whole-env
  envhelper join
`);
}

async function version() {
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));
  console.log(pkg.version);
}

function help() {
  commandsCommand();
}

function commandHelp(name) {
  const text = {
    start: "Usage: envhelper start [--profile local-demo|real-ai|integrations] [--optional|--all] [--unknown] [--template] [--validate|--no-validate]\n\nScan the repo and guide setup for required credentials. In a terminal, EnvHelper offers setup profiles and an action summary. Use --profile to skip profile selection, --optional for optional known-provider credentials that are referenced outside the template, --template for template-only optional credentials, --unknown to include unknown optional credentials, or --all for every variable.",
    init: "Usage: envhelper init [--optional|--all] [--validate|--no-validate]\n\nAlias for start.",
    setup: "Usage: envhelper setup [--optional|--all] [--validate|--no-validate]\n\nAlias for start.",
    needs: "Usage: envhelper needs [--profile local-demo|real-ai|integrations] [--optional|--all] [--unknown] [--template] [--show-set] [--verbose] [--json]\n\nShow missing credentials and where to get them. If .envhelper.lock exists, EnvHelper uses its default profile. Use --profile to inspect another profile, --optional for optional known-provider credentials referenced outside the template, --template for template-only optional credentials, --unknown to include unknown optional credentials, --all for config values too, --show-set to include values already present in .env, or --verbose to show source files.",
    scan: "Usage: envhelper scan [--profile local-demo|real-ai|integrations] [--optional|--all] [--unknown] [--template] [--show-set] [--verbose] [--json]\n\nAlias for needs.",
    add: "Usage: envhelper add <provider-or-env-var> [--validate|--no-validate]\n\nAdd a provider or single env var to .env and .env.example.",
    link: "Usage: envhelper link <provider-or-env-var> [--copy] [--open]\n\nPrint, copy, or open a source-backed provider link. Unknown providers use Google search.",
    links: "Usage: envhelper links <provider-or-env-var> [--copy] [--open]\n\nAlias for link.",
    doctor: "Usage: envhelper doctor [--fix] [--history|--full]\n\nCheck .env hygiene, likely leaks, frontend exposure, and optional recent git history.",
    check: "Usage: envhelper check [--fix] [--history|--full]\n\nAlias for doctor.",
    example: "Usage: envhelper example\n\nGenerate .env.example from detected env vars.",
    validate: "Usage: envhelper validate\n\nValidate local .env values with providers after explicit consent.",
    invite: "Usage: envhelper invite [--out teammate.pub]\n\nCreate or reuse a local age identity and print the public invite code.",
    share: "Usage: envhelper share [--out teammate.pub] [--recipient age1...] [--recipients-file file] [--recipients-dir dir] [--exclude NAME[,NAME...]] [--whole-env] [--interactive] [--join]\n\nSmart sharing command. Without recipients it explains the flow and prints your invite code. With recipient codes it encrypts .env. Interactive sharing lets you exclude likely personal keys, share the whole .env, or choose exclusions. Non-interactive sharing excludes likely personal keys by default unless --whole-env is passed.",
    rekey: "Usage: envhelper rekey [--recipient age1...] [--recipients-file file] [--recipients-dir dir] [--exclude NAME[,NAME...]] [--whole-env]\n\nAlias for share; re-encrypts the current local .env to a fresh recipient set.",
    join: "Usage: envhelper join\n\nDecrypt .env.team.enc locally into .env.",
    providers: "Usage: envhelper providers [--json]\n\nList the built-in source-backed provider directory.",
    commands: "Usage: envhelper commands\n\nShow the simplified command directory.",
    directory: "Usage: envhelper directory\n\nAlias for commands.",
    version: "Usage: envhelper version\n\nPrint the EnvHelper version.",
    help: "Usage: envhelper help\n\nShow the main help."
  }[name];
  console.log(text || "Usage: envhelper help");
}

function banner() {
  console.log("EnvHelper - local-first .env setup and sharing\n");
}

async function printShareNextStep(argv = []) {
  console.log("Sharing needs one public invite code from each teammate.");
  console.log("Ask each teammate to run:");
  console.log("  envhelper invite");
  console.log("\nThen encrypt your .env with:");
  console.log("  envhelper share --recipient age1...");
  console.log("\nOr put teammate .pub files in ./invites and run:");
  console.log("  envhelper share");
  console.log("\nIf someone else is sharing with you, send them your invite code:");
  console.log("");
  await invite(argv);
}

function hasExplicitRecipients(argv) {
  return argv.some((arg) =>
    arg === "--recipient" ||
    arg === "-r" ||
    arg === "--recipients-file" ||
    arg === "--recipients-dir"
  ) || existsSync(path.join(cwd, "invites"));
}

async function collectRecipients(argv, options = {}) {
  const recipients = [];
  const parsed = parseArgs(argv);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--recipient" || argv[i] === "-r") {
      const value = argv[i + 1];
      if (value) {
        recipients.push(value.trim());
        i++;
      }
    }
  }
  if (parsed.recipientsFile) {
    recipients.push(...await readRecipientsFile(path.resolve(cwd, parsed.recipientsFile)));
  }
  if (parsed.recipientsDir) {
    recipients.push(...await readRecipientsDir(path.resolve(cwd, parsed.recipientsDir)));
  }
  if (!recipients.length && existsSync(path.join(cwd, "invites"))) {
    recipients.push(...await readRecipientsDir(path.join(cwd, "invites")));
  }
  if (recipients.length) return uniqueRecipients(recipients);
  if (!options.interactive) return [];

  console.log("Paste teammate invite codes, one per line. Blank line to finish.");
  while (true) {
    const value = await prompt("> ");
    if (!value.trim()) break;
    recipients.push(value.trim());
  }
  return uniqueRecipients(recipients);
}

async function writeMetadata(root, scan, providers) {
  const names = scan.envVars.map((item) => item.name);
  const metadata = buildMetadata(root, names, providers, scan.packageNames);
  await writeMetadataFile(root, metadata);
}

async function mergeMetadata(root, names, providers, packageNames = []) {
  const file = path.join(root, ".envhelper.json");
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    existing = {};
  }
  const required = [...new Set([...(existing.required || []), ...names])].sort();
  const metadata = buildMetadata(root, required, providers, packageNames);
  await writeMetadataFile(root, metadata);
}

async function writeMetadataFile(root, metadata) {
  try {
    await fs.writeFile(path.join(root, ".envhelper.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    console.log("Wrote non-secret .envhelper.json metadata.");
  } catch (error) {
    console.log(`Skipped .envhelper.json metadata: ${error.code || error.message}`);
  }
}

function buildMetadata(root, names, providers, packageNames = []) {
  return {
    version: 1,
    generatedBy: "envhelper",
    project: path.basename(root),
    detected: [...new Set(names)].sort(),
    providers: Object.fromEntries(
      [...new Set(names)].sort().map((name) => {
        const provider = providerForEnvVar(name, providers, packageNames);
        return [name, provider?.id || null];
      })
    )
  };
}

function looksFrontendPublic(name) {
  return name.startsWith("NEXT_PUBLIC_") || name.startsWith("VITE_") || name.startsWith("PUBLIC_");
}

async function readDecisionLock(root) {
  try {
    const lock = JSON.parse(await fs.readFile(path.join(root, ".envhelper.lock"), "utf8"));
    return lock?.generatedBy === "envhelper" ? lock : null;
  } catch {
    return null;
  }
}

async function writeDecisionLock(root, profile, profiles) {
  const lock = {
    version: 1,
    generatedBy: "envhelper",
    defaultProfile: profile.id,
    profiles: Object.fromEntries(profiles.map((entry) => [
      entry.id,
      {
        name: entry.name,
        description: entry.description,
        env: entry.items.map((item) => item.name).sort()
      }
    ]))
  };
  await fs.writeFile(path.join(root, ".envhelper.lock"), `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

async function maybeSaveDecisionLock(root, profile, profiles, existingLock) {
  if (existingLock || !process.stdin.isTTY) return;
  const ok = await promptYesNo("Save these setup decisions to .envhelper.lock? ", true);
  if (!ok) return;
  await writeDecisionLock(root, profile, profiles);
  console.log("Saved .envhelper.lock decisions.");
}

function buildSetupProfiles(rows, decisionLock) {
  if (decisionLock?.profiles) {
    const locked = Object.entries(decisionLock.profiles)
      .map(([id, profile]) => ({
        id,
        name: profile.name || id,
        description: profile.description || "Saved project setup profile",
        items: rows.filter((row) => (profile.env || []).includes(row.name))
      }))
      .filter((profile) => profile.items.length);
    if (locked.length) return locked;
  }

  const required = rows.filter((row) => row.kind === "required credential");
  const knownCredentials = rows.filter((row) => row.kind.includes("credential") && row.provider);
  const realAi = uniqueRows([
    ...required,
    ...knownCredentials.filter((row) => isAiCredential(row))
  ]);
  const integrations = uniqueRows([
    ...required,
    ...knownCredentials.filter((row) => isIntegrationCredential(row))
  ]);
  const knownOptional = uniqueRows([
    ...required,
    ...knownCredentials.filter((row) => row.kind === "optional credential" && !isTemplateOnly(row))
  ]);

  return [
    {
      id: "local-demo",
      name: "Local demo",
      description: "Required values only. Best for getting the app running locally.",
      items: required
    },
    {
      id: "real-ai",
      name: "Real AI mode",
      description: "Required values plus AI provider keys such as OpenAI or Anthropic.",
      items: realAi
    },
    {
      id: "integrations",
      name: "Integrations mode",
      description: "Required values plus GitHub, Jira, Slack, and similar integration keys.",
      items: integrations
    },
    {
      id: "known-optional",
      name: "Known optional keys",
      description: "Required values plus optional known-provider keys referenced by the repo.",
      items: knownOptional
    }
  ].filter((profile) => profile.items.length);
}

function selectLockedProfile(profiles, options, decisionLock) {
  if (!profiles.length) return null;
  if (options.profile) return profiles.find((profile) => profile.id === options.profile) || null;
  if (decisionLock?.defaultProfile) return profiles.find((profile) => profile.id === decisionLock.defaultProfile) || null;
  return null;
}

async function maybeChooseSetupProfile(profiles, options, decisionLock) {
  if (!profiles.length) return null;
  const locked = selectLockedProfile(profiles, options, decisionLock);
  if (locked && !options.chooseProfile) return locked;
  if (!process.stdin.isTTY || options.optional || options.all) return null;

  console.log("Setup profiles:\n");
  profiles.forEach((profile, index) => {
    const missing = profile.items.filter((item) => item.status !== "set").length;
    const set = profile.items.length - missing;
    console.log(`${index + 1}. ${profile.name}`);
    console.log(`   ${profile.description}`);
    console.log(`   ${missing} missing, ${set} set`);
  });
  const answer = await prompt("\nChoose setup profile [1]: ");
  const index = Number(answer.trim() || "1") - 1;
  return profiles[index] || profiles[0];
}

function printSetupSummary(profile, allRows) {
  console.log("\nEnvHelper setup\n");
  console.log(`Profile: ${profile.name}`);
  console.log(profile.description);
  console.log("");

  const grouped = groupRowsByProvider(profile.items);
  for (const group of grouped) {
    const total = group.items.length;
    const set = group.items.filter((item) => item.status === "set").length;
    const mark = set === total ? "✓" : "!";
    console.log(`${mark} ${group.name}: ${set}/${total} set`);
    for (const item of group.items.filter((row) => row.status !== "set").slice(0, 4)) {
      console.log(`  ! ${item.name}`);
    }
  }

  const otherKnown = allRows.filter((row) =>
    row.kind === "optional credential" &&
    row.status !== "set" &&
    row.provider &&
    !profile.items.some((item) => item.name === row.name)
  );
  if (otherKnown.length) {
    console.log("\nOther optional known-provider keys:");
    for (const item of otherKnown.slice(0, 5)) console.log(`- ${item.name} (${providerLabel(item)})`);
    if (otherKnown.length > 5) console.log(`- ...and ${otherKnown.length - 5} more`);
  }
  console.log("");
}

async function chooseSetupAction(profile, setupItems) {
  const hasMissing = setupItems.length > 0;
  console.log("What do you want to do?");
  console.log(`1. ${hasMissing ? "Fill missing values" : "Check setup status"}`);
  console.log("2. Show key links");
  console.log("3. Share current .env");
  console.log("4. Save decisions to .envhelper.lock");
  console.log("5. Pick a different profile");
  console.log("6. Exit");
  const answer = await prompt(`Choose [${hasMissing ? "1" : "5"}]: `);
  const choice = answer.trim() || (hasMissing ? "1" : "5");
  return {
    "1": hasMissing ? "fill" : "exit",
    "2": "links",
    "3": "share",
    "4": "save",
    "5": "profiles",
    "6": "exit"
  }[choice] || (hasMissing ? "fill" : "exit");
}

function printProfileLinks(profile) {
  console.log(`\nLinks for ${profile.name}:\n`);
  const seen = new Set();
  for (const item of profile.items) {
    const key = `${item.name}:${providerLabel(item)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`${item.name}`);
    if (item.provider) {
      const url = bestEnvUrl(item.provider, item.name);
      if (url) console.log(`  ${formatLink(`${item.provider.name} key page`, url)}`);
      if (item.provider.docsUrl) console.log(`  docs: ${formatLink("docs", item.provider.docsUrl)}`);
    } else {
      console.log(`  ${formatLink("Google search", fallbackSearchUrl(item.name))}`);
    }
  }
}

function printProviderCard(item) {
  const provider = item.provider;
  console.log("");
  console.log(provider ? `${provider.name} setup` : `${item.name} setup`);
  console.log("");
  if (provider) {
    console.log(`Value: ${item.name}`);
    const keyUrl = bestEnvUrl(provider, item.name);
    if (keyUrl) console.log(`Where: ${formatLink("open key page", keyUrl)}`);
    const docsUrl = docsEnvUrl(provider, item.name);
    if (docsUrl) console.log(`Docs: ${formatLink("open docs", docsUrl)}`);
    console.log("Steps:");
    for (const step of providerSteps(provider, item.name)) console.log(`  ${step}`);
    if (envVarClientSafe(item.name, provider) === false && looksFrontendPublic(item.name)) {
      console.log("Warning: this looks frontend-exposed, but the provider marks it as secret.");
    }
    const notes = envNotes(provider, item.name);
    if (notes.length) {
      for (const note of notes) console.log(`Note: ${note}`);
    }
  } else {
    console.log("Provider: unknown");
    console.log(`Search: ${formatLink("Google search", fallbackSearchUrl(item.name))}`);
    console.log("Steps:");
    console.log("  1. Use the search link to find the provider docs.");
    console.log("  2. Paste the value locally, or leave blank if this project mode does not need it.");
  }
}

function providerSteps(provider, name) {
  const lower = provider.id?.toLowerCase();
  const upper = name.toUpperCase();
  if (upper.includes("WEBHOOK_SECRET")) return [
    "1. Generate a long random string, for example with a password manager or `openssl rand -hex 32`.",
    "2. Paste that same string into the provider's webhook Secret field.",
    `3. Paste the same string here as ${name}.`,
    "4. Do not use an access token for this value."
  ];
  if (lower === "slack" && upper.includes("SIGNING_SECRET")) return [
    "1. Open your Slack app's Basic Information page.",
    "2. Copy the Signing Secret, not a bot/user token.",
    `3. Paste it here as ${name}.`,
    "4. Use it server-side to verify Slack request signatures."
  ];
  if (upper.includes("SIGNING_SECRET")) return [
    "1. Open the linked provider settings or docs.",
    "2. Copy the signing secret for request/webhook verification.",
    `3. Paste it here as ${name}.`,
    "4. Do not use an API token for this value."
  ];
  if (lower === "github" && upper.includes("TOKEN")) return [
    "1. Create a fine-grained token for the target repo or org.",
    "2. Give it the smallest scopes this project needs.",
    "3. Copy the token once and paste it here."
  ];
  if (lower === "jira" && upper.includes("TOKEN")) return [
    "1. Open Atlassian account API tokens.",
    "2. Create a token for this project.",
    "3. Pair it with your Jira email/domain in .env."
  ];
  if (lower === "slack" && upper.includes("TOKEN")) return [
    "1. Open your Slack app configuration.",
    "2. Copy the bot/user/app token requested by this variable.",
    "3. Keep it server-side only."
  ];
  if (upper.endsWith("_URL") || upper.includes("_URL_")) return [
    "1. Open the linked provider docs or project settings.",
    `2. Copy the URL requested by ${name}.`,
    "3. Paste only the URL value here."
  ];
  if (upper.includes("PUBLISHABLE") || upper.includes("PUBLIC")) return [
    "1. Open the linked provider docs or project settings.",
    `2. Copy the publishable/public value for ${name}.`,
    "3. Confirm this value is intended to be public before using it in frontend code."
  ];
  return [
    "1. Open the linked provider page or docs.",
    `2. Create, reveal, or copy the value for ${name}.`,
    "3. Copy it once and paste it here."
  ];
}

function groupRowsByProvider(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = providerLabel(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((left, right) =>
      (left.name.toLowerCase().startsWith("unknown") ? 1 : 0) -
      (right.name.toLowerCase().startsWith("unknown") ? 1 : 0) ||
      left.name.localeCompare(right.name)
    );
}

function uniqueRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.name)) return false;
    seen.add(row.name);
    return true;
  });
}

function isAiCredential(row) {
  const provider = providerLabel(row).toLowerCase();
  return [
    "openai",
    "anthropic",
    "groq",
    "mistral",
    "cohere",
    "replicate",
    "pinecone"
  ].some((name) => provider.includes(name)) || /(?:LLM|AI|EMBEDDING|MODEL)/.test(row.name);
}

function isIntegrationCredential(row) {
  const provider = providerLabel(row).toLowerCase();
  return [
    "github",
    "jira",
    "slack",
    "discord",
    "linear",
    "notion",
    "airtable",
    "twilio"
  ].some((name) => provider.includes(name));
}

function appendLocalEnvNames(rows, values, providers, packageNames = []) {
  const seen = new Set(rows.map((row) => row.name));
  const additions = [];
  for (const name of Object.keys(values || {})) {
    if (seen.has(name)) continue;
    const provider = providerForEnvVar(name, providers, packageNames);
    const template = summarizeTemplates([]);
    const kind = classifyEnvVar(name, provider, template);
    additions.push({
      name,
      sources: [".env"],
      provider,
      template,
      kind,
      actionable: false,
      status: "set"
    });
  }
  return [...rows, ...additions].sort((a, b) => a.name.localeCompare(b.name));
}

function enrichEnvVars(scan, providers) {
  return scan.envVars.map((item) => {
    const provider = providerForEnvVar(item.name, providers, scan.packageNames);
    const template = summarizeTemplates(item.templates || []);
    const kind = classifyEnvVar(item.name, provider, template);
    return {
      ...item,
      provider,
      template,
      kind,
      actionable: kind === "required credential"
    };
  });
}

function filterEnvRows(rows, options) {
  if (options.all) return rows;
  if (options.optional) {
    return rows.filter((row) =>
      row.kind === "required credential" ||
      (row.kind === "optional credential" && shouldIncludeOptional(row, options))
    );
  }
  return rows.filter((row) => row.kind === "required credential");
}

function shouldIncludeOptional(row, options) {
  if (!options.unknown && !row.provider) return false;
  if (!options.template && isTemplateOnly(row)) return false;
  return true;
}

function isTemplateOnly(row) {
  const sources = row.sources || [];
  return sources.length > 0 && sources.every((source) => source === ".env.example" || source === ".envhelper.json");
}

function printOptionalPreview(rows, options, command) {
  if (options.optional || options.all) return;
  const optional = rows
    .filter((row) => row.kind === "optional credential" && row.status !== "set" && shouldIncludeOptional(row, options))
    .sort((left, right) => providerRank(left) - providerRank(right) || left.name.localeCompare(right.name));
  if (!optional.length) return;
  const shown = optional.slice(0, 5);
  console.log("\nOptional credentials detected:");
  for (const row of shown) {
    console.log(`- ${row.name} (${providerLabel(row)})`);
  }
  if (optional.length > shown.length) console.log(`- ...and ${optional.length - shown.length} more`);
  console.log(`Run \`envhelper ${command} --optional\` to include these.`);
  const unknownCount = rows.filter((row) => row.kind === "optional credential" && row.status !== "set" && !row.provider).length;
  if (unknownCount) console.log(`Hidden: ${unknownCount} unknown optional credential(s). Add \`--unknown\` if you really want those too.`);
  const templateCount = rows.filter((row) => row.kind === "optional credential" && row.status !== "set" && row.provider && isTemplateOnly(row)).length;
  if (templateCount) console.log(`Hidden: ${templateCount} template-only optional credential(s). Add \`--template\` to include them.`);
}

function needsHeading(options, missingCount, setCount) {
  const scope = options.profileName
    ? `${options.profileName} profile values`
    : options.all ? "all categories" : options.optional ? "required/optional credentials" : "required setup values";
  if (missingCount) return `Missing ${scope}:`;
  if (options.showSet) return `No missing ${scope}. Showing ${setCount} already set value(s):`;
  return `No missing ${scope}.`;
}

function needsFlagHint(options) {
  if (options.all) return "--all ";
  if (options.optional) return "--optional ";
  return "";
}

function printNeedsRow(row, options) {
  const mark = row.status === "set" ? "✓" : "!";
  const provider = providerLabel(row);
  const detail = options.all || options.optional ? `${row.kind}, ${provider}` : provider;
  console.log(`${mark} ${row.name} (${detail})`);
  if (row.link) console.log(`  ${formatLink(row.provider ? "open key page" : "Google search", row.link)}`);
  if (options.verbose) console.log(`  found in: ${row.sources.join(", ")}`);
}

function providerLabel(row) {
  if (!row.provider) return "Unknown provider";
  if (typeof row.provider === "string") return row.provider;
  return row.provider.name || "Unknown provider";
}

function providerRank(row) {
  return providerLabel(row).toLowerCase().startsWith("unknown") ? 1 : 0;
}

function classifyEnvVar(name, provider, template = summarizeTemplates([])) {
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
  const blankTemplates = templates.filter((template) => !template.hasDefault);
  const required = hasTemplate && blankTemplates.length > 0 && blankTemplates.every((template) => !template.optional);
  const blankOptional = hasTemplate && !required && blankTemplates.length > 0;
  return { hasTemplate, required, blankOptional };
}

function fallbackSearchUrl(name) {
  return googleSearchUrl(name);
}

function bestProviderUrl(provider) {
  return provider?.keyUrl || provider?.docsUrl || provider?.sourceUrl || null;
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
  return bestProviderUrl(provider);
}

function docsEnvUrl(provider, name) {
  return bestEnvUrl(provider, name) || provider?.docsUrl || null;
}

function envNotes(provider, name) {
  const id = provider?.id?.toLowerCase();
  const upper = name.toUpperCase();
  if (id === "github" && upper.includes("WEBHOOK_SECRET")) {
    return ["This is not a GitHub access token. It is used only to verify webhook signatures."];
  }
  if (upper.includes("WEBHOOK_SECRET")) {
    return ["This is not an access token. It is used only to verify webhook signatures."];
  }
  if (id === "slack" && upper.includes("SIGNING_SECRET")) {
    return ["This is not a Slack bot token. It is used only to verify Slack request signatures."];
  }
  if (upper.includes("SIGNING_SECRET")) {
    return ["This is not an API token. It is used only to verify signed requests."];
  }
  return provider?.notes || [];
}

function looksEnvVar(value) {
  return /^[A-Z][A-Z0-9_]*$/.test(value);
}

async function chooseProviderVars(provider) {
  const names = provider.env || [];
  if (names.length <= 1) return names;
  console.log(`${provider.name} has multiple known env vars:`);
  names.forEach((name, index) => console.log(`${index + 1}. ${name}`));
  const answer = await prompt("Choose numbers separated by commas, or press enter for all: ");
  if (!answer.trim()) return names;
  const selected = answer
    .split(",")
    .map((part) => Number(part.trim()) - 1)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < names.length);
  return [...new Set(selected.map((index) => names[index]))];
}

function parseArgs(argv) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--validate") options.validate = true;
    else if (arg === "--no-validate") options.noValidate = true;
    else if (arg === "--copy") options.copy = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--show-set") options.showSet = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--unknown") options.unknown = true;
    else if (arg === "--template") options.template = true;
    else if (arg === "--interactive") options.interactive = true;
    else if (arg === "--choose-profile") options.chooseProfile = true;
    else if (arg === "--invite") options.invite = true;
    else if (arg === "--join") options.join = true;
    else if (arg === "--whole-env") options.wholeEnv = true;
    else if (arg === "--all" || arg === "-all") options.all = true;
    else if (arg === "--optional" || arg === "-optional") options.optional = true;
    else if (arg === "--exclude") {
      if (!options.exclude) options.exclude = [];
      options.exclude.push(argv[++i] || "");
    }
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--profile") options.profile = argv[++i];
    else if (arg === "--recipients-file") options.recipientsFile = argv[++i];
    else if (arg === "--recipients-dir") options.recipientsDir = argv[++i];
    else options._.push(arg);
  }
  return options;
}

function shouldValidate(options, name, provider) {
  if (options.noValidate) return false;
  if (options.validate) return true;
  return canValidateEnvVar(name, provider);
}

async function maybeValidateValue(name, value, provider, options) {
  if (!canValidateEnvVar(name, provider)) return true;
  const allowed = options.validate || await promptYesNo(`Validate ${name} with ${provider.name}? This sends the value directly to ${provider.name}. `);
  if (!allowed) return true;
  const result = await validateEnvValue(name, value, provider);
  const icon = result.ok === true ? "✓" : result.ok === false ? "✗" : "!";
  console.log(`${icon} ${result.message}`);
  if (result.ok === false) {
    const saveAnyway = await promptYesNo(`Save ${name} anyway? `);
    if (!saveAnyway) return false;
  }
  return true;
}

async function readRecipientsFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return parseRecipientLines(content);
}

async function readRecipientsDir(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
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
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => line.startsWith("age1"));
}

function uniqueRecipients(recipients) {
  return [...new Set(recipients.map((recipient) => recipient.trim()).filter(Boolean))];
}

function uniqueNames(names) {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

async function prompt(question) {
  if (!process.stdin.isTTY) return readPipedLine(question);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    console.log("");
    return answer;
  } finally {
    rl.close();
  }
}

function readPipedLine(question) {
  process.stdout.write(question);
  if (!pipedInputLines) pipedInputLines = readFileSync(0, "utf8").split(/\r?\n/);
  return pipedInputLines[pipedInputIndex++] ?? "";
}

async function promptSecret(question) {
  if (!process.stdin.isTTY) return prompt(question);
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let value = "";
  return await new Promise((resolve) => {
    const onData = (char) => {
      if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (char === "\r" || char === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.off("data", onData);
        process.stdin.pause();
        process.stdout.write("\n\n");
        resolve(value);
        return;
      }
      if (char === "\u007f") {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      value += char;
      process.stdout.write("*");
    };
    process.stdin.on("data", onData);
  });
}

async function promptYesNo(question, defaultYes = false) {
  const answer = await prompt(`${question}${defaultYes ? "[Y/n]" : "[y/N]"} `);
  const normalized = answer.trim().toLowerCase();
  if (!normalized) return defaultYes;
  return normalized === "y" || normalized === "yes";
}

function printAgeInstall() {
  console.error("EnvHelper sharing requires the `age` CLI.");
  console.error("Install from https://age-encryption.org/ or with Homebrew: brew install age");
}
