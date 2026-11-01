import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { activeSlices } from "../src/watchdog.js";

const exec = promisify(execFile);
async function call(root: string, ...args: string[]) {
  let stdout = "", stderr = "";
  const code = await main([...args, "--root", root], { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { code, stdout, stderr };
}
async function fixture(body: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ship-learning-")));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await body(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("shared setup creates a durable handbook once; local setup only links existing sources", async () => fixture(async (root) => {
  assert.equal((await call(root, "setup")).code, 0);
  await assert.rejects(readFile(join(root, "agent-ship.team.json")));
  await assert.rejects(readFile(join(root, "docs/agent-team/handbook.md")));
  assert.equal((await call(root, "setup", "--shared")).code, 0);
  const handbook = join(root, "docs/agent-team/handbook.md");
  await writeFile(handbook, "# Owner handbook\nKeep my decisions.\n");
  const config = await readFile(join(root, "agent-ship.team.json"), "utf8");
  assert.equal((await call(root, "setup", "--shared")).code, 0);
  assert.equal(await readFile(handbook, "utf8"), "# Owner handbook\nKeep my decisions.\n");
  assert.equal(await readFile(join(root, "agent-ship.team.json"), "utf8"), config);
  const context = await call(root, "team", "context");
  assert.equal(context.code, 0, context.stderr);
  assert.ok(JSON.parse(context.stdout).required_sources.some((p: string) => p.endsWith("handbook.md")));
  assert.deepEqual(JSON.parse(context.stdout).lessons, []);
}));

function lesson(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `Lesson ${id}`, summary: "Check the execution boundary.", when: "When tasks span independent repositories.", action: "Check the recorded worker repository and branch.", tags: ["git", "parallel"], evidence: ["https://example.com/reports/verified"], source_task_id: "source-task", reuse_reason: "Prevents repeating a verified path-check failure.", ...extra };
}
async function add(root: string, input: Record<string, unknown>) {
  const file = join(root, "lesson-input.json");
  await writeFile(file, JSON.stringify(input));
  return call(root, "lesson", "add", "--input", file);
}
async function activate(root: string, id: string) {
  const result = await call(root, "lesson", "review", "--id", id, "--status", "active", "--reviewed-by", "maintainer-review", "--note", "Verified evidence, scope, usefulness and semantic duplicates.");
  assert.equal(result.code, 0, result.stderr);
}

test("lesson admission requires actionable evidence and deduplicates without overwriting", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  assert.equal((await add(root, lesson("missing-evidence", { evidence: [] }))).code, 1);
  assert.equal((await add(root, lesson("placeholder", { evidence: ["<report>"] }))).code, 1);
  assert.equal((await add(root, lesson("missing-scope", { when: "" }))).code, 1);
  assert.equal((await add(root, lesson("pre-approved", { status: "active" }))).code, 1);
  assert.equal((await add(root, lesson("first"))).code, 0);
  const before = await readFile(join(root, "docs/agent-team/lessons/first.json"), "utf8");
  const duplicate = await add(root, lesson("second", { title: "Another occurrence", evidence: ["https://example.com/new-report"] }));
  assert.equal(duplicate.code, 0, duplicate.stderr);
  assert.equal(JSON.parse(duplicate.stdout).id, "first");
  assert.equal(JSON.parse(duplicate.stdout).duplicate, true);
  assert.equal(await readFile(join(root, "docs/agent-team/lessons/first.json"), "utf8"), before);
  await assert.rejects(readFile(join(root, "docs/agent-team/lessons/second.json")));
}));

test("retrieval is opt-in, scoped, active-only and bounded; required rules survive a zero budget", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  for (let index = 0; index < 5; index++) {
    const id = `active-${index}`;
    assert.equal((await add(root, lesson(id, { action: `Check execution boundary ${index}.` }))).code, 0);
    await activate(root, id);
  }
  await add(root, lesson("candidate", { action: "Unreviewed action." }));
  await add(root, lesson("other-project", { action: "Project-specific action.", project: "other" })); await activate(root, "other-project");
  const empty = JSON.parse((await call(root, "team", "context")).stdout);
  assert.deepEqual(empty.lessons, []);
  const found = JSON.parse((await call(root, "lesson", "search", "--tag", "git", "--project", "current")).stdout);
  assert.ok(found.lessons.length > 0 && found.lessons.length <= 3);
  assert.ok(found.summary_chars <= 1200);
  assert.ok(found.omitted_count >= 2);
  assert.ok(found.lessons.every((item: { id: string }) => item.id.startsWith("active-")));
  assert.equal(JSON.parse((await call(root, "lesson", "search", "--tag", "unrelated")).stdout).lessons.length, 0);
  const config = JSON.parse(await readFile(join(root, "agent-ship.team.json"), "utf8"));
  config.summary_chars = 0;
  await writeFile(join(root, "agent-ship.team.json"), JSON.stringify(config));
  const bounded = JSON.parse((await call(root, "team", "context", "--tag", "git")).stdout);
  assert.equal(bounded.lessons.length, 0);
  assert.ok(bounded.required_sources.some((path: string) => path.endsWith("handbook.md")));
}));

