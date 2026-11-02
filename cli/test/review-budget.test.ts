import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { listInbox } from "../src/inbox.js";
import { parseHumanReviewBudget } from "../src/review-budget.js";
import { eventsFile, runWatchdog } from "../src/watchdog.js";

const exec = promisify(execFile);

function section(body: string): string {
  return `# Proposal card\n\nProposal id: proposal_auth\n\n## Human review budget 人工审阅预算\n\n${body}\n`;
}

const filled = `human_reviews_expected: 3

- 方案冻结
- 验收
- 合 PR

must_human: 方案冻结、验收、合 PR 必须由人完成。不自动合并。
already_automated: agent-ship check 已覆盖允许路径和禁止路径。
`;

test("a filled budget parses, and optional notes may be omitted", () => {
  const parsed = parseHumanReviewBudget(section(filled), "proposal");
  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.violations, []);
  assert.deepEqual(parsed.budget, {
    human_reviews_expected: 3,
    reviews: ["方案冻结", "验收", "合 PR"],
    must_human: "方案冻结、验收、合 PR 必须由人完成。不自动合并。",
    already_automated: "agent-ship check 已覆盖允许路径和禁止路径。",
  });

  const bare = parseHumanReviewBudget(section("human_reviews_expected: `0`\n"), "proposal");
  assert.deepEqual(bare.budget, {
    human_reviews_expected: 0,
    reviews: [],
    must_human: null,
    already_automated: null,
  });
});

test("a missing section is an older card, and a new section fails when malformed", () => {
  const older = parseHumanReviewBudget("# Proposal\n\n## Ask\n\n- something\n", "proposal");
  assert.equal(older.present, false);
  assert.deepEqual(older.violations, []);

  const missing = parseHumanReviewBudget(section("- 验收\n"), "proposal");
  assert.equal(missing.budget, null);
  assert.equal(missing.violations[0]?.code, "missing");

  const placeholder = parseHumanReviewBudget(section("human_reviews_expected: `<count>`\n\n- `<验收>`\n"), "proposal");
  assert.equal(placeholder.budget, null);
  assert.ok(placeholder.violations.some((item) => item.message.includes("non-negative integer")));
  assert.ok(placeholder.violations.some((item) => item.message.includes("placeholder")));

  const mismatch = parseHumanReviewBudget(section("human_reviews_expected: 2\n\n- 方案冻结\n- 验收\n- 合 PR\n"), "proposal");
  assert.match(mismatch.violations.map((item) => item.message).join("\n"), /is 2 but lists 3/);

  const emptyNote = parseHumanReviewBudget(section("human_reviews_expected: 1\n\n- 验收\n\nmust_human:\n"), "proposal");
  assert.match(emptyNote.violations.map((item) => item.message).join("\n"), /must_human is empty/);

  const duplicate = parseHumanReviewBudget(`${section(filled)}\n## Human review budget\n\nhuman_reviews_expected: 0\n`, "proposal");
  assert.match(duplicate.violations.map((item) => item.message).join("\n"), /more than one/);
});

test("shipped cards carry the budget fields, and the blank proposal is not yet valid", async () => {
  const proposal = await readFile(new URL("../../templates/proposal-card.md", import.meta.url), "utf8");
  const contract = await readFile(new URL("../../templates/contract-card.md", import.meta.url), "utf8");
  const packet = await readFile(new URL("../../templates/review-packet.md", import.meta.url), "utf8");
  for (const card of [proposal, contract, packet]) {
    assert.match(card, /human_reviews_expected:/);
    assert.match(card, /must_human:/);
    assert.match(card, /already_automated:/);
  }
  assert.match(packet, /inbox_needs_review_count:/);
  assert.match(contract, /inbox_needs_review_count/);
  const parsed = parseHumanReviewBudget(proposal, "proposal");
  assert.equal(parsed.present, true);
  assert.equal(parsed.budget, null);
  assert.ok(parsed.violations.length > 0);
});

async function git(root: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd: root });
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ship-budget-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "base\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "base"]);
  await mkdir(join(root, ".agent-ship", "contracts"), { recursive: true });
  return root;
}

