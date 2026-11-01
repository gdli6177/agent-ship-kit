import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { activeSlices, allSlices, runWatchdog } from "../src/watchdog.js";

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root })).stdout.trim();
}
async function call(root: string, ...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main([...args, "--root", root], {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr };
}
async function repo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, ".gitignore"), ".agent-ship/\nrepos/\n");
  await writeFile(join(root, "allowed.txt"), "baseline\n");
  await writeFile(join(root, "forbidden.txt"), "baseline\n");
  await git(root, "add", ".gitignore", "allowed.txt", "forbidden.txt");
  await git(root, "commit", "-m", "baseline");
}
async function contract(root: string, id = "c", status = "frozen", allowed = "allowed.txt", cap = 3) {
  await mkdir(join(root, ".agent-ship", "contracts"), { recursive: true });
  await writeFile(join(root, ".agent-ship", "contracts", `${id}.md`), `# Contract
Status: ${status}
Frozen by: Test human
Frozen at: 2026-10-31T10:00:00Z
## Allowed paths
- ${allowed}
## Forbidden paths
- forbidden.txt
## Slices
max_parallel: ${cap}
| Slice id | Inputs | Done when |
| --- | --- | --- |
| a | contract | checks pass |
| b | contract | checks pass |
`);
}
async function start(root: string, task: string, slice = "a", extra: string[] = []) {
  return call(root, "slice", "start", "--contract", "c", "--slice", slice,
    "--source-task-id", task, ...(extra.some((arg) => arg.startsWith("--branch")) ? [] : ["--branch", "main"]), "--title", task, "--summary", "Test dispatch.", ...extra);
}
async function fixture(body: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ship-workspace-")));
  const previous = process.env.AGENT_SHIP_TIMER_PLATFORM;
  const previousHome = process.env.AGENT_SHIP_TIMER_HOME;
  process.env.AGENT_SHIP_TIMER_PLATFORM = "unsupported";
  process.env.AGENT_SHIP_TIMER_HOME = join(root, "timer-home");
  try { await body(root); }
  finally {
    if (previous === undefined) delete process.env.AGENT_SHIP_TIMER_PLATFORM;
    else process.env.AGENT_SHIP_TIMER_PLATFORM = previous;
    if (previousHome === undefined) delete process.env.AGENT_SHIP_TIMER_HOME;
    else process.env.AGENT_SHIP_TIMER_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

test("slice start reports each frozen-contract and branch requirement", async () => fixture(async (root) => {
  await repo(root);
  await contract(root);
  const missingBranch = await start(root, "nobranch", "a", ["--branch", "ship/missing"]);
  assert.equal(missingBranch.code, 1);
  assert.equal(
    missingBranch.stderr.includes(`branch ship/missing does not exist in ${root}; create it first (git branch ship/missing main)`),
    true,
    missingBranch.stderr,
  );

  const text = await readFile(join(root, ".agent-ship", "contracts", "c.md"), "utf8");
  await writeFile(join(root, ".agent-ship", "contracts", "c.md"), text.replace("Frozen by: Test human", "Frozen by: <name>"));
  assert.match((await start(root, "no-by")).stderr, /contract must record Frozen by/);
  await writeFile(join(root, ".agent-ship", "contracts", "c.md"), text.replace("Frozen at: 2026-10-31T10:00:00Z", "Frozen at: yesterday"));
  assert.match((await start(root, "no-at")).stderr, /contract must record a valid Frozen at/);
  await writeFile(join(root, ".agent-ship", "contracts", "c.md"), text.replace("- forbidden.txt\n", ""));
  assert.match((await start(root, "no-forbidden")).stderr, /contract needs non-empty Forbidden paths/);
  await writeFile(join(root, ".agent-ship", "contracts", "c.md"), text);
  assert.match((await start(root, "unknown-slice", "missing")).stderr, /slice missing is not in the Slices table/);
}));

test("setup from a subdirectory uses that worktree's top-level", async () => fixture(async (root) => {
  await repo(root);
  const nested = join(root, "src", "nested");
  await mkdir(nested, { recursive: true });
  const here = await call(nested, "setup");
  assert.equal(here.code, 0, here.stderr);
  assert.equal(JSON.parse(here.stdout).root, root);
  await readFile(join(root, ".agent-ship", "kit-root"), "utf8");

  const member = join(root, "member");
  const tree = join(root, "tree");
  await repo(member);
  await git(member, "worktree", "add", "-b", "ship/c/a", tree, "main");
  const inside = join(tree, "inside");
  await mkdir(inside);
  const fromTree = await call(inside, "setup");
  assert.equal(fromTree.code, 0, fromTree.stderr);
  assert.equal(JSON.parse(fromTree.stdout).root, await realpath(tree));
  await readFile(join(tree, ".agent-ship", "kit-root"), "utf8");
  const hooks = await git(tree, "rev-parse", "--git-path", "hooks/pre-commit");
  assert.match(await readFile(hooks.startsWith("/") ? hooks : join(tree, hooks), "utf8"), /agent-ship-hook-start/);
}));

test("a dead hook-registry lock is reclaimed", async () => fixture(async (root) => {
  await repo(root);
  const hooks = await git(root, "rev-parse", "--git-path", "hooks");
  const hookDir = hooks.startsWith("/") ? hooks : join(root, hooks);
  const lock = join(hookDir, ".agent-ship-lock");
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 2_000_000_001, hostname: hostname(), started_at: "2020-01-01T00:00:00Z", cmd: "stale-hook" }));
  const result = await call(root, "setup");
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(readFile(join(lock, "owner.json"), "utf8"));
}));

