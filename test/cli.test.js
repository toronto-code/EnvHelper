import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const cliPath = path.resolve("src", "cli.js");
const ageAvailable = commandExists("age") && commandExists("age-keygen");

test("help exposes only setup and sharing commands", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /envhelper setup/);
  assert.match(result.stdout, /envhelper share/);
  assert.match(result.stdout, /envhelper invite/);
  assert.match(result.stdout, /envhelper join/);
  assert.doesNotMatch(result.stdout, /doctor|providers|link|validate|needs/);
});

test("version and option errors are explicit", () => {
  const version = runCli(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

  const removed = runCli(["doctor"]);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /Unknown command: doctor/);

  const unknown = runCli(["setup", "--wat"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --wat/);
});

test("setup discovers variables, updates the example, and writes mode-0600 .env", async () => {
  const root = await tempDirectory("envhelper-setup-");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, ".env.example"), "STRIPE_SECRET_KEY=\n", "utf8");
  await fs.writeFile(path.join(root, "src", "app.js"), "process.env.OPENAI_API_KEY;\n", "utf8");

  const result = runCli(["setup", "--profile", "all", "--no-validate"], {
    cwd: root,
    input: "fake-openai-value\nfake-stripe-value\n"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /fake-openai-value|fake-stripe-value/);

  const env = await fs.readFile(path.join(root, ".env"), "utf8");
  assert.match(env, /OPENAI_API_KEY=fake-openai-value/);
  assert.match(env, /STRIPE_SECRET_KEY=fake-stripe-value/);
  assert.equal((await fs.stat(path.join(root, ".env"))).mode & 0o077, 0);

  const example = await fs.readFile(path.join(root, ".env.example"), "utf8");
  assert.match(example, /OPENAI_API_KEY=/);
  assert.match(example, /STRIPE_SECRET_KEY=/);
  assert.match(await fs.readFile(path.join(root, ".gitignore"), "utf8"), /^\.env$/m);
});

test("setup dry-run is read-only and reports provider links", async () => {
  const root = await tempDirectory("envhelper-dry-run-");
  await fs.writeFile(path.join(root, ".env.example"), "GITHUB_WEBHOOK_SECRET=\nSLACK_SIGNING_SECRET=\n", "utf8");

  const result = runCli(["setup", "--dry-run"], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GITHUB_WEBHOOK_SECRET/);
  assert.match(result.stdout, /validating-webhook-deliveries/);
  assert.match(result.stdout, /SLACK_SIGNING_SECRET/);
  assert.match(result.stdout, /verifying-requests-from-slack/);
  await assert.rejects(fs.access(path.join(root, ".env")));
  await assert.rejects(fs.access(path.join(root, ".gitignore")));
});

test("setup recognizes export and spaced assignment syntax without duplicating keys", async () => {
  const root = await tempDirectory("envhelper-existing-env-");
  await fs.writeFile(path.join(root, ".env.example"), "STRIPE_SECRET_KEY=\nSUPABASE_URL=\n", "utf8");
  await fs.writeFile(path.join(root, ".env"), "export STRIPE_SECRET_KEY=already-set\nSUPABASE_URL = https://demo.supabase.co\n", "utf8");

  const result = runCli(["setup", "--dry-run"], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Everything in this setup scope is ready/);
  const env = await fs.readFile(path.join(root, ".env"), "utf8");
  assert.equal((env.match(/STRIPE_SECRET_KEY/g) || []).length, 1);
  assert.equal((env.match(/SUPABASE_URL/g) || []).length, 1);
});

