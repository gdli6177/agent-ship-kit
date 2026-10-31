import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { checkPaths, parseContractPaths } from "../src/paths.js";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd: root });
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ship-check-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "base\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

const contract = `# Contract card

Contract id: contract_auth

## Allowed paths 允许改动的路径

- src/**

## Forbidden paths 禁止改动的路径

- .env*
- secrets/**
`;

test("path rules flag forbidden matches and paths outside the allow list", () => {
  const paths = parseContractPaths(contract);
  assert.deepEqual(paths.allowed, ["src/**"]);
  assert.deepEqual(paths.forbidden, [".env*", "secrets/**"]);
  const violations = checkPaths(["src/app.ts", ".env", "secrets/key.txt", "docs/guide.md"], paths);
  assert.deepEqual(
    violations.map((item) => item.path),
    [".env", "secrets/key.txt", "docs/guide.md"],
  );
  assert.equal(violations[0]?.rule, "forbidden");
  assert.equal(violations[2]?.rule, "outside_allowed");
});

test("check compares the branch to base with plain git and fails closed", async () => {
  const root = await repo();
  try {
    await mkdir(join(root, ".agent-ship", "contracts"), { recursive: true });
    await writeFile(join(root, ".agent-ship", "contracts", "contract_auth.md"), contract);
    await git(root, ["checkout", "-b", "ship/contract_auth/slice"]);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const ok = true;\n");
    await git(root, ["add", "src/app.ts"]);
    await git(root, ["commit", "-m", "slice"]);

    const good = capture();
    assert.equal(
      await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], good.io),
      0,
    );
    const goodResult = JSON.parse(good.stdout());
    assert.equal(goodResult.ok, true);
    assert.deepEqual(goodResult.changed, ["src/app.ts"]);

    await writeFile(join(root, ".env"), "TOKEN=nope\n");
    await git(root, ["add", ".env"]);
    await git(root, ["commit", "-m", "secret"]);
    const bad = capture();
    assert.equal(
      await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], bad.io),
      1,
    );
    const badResult = JSON.parse(bad.stdout());
    assert.equal(badResult.ok, false);
    assert.ok(badResult.violations.some((item: { path: string; rule: string }) => item.path === ".env" && item.rule === "forbidden"));

    await writeFile(join(root, "notes.txt"), "outside\n");
    await git(root, ["add", "notes.txt"]);
    const staged = capture();
    assert.equal(
      await main(["check", "--root", root, "--contract", "contract_auth", "--staged"], staged.io),
      1,
    );
    const stagedResult = JSON.parse(staged.stdout());
    assert.equal(stagedResult.mode, "staged");
    assert.equal(stagedResult.violations[0].rule, "outside_allowed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function capture(): { io: { stdout: (chunk: string) => void; stderr: (chunk: string) => void }; stdout: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => err.push(chunk),
    },
    stdout: () => out.join(""),
  };
}