test("allSlices uses sequence then file order when created_at does not parse", async () => fixture(async (root) => {
  await mkdir(join(root, ".agent-ship"), { recursive: true });
  const line = (task: string, sequence?: number) => JSON.stringify({
    type: "worker_dispatched", source_task_id: task, title: task, summary: task, created_at: "not-a-date", status: "running", ...(sequence === undefined ? {} : { sequence }),
  });
  await writeFile(join(root, ".agent-ship", "events.jsonl"), `${line("file-a")}\n${line("file-b")}\n${line("file-c")}\n`);
  assert.deepEqual((await allSlices(root)).map((slice) => slice.source_task_id), ["file-a", "file-b", "file-c"]);
  await writeFile(join(root, ".agent-ship", "events.jsonl"), `${line("seq-3", 3)}\n${line("seq-1", 1)}\n${line("seq-2", 2)}\n`);
  assert.deepEqual((await allSlices(root)).map((slice) => slice.source_task_id), ["seq-1", "seq-2", "seq-3"]);
}));

test("dispatch rejects missing/draft contracts, unknown slices and duplicate work", async () => fixture(async (root) => {
  await repo(root);
  assert.equal((await start(root, "missing")).code, 1);
  await contract(root, "c", "draft");
  assert.equal((await start(root, "draft")).code, 1);
  await contract(root);
  assert.equal((await start(root, "unknown", "unknown")).code, 1);
  assert.equal((await start(root, "first")).code, 0);
  assert.equal((await start(root, "duplicate")).code, 1);
  assert.equal((await start(root, "first", "b")).code, 1);
}));

test("simultaneous dispatches share atomic global and contract caps across repositories", async () => fixture(async (root) => {
  await repo(root);
  const a = join(root, "repos", "a"), b = join(root, "repos", "b");
  await repo(a); await repo(b); await contract(root);
  await writeFile(join(root, ".agent-ship", "limits.json"), '{"global_max_parallel":1}');
  const results = await Promise.all([start(root, "one", "a", ["--repo", a]), start(root, "two", "b", ["--repo", b])]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 1]);
  assert.equal((await activeSlices(root)).length, 1);
  await writeFile(join(root, ".agent-ship", "events.jsonl"), "");
  await writeFile(join(root, ".agent-ship", "limits.json"), '{"global_max_parallel":3}');
  await contract(root, "c", "frozen", "allowed.txt", 1);
  const perContract = await Promise.all([start(root, "three", "a", ["--repo", a]), start(root, "four", "b", ["--repo", b])]);
  assert.deepEqual(perContract.map((r) => r.code).sort(), [0, 1]);
}));

test("central checks and watchdog inspect the worker repository and branch", async () => fixture(async (root) => {
  await repo(root);
  const member = join(root, "repos", "member");
  await repo(member); await contract(root);
  await git(member, "checkout", "-b", "ship/c/a");
  await writeFile(join(member, "forbidden.txt"), "drift\n");
  await git(member, "add", "forbidden.txt"); await git(member, "commit", "-m", "drift");
  await git(member, "checkout", "main");
  assert.equal((await start(root, "worker", "a", ["--repo", member, "--branch=ship/c/a"])).code, 0);
  const check = await call(root, "check", "--contract", "c");
  assert.equal(check.code, 1, check.stderr);
  assert.equal(JSON.parse(check.stdout).repo_root, member);
  assert.deepEqual(JSON.parse(check.stdout).changed, ["forbidden.txt"]);
  const report = await runWatchdog(root);
  assert.equal(report.flagged[0]?.reason, "drift");
  assert.equal(report.flagged[0]?.source_task_id, "worker");
}));

test("a parent contract cannot silently check paths in a nested Git repository", async () => fixture(async (root) => {
  await repo(root); await repo(join(root, "repos", "member"));
  await contract(root, "c", "frozen", "repos/member/**");
  const result = await call(root, "check", "--contract", "c");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /nested.*repository|--repo/i);
}));

