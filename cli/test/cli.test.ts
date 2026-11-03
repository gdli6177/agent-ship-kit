import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "crewvane-cli-"));
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
  const root = await mkdtemp(join(tmpdir(), "crewvane-cli-"));
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

test("cli decide hides the item and notify run refuses a high page without evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-cli-"));
  const policy = fileURLToPath(new URL("../../templates/notify.policy.example.md", import.meta.url));
  const allowlist = fileURLToPath(new URL("../../templates/notify.allowlist.example.json", import.meta.url));
  try {
    const added = capture();
    assert.equal(
      await main(
        [
          "inbox",
          "add",
          "--root",
          root,
          "--type",
          "needs_approval",
          "--title",
          "Approve the migration slice",
          "--summary",
          "Worker is waiting on the owner.",
          "--source-task-id",
          "task_migrate",
          "--id",
          "evt_need_migrate",
        ],
        added.io,
      ),
      0,
    );

    const decided = capture();
    assert.equal(
      await main(
        ["inbox", "decide", "evt_need_migrate", "changes_requested", "--root", root, "--note", "Stay read-only."],
        decided.io,
      ),
      0,
    );
    const decision = JSON.parse(decided.stdout());
    assert.equal(decision.type, "review_decided");
    assert.equal(decision.subject_id, "evt_need_migrate");
    assert.equal(decision.decision, "changes_requested");

    const open = capture();
    assert.equal(await main(["inbox", "list", "--root", root, "--json"], open.io), 0);
    assert.deepEqual(JSON.parse(open.stdout()), []);

    const all = capture();
    assert.equal(await main(["inbox", "list", "--root", root, "--all", "--json"], all.io), 0);
    assert.equal(JSON.parse(all.stdout()).length, 2);

    const bare = capture();
    assert.equal(
      await main(
        [
          "inbox",
          "add",
          "--root",
          root,
          "--title",
          "High with no proof",
          "--summary",
          "Not ready to page.",
          "--priority",
          "high",
          "--source-task-id",
          "task_empty",
          "--id",
          "evt_high_empty",
        ],
        bare.io,
      ),
      0,
    );
    const ran = capture();
    const code = await main(
      ["notify", "run", "--root", root, "--latest", "--policy", policy, "--allowlist", allowlist],
      ran.io,
    );
    assert.equal(code, 1);
    const refused = JSON.parse(ran.stdout());
    assert.equal(refused.allow, false);
    assert.equal(refused.executed, false);
    assert.equal(refused.mode, "run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notify run executes an allowlisted argv and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-run-"));
  const previousActor = process.env.CREWVANE_ACTOR;
  const sentinel = join(root, "ran.txt");
  const script = join(root, "mark.js");
  await writeFile(script, "require('node:fs').writeFileSync(process.argv[2], 'ran');\n");
  const program = process.execPath;
  const action = `${program} ${script} ${sentinel}`;
  const policy = join(root, "policy.md");
  const allowlist = join(root, "allow.json");
  await writeFile(
    policy,
    `## Rule: mark\n\nwhen.type: blocked\naction: ${action}\n`,
  );
  await writeFile(allowlist, JSON.stringify({ patterns: [action] }));
  try {
    assert.equal(
      await main(
        [
          "inbox",
          "add",
          "--root",
          root,
          "--type",
          "blocked",
          "--title",
          "Need a decision",
          "--summary",
          "Worker stopped.",
          "--source-task-id",
          "task_block",
        ],
        capture().io,
      ),
      0,
    );
    delete process.env.CREWVANE_ACTOR;
    assert.equal(await main(["authority", "init", "--root", root, "--human", "fixture-human", "--captain", "fixture-captain"], capture().io), 0);
    process.env.CREWVANE_ACTOR = "fixture-captain";
    const ran = capture();
    const code = await main(
      ["notify", "run", "--root", root, "--latest", "--policy", policy, "--allowlist", allowlist],
      ran.io,
    );
    assert.equal(code, 0);
    assert.equal(await readFile(sentinel, "utf8"), "ran");
    const result = JSON.parse(ran.stderr());
    assert.equal(result.mode, "run");
    assert.equal(result.executed, true);
    assert.equal(result.exit_code, 0);

    const denied = capture();
    const deniedCode = await main(
      [
        "notify",
        "run",
        "--root",
        root,
        "--latest",
        "--policy",
        policy,
        "--allowlist",
        allowlist,
        "--action",
        "rm -rf /",
      ],
      denied.io,
    );
    assert.equal(deniedCode, 1);
    assert.equal(JSON.parse(denied.stdout()).allow, false);
    assert.equal(await readFile(sentinel, "utf8"), "ran");
  } finally {
    if (previousActor === undefined) delete process.env.CREWVANE_ACTOR; else process.env.CREWVANE_ACTOR = previousActor;
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
