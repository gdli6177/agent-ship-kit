import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { main, type Io } from "../src/cli.js";
import { HOOK_END, HOOK_START, RULES_END, RULES_START } from "../src/setup.js";

const exec = promisify(execFile);

function capture(): { io: Io; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => err.push(chunk),
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: root });
  return stdout;
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ship-setup-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "project\n");
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await git(root, ["add", "README.md", ".gitignore"]);
  await git(root, ["commit", "-m", "init"]);
  return root;
}

test("setup is local, idempotent, chains hooks, and uninstalls cleanly", async () => {
  const root = await repo();
  const ignoreBefore = await readFile(join(root, ".gitignore"), "utf8");
  const foreign = "#!/bin/sh\necho foreign-hook >> \"$PWD/hook-trace.txt\"\nexit 0\n";
  await writeFile(join(root, ".git", "hooks", "pre-commit"), foreign);
  await chmod(join(root, ".git", "hooks", "pre-commit"), 0o755);
  try {
    const first = capture();
    assert.equal(await main(["setup", "--root", root], first.io), 0);
    const report = JSON.parse(first.stdout());
    assert.equal(report.ok, true);
    assert.equal(report.shared, false);
    assert.equal(await readFile(join(root, ".gitignore"), "utf8"), ignoreBefore);
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /# agent-ship-exclude-start/);
    assert.match(exclude, /\.agent-ship\//);
    assert.match(exclude, /\.env\*/);
    assert.match(exclude, /\*\.storage-state\.json/);
    assert.match(exclude, /^AGENTS\.md$/m);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    assert.equal(agents.split(RULES_START).length - 1, 1);
    assert.equal(agents.split(RULES_END).length - 1, 1);
    const hook = await readFile(join(root, ".git", "hooks", "pre-commit"), "utf8");
    assert.match(hook, new RegExp(HOOK_START));
    assert.match(hook, /agent-ship-chain/);
    assert.equal(await readFile(join(root, ".git", "hooks", "pre-commit.agent-ship-chain"), "utf8"), foreign);
    await assert.rejects(git(root, ["config", "--local", "--get", "core.hooksPath"]));
    const status = await git(root, ["status", "--short"]);
    assert.equal(status.includes("AGENTS.md"), false);
    assert.equal(status.includes(".agent-ship"), false);

    const second = capture();
    assert.equal(await main(["init", "--root", root], second.io), 0);
    const again = await readFile(join(root, "AGENTS.md"), "utf8");
    assert.equal(again.split(RULES_START).length - 1, 1);
    assert.equal(again, agents);

    const trace = join(root, "hook-trace.txt");
    const noContract = spawnSync(join(root, ".git", "hooks", "pre-commit"), [], { cwd: root, encoding: "utf8" });
    assert.equal(noContract.status, 0);
    assert.match(await readFile(trace, "utf8"), /foreign-hook/);

    await writeFile(
      join(root, ".agent-ship", "contracts", "contract_auth.md"),
      "# Contract\n\n## Allowed paths\n\n- src/**\n\n## Forbidden paths\n\n- .env*\n",
    );
    await writeFile(join(root, ".agent-ship", "active-contract"), "contract_auth\n");
    await writeFile(join(root, ".env"), "nope\n");
    await git(root, ["add", "-f", ".env"]);
    const blocked = spawnSync(join(root, ".git", "hooks", "pre-commit"), [], { cwd: root, encoding: "utf8" });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stdout, /"ok": false/);

    const pushHook = join(root, ".git", "hooks", "pre-push");
    const refused = spawnSync(pushHook, [], {
      cwd: root,
      encoding: "utf8",
      input: "refs/heads/local aaa refs/heads/main bbb\n",
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /protected branch/);
    const feature = spawnSync(pushHook, [], {
      cwd: root,
      encoding: "utf8",
      input: "refs/heads/local aaa refs/heads/feature/slice bbb\n",
    });
    assert.equal(feature.status, 0);
    const allowed = spawnSync(pushHook, [], {
      cwd: root,
      encoding: "utf8",
      input: "refs/heads/local aaa refs/heads/main bbb\n",
      env: { ...process.env, AGENT_SHIP_ALLOW_PROTECTED_PUSH: "1" },
    });
    assert.equal(allowed.status, 0);

    const removed = capture();
    assert.equal(await main(["setup", "--uninstall", "--root", root], removed.io), 0);
    const after = JSON.parse(removed.stdout());
    assert.equal(after.uninstalled, true);
    assert.equal(after.ok, true);
    assert.equal(await readFile(join(root, ".git", "hooks", "pre-commit"), "utf8"), foreign);
    await assert.rejects(readFile(join(root, "AGENTS.md"), "utf8"));
    const excludeAfter = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    assert.equal(excludeAfter.includes("agent-ship-exclude-start"), false);
    assert.equal(await readFile(join(root, ".gitignore"), "utf8"), ignoreBefore);
    await assert.rejects(git(root, ["config", "--local", "--get", "core.hooksPath"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup --shared writes gitignore and leaves info/exclude alone", async () => {
  const root = await repo();
  const excludeBefore = await readFile(join(root, ".git", "info", "exclude"), "utf8");
  try {
    const ran = capture();
    assert.equal(await main(["setup", "--shared", "--root", root], ran.io), 0);
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    assert.match(gitignore, /node_modules\//);
    assert.match(gitignore, /# agent-ship-gitignore-start/);
    assert.match(gitignore, /\.agent-ship\//);
    assert.match(gitignore, /\.env\*/);
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude, excludeBefore);
    assert.match(await readFile(join(root, "AGENTS.md"), "utf8"), new RegExp(RULES_START));
    await assert.rejects(git(root, ["config", "--local", "--get", "core.hooksPath"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local setup does not edit a tracked AGENTS.md", async () => {
  const root = await repo();
  await writeFile(join(root, "AGENTS.md"), "# Team rules\n\nKeep this shared.\n");
  await git(root, ["add", "AGENTS.md"]);
  await git(root, ["commit", "-m", "agents"]);
  try {
    assert.equal(await main(["setup", "--root", root], capture().io), 0);
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "# Team rules\n\nKeep this shared.\n");
    assert.match(await readFile(join(root, ".agent-ship", "AGENTS.local.md"), "utf8"), /Talk to the human only as the captain/);
    const status = await git(root, ["status", "--short"]);
    assert.equal(status.includes("AGENTS.md"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