test("worktree setup uses shared Git hooks and checkout-specific contracts/state roots", async () => fixture(async (root) => {
  const state = join(root, "state"), member = join(root, "member"), a = join(root, "a"), b = join(root, "b");
  await repo(state); await repo(member); await contract(state);
  await git(member, "worktree", "add", "-b", "ship/c/a", a, "main");
  await git(member, "worktree", "add", "-b", "ship/c/b", b, "main");
  assert.equal((await call(a, "setup", "--state-root", state)).code, 0);
  assert.equal((await call(b, "setup", "--state-root", state)).code, 0);
  assert.equal((await readFile(join(a, ".agent-ship", "state-root"), "utf8")).trim(), state);
  await writeFile(join(a, ".agent-ship", "active-contract"), "c\n");
  await writeFile(join(b, ".agent-ship", "active-contract"), "c\n");
  await writeFile(join(a, "forbidden.txt"), "denied\n"); await git(a, "add", "forbidden.txt");
  await assert.rejects(git(a, "commit", "-m", "forbidden"), /forbidden|ok/);
  await writeFile(join(b, "allowed.txt"), "allowed\n"); await git(b, "add", "allowed.txt");
  await git(b, "commit", "-m", "allowed");
  const hook = await git(b, "rev-parse", "--git-path", "hooks/pre-push");
  const push = spawnSync("sh", [hook], { cwd: b, encoding: "utf8", input: "refs/heads/x aaa refs/heads/main bbb\n" });
  assert.equal(push.status, 1);
  assert.match(push.stderr, /protected branch/);
  assert.doesNotMatch(push.stderr, /not a directory/i);
  assert.equal((await call(a, "setup", "--uninstall")).code, 0);
  assert.match(await readFile(await git(b, "rev-parse", "--git-path", "hooks/pre-commit"), "utf8"), /agent-ship-hook-start/);
}));

test("inbox review closes running work without a later false stall", async () => fixture(async (root) => {
  await repo(root); await contract(root);
  assert.equal((await start(root, "worker")).code, 0);
  const added = await call(root, "inbox", "add", "--title", "Ready", "--summary", "Checks passed.", "--source-task-id", "worker", "--evidence", "https://example.com/evidence");
  const id = JSON.parse(added.stdout).id;
  assert.equal((await activeSlices(root)).length, 0);
  assert.equal((await call(root, "slice", "update", "--source-task-id", "worker", "--status", "running")).code, 1);
  assert.equal((await call(root, "inbox", "decide", id, "accept")).code, 0);
  assert.equal((await runWatchdog(root, { now: new Date(Date.now() + 7200000) })).noop, true);
  assert.equal((await call(root, "slice", "update", "--source-task-id", "worker", "--status", "running")).code, 1);
}));

test("resume rechecks limits, and failed work requires explicit replacement", async () => fixture(async (root) => {
  await repo(root); await contract(root);
  await writeFile(join(root, ".agent-ship", "limits.json"), '{"global_max_parallel":1}');
  assert.equal((await start(root, "first")).code, 0);
  const item = await call(root, "inbox", "add", "--title", "Ready", "--summary", "Review me.", "--source-task-id", "first");
  await call(root, "inbox", "decide", JSON.parse(item.stdout).id, "changes_requested", "--note", "Please revise.");
  assert.equal((await start(root, "second", "b")).code, 0);
  assert.equal((await call(root, "slice", "update", "--source-task-id", "first", "--status", "running")).code, 1);
  assert.equal((await call(root, "slice", "update", "--source-task-id", "second", "--status", "cancelled")).code, 0);
  assert.equal((await call(root, "slice", "update", "--source-task-id", "first", "--status", "running")).code, 0);
  assert.equal((await activeSlices(root)).length, 1);
  assert.equal((await call(root, "slice", "update", "--source-task-id", "first", "--status", "failed")).code, 0);
  assert.equal((await start(root, "replacement")).code, 1);
  assert.equal((await start(root, "replacement", "a", ["--replace"])).code, 0);
}));

test("dispatch caps serialize actual CLI processes, not only in-process calls", async () => fixture(async (root) => {
  await repo(root); await contract(root);
  await writeFile(join(root, ".agent-ship", "limits.json"), '{"global_max_parallel":1}');
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const processes = ["a", "b"].map((slice) => exec(process.execPath, ["--import", "tsx", cli, "slice", "start", "--root", root, "--contract", "c", "--slice", slice, "--source-task-id", slice, "--branch", "main", "--title", slice, "--summary", "Process admission."], { cwd: fileURLToPath(new URL("..", import.meta.url)) }));
  const results = await Promise.allSettled(processes);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await activeSlices(root)).length, 1);
}));