test("setup keeps optional credentials out of the default scope", async () => {
  const root = await tempDirectory("envhelper-optional-");
  await fs.writeFile(
    path.join(root, ".env.example"),
    "STRIPE_SECRET_KEY=\n# Optional. Falls back to mock responses.\nOPENAI_API_KEY=\n",
    "utf8"
  );

  let result = runCli(["setup", "--no-validate"], { cwd: root, input: "fake-stripe\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Paste STRIPE_SECRET_KEY/);
  assert.doesNotMatch(result.stdout, /Paste OPENAI_API_KEY/);

  result = runCli(["setup", "--optional", "--no-validate"], { cwd: root, input: "fake-openai\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Paste OPENAI_API_KEY/);
  const env = await fs.readFile(path.join(root, ".env"), "utf8");
  assert.match(env, /STRIPE_SECRET_KEY=fake-stripe/);
  assert.match(env, /OPENAI_API_KEY=fake-openai/);
});

test("credential placeholders in templates remain missing", async () => {
  const root = await tempDirectory("envhelper-placeholder-");
  await fs.writeFile(path.join(root, ".env.example"), "OPENAI_API_KEY=your-key-here\n", "utf8");
  const result = runCli(["setup", "--profile", "all", "--dry-run"], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing values:/);
  assert.match(result.stdout, /OPENAI_API_KEY/);
  assert.match(result.stdout, /1 value\(s\) would be requested/);
  assert.doesNotMatch(result.stdout, /Everything in this setup scope is ready/);
  await assert.rejects(fs.access(path.join(root, ".env")));
});

test("safe template defaults are copied into .env without prompting", async () => {
  const root = await tempDirectory("envhelper-defaults-");
  await fs.writeFile(path.join(root, ".env.example"), "PORT=3000\nFEATURE_FLAG=true\nAPP_LABEL=\"Demo # one\"\nSUPABASE_URL=https://demo.supabase.co\n", "utf8");
  const result = runCli(["setup"], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Template defaults to apply:/);
  assert.match(result.stdout, /These non-secret defaults will be copied into \.env/);
  assert.equal(await fs.readFile(path.join(root, ".env"), "utf8"), "APP_LABEL=\"Demo # one\"\nFEATURE_FLAG=true\nPORT=3000\nSUPABASE_URL=https://demo.supabase.co\n");
  assert.equal((await fs.stat(path.join(root, ".env"))).mode & 0o077, 0);
});

test("secret-bearing and conflicting template defaults are not copied", async () => {
  const root = await tempDirectory("envhelper-unsafe-defaults-");
  await fs.writeFile(path.join(root, ".env.example"), "DATABASE_URL=postgres://user:password@localhost/app\nPORT=3000\n", "utf8");
  await fs.writeFile(path.join(root, ".env.sample"), "PORT=4000\n", "utf8");
  const result = runCli(["setup", "--profile", "all", "--dry-run"], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DATABASE_URL/);
  assert.match(result.stdout, /PORT/);
  assert.match(result.stdout, /2 value\(s\) would be requested/);
  assert.doesNotMatch(result.stdout, /Template defaults to apply:/);
  await assert.rejects(fs.access(path.join(root, ".env")));
});

test("invite creates an owner-only identity", { skip: !ageAvailable }, async () => {
  const root = await tempDirectory("envhelper-invite-");
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await fs.mkdir(home);
  await fs.mkdir(project);

  const result = runCli(["invite", "--out", "alice.pub"], { cwd: project, home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^age1/m);
  assert.match((await fs.readFile(path.join(project, "alice.pub"), "utf8")).trim(), /^age1/);
  assert.equal((await fs.stat(path.join(home, ".envhelper", "identity.txt"))).mode & 0o077, 0);
});

test("filtered sharing removes complete multiline secrets and comments", { skip: !ageAvailable }, async () => {
  const fixture = await sharingFixture("envhelper-filtered-");
  await fs.writeFile(
    path.join(fixture.sender, ".env"),
    [
      "# OLD_TOKEN=comment-only-secret",
      "SSH_PRIVATE_KEY=\"-----BEGIN PRIVATE KEY-----",
      "FAKE_MULTILINE_PRIVATE_BODY",
      "-----END PRIVATE KEY-----\"",
      "GITHUB_TOKEN=personal-token",
      "TEAM_SETTING=shared"
    ].join("\n"),
    "utf8"
  );

  const shared = runCli(["share", "--recipient", fixture.publicKey], {
    cwd: fixture.sender,
    home: fixture.senderHome
  });
  assert.equal(shared.status, 0, shared.stderr);
  assert.match(shared.stdout, /Excluded \(2\): SSH_PRIVATE_KEY, GITHUB_TOKEN/);
  assert.match(shared.stdout, /Included \(1\): TEAM_SETTING/);

  await fs.copyFile(path.join(fixture.sender, ".env.team.enc"), path.join(fixture.recipient, ".env.team.enc"));
  const joined = runCli(["join"], { cwd: fixture.recipient, home: fixture.recipientHome });
  assert.equal(joined.status, 0, joined.stderr);
  const env = await fs.readFile(path.join(fixture.recipient, ".env"), "utf8");
  assert.equal(env, "TEAM_SETTING=shared\n");
  assert.doesNotMatch(env, /PRIVATE|MULTILINE|comment-only|personal-token/);
  assert.equal((await fs.stat(path.join(fixture.recipient, ".env"))).mode & 0o077, 0);
});

test("whole-env and explicit exclusion modes are honest", { skip: !ageAvailable }, async () => {
  const fixture = await sharingFixture("envhelper-whole-");
  await fs.writeFile(path.join(fixture.sender, ".env"), "# retained comment\nA=one\nB=two\n", "utf8");

  let result = runCli(["share", "--recipient", fixture.publicKey, "--whole-env"], {
    cwd: fixture.sender,
    home: fixture.senderHome
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Warning: whole-env mode/);
  await fs.copyFile(path.join(fixture.sender, ".env.team.enc"), path.join(fixture.recipient, ".env.team.enc"));
  result = runCli(["join", "--output", "raw.env"], { cwd: fixture.recipient, home: fixture.recipientHome });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await fs.readFile(path.join(fixture.recipient, "raw.env"), "utf8"), /retained comment/);

  result = runCli(["share", "--recipient", fixture.publicKey, "--exclude", "B"], {
    cwd: fixture.sender,
    home: fixture.senderHome
  });
  assert.equal(result.status, 0, result.stderr);
  await fs.copyFile(path.join(fixture.sender, ".env.team.enc"), path.join(fixture.recipient, "filtered.enc"));
  result = runCli(["join", "--input", "filtered.enc", "--output", "filtered.env"], {
    cwd: fixture.recipient,
    home: fixture.recipientHome
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(fixture.recipient, "filtered.env"), "utf8"), "A=one\n");
});

test("sharing fails closed for typoed exclusions and unsupported syntax", { skip: !ageAvailable }, async () => {
  const fixture = await sharingFixture("envhelper-fail-closed-");
  await fs.writeFile(path.join(fixture.sender, ".env"), "A=one\n", "utf8");
  let result = runCli(["share", "--recipient", fixture.publicKey, "--exclude", "TYPO"], {
    cwd: fixture.sender,
    home: fixture.senderHome
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot exclude unknown key/);
  await assert.rejects(fs.access(path.join(fixture.sender, ".env.team.enc")));

  await fs.writeFile(path.join(fixture.sender, ".env"), "A=one\nsource ./other-secrets\n", "utf8");
  result = runCli(["share", "--recipient", fixture.publicKey], {
    cwd: fixture.sender,
    home: fixture.senderHome
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported \.env syntax/);
});

test("sensitive reads and writes reject symlinks", { skip: !ageAvailable }, async () => {
  const fixture = await sharingFixture("envhelper-symlink-");
  const target = path.join(fixture.base, "outside-target");
  await fs.writeFile(target, "UNCHANGED\n", "utf8");
  await fs.symlink(target, path.join(fixture.sender, ".env"));

  let result = runCli(["share", "--recipient", fixture.publicKey], {
    cwd: fixture.sender,
    home: fixture.senderHome
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symlink/i);
  assert.equal(await fs.readFile(target, "utf8"), "UNCHANGED\n");

  await fs.unlink(path.join(fixture.sender, ".env"));
  await fs.writeFile(path.join(fixture.sender, ".env"), "A=one\n", "utf8");
  await fs.symlink(target, path.join(fixture.sender, ".env.team.enc"));
  result = runCli(["share", "--recipient", fixture.publicKey], {
    cwd: fixture.sender,
    home: fixture.senderHome
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symlink/i);
  assert.equal(await fs.readFile(target, "utf8"), "UNCHANGED\n");
});

async function sharingFixture(prefix) {
  const base = await tempDirectory(prefix);
  const recipientHome = path.join(base, "recipient-home");
  const senderHome = path.join(base, "sender-home");
  const recipient = path.join(base, "recipient");
  const sender = path.join(base, "sender");
  await Promise.all([recipientHome, senderHome, recipient, sender].map((directory) => fs.mkdir(directory)));
  const invite = runCli(["invite", "--out", "recipient.pub"], { cwd: recipient, home: recipientHome });
  assert.equal(invite.status, 0, invite.stderr);
  const publicKey = (await fs.readFile(path.join(recipient, "recipient.pub"), "utf8")).trim();
  return { base, recipientHome, senderHome, recipient, sender, publicKey };
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.home ? { HOME: options.home } : {}) },
    input: options.input || "",
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function commandExists(command) {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function tempDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
