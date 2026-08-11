#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerFile = path.join(root, "providers", "providers.json");
const directory = JSON.parse(fs.readFileSync(providerFile, "utf8"));

const errors = [];
const envOwners = new Map();
const disallowedExactEnv = new Set([
  "API_KEY",
  "SECRET_KEY",
  "TOKEN",
  "ACCESS_TOKEN",
  "AUTH_TOKEN",
  "DATABASE_URL",
  "POSTGRES_URL"
]);

if (directory.version !== 1) errors.push("providers.version must be 1");
if (!Array.isArray(directory.providers)) errors.push("providers.providers must be an array");
if ((directory.providers || []).length < 30) errors.push("provider directory should contain at least 30 curated providers");

const ids = new Set();
for (const provider of directory.providers || []) {
  const label = provider.id || provider.name || "(missing id)";

  requireString(provider.id, `${label}.id`);
  requireString(provider.name, `${label}.name`);
  requireString(provider.sourceUrl, `${label}.sourceUrl`);
  requireString(provider.sourceKind, `${label}.sourceKind`);
  if (provider.sourceKind && provider.sourceKind !== "official-docs") {
    errors.push(`${label}.sourceKind must be official-docs`);
  }

  if (ids.has(provider.id)) errors.push(`duplicate provider id: ${provider.id}`);
  ids.add(provider.id);

  if (!provider.keyUrl && !provider.docsUrl) {
    errors.push(`${label} needs keyUrl or docsUrl`);
  }

  for (const field of ["keyUrl", "docsUrl", "sourceUrl"]) {
    if (provider[field]) validateUrl(provider[field], `${label}.${field}`);
  }

  for (const env of provider.env || []) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(env)) errors.push(`${label}.env contains invalid env var: ${env}`);
    if (disallowedExactEnv.has(env)) {
      errors.push(`${label}.env maps generic env var ${env}; use provider-specific names or package hints instead`);
    }
    if (envOwners.has(env)) {
      errors.push(`duplicate env var ${env}: ${envOwners.get(env)} and ${provider.id}`);
    }
    envOwners.set(env, provider.id);
  }

  for (const pattern of provider.envPatterns || []) {
    try {
      new RegExp(pattern);
    } catch (error) {
      errors.push(`${label}.envPatterns has invalid regex ${pattern}: ${error.message}`);
    }
  }

  for (const env of Object.keys(provider.envSafety || {})) {
    if (!(provider.env || []).includes(env)) {
      errors.push(`${label}.envSafety.${env} is not listed in ${label}.env`);
    }
    if (typeof provider.envSafety[env].clientSafe !== "boolean") {
      errors.push(`${label}.envSafety.${env}.clientSafe must be a boolean`);
    }
  }

  validateValidation(provider.validation, `${label}.validation`, provider);
  for (const [env, config] of Object.entries(provider.envSafety || {})) {
    validateValidation(config.validation, `${label}.envSafety.${env}.validation`, provider);
  }
}

if (errors.length) {
  console.error("Provider audit failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Provider audit passed (${directory.providers.length} providers, ${envOwners.size} exact env vars).`);

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${field} must be a non-empty string`);
}

function validateUrl(value, field) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") errors.push(`${field} must use https`);
    if (parsed.hostname === "example.com") errors.push(`${field} must not use example.com`);
    if (parsed.hostname === "www.google.com" && parsed.pathname === "/search" && field.endsWith("sourceUrl")) {
      errors.push(`${field} must be an official source, not a search result`);
    }
  } catch {
    errors.push(`${field} must be a valid URL`);
  }
}

function validateValidation(validation, field, provider) {
  if (!validation) return;
  if (!["format", "http", "url"].includes(validation.type)) {
    errors.push(`${field}.type is invalid`);
  }
  for (const env of validation.env || []) {
    if (!(provider.env || []).includes(env)) errors.push(`${field}.env references unknown env var ${env}`);
  }
  if (validation.type === "http") {
    if (!validation.env?.length) errors.push(`${field}.env must scope HTTP validation to exact env vars`);
    validateUrl(validation.url, `${field}.url`);
    if (!validation.headers || !JSON.stringify(validation.headers).includes("{value}")) {
      errors.push(`${field}.headers should contain {value}`);
    }
  }
  if (validation.type === "format" && !validation.pattern) {
    errors.push(`${field}.pattern is required for format validation`);
  } else if (validation.type === "format") {
    try {
      new RegExp(validation.pattern);
    } catch (error) {
      errors.push(`${field}.pattern is invalid: ${error.message}`);
    }
  }
}