test("outdated or retired lessons do not return as actionable summaries", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  await add(root, lesson("expired")); await activate(root, "expired");
  const file = join(root, "docs/agent-team/lessons/expired.json");
  const card = JSON.parse(await readFile(file, "utf8"));
  card.review_after = "2000-01-01T00:00:00Z";
  await writeFile(file, JSON.stringify(card));
  let result = JSON.parse((await call(root, "team", "context", "--tag", "git")).stdout);
  assert.deepEqual(result.lessons, []);
  assert.equal(result.review_required_count, 1);
  assert.equal(result.review_required[0].id, "expired");
  assert.equal((await call(root, "lesson", "review", "--id", "expired", "--status", "retired", "--reviewed-by", "maintainer", "--note", "The source behavior changed.")).code, 0);
  result = JSON.parse((await call(root, "team", "context", "--tag", "git")).stdout);
  assert.equal(result.review_required_count, 0);
  assert.equal(JSON.parse((await call(root, "lesson", "show", "--id", "expired")).stdout).lesson.status, "retired");
}));

test("explicit external sources remain readable and cannot be written or mirrored", async () => fixture(async (root) => {
  const library = await realpath(await mkdtemp(join(tmpdir(), "agent-ship-library-")));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: library });
    await call(library, "setup", "--shared"); await add(library, lesson("external")); await activate(library, "external");
    const directory = join(library, "docs/agent-team/lessons");
    const result = await call(root, "setup", "--shared", "--handbook", join(library, "docs/agent-team/handbook.md"), "--lessons", directory);
    assert.equal(result.code, 0, result.stderr);
    const found = await call(root, "team", "context", "--tag", "git");
    assert.equal(found.code, 0, found.stderr);
    assert.equal(JSON.parse(found.stdout).lessons[0].id, "external");
    assert.equal((await add(root, lesson("no-write", { action: "Should not be written externally." }))).code, 1);
    assert.equal((await call(root, "lesson", "review", "--id", "external", "--status", "retired", "--reviewed-by", "reviewer", "--note", "Must use owner workflow.")).code, 1);
    await assert.rejects(readFile(join(root, "docs/agent-team/handbook.md")));
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".json")), ["external.json"]);
  } finally { await rm(library, { recursive: true, force: true }); }
}));

