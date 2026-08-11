import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadProviders, providerForEnvVar } from "../src/providers.js";
import { scanProject } from "../src/scanner.js";
import { validateEnvValue } from "../src/validators.js";

test("setup scanner finds common language and template references", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "envhelper-scan-"));
  await fs.writeFile(path.join(root, ".env.example"), "OPENAI_API_KEY=\n# Optional fallback\nACME_TOKEN=\n", "utf8");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "app.ts"), "process.env.RESEND_API_KEY; import.meta.env.VITE_FIREBASE_API_KEY;", "utf8");
  await fs.writeFile(path.join(root, "worker.py"), "os.environ.get(\"ANTHROPIC_API_KEY\")\n", "utf8");
  await fs.writeFile(path.join(root, "main.go"), "os.Getenv(\"STRIPE_SECRET_KEY\")\n", "utf8");

  const scan = await scanProject(root);
  assert.deepEqual(scan.envVars.map((item) => item.name), [
    "ACME_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
    "VITE_FIREBASE_API_KEY"
  ]);
});

test("hand-authored setup requirements are read without generated feedback loops", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "envhelper-config-"));
  await fs.writeFile(path.join(root, ".envhelper.json"), JSON.stringify({ required: ["OPENAI_API_KEY"] }), "utf8");
  assert.deepEqual((await scanProject(root)).envVars.map((item) => item.name), ["OPENAI_API_KEY"]);

  await fs.writeFile(path.join(root, ".envhelper.json"), JSON.stringify({ generatedBy: "envhelper", required: ["STRIPE_SECRET_KEY"] }), "utf8");
  assert.deepEqual((await scanProject(root)).envVars.map((item) => item.name), []);
});

test("provider metadata and local URL validation work", async () => {
  const providers = await loadProviders();
  assert.ok(providers.length >= 50);
  assert.equal(providerForEnvVar("OPENAI_API_KEY", providers).name, "OpenAI");
  const supabase = providerForEnvVar("SUPABASE_URL", providers);
  assert.equal((await validateEnvValue("SUPABASE_URL", "https://demo.supabase.co", supabase)).ok, true);
  assert.equal((await validateEnvValue("SUPABASE_URL", "not-a-url", supabase)).ok, false);
});

test("HTTP validation replaces secrets without exposing them in results", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { status: 200 };
  };
  try {
    const provider = {
      validation: {
        env: ["ACME_API_KEY"],
        type: "http",
        method: "POST",
        url: "https://api.acme.invalid/check",
        headers: { Authorization: "Bearer {value}" },
        body: { token: "{value}" },
        okStatus: [200]
      }
    };
    const result = await validateEnvValue("ACME_API_KEY", "fake-secret", provider);
    assert.equal(result.ok, true);
    assert.equal(request.options.headers.Authorization, "Bearer fake-secret");
    assert.equal(request.options.body, JSON.stringify({ token: "fake-secret" }));
    assert.doesNotMatch(result.message, /fake-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