function capture(): { io: { stdout: (chunk: string) => void; stderr: (chunk: string) => void }; stdout: () => string; stderr: () => string } {
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

const paths = `
## Allowed paths 允许改动的路径

- src/**

## Forbidden paths 禁止改动的路径

- .env*
`;

test("older cards warn and still pass; a malformed new proposal fails the check", async () => {
  const root = await repo();
  try {
    await writeFile(join(root, ".agent-ship", "contracts", "contract_auth.md"), `# Contract\n\nContract id: contract_auth\n${paths}`);
    const older = capture();
    assert.equal(await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], older.io), 0);
    const olderResult = JSON.parse(older.stdout());
    assert.equal(olderResult.ok, true);
    assert.equal(olderResult.human_review_budget, null);
    assert.equal(olderResult.inbox_needs_review_count, 0);
    assert.equal("human_review_violations" in olderResult, false);
    assert.match(older.stderr(), /contract contract_auth has no Human review budget section; older card, not a failure/);

    await mkdir(join(root, ".agent-ship", "proposals"), { recursive: true });
    await writeFile(join(root, ".agent-ship", "proposals", "proposal_auth.md"), section("human_reviews_expected: `<count>`\n\n- 验收\n"));
    await writeFile(
      join(root, ".agent-ship", "contracts", "contract_auth.md"),
      `# Contract\n\nContract id: contract_auth\nProposal id: proposal_auth\n${paths}`,
    );
    const bad = capture();
    assert.equal(await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], bad.io), 1);
    const badResult = JSON.parse(bad.stdout());
    assert.equal(badResult.ok, false);
    assert.deepEqual(badResult.violations, []);
    assert.ok(badResult.human_review_violations.some((item: { card: string; code: string }) => item.card === "proposal" && item.code === "malformed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check compares a mirrored budget with the contract's inbox review count", async () => {
  const root = await repo();
  try {
    const budget = `## Human review budget 人工审阅预算\n\n${filled}`;
    await mkdir(join(root, ".agent-ship", "proposals"), { recursive: true });
    await writeFile(join(root, ".agent-ship", "proposals", "proposal_auth.md"), `# Proposal\n\nProposal id: proposal_auth\n\n${budget}`);
    await writeFile(
      join(root, ".agent-ship", "contracts", "contract_auth.md"),
      `# Contract\n\nContract id: contract_auth\nProposal id: proposal_auth\n${budget}\n${paths}`,
    );
    const add = async (args: string[]) => {
      const captured = capture();
      assert.equal(await main(["inbox", "add", "--root", root, ...args], captured.io), 0, captured.stderr());
    };
    await add(["--title", "Acceptance", "--summary", "Evidence is ready.", "--source-task-id", "task_accept", "--contract", "contract_auth"]);
    await add(["--title", "Blocked", "--summary", "Waiting on a decision.", "--source-task-id", "task_block", "--contract", "contract_auth", "--type", "blocked", "--reason", "other"]);
    await add(["--title", "Other", "--summary", "Another contract.", "--source-task-id", "task_other", "--contract", "contract_other"]);

    const good = capture();
    assert.equal(await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], good.io), 0, good.stderr());
    const result = JSON.parse(good.stdout());
    assert.equal(result.ok, true);
    assert.equal(result.human_review_budget.source, "proposal");
    assert.equal(result.human_review_budget.human_reviews_expected, 3);
    assert.deepEqual(result.human_review_budget.reviews, ["方案冻结", "验收", "合 PR"]);
    assert.equal(result.inbox_needs_review_count, 1);
    assert.equal(result.human_review_warnings.length, 0);

    await writeFile(
      join(root, ".agent-ship", "contracts", "contract_auth.md"),
      `# Contract\n\nContract id: contract_auth\nProposal id: proposal_auth\n## Human review budget\n\nhuman_reviews_expected: 1\n\n- 验收\n${paths}`,
    );
    const drifted = capture();
    assert.equal(await main(["check", "--root", root, "--contract", "contract_auth", "--base", "main"], drifted.io), 1);
    const driftedResult = JSON.parse(drifted.stdout());
    assert.equal(driftedResult.violations.length, 0);
    assert.ok(driftedResult.human_review_violations.some((item: { code: string }) => item.code === "mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog reports a malformed human review budget as drift without calling it a path miss", async () => {
  const root = await repo();
  try {
    await writeFile(
      join(root, ".agent-ship", "contracts", "contract_auth.md"),
      `# Contract\n\n## Human review budget\n\nhuman_reviews_expected: 1\n${paths}`,
    );
    const now = new Date();
    await writeFile(
      eventsFile(root),
      `${JSON.stringify({
        id: "evt_disp_budget",
        type: "worker_dispatched",
        title: "Auth slice",
        summary: "Dispatched.",
        created_at: now.toISOString(),
        source_task_id: "task_budget",
        contract_id: "contract_auth",
        slice_id: "auth",
        status: "running",
      })}\n`,
    );
    const report = await runWatchdog(root, { now, staleMinutes: 30 });
    assert.equal(report.flagged[0]?.reason, "drift");
    const filed = (await listInbox(root, { openOnly: true }))[0];
    assert.match(filed?.summary ?? "", /Human review budget failed the check/);
    assert.equal((filed?.summary ?? "").includes("Paths drifted"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