test("symlink writes outside the owner and sensitive source references fail closed", async () => fixture(async (root) => {
  const outside = await mkdtemp(join(tmpdir(), "agent-ship-outside-"));
  try {
    await call(root, "setup", "--shared");
    await symlink(outside, join(root, "external-link"));
    const config = JSON.parse(await readFile(join(root, "agent-ship.team.json"), "utf8"));
    config.lessons = "external-link";
    await writeFile(join(root, "agent-ship.team.json"), JSON.stringify(config));
    assert.equal((await add(root, lesson("escape"))).code, 1);
    assert.equal((await readdir(outside)).length, 0);
    config.rules = [".env"];
    await writeFile(join(root, "agent-ship.team.json"), JSON.stringify(config));
    assert.equal((await call(root, "team", "context")).code, 1);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test("candidate checks require real references, and cancellation leaves an auditable pending check", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  await writeFile(join(root, ".agent-ship/events.jsonl"), JSON.stringify({ id: "evt_start", type: "worker_dispatched", source_task_id: "task", contract_id: "c", slice_id: "a", status: "running", learning_required: true, sequence: 0 }) + "\n");
  const checked = (...extra: string[]) => call(root, "lesson", "check", "--source-task-id", "task", "--outcome", "candidate", "--reason", "A reusable execution constraint was verified.", "--reviewed-by", "verifier", ...extra);
  assert.equal((await checked()).code, 1);
  assert.equal((await checked("--candidate-id", "missing")).code, 1);
  await add(root, lesson("verified"));
  assert.equal((await checked("--candidate-id", "verified", "--trigger", "verifier_return")).code, 0);
  assert.equal((await call(root, "inbox", "add", "--title", "Ready", "--summary", "Evidence ready.", "--source-task-id", "task")).code, 0);
  // A separate failed task may stop immediately; its learning check remains visible at wrap-up.
  const events = await readFile(join(root, ".agent-ship/events.jsonl"), "utf8");
  await writeFile(join(root, ".agent-ship/events.jsonl"), events + JSON.stringify({ id: "evt_failed", type: "worker_dispatched", source_task_id: "failed-task", learning_required: true, status: "failed" }) + "\n");
  assert.equal(JSON.parse((await call(root, "lesson", "pending")).stdout).items[0].source_task_id, "failed-task");
}));

test("existing handbooks are referenced without replacing their content", async () => fixture(async (root) => {
  await writeFile(join(root, "TEAM.md"), "# Existing team\n");
  assert.equal((await call(root, "setup", "--shared")).code, 0);
  const config = JSON.parse(await readFile(join(root, "agent-ship.team.json"), "utf8"));
  assert.equal(config.handbook, "TEAM.md");
  assert.equal(await readFile(join(root, "TEAM.md"), "utf8"), "# Existing team\n");
  await assert.rejects(readFile(join(root, "docs/agent-team/handbook.md")));
}));

test("managed review requires a fresh checked none/candidate outcome", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  await writeFile(join(root, ".agent-ship/events.jsonl"), JSON.stringify({ id: "evt_start", type: "worker_dispatched", source_task_id: "task", contract_id: "c", slice_id: "a", status: "running", sequence: 1, learning_required: true }) + "\n");
  const review = () => call(root, "inbox", "add", "--title", "Ready", "--summary", "Evidence complete.", "--source-task-id", "task");
  assert.equal((await review()).code, 1);
  assert.equal((await call(root, "lesson", "check", "--source-task-id", "task", "--outcome", "none", "--reason", "Routine change; no new reusable finding.", "--reviewed-by", "verifier-session")).code, 0);
  const ready = await review();
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal((await readdir(join(root, "docs/agent-team/lessons"))).filter((name) => name.endsWith(".json")).length, 0);
  assert.equal((await call(root, "inbox", "decide", JSON.parse(ready.stdout).id, "changes_requested", "--note", "Please revise the behavior.")).code, 0);
  assert.equal((await review()).code, 1);
  const corrected = await call(root, "lesson", "check", "--source-task-id", "task", "--outcome", "none", "--reason", "The correction is covered by existing project rules.", "--reviewed-by", "verifier-session");
  assert.equal(corrected.code, 0, corrected.stderr);
  assert.ok(JSON.parse(corrected.stdout).triggers.includes("user_correction"));
  const events = await readFile(join(root, ".agent-ship/events.jsonl"), "utf8");
  assert.ok(events.includes("learning_checked"));
  await writeFile(join(root, ".agent-ship/events.jsonl"), events + JSON.stringify({ id: "evt_resume", type: "worker_progress", source_task_id: "task", status: "running", sequence: 1000 }) + "\n");
  assert.equal((await review()).code, 1);
}));