test("missing worker branches fail visibly and multiple repo checks require a target", async () => fixture(async (root) => {
  await repo(root); await contract(root);
  const a = join(root, "repos", "a"), b = join(root, "repos", "b");
  await repo(a); await repo(b);
  await git(a, "branch", "ship/c/a"); await git(b, "branch", "ship/c/b");
  assert.equal((await start(root, "a", "a", ["--repo", a, "--branch=ship/c/a"])).code, 0);
  assert.equal((await start(root, "b", "b", ["--repo", b, "--branch=ship/c/b"])).code, 0);
  const ambiguous = await call(root, "check", "--contract", "c");
  assert.equal(ambiguous.code, 1); assert.match(ambiguous.stderr, /spans repositories/);
  assert.equal((await call(root, "check", "--contract", "c", "--slice", "a")).code, 0);
  assert.equal((await call(root, "check", "--contract", "c", "--slice", "unknown")).code, 1);
  assert.equal((await call(root, "check", "--contract", "c", "--head", "HEAD")).code, 1);
  await git(a, "branch", "-D", "ship/c/a");
  const report = await runWatchdog(root);
  assert.equal(report.flagged[0]?.source_task_id, "a");
  assert.equal(report.flagged[0]?.reason, "drift");
  await rename(join(b, ".git"), join(b, ".lost-git"));
  const lostRepo = await runWatchdog(root);
  assert.equal(lostRepo.flagged[0]?.source_task_id, "b");
  assert.equal(lostRepo.flagged[0]?.reason, "drift");
}));

test("custom hooksPath is rejected before setup mutates checkout files", async () => fixture(async (root) => {
  await repo(root); await git(root, "config", "core.hooksPath", ".owner-hooks");
  const result = await call(root, "setup");
  assert.equal(result.code, 1);
  assert.match(result.stdout, /core.hooksPath/);
  await assert.rejects(readFile(join(root, ".agent-ship", "kit-root")));
}));

test("parallel member and worktree deliveries use central contracts through real commit hooks", async () => fixture(async (root) => {
  await repo(root); await contract(root);
  const members = [join(root, "repos", "a"), join(root, "repos", "b")];
  for (const member of members) await repo(member);
  for (const [index, member] of members.entries()) {
    const slice = index === 0 ? "a" : "b";
    await git(member, "checkout", "-b", `ship/c/${slice}`);
    assert.equal((await call(member, "setup", "--state-root", root)).code, 0);
    await writeFile(join(member, ".agent-ship", "active-contract"), "c\n");
    assert.equal((await start(root, `member-${slice}`, slice, ["--repo", member, `--branch=ship/c/${slice}`])).code, 0);
  }
  const deliver = async (checkout: string, id: string, slice: string) => {
    await writeFile(join(checkout, "allowed.txt"), `${id}-${slice} delivery\n`);
    await git(checkout, "add", "allowed.txt");
    await git(checkout, "commit", "-m", `${id}-${slice}`);
    const checked = await call(root, "check", "--contract", id, "--slice", slice);
    assert.equal(checked.code, 0, checked.stderr);
    assert.deepEqual(JSON.parse(checked.stdout).changed, ["allowed.txt"]);
    const item = await call(root, "inbox", "add", "--title", "Ready", "--summary", "Commit hook and branch check passed.", "--source-task-id", `${id === "c" ? "member" : "tree"}-${slice}`, "--evidence", "https://example.com/test-report");
    assert.equal((await call(root, "inbox", "decide", JSON.parse(item.stdout).id, "accept")).code, 0);
  };
  await Promise.all(members.map((member, index) => deliver(member, "c", index === 0 ? "a" : "b")));
  assert.equal((await activeSlices(root)).length, 0);

  await contract(root, "trees");
  const trees = [join(root, "trees", "a"), join(root, "trees", "b")];
  for (const [index, tree] of trees.entries()) {
    const slice = index === 0 ? "a" : "b";
    await git(members[0]!, "worktree", "add", "-b", `ship/trees/${slice}`, tree, "main");
    assert.equal((await call(tree, "setup", "--state-root", root)).code, 0);
    await writeFile(join(tree, ".agent-ship", "active-contract"), "trees\n");
    const started = await call(root, "slice", "start", "--repo", tree, "--contract", "trees", "--slice", slice, "--source-task-id", `tree-${slice}`, "--branch", `ship/trees/${slice}`, "--title", "Tree", "--summary", "Reserve isolated worktree.");
    assert.equal(started.code, 0, started.stderr);
  }
  await Promise.all(trees.map((tree, index) => deliver(tree, "trees", index === 0 ? "a" : "b")));
  assert.equal((await activeSlices(root)).length, 0);
  assert.equal((await runWatchdog(root, { now: new Date(Date.now() + 7200000) })).noop, true);
}));
