import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  filterEnvAssignments,
  parseEnvAssignments,
  parseEnvFile,
  upsertEnvFile
} from "../src/envfile.js";
import { readRegularFile, safeWriteFile } from "../src/safe-file.js";

test("dotenv parsing supports export, spaces, comments, and multiline quotes", () => {
  const entries = parseEnvAssignments([
    "# comment",
    "export A=one",
    "B = two # inline comment",
    "PRIVATE_KEY=\"first",
    "second\""
  ].join("\n"));
  assert.deepEqual(entries.map(({ key, value }) => ({ key, value })), [
    { key: "A", value: "one" },
    { key: "B", value: "two" },
    { key: "PRIVATE_KEY", value: "first\nsecond" }
  ]);
});

test("filtered serialization removes complete excluded assignments and comments", () => {
  const entries = parseEnvAssignments("# secret comment\nPRIVATE_KEY=\"first\nsecond\"\nA=one\n");
  assert.deepEqual(filterEnvAssignments(entries, ["PRIVATE_KEY"]), {
    content: "A=one\n",
    included: ["A"],
    excluded: ["PRIVATE_KEY"]
  });
});

test("upsert preserves surrounding content and does not duplicate valid syntax", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "envhelper-upsert-"));
  const file = path.join(root, ".env");
  await fs.writeFile(file, "# keep me\nexport A=old\nB = old\n", "utf8");
  await upsertEnvFile(file, { A: "new", B: "two words" });
  const content = await fs.readFile(file, "utf8");
  assert.match(content, /^# keep me$/m);
  assert.equal((content.match(/^A=/gm) || []).length, 1);
  assert.equal((content.match(/^B=/gm) || []).length, 1);
  assert.deepEqual(await parseEnvFile(file), { A: "new", B: "two words" });
  assert.equal((await fs.stat(file)).mode & 0o077, 0);
});

test("safe file helpers refuse symlink reads and writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "envhelper-safe-file-"));
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  await fs.writeFile(target, "original", "utf8");
  await fs.symlink(target, link);
  await assert.rejects(readRegularFile(link), /symlink/i);
  await assert.rejects(safeWriteFile(link, "changed"), /symlink/i);
  assert.equal(await fs.readFile(target, "utf8"), "original");
});
