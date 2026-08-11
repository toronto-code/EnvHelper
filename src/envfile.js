import path from "node:path";

import { readRegularFile, safeWriteFile } from "./safe-file.js";

export function parseEnvAssignments(content) {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const entries = [];

  for (let index = 0; index < lines.length; index++) {
    const startLine = index;
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) {
      throw new Error(`Unsupported .env syntax on line ${index + 1}. Use KEY=value assignments or pass --whole-env explicitly.`);
    }

    const key = match[1];
    let rawValue = match[2].trimStart();
    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      const quote = rawValue[0];
      let closing = findClosingQuote(rawValue, quote);
      while (closing === -1 && index + 1 < lines.length) {
        rawValue += `\n${lines[++index]}`;
        closing = findClosingQuote(rawValue, quote);
      }
      if (closing === -1) throw new Error(`Unterminated quoted value for ${key}.`);
      const trailing = rawValue.slice(closing + 1);
      if (trailing.trim() && !/^\s*#/.test(trailing)) {
        throw new Error(`Unsupported content after ${key} value.`);
      }
      rawValue = rawValue.slice(0, closing + 1);
    } else {
      const comment = rawValue.indexOf("#");
      if (comment !== -1) rawValue = rawValue.slice(0, comment);
      rawValue = rawValue.trimEnd();
    }

    entries.push({
      key,
      value: unquoteValue(rawValue),
      serialized: `${key}=${rawValue}`,
      startLine,
      endLine: index
    });
  }

  return entries;
}

export async function parseEnvFile(filePath) {
  const content = await readRegularFile(filePath, { encoding: "utf8", maxBytes: 10 * 1024 * 1024 });
  return Object.fromEntries(parseEnvAssignments(content).map((entry) => [entry.key, entry.value]));
}

export async function upsertEnvFile(filePath, updates) {
  let content = "";
  try {
    content = await readRegularFile(filePath, { encoding: "utf8", maxBytes: 10 * 1024 * 1024 });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const entries = parseEnvAssignments(content);
  const byStart = new Map(entries.map((entry) => [entry.startLine, entry]));
  const seen = new Set();
  const next = [];

  for (let index = 0; index < lines.length;) {
    const entry = byStart.get(index);
    if (!entry) {
      next.push(lines[index++]);
      continue;
    }
    if (Object.hasOwn(updates, entry.key)) {
      if (!seen.has(entry.key)) {
        next.push(`${entry.key}=${quoteEnv(updates[entry.key])}`);
        seen.add(entry.key);
      }
    } else {
      next.push(...lines.slice(entry.startLine, entry.endLine + 1));
    }
    index = entry.endLine + 1;
  }

  while (next.length && next.at(-1) === "") next.pop();
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    if (!seen.has(key)) next.push(`${key}=${quoteEnv(value)}`);
  }
  await safeWriteFile(filePath, `${next.join("\n")}\n`, { mode: 0o600 });
}

export async function writeEnvExample(filePath, names) {
  const unique = [...new Set(names.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))].sort();
  if (!unique.length) return false;
  let content = "";
  try {
    content = await readRegularFile(filePath, { encoding: "utf8", maxBytes: 10 * 1024 * 1024 });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const existing = new Set(parseEnvAssignments(content).map((entry) => entry.key));
  const missing = unique.filter((name) => !existing.has(name));
  if (!missing.length) return false;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  await safeWriteFile(filePath, `${content}${prefix}${missing.map((name) => `${name}=`).join("\n")}\n`, { mode: 0o644 });
  return true;
}

export function filterEnvAssignments(entries, excludedNames) {
  const keys = new Set(entries.map((entry) => entry.key));
  const excluded = [...new Set(excludedNames.map((name) => name.trim()).filter(Boolean))];
  const unknown = excluded.filter((name) => !keys.has(name));
  if (unknown.length) throw new Error(`Cannot exclude unknown key(s): ${unknown.join(", ")}.`);

  const excludedSet = new Set(excluded);
  const kept = entries.filter((entry) => !excludedSet.has(entry.key));
  return {
    content: kept.length ? `${kept.map((entry) => entry.serialized).join("\n")}\n` : "",
    included: [...new Set(kept.map((entry) => entry.key))],
    excluded: [...new Set(entries.filter((entry) => excludedSet.has(entry.key)).map((entry) => entry.key))]
  };
}

export function likelyPersonalShareEntries(entries) {
  return entries.filter((entry) => isLikelyPersonalShareKey(entry.key, entry.value));
}

export async function ensureEnvIgnored(root) {
  const filePath = path.join(root, ".gitignore");
  const needed = [".env", ".env.*", "!.env.example", "!.env.team.enc"];
  let content = "";
  try {
    content = await readRegularFile(filePath, { encoding: "utf8", maxBytes: 5 * 1024 * 1024 });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missing = needed.filter((line) => !lines.has(line));
  if (!missing.length) return false;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  await safeWriteFile(filePath, `${content}${prefix}${missing.join("\n")}\n`, { mode: 0o644 });
  return true;
}

function findClosingQuote(value, quote) {
  let escaped = false;
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (quote === '"' && char === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (char === quote && !escaped) return index;
    escaped = false;
  }
  return -1;
}

function unquoteValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isLikelyPersonalShareKey(name, value = "") {
  const upper = name.toUpperCase();
  const normalizedValue = value.trim();
  if (/(^|_)(PERSONAL|PROD|PRODUCTION)(_|$)/.test(upper)) return true;
  if (upper.endsWith("_PRIVATE_KEY") || upper === "PRIVATE_KEY" || upper === "SSH_PRIVATE_KEY") return true;
  if (upper.includes("REFRESH_TOKEN") || upper.includes("SESSION_TOKEN")) return true;
  if (/^(GH|GITHUB|GITLAB|NPM|VERCEL|NETLIFY|RAILWAY|RENDER|CLOUDFLARE)_(TOKEN|AUTH_TOKEN|API_TOKEN|ACCESS_TOKEN)$/.test(upper)) return true;
  if (/^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)$/.test(upper)) return true;
  if (/^(GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CREDENTIALS|AZURE_CLIENT_SECRET)$/.test(upper)) return true;
  if (/^(DOCKER_PASSWORD|DOCKER_TOKEN|HOMEBREW_GITHUB_API_TOKEN)$/.test(upper)) return true;
  if (normalizedValue.startsWith("sk_live_") || normalizedValue.startsWith("rk_live_")) return true;
  return false;
}

function quoteEnv(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
