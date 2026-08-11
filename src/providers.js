import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const providerPath = fileURLToPath(new URL("../providers/providers.json", import.meta.url));

export async function loadProviders() {
  const raw = await fs.readFile(providerPath, "utf8");
  return JSON.parse(raw).providers;
}

export function providerForEnvVar(name, providers, packageNames = []) {
  const upper = name.toUpperCase();
  const exact = providers.find((provider) => (provider.env || []).includes(upper));
  if (exact) return exact;

  if (isLikelyCredentialEnvVar(upper)) {
    const byPattern = providers.find((provider) =>
      (provider.envPatterns || []).some((pattern) => new RegExp(pattern, "i").test(name))
    );
    if (byPattern) return byPattern;
  }

  if (isGenericEnvName(upper)) {
    const packageMatches = providers.filter((provider) =>
      (provider.packages || []).some((pkg) => packageNames.includes(pkg))
    );
    if (packageMatches.length === 1) return packageMatches[0];
  }

  return null;
}

export function envVarClientSafe(name, provider) {
  if (!provider) return null;
  const upper = name.toUpperCase();
  if (provider.envSafety && upper in provider.envSafety) return provider.envSafety[upper].clientSafe;
  if (upper.includes("SECRET") || upper.includes("PRIVATE") || upper.includes("SERVICE_ROLE")) return false;
  if (upper.startsWith("NEXT_PUBLIC_") || upper.startsWith("VITE_") || upper.startsWith("PUBLIC_")) return true;
  return provider.clientSafe ?? null;
}

export function isLikelyCredentialEnvVar(name) {
  const upper = name.toUpperCase();
  return [
    "API_KEY",
    "APP_KEY",
    "AUTH_TOKEN",
    "CLIENT_SECRET",
    "CREDENTIAL",
    "CREDENTIALS",
    "PASSWORD",
    "PRIVATE_KEY",
    "PUBLISHABLE_KEY",
    "SECRET",
    "SECRET_KEY",
    "SERVICE_ROLE",
    "SIGNING_SECRET",
    "TOKEN",
    "WEBHOOK_SECRET"
  ].some((part) => upper.includes(part));
}

export function isKnownProviderEnvVar(name, provider) {
  if (!provider) return false;
  return (provider.env || []).includes(name.toUpperCase());
}

function isGenericEnvName(name) {
  return ["API_KEY", "SECRET_KEY", "TOKEN", "ACCESS_TOKEN", "AUTH_TOKEN"].includes(name);
}
