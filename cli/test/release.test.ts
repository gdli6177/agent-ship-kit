import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { main } from "../src/cli.js";

const exec = promisify(execFile);
async function call(root: string, ...args: string[]) {
  let stdout = "", stderr = "";
  const code = await main([...args, "--root", root], { stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}
async function fixture(body: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ship-release-")));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await writeFile(join(root, "AGENTS.md"), "# Owner rules\n");
    await writeFile(join(root, "allowed.txt"), "baseline\n");
    await exec("git", ["add", "AGENTS.md", "allowed.txt"], { cwd: root });
    await exec("git", ["commit", "-m", "baseline"], { cwd: root });
    assert.equal((await call(root, "setup")).code, 0);
    await body(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("local setup reports rules that the host will not auto-load", () => fixture(async root => {
  const report = (await call(root, "setup")).json();
  assert.equal(report.rules_auto_loaded, false);
  assert.ok(report.warnings.some((s: string) => s.includes("AGENTS.local.md")));
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "# Owner rules\n");
}));

test("local setup preserves an inherited shared ignore block", () => fixture(async root => {
  assert.equal((await call(root, "setup", "--shared")).code, 0);
  const before = await readFile(join(root, ".gitignore"), "utf8");
  const local = await call(root, "setup");
  assert.equal(local.code, 0, local.stdout + local.stderr);
  assert.equal(await readFile(join(root, ".gitignore"), "utf8"), before);
}));

test("intake is idempotent; no contract blocks commits; explicit direct scope permits only allowed paths", () => fixture(async root => {
  const args = ["intake", "--id", "proposal_test", "--text", "Update the allowed file."];
  const proposal = await call(root, ...args);
  assert.equal(proposal.code, 0, proposal.stderr);
  assert.equal(proposal.json().status, "draft");
  assert.equal((await call(root, ...args)).json().unchanged, true);
  assert.equal((await call(root, "guard")).code, 1);
  await writeFile(join(root, "allowed.txt"), "changed\n");
  await exec("git", ["add", "allowed.txt"], { cwd: root });
  await assert.rejects(exec("git", ["commit", "-m", "unauthorized"], { cwd: root }));
  const direct = await call(root, "intake", "--direct", "--id", "direct_test", "--text", "Update allowed.txt only.", "--allowed", "allowed.txt", "--forbidden", "AGENTS.md", "--accepted-by", "Test human", "--accepted-text", "Do it directly within this scope.");
  assert.equal(direct.code, 0, direct.stderr);
  assert.equal((await call(root, "guard", "--staged")).code, 0);
  await writeFile(join(root, "AGENTS.md"), "unauthorized\n");
  await exec("git", ["add", "AGENTS.md"], { cwd: root });
  assert.equal((await call(root, "guard", "--staged")).code, 1);
}));

test("corrections before dispatch become reviewed, scoped lessons and preserve proposal history", () => fixture(async root => {
  await call(root, "setup", "--shared");
  await call(root, "intake", "--id", "proposal_test", "--text", "Prepare the change.");
  const source = "proposal:proposal_test";
  const handbook = await readFile(join(root, "docs/agent-team/handbook.md"), "utf8");
  const correction = await call(root, "correction", "add", "--text", "Read owner rules before making a plan.", "--scope", "lesson", "--source", source, "--project", "demo", "--when", "When planning a change.", "--action", "Read the owner rules first.", "--tag", "process", "--corrected-by", "Test human");
  assert.equal(correction.code, 0, correction.stderr);
  const extracted = await call(root, "learning", "extract");
  assert.equal(extracted.code, 0, extracted.stderr);
  const id = extracted.json().items[0].id;
  assert.equal((await call(root, "team", "context", "--auto", "--project", "demo")).json().lessons.length, 0);
  const reviewed = await call(root, "lesson", "review", "--id", id, "--status", "active", "--reviewed-by", "Test human", "--note", "Reviewed evidence and applicability.");
  assert.equal(reviewed.code, 0, reviewed.stderr);
  const context = (await call(root, "team", "context", "--auto", "--project", "demo")).json();
  assert.equal(context.lessons[0].id, id);
  assert.ok(context.handbook.excerpt.length > 0);
  assert.ok(context.source_details.every((s: { read_required: boolean; digest: string }) => s.read_required && s.digest));
  assert.equal((await call(root, "team", "context", "--auto", "--project", "other")).json().lessons.length, 0);
  assert.equal((await call(root, "learning", "review")).code, 1);
  assert.equal((await call(root, "learning", "review", "--outcome", "candidate", "--reason", "Reviewed this session's corrections.")).code, 0);
  assert.equal(await readFile(join(root, "docs/agent-team/handbook.md"), "utf8"), handbook);
}));

test("single handbook correction enters review queue; secrets are rejected before persistence", () => fixture(async root => {
  await call(root, "setup", "--shared");
  await call(root, "intake", "--id", "proposal_test", "--text", "Prepare release.");
  const result = await call(root, "correction", "add", "--text", "Test and staging have distinct purposes.", "--scope", "handbook", "--source", "proposal:proposal_test", "--project", "demo", "--when", "When preparing a release.", "--action", "Validate test before staging.", "--corrected-by", "Test human");
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await call(root, "lesson", "pending", "--handbook")).json().total_count, 1);
  const bad = await call(root, "correction", "add", "--text", "token=really-private-value", "--scope", "event", "--source", "proposal:proposal_test", "--corrected-by", "Test human");
  assert.equal(bad.code, 1);
  assert.doesNotMatch(await readFile(join(root, ".agent-ship/events.jsonl"), "utf8"), /really-private-value/);
}));

test("a new proposal cannot borrow an older direct authorization", () => fixture(async root => {
  const authorized = await call(root, "intake", "--direct", "--id", "first", "--text", "Update allowed.txt.", "--allowed", "allowed.txt", "--forbidden", "AGENTS.md", "--accepted-by", "Test human", "--accepted-text", "Direct update.");
  assert.equal(authorized.code, 0, authorized.stderr);
  await call(root, "intake", "--id", "second", "--text", "A different request.");
  const result = await call(root, "guard", "--staged");
  assert.equal(result.code, 1);
  assert.match(result.stdout, /no matching frozen contract/);
}));

test("explicit team corrections are reusable across projects; unknown project signals are deferred", () => fixture(async root => {
  const team = await call(root, "correction", "add", "--text", "Read owner rules before dispatch.", "--scope", "lesson", "--source", "session:team_trial", "--team", "--when", "Before dispatch.", "--action", "Read owner rules.", "--corrected-by", "Test human");
  assert.equal(team.code, 0, team.stderr);
  const id = team.json().extraction.items[0].id;
  assert.ok(id);
  assert.equal((await call(root, "lesson", "review", "--id", id, "--status", "active", "--reviewed-by", "Maintainer", "--note", "Applies to all projects.")).code, 0);
  assert.equal((await call(root, "team", "context", "--auto", "--project", "any")).json().lessons[0].id, id);
  const item = await call(root, "inbox", "add", "--title", "Unmanaged review", "--summary", "Review this fixture.", "--source-task-id", "unknown_project_task");
  assert.equal(item.code, 0, item.stderr);
  const decided = await call(root, "inbox", "decide", item.json().id, "changes_requested", "--note", "Check the result against the acceptance criteria.");
  assert.equal(decided.code, 0, decided.stderr);
  const deferred = await call(root, "learning", "extract");
  assert.ok(deferred.json().items.some((item: { deferred?: string }) => item.deferred));
  const scoped = await call(root, "learning", "extract", "--project", "demo");
  assert.ok(scoped.json().items.some((item: { id: string; deferred?: string }) => item.id && !item.deferred));
}));

test("extraction is idempotent after evidence rotation and recurrence after supply requires review", () => fixture(async root => {
  const correction = (id: string) => call(root, "correction", "add", "--text", "Check edge cases before delivery.", "--scope", "lesson", "--source", `session:${id}`, "--project", "demo", "--when", "When delivering code.", "--action", "Test edge cases.", "--corrected-by", "Test human");
  const first = await correction("first");
  assert.equal(first.code, 0, first.stderr);
  const id = first.json().extraction.items[0].id;
  for (let i = 0; i < 12; i++) assert.equal((await correction(`task_${i}`)).code, 0);
  const before = (await call(root, "lesson", "show", "--id", id)).json();
  await call(root, "learning", "extract");
  assert.deepEqual((await call(root, "lesson", "show", "--id", id)).json(), before);
  assert.equal((await call(root, "lesson", "review", "--id", id, "--status", "active", "--reviewed-by", "Human maintainer", "--note", "Reviewed evidence.")).code, 0);
  await new Promise(resolve => setTimeout(resolve, 5));
  const supplied = await call(root, "team", "context", "--auto", "--project", "demo", "--source-task-id", "again");
  assert.equal(supplied.json().lessons[0].id, id);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await correction("again")).code, 0);
  assert.equal((await call(root, "lesson", "show", "--id", id)).json().lesson.status, "needs_review");
  assert.equal((await call(root, "team", "context", "--auto", "--project", "demo")).json().lessons.length, 0);
}));
