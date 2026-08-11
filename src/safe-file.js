import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function assertSafeFile(filePath, options = {}) {
  const allowMissing = options.allowMissing !== false;
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to use symlink: ${filePath}`);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
    return stat;
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) return null;
    throw error;
  }
}

export async function readRegularFile(filePath, options = {}) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fs.open(filePath, flags);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
    if (options.maxBytes && stat.size > options.maxBytes) {
      throw new Error(`File is too large to process safely: ${filePath}`);
    }
    return await handle.readFile(options.encoding ? { encoding: options.encoding } : undefined);
  } catch (error) {
    if (error.code === "ELOOP") throw new Error(`Refusing to follow symlink: ${filePath}`);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function safeWriteFile(filePath, content, options = {}) {
  const mode = options.mode ?? 0o600;
  const overwrite = options.overwrite !== false;
  const existing = await assertSafeFile(filePath, { allowMissing: true });
  if (existing && !overwrite) throw new Error(`File already exists: ${filePath}`);

  const parent = path.dirname(filePath);
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`Output directory must be a real directory, not a symlink: ${parent}`);
  }

  const tempPath = path.join(parent, `.${path.basename(filePath)}.envhelper-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, mode);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function ensurePrivateDirectory(dirPath) {
  try {
    const stat = await fs.lstat(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Private directory must be a real directory, not a symlink: ${dirPath}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  }
  await fs.chmod(dirPath, 0o700);
}