test("setup, bounded dispatch context, verifier check and revised delivery form one flow", async () => fixture(async (root) => {
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await writeFile(join(root, "README.md"), "baseline\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "baseline"], { cwd: root });
  await call(root, "setup", "--shared");
  await add(root, lesson("known")); await activate(root, "known");
  await writeFile(join(root, ".agent-ship/contracts/c.md"), "Status: frozen\nFrozen by: Test human\nFrozen at: 2026-11-01T00:00:00Z\nProposal id: proposal_c\nAccepted text: Isolated delivery of README.md\nAccepted by: Test human\nAccepted at: 2026-11-01T00:00:00Z\n## Allowed paths\n- README.md\n## Forbidden paths\n- forbidden.txt\n## Slices\nmax_parallel: 1\n| a | contract | pass |\n");
  const previous = process.env.AGENT_SHIP_TIMER_PLATFORM, previousHome = process.env.AGENT_SHIP_TIMER_HOME;
  process.env.AGENT_SHIP_TIMER_PLATFORM = "unsupported";
  process.env.AGENT_SHIP_TIMER_HOME = join(root, "timers");
  try {
    const started = await call(root, "slice", "start", "--contract", "c", "--slice", "a", "--branch", "main", "--source-task-id", "task", "--title", "Task", "--summary", "Isolated delivery.", "--tag", "git", "--project", "api", "--worker", "worker-ref", "--proposal", "proposal_c");
    assert.equal(started.code, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).context.lessons[0].id, "known");
    const events = (await readFile(join(root, ".agent-ship/events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events[0].lesson_ids, ["known"]);
    assert.ok(events[0].context_refs.some((p: string) => p.endsWith("handbook.md")));
    await call(root, "slice", "update", "--source-task-id", "task", "--status", "running", "--worker", "worker-ref");
    const selfReview = await call(root, "lesson", "check", "--source-task-id", "task", "--outcome", "none", "--reason", "Existing rules cover it.", "--reviewed-by", "worker-ref");
    assert.equal(selfReview.code, 1);
    assert.match(selfReview.stderr, /reviewed-by must differ from the recorded worker/);
    const review = () => call(root, "inbox", "add", "--title", "Ready", "--summary", "All evidence passed.", "--source-task-id", "task");
    assert.equal((await review()).code, 1);
    const checked = () => call(root, "lesson", "check", "--source-task-id", "task", "--outcome", "none", "--reason", "Existing rules cover it.", "--reviewed-by", "verifier-ref");
    assert.equal((await checked()).code, 0);
    assert.equal((await call(root, "slice", "update", "--source-task-id", "task", "--status", "needs_review")).code, 0);
    const first = await review(); assert.equal(first.code, 0, first.stderr);
    await call(root, "inbox", "decide", JSON.parse(first.stdout).id, "changes_requested", "--note", "Revise the behavior.");
    assert.equal((await call(root, "slice", "update", "--source-task-id", "task", "--status", "running")).code, 0);
    assert.equal((await review()).code, 1);
    assert.equal((await checked()).code, 0);
    const second = await review(); assert.equal(second.code, 0, second.stderr);
    await call(root, "inbox", "decide", JSON.parse(second.stdout).id, "accept");
    assert.equal((await activeSlices(root)).length, 0);
    assert.equal(JSON.parse((await call(root, "lesson", "pending")).stdout).total_count, 0);
  } finally {
    if (previous === undefined) delete process.env.AGENT_SHIP_TIMER_PLATFORM; else process.env.AGENT_SHIP_TIMER_PLATFORM = previous;
    if (previousHome === undefined) delete process.env.AGENT_SHIP_TIMER_HOME; else process.env.AGENT_SHIP_TIMER_HOME = previousHome;
  }
}));

test("learning_required can be turned off and pending history is bounded", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  const records = Array.from({ length: 25 }, (_, index) => JSON.stringify({ id: `evt_${index}`, type: "worker_dispatched", source_task_id: `task-${index}`, status: "cancelled", learning_required: true, created_at: new Date().toISOString(), sequence: index }));
  await writeFile(join(root, ".agent-ship/events.jsonl"), records.join("\n") + "\n");
  const pending = JSON.parse((await call(root, "lesson", "pending")).stdout);
  assert.equal(pending.items.length, 20); assert.equal(pending.total_count, 25); assert.equal(pending.omitted_count, 5);
  const one = JSON.parse((await call(root, "lesson", "pending", "--source-task-id", "task-24")).stdout);
  assert.equal(one.items.length, 1);
  const config = JSON.parse(await readFile(join(root, "agent-ship.team.json"), "utf8"));
  config.learning_required = false;
  await writeFile(join(root, "agent-ship.team.json"), JSON.stringify(config));
  const context = await call(root, "team", "context");
  assert.equal(context.code, 0, context.stderr);
  assert.equal(JSON.parse(context.stdout).learning_required, false);
}));

test("plain setup turns learning off and shared setup deletes the local team file", async () => fixture(async (root) => {
  assert.equal((await call(root, "setup")).code, 0);
  const localPath = join(root, ".agent-ship/team.json");
  assert.equal(JSON.parse(await readFile(localPath, "utf8")).learning_required, false);
  assert.equal((await call(root, "setup", "--shared")).code, 0);
  await assert.rejects(readFile(localPath));
  assert.equal(JSON.parse(await readFile(join(root, "agent-ship.team.json"), "utf8")).learning_required, true);
}));

test("managed slice start requires consent text, a distinct worker, and the proposal id", async () => fixture(async (root) => {
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await writeFile(join(root, "README.md"), "baseline\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "baseline"], { cwd: root });
  await call(root, "setup", "--shared");
  const previous = process.env.AGENT_SHIP_TIMER_PLATFORM;
  const previousHome = process.env.AGENT_SHIP_TIMER_HOME;
  process.env.AGENT_SHIP_TIMER_PLATFORM = "unsupported";
  process.env.AGENT_SHIP_TIMER_HOME = join(root, "timers");
  const body = "Status: frozen\nFrozen by: Test human\nFrozen at: 2026-11-01T00:00:00Z\nProposal id: proposal_c\nAccepted text: Ship the README change only.\nAccepted by: Test human\nAccepted at: 2026-11-01T00:00:00Z\n## Allowed paths\n- README.md\n## Forbidden paths\n- forbidden.txt\n## Slices\n| a | contract | pass |\n";
  const path = join(root, ".agent-ship/contracts/c.md");
  await writeFile(path, body.replace("Accepted text: Ship the README change only.\n", ""));
  const start = (...extra: string[]) => call(root, "slice", "start", "--contract", "c", "--slice", "a", "--branch", "main", "--source-task-id", "consent-task", "--title", "Task", "--summary", "Go.", ...extra);
  assert.match((await start("--worker", "worker-ref", "--proposal", "proposal_c")).stderr, /contract must record Accepted text/);
  await writeFile(path, body);
  assert.match((await start("--worker", "worker-ref", "--proposal", "other")).stderr, /proposal id mismatches proposal_c/);
  await mkdir(join(root, ".agent-ship/proposals"), { recursive: true });
  await writeFile(join(root, ".agent-ship/proposals/proposal_c.md"), "Proposal id: other_plan\n");
  assert.match((await start("--worker", "worker-ref", "--proposal", "proposal_c")).stderr, /proposal id mismatches/);
  await writeFile(join(root, ".agent-ship/proposals/proposal_c.md"), "Proposal id: proposal_c\n");
  assert.match((await start("--proposal", "proposal_c")).stderr, /managed tasks require --worker/);
  const started = await start("--worker", "worker-ref", "--proposal", "proposal_c");
  assert.equal(started.code, 0, started.stderr);
  const event = JSON.parse((await readFile(join(root, ".agent-ship/events.jsonl"), "utf8")).trim().split("\n")[0] ?? "{}");
  assert.equal(event.accepted_text, "Ship the README change only.");
  assert.equal(event.accepted_by, "Test human");
  assert.equal(event.accepted_at, "2026-11-01T00:00:00Z");
  assert.equal(event.proposal_id, "proposal_c");
  assert.equal(event.worker_ref, "worker-ref");
  if (previous === undefined) delete process.env.AGENT_SHIP_TIMER_PLATFORM; else process.env.AGENT_SHIP_TIMER_PLATFORM = previous;
  if (previousHome === undefined) delete process.env.AGENT_SHIP_TIMER_HOME; else process.env.AGENT_SHIP_TIMER_HOME = previousHome;
}));

test("lesson activation rejects the author and field errors name the limit", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  const tooLong = await add(root, lesson("too-long", { title: "t".repeat(121) }));
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.stderr, /invalid title; must be a single line of at most 120 characters/);
  const badWhen = await add(root, lesson("bad-when", { when: "w".repeat(201) }));
  assert.match(badWhen.stderr, /invalid when; must be a single line of at most 200 characters/);
  assert.equal((await add(root, lesson("authored", { authored_by: "same-person" }))).code, 0);
  const denied = await call(root, "lesson", "review", "--id", "authored", "--status", "active", "--reviewed-by", "same-person", "--note", "Cannot review one's own card.");
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /lesson author and reviewer must differ/);
  assert.equal((await call(root, "lesson", "review", "--id", "authored", "--status", "active", "--reviewed-by", "maintainer", "--note", "Independent review.")).code, 0);
}));

test("bad JSON is reported without copying its contents into output", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  const file = join(root, "bad-input.json");
  await writeFile(file, "not_json_with_test_marker_123");
  const result = await call(root, "lesson", "add", "--input", file);
  assert.equal(result.code, 1); assert.match(result.stderr, /not valid JSON/);
  assert.doesNotMatch(result.stderr, /test_marker_123/);
}));
