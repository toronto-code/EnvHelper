import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const skipDirs = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
  ".cache",
  "__tests__",
  "test",
  "tests"
]);

const skipFiles = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.team.enc"
]);

const textExts = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".py", ".rb", ".go", ".rs",
  ".java", ".cs", ".php", ".sh", ".bash", ".zsh",
  ".md", ".mdx", ".txt", ".yml", ".yaml", ".json",
  ".toml", ".env", ".example"
]);

const envPatterns = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /Deno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
  /Bun\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /os\.environ\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /os\.(?:getenv|environ\.get)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
  /ENV\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /os\.Getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
  /System\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
  /std::env::var\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g,
  /getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/g
];

const ignoredEnvNames = new Set([
  "CI", "FORCE_COLOR", "FORCE_HYPERLINK", "GITHUB_ACTIONS", "HOME",
  "MY_KEY", "NO_COLOR", "NODE_ENV", "PATH", "PWD", "SHELL", "TERM",
  "TERM_PROGRAM", "USER", "USERNAME", "WT_SESSION", "X"
]);

export async function scanProject(root) {
  const files = await listFiles(root);
  const packageNames = await readPackageNames(files);
  const envVars = new Map();

  await collectEnvhelperConfig(root, envVars);
  await collectEnvTemplates(root, envVars);

  for (const file of files) {
    if (!isTextFile(file)) continue;
    const content = await safeRead(file);
    if (!content) continue;
    const relative = path.relative(root, file);

    for (const pattern of envPatterns) {
      for (const match of content.matchAll(pattern)) addEnv(envVars, match[1], relative);
    }

    if (path.basename(file).toLowerCase().includes("readme")) {
      for (const match of content.matchAll(/\b([A-Z][A-Z0-9_]{2,})=/g)) {
        addEnv(envVars, match[1], relative);
      }
    }
  }

  return {
    envVars: [...envVars.values()].sort((left, right) => left.name.localeCompare(right.name)),
    packageNames
  };
}

async function collectEnvTemplates(root, envVars) {
  for (const name of [".env.example", ".env.sample", ".env.template"]) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const content = await fs.readFile(file, "utf8");
    for (const entry of parseEnvTemplate(content)) {
      addEnv(envVars, entry.name, name, { template: entry });
    }
  }
}

async function collectEnvhelperConfig(root, envVars) {
  const file = path.join(root, ".envhelper.json");
  if (!existsSync(file)) return;
  try {
    const config = JSON.parse(await fs.readFile(file, "utf8"));
    if (config.generatedBy === "envhelper") return;
    for (const key of config.required || []) addEnv(envVars, key, ".envhelper.json");
  } catch (error) {
    throw new Error(`Could not read .envhelper.json: ${error.message}`);
  }
}

function addEnv(map, name, source, metadata = {}) {
  if (!name) return;
  const normalized = name.trim();
  if (ignoredEnvNames.has(normalized.toUpperCase())) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) return;
  const current = map.get(normalized) || { name: normalized, sources: [], templates: [] };
  if (!current.sources.includes(source)) current.sources.push(source);
  if (metadata.template) current.templates.push(metadata.template);
  map.set(normalized, current);
}

function parseEnvTemplate(content) {
  const entries = [];
  let comments = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      comments = [];
      continue;
    }
    if (line.startsWith("#")) {
      comments.push(line.replace(/^#+\s?/, "").trim());
      comments = comments.slice(-12);
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const value = stripInlineComment(match[2].trim());
    const context = comments.join(" ");
    entries.push({
      name: match[1],
      value,
      hasDefault: value.length > 0,
      optional: isOptionalTemplateContext(context),
      context
    });
  }
  return entries;
}

function stripInlineComment(value) {
  if (!value) return "";
  const hash = value.indexOf("#");
  return hash === -1 ? value : value.slice(0, hash).trim();
}

function isOptionalTemplateContext(context) {
  return /\b(optional|recommended|fallback|falls back|if unset|safe to leave blank|leave blank|leave empty|deprecated|no longer|not wired|not required|no .* required|simulated only|demo still works|observability|settings page)\b/i.test(context);
}

async function readPackageNames(files) {
  const names = new Set();
  const packageFiles = files.filter((file) => path.basename(file) === "package.json");
  for (const file of packageFiles) {
    try {
      const pkg = JSON.parse(await fs.readFile(file, "utf8"));
      for (const name of Object.keys({
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
        ...(pkg.peerDependencies || {})
      })) names.add(name);
    } catch {
      // Invalid package metadata should not block environment discovery.
    }
  }
  return [...names];
}

async function listFiles(root) {
  const output = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await walk(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        if (skipFiles.has(entry.name) || isProbablyTestFile(entry.name)) continue;
        output.push(path.join(directory, entry.name));
      }
    }
  }
  await walk(root);
  return output;
}

function isProbablyTestFile(name) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

async function safeRead(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 500_000) return "";
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

function isTextFile(file) {
  const base = path.basename(file);
  if (base.startsWith(".env") || ["Dockerfile", "Procfile"].includes(base)) return true;
  return textExts.has(path.extname(file));
}
