import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const envhelperDir = path.join(os.homedir(), ".envhelper");
const identityPath = path.join(envhelperDir, "identity.txt");

export function hasAge() {
  return spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0 &&
    spawnSync("age-keygen", ["--version"], { stdio: "ignore" }).status === 0;
}

export async function ensureAgeIdentity(options = { create: true }) {
  try {
    const identity = await readIdentity(identityPath);
    return { identityPath, publicKey: identity.publicKey };
  } catch {
    if (options.create === false) return null;
  }

  await fs.mkdir(envhelperDir, { recursive: true, mode: 0o700 });
  const result = spawnSync("age-keygen", ["-o", identityPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "age-keygen failed");
  }
  await fs.chmod(identityPath, 0o600).catch(() => {});
  const identity = await readIdentity(identityPath);
  return { identityPath, publicKey: identity.publicKey };
}

export async function encryptBundle({ inputPath, outputPath, recipients }) {
  const args = [];
  for (const recipient of recipients) {
    args.push("-r", recipient);
  }
  args.push("-o", outputPath, inputPath);
  const result = spawnSync("age", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr || "age encryption failed");
}

export async function encryptBundleContent({ content, outputPath, recipients }) {
  const args = [];
  for (const recipient of recipients) {
    args.push("-r", recipient);
  }
  args.push("-o", outputPath);
  const result = spawnSync("age", args, {
    encoding: "utf8",
    input: content,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(result.stderr || "age encryption failed");
}

export async function decryptBundle({ inputPath, outputPath, identityPath }) {
  const result = spawnSync("age", ["-d", "-i", identityPath, "-o", outputPath, inputPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(result.stderr || "age decryption failed");
}

async function readIdentity(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const publicLine = content.split(/\r?\n/).find((line) => line.includes("public key:"));
  const publicKey = publicLine?.split("public key:")[1]?.trim();
  if (!publicKey) throw new Error("Identity file does not include an age public key comment.");
  return { publicKey };
}
