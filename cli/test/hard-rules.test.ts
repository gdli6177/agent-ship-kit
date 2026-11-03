import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { main, type Io } from "../src/cli.js";
import { containsSecret, hardRulesPath, matchHardRules } from "../src/hard-rules.js";

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

async function git(root: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd: root });
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "crewvane-rules-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "base\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "crewvane-rules-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const contract = `# Contract

## Allowed paths

- src/**

## Forbidden paths

- .env*
`;

async function addItem(root: string, id: string): Promise<void> {
  const added = capture();
  assert.equal(
    await main(
      [
        "inbox",
        "add",
        "--root",
        root,
        "--type",
        "blocked",
        "--id",
        id,
        "--title",
        "Review note",
        "--summary",
        "Human asked for a change.",
        "--source-task-id",
        "task_rules",
      ],
      added.io,
    ),
    0,
  );
}

test("matchHardRules names the rule id and leaves verify items as checklist", () => {
  const matched = matchHardRules(["src/secret.ts", "src/app.ts"], [
    {
      id: "hr_secret",
      kind: "hook",
      source: { text: "no private file" },
      paths: ["src/secret.ts"],
      message: "Do not add src/secret.ts.",
      created_at: "2026-11-02T00:00:00.000Z",
      updated_at: "2026-11-02T00:00:00.000Z",
    },
    {
      id: "hr_login",
      kind: "verify_checklist",
      source: { text: "re-run login" },
      paths: ["src/**"],
      message: "Re-run the login smoke.",
      command_hint: "npm test",
      created_at: "2026-11-02T00:00:00.000Z",
      updated_at: "2026-11-02T00:00:00.000Z",
    },
  ]);
  assert.equal(matched.violations.length, 1);
  assert.equal(matched.violations[0]?.rule, "hard_rule");
  assert.equal(matched.violations[0]?.rule_id, "hr_secret");
  assert.equal(matched.checklist[0]?.id, "hr_login");
  assert.deepEqual(matched.checklist[0]?.matched, ["src/secret.ts", "src/app.ts"]);
});

test("promote writes a hard rule and updates the same inbox kind in place", async () => {
  await withRoot(async (root) => {
    await addItem(root, "evt_rule_env");
    const created = capture();
    assert.equal(
      await main(
        [
          "promote",
          "--root",
          root,
          "--inbox",
          "evt_rule_env",
          "--kind",
          "hook",
          "--glob",
          ".env*",
          "--message",
          "Do not commit env files.",
          "--source",
          "Stop committing env files.",
          "--tag",
          "no-env",
        ],
        created.io,
      ),
      0,
    );
    const rule = JSON.parse(created.stdout());
    assert.equal(rule.action, "created");
    assert.equal(rule.id, "hr_evt_rule_env");
    assert.equal(rule.kind, "hook");
    assert.equal(rule.source.inbox_id, "evt_rule_env");
    assert.deepEqual(rule.paths, [".env*"]);
    const raw = await readFile(hardRulesPath(root), "utf8");
    assert.equal(containsSecret(raw), false);
    assert.equal(JSON.parse(raw).rules.length, 1);

    const updated = capture();
    assert.equal(
      await main(
        [
          "promote",
          "--root",
          root,
          "--inbox",
          "evt_rule_env",
          "--kind",
          "hook",
          "--glob",
          ".env*",
          "--glob",
          ".env.local",
          "--message",
          "Do not commit env files or local overrides.",
          "--source",
          "Stop committing env files.",
        ],
        updated.io,
      ),
      0,
    );
    const again = JSON.parse(updated.stdout());
    assert.equal(again.action, "updated");
    assert.equal(again.id, "hr_evt_rule_env");
    const stored = JSON.parse(await readFile(hardRulesPath(root), "utf8"));
    assert.equal(stored.rules.length, 1);
    assert.deepEqual(stored.rules[0].paths, [".env*", ".env.local"]);
  });
});

test("check fails with the hard rule id and a verify rule stays a checklist", async () => {
  const root = await repo();
  try {
    await mkdir(join(root, ".crewvane", "contracts"), { recursive: true });
    await writeFile(join(root, ".crewvane", "contracts", "contract_auth.md"), contract);
    await addItem(root, "evt_rule_secret");
    assert.equal(
      await main(
        [
          "promote",
          "--root",
          root,
          "--inbox",
          "evt_rule_secret",
          "--kind",
          "contract",
          "--glob",
          "src/secret.ts",
          "--message",
          "Do not add the private helper.",
          "--source",
          "That file keeps coming back.",
        ],
        capture().io,
      ),
      0,
    );
    const marker = join(root, "hint-ran.txt");
    assert.equal(
      await main(
        [
          "promote",
          "--root",
          root,
          "--kind",
          "verify",
          "--source",
          "Re-run login when auth changes.",
          "--glob",
          "src/**",
          "--message",
          "Re-run the login smoke.",
          "--command-hint",
          `node -e "require('fs').writeFileSync('${marker}','ran')"`,
        ],
        capture().io,
      ),
      0,
    );

    await git(root, ["checkout", "-b", "ship/contract_auth/slice"]);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "secret.ts"), "export const no = true;\n");
    await git(root, ["add", "src/secret.ts"]);
    await git(root, ["commit", "-m", "secret helper"]);

    const bad = capture();
    assert.equal(await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], bad.io), 1);
    const result = JSON.parse(bad.stdout());
    assert.equal(result.ok, false);
    const hit = result.violations.find((item: { rule_id?: string }) => item.rule_id === "hr_evt_rule_secret");
    assert.equal(hit.rule, "hard_rule");
    assert.equal(hit.kind, "contract_forbidden");
    assert.equal(hit.path, "src/secret.ts");
    assert.equal(result.checklist.length, 1);
    assert.equal(result.checklist[0].id.startsWith("hr_"), true);
    await assert.rejects(readFile(marker, "utf8"));

    const hooksOnly = capture();
    assert.equal(await main(["check", "--root", root, "--hard-rules", "--base", "main"], hooksOnly.io), 1);
    assert.equal(JSON.parse(hooksOnly.stdout()).violations[0].rule_id, "hr_evt_rule_secret");

    await git(root, ["rm", "src/secret.ts"]);
    await git(root, ["commit", "-m", "drop secret"]);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "export const ok = true;\n");
    await git(root, ["add", "src/app.ts"]);
    await git(root, ["commit", "-m", "app"]);
    const checklist = capture();
    assert.equal(await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], checklist.io), 0);
    const clean = JSON.parse(checklist.stdout());
    assert.equal(clean.ok, true);
    assert.equal(clean.checklist[0].command_hint.includes("hint-ran"), true);
    await assert.rejects(readFile(marker, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decide without promote leaves the decision and writes no hard rule", async () => {
  await withRoot(async (root) => {
    await addItem(root, "evt_plain");
    const decided = capture();
    assert.equal(
      await main(
        ["inbox", "decide", "evt_plain", "changes_requested", "--root", root, "--note", "Stay read-only.", "--promote", "none"],
        decided.io,
      ),
      0,
    );
    const decision = JSON.parse(decided.stdout());
    assert.deepEqual(Object.keys(decision).sort(), [
      "created_at",
      "decision",
      "id",
      "note",
      "sequence",
      "source_task_id",
      "subject_id",
      "summary",
      "title",
      "type",
    ]);
    assert.equal(decision.decision, "changes_requested");
    assert.equal(decision.subject_id, "evt_plain");
    assert.equal(decision.note, "Stay read-only.");
    assert.equal(decided.stderr(), "");
    await assert.rejects(readFile(hardRulesPath(root), "utf8"));
    await assert.rejects(readFile(join(root, ".crewvane", "feedback-tags.json"), "utf8"));

    const open = capture();
    assert.equal(await main(["inbox", "list", "--root", root, "--json"], open.io), 0);
    assert.deepEqual(JSON.parse(open.stdout()), []);
  });
});

test("decide --promote writes the rule without changing the decision record", async () => {
  await withRoot(async (root) => {
    await addItem(root, "evt_promote_me");
    const refused = capture();
    assert.equal(
      await main(
        ["inbox", "decide", "evt_promote_me", "changes_requested", "--root", root, "--promote", "hook", "--note", "No env files."],
        refused.io,
      ),
      1,
    );
    assert.match(refused.stderr(), /--glob is required/);
    const stillOpen = capture();
    assert.equal(await main(["inbox", "list", "--root", root, "--json"], stillOpen.io), 0);
    assert.equal(JSON.parse(stillOpen.stdout())[0].id, "evt_promote_me");

    const decided = capture();
    assert.equal(
      await main(
        [
          "inbox",
          "decide",
          "evt_promote_me",
          "changes_requested",
          "--root",
          root,
          "--note",
          "No env files.",
          "--promote",
          "hook",
          "--glob",
          ".env*",
          "--tag",
          "no-env",
        ],
        decided.io,
      ),
      0,
    );
    const decision = JSON.parse(decided.stdout());
    assert.equal(decision.type, "review_decided");
    assert.equal(decision.promoted, undefined);
    assert.match(decided.stderr(), /^promoted hr_evt_promote_me\n$/);
    const stored = JSON.parse(await readFile(hardRulesPath(root), "utf8"));
    assert.equal(stored.rules[0].source.inbox_id, "evt_promote_me");
    assert.equal(stored.rules[0].message, "No env files.");
    assert.equal(containsSecret(JSON.stringify(stored)), false);
  });
});

test("a repeated tag suggests promote and does not write a rule", async () => {
  await withRoot(async (root) => {
    await addItem(root, "evt_tag_one");
    await addItem(root, "evt_tag_two");
    const first = capture();
    assert.equal(
      await main(
        ["inbox", "decide", "evt_tag_one", "changes_requested", "--root", root, "--note", "Stop env files.", "--tag", "no-env"],
        first.io,
      ),
      0,
    );
    assert.equal(first.stderr(), "");
    const second = capture();
    assert.equal(
      await main(
        ["inbox", "decide", "evt_tag_two", "changes_requested", "--root", root, "--note", "Stop env files.", "--tag", "no-env"],
        second.io,
      ),
      0,
    );
    assert.match(second.stderr(), /suggest promote: tag "no-env" count 2/);
    assert.match(second.stderr(), /suggest promote: changes_requested note repeated 2 times/);
    await assert.rejects(readFile(hardRulesPath(root), "utf8"));
  });
});

test("promote refuses secrets and does not store them", async () => {
  await withRoot(async (root) => {
    const secret = "token=abcd1234efgh";
    const refused = capture();
    assert.equal(
      await main(
        ["promote", "--root", root, "--kind", "hook", "--glob", ".env*", "--message", secret, "--source", "review note"],
        refused.io,
      ),
      1,
    );
    assert.match(refused.stderr(), /looks like a secret/);
    assert.equal(refused.stderr().includes(secret), false);
    await assert.rejects(readFile(hardRulesPath(root), "utf8"));

    const bearer = capture();
    assert.equal(
      await main(
        [
          "promote",
          "--root",
          root,
          "--kind",
          "verify",
          "--message",
          "Re-run the smoke.",
          "--source",
          "Bearer abcdefghijklmnop",
        ],
        bearer.io,
      ),
      1,
    );
    assert.match(bearer.stderr(), /looks like a secret/);
    await assert.rejects(readFile(hardRulesPath(root), "utf8"));
  });
});

test("a stored secret fails closed and pre-commit enforces hook rules without a contract", async () => {
  const root = await repo();
  try {
    assert.equal(await main(["setup", "--root", root], capture().io), 0);
    await mkdir(join(root, ".crewvane"), { recursive: true });
    await writeFile(
      hardRulesPath(root),
      `${JSON.stringify({
        version: 1,
        rules: [
          {
            id: "hr_leaked",
            kind: "hook",
            source: { text: "token=abcd1234efgh" },
            paths: ["README.md"],
            message: "leaked",
            created_at: "2026-11-02T00:00:00.000Z",
            updated_at: "2026-11-02T00:00:00.000Z",
          },
        ],
      })}\n`,
    );
    const poisoned = capture();
    assert.equal(await main(["check", "--root", root, "--hard-rules", "--staged"], poisoned.io), 1);
    assert.match(poisoned.stderr(), /contains a secret/);

    await writeFile(
      hardRulesPath(root),
      `${JSON.stringify({
        version: 1,
        rules: [
          {
            id: "hr_drop",
            kind: "hook",
            source: { text: "Do not add drop files." },
            paths: ["drop/**"],
            message: "Do not add drop files.",
            created_at: "2026-11-02T00:00:00.000Z",
            updated_at: "2026-11-02T00:00:00.000Z",
          },
        ],
      })}\n`,
    );
    await mkdir(join(root, "drop"), { recursive: true });
    await writeFile(join(root, "drop", "note.txt"), "nope\n");
    await git(root, ["add", "drop/note.txt"]);
    const hook = join(root, ".git", "hooks", "pre-commit");
    const blocked = spawnSync(hook, [], { cwd: root, encoding: "utf8" });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stdout, /hr_drop/);
    assert.match(blocked.stdout, /"ok": false/);

    await git(root, ["reset", "HEAD"]);
    await writeFile(join(root, "README.md"), "base\nstill fine\n");
    await git(root, ["add", "README.md"]);
    const authorization = capture();
    assert.equal(await main(["intake", "--direct", "--text", "Update README only.", "--allowed", "README.md", "--forbidden", "drop/**", "--accepted-by", "Test human", "--accepted-text", "Direct README update.", "--root", root], authorization.io), 0);
    const allowed = spawnSync(hook, [], { cwd: root, encoding: "utf8" });
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.match(allowed.stdout, /"ok": true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
