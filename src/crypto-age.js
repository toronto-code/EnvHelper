import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { ensurePrivateDirectory, readRegularFile, safeWriteFile } from "./safe-file.js";

const envhelperDir = path.join(os.homedir(), ".envhelper");
const identityPath = path.join(envhelperDir, "identity.txt");
const maxBuffer = 32 * 1024 * 1024;

export function hasAge() {
  return commandSucceeds("age", ["--version"]) && commandSucceeds("age-keygen", ["--version"]);
}

export async function ensureAgeIdentity(options = { create: true }) {
  try {
    const content = await readRegularFile(identityPath, { encoding: "utf8", maxBytes: 1024 * 1024 });
    return { identityPath, publicKey: parsePublicKey(content) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (options.create === false) return null;
  }

  await ensurePrivateDirectory(envhelperDir);
  const result = spawnSync("age-keygen", [], {
    encoding: null,
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0 || !result.stdout?.length) {
    throw new Error(stderrMessage(result, "age-keygen failed"));
  }
  await safeWriteFile(identityPath, result.stdout, { mode: 0o600, overwrite: false });
  const content = result.stdout.toString("utf8");
  return { identityPath, publicKey: parsePublicKey(content) };
}

export function encryptBundleContent({ content, recipients }) {
  const args = recipients.flatMap((recipient) => ["-r", recipient]);
  const result = spawnSync("age", args, {
    input: content,
    encoding: null,
    maxBuffer,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(stderrMessage(result, "age encryption failed"));
  return result.stdout;
}

export function decryptBundleContent({ encrypted, identityPath: localIdentityPath }) {
  const result = spawnSync("age", ["-d", "-i", localIdentityPath], {
    input: encrypted,
    encoding: null,
    maxBuffer,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(stderrMessage(result, "age decryption failed"));
  return result.stdout;
}

function parsePublicKey(content) {
  const publicLine = content.split(/\r?\n/).find((line) => line.toLowerCase().includes("public key:"));
  const publicKey = publicLine?.split(/public key:/i)[1]?.trim();
  if (!publicKey || !/^age1[0-9a-z]+$/.test(publicKey)) {
    throw new Error("Identity file does not contain a valid age public key comment.");
  }
  return publicKey;
}

function commandSucceeds(command, args) {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

function stderrMessage(result, fallback) {
  const message = result.stderr?.toString("utf8").trim();
  return message || fallback;
}
