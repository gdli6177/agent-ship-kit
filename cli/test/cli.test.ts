import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, parseArgs, type Io } from "../src/cli.js";

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

test("parseArgs keeps repeated evidence and inline values", () => {
  const parsed = parseArgs([
    "inbox",
    "add",
    "--title=Auth",
    "--evidence",
    "https://ci.example/1",
    "--evidence",
    "https://ci.example/2",
    "--latest",
  ]);
  assert.deepEqual(parsed.positionals, ["inbox", "add"]);
  assert.deepEqual(parsed.values.get("evidence"), ["https://ci.example/1", "https://ci.example/2"]);
  assert.equal(parsed.values.get("title")?.[0], "Auth");
  assert.equal(parsed.flags.has("latest"), true);
});

test("cli inbox add/list and notify dry-run against the example policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ship-cli-"));
  const policy = fileURLToPath(new URL("../../templates/notify.policy.example.md", import.meta.url));
  const allowlist = fileURLToPath(new URL("../../templates/notify.allowlist.example.json", import.meta.url));
  try {
    const added = capture();
    const addCode = await main(
      [
        "inbox",
        "add",
        "--root",
        root,
        "--title",
        "Auth middleware ready",
        "--summary",
        "Contract checks passed.",
        "--priority",
        "high",
        "--source-task-id",
        "task_auth_mw",
        "--evidence",
        "https://ci.example/runs/1001",
        "--pr",
        "https://example.com/pull/12",
      ],
      added.io,
    );
    assert.equal(addCode, 0);
    assert.equal(added.stderr(), "");
    const created = JSON.parse(added.stdout());
    assert.equal(created.type, "needs_review");
    assert.equal(created.priority, "high");

    const listed = capture();
    const listCode = await main(["inbox", "list", "--root", root, "--json"], listed.io);
    assert.equal(listCode, 0);
    const items = JSON.parse(listed.stdout());
    assert.equal(items.length, 1);
    assert.equal(items[0].id, created.id);

    const planned = capture();
    const planCode = await main(
      [
        "notify",
        "dry-run",
        "--root",
        root,
        "--latest",
        "--policy",
        policy,
        "--allowlist",
        allowlist,
      ],
      planned.io,
    );
    assert.equal(planCode, 0);
    const plan = JSON.parse(planned.stdout());
    assert.equal(plan.executed, false);
    assert.equal(plan.allow, true);
    assert.equal(plan.reason, "allowlisted");
    assert.equal(plan.matched_rule, "high priority page");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cli warns on high priority without evidence and rejects unknown commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ship-cli-"));
  try {
    const warned = capture();
    const code = await main(
      [
        "inbox",
        "add",
        "--root",
        root,
        "--title",
        "No evidence yet",
        "--summary",
        "Opened early.",
        "--priority",
        "high",
        "--source-task-id",
        "task_early",
      ],
      warned.io,
    );
    assert.equal(code, 0);
    assert.match(warned.stderr(), /no evidence URLs/);

    const bad = capture();
    const badCode = await main(["notify", "run", "--rm", "-rf", "/"], bad.io);
    assert.equal(badCode, 1);
    assert.match(bad.stderr(), /unknown flag --rm/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cli rejects an unknown priority", async () => {
  const captured = capture();
  const code = await main(["inbox", "list", "--priority", "urgent"], captured.io);
  assert.equal(code, 1);
  assert.match(captured.stderr(), /priority must be one of: normal, high/);
});

test("help prints usage and does not require an inbox", async () => {
  const helped = capture();
  assert.equal(await main(["--help"], helped.io), 0);
  assert.match(helped.stdout(), /notify dry-run/);
  assert.match(helped.stdout(), /does not start a command/);
});
