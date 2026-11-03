import { fileURLToPath } from "node:url";
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
  const code = await main([...args, ...(args[0] === "slice" ? ["--allow-untimed"] : []), "--root", root], { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { code, stdout, stderr };
}
async function fixture(body: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "crewvane-learning-")));
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await body(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("shared setup creates a durable handbook once; local setup only links existing sources", async () => fixture(async (root) => {
  assert.equal((await call(root, "setup")).code, 0);
  await assert.rejects(readFile(join(root, "crewvane.team.json")));
  await assert.rejects(readFile(join(root, "docs/agent-team/handbook.md")));
  assert.equal((await call(root, "setup", "--shared")).code, 0);
  const handbook = join(root, "docs/agent-team/handbook.md");
  await writeFile(handbook, "# Owner handbook\nKeep my decisions.\n");
  const config = await readFile(join(root, "crewvane.team.json"), "utf8");
  assert.equal((await call(root, "setup", "--shared")).code, 0);
  assert.equal(await readFile(handbook, "utf8"), "# Owner handbook\nKeep my decisions.\n");
  assert.equal(await readFile(join(root, "crewvane.team.json"), "utf8"), config);
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
  const config = JSON.parse(await readFile(join(root, "crewvane.team.json"), "utf8"));
  config.summary_chars = 0;
  await writeFile(join(root, "crewvane.team.json"), JSON.stringify(config));
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
  const library = await realpath(await mkdtemp(join(tmpdir(), "crewvane-library-")));
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
  const outside = await mkdtemp(join(tmpdir(), "crewvane-outside-"));
  try {
    await call(root, "setup", "--shared");
    await symlink(outside, join(root, "external-link"));
    const config = JSON.parse(await readFile(join(root, "crewvane.team.json"), "utf8"));
    config.lessons = "external-link";
    await writeFile(join(root, "crewvane.team.json"), JSON.stringify(config));
    assert.equal((await add(root, lesson("escape"))).code, 1);
    assert.equal((await readdir(outside)).length, 0);
    config.rules = [".env"];
    await writeFile(join(root, "crewvane.team.json"), JSON.stringify(config));
    assert.equal((await call(root, "team", "context")).code, 1);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test("candidate checks require real references, and cancellation leaves an auditable pending check", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  await writeFile(join(root, ".crewvane/events.jsonl"), JSON.stringify({ id: "evt_start", type: "worker_dispatched", source_task_id: "task", contract_id: "c", slice_id: "a", status: "running", learning_required: true, sequence: 0 }) + "\n");
  const checked = (...extra: string[]) => call(root, "lesson", "check", "--source-task-id", "task", "--outcome", "candidate", "--reason", "A reusable execution constraint was verified.", "--reviewed-by", "verifier", ...extra);
  assert.equal((await checked()).code, 1);
  assert.equal((await checked("--candidate-id", "missing")).code, 1);
  await add(root, lesson("verified"));
  assert.equal((await checked("--candidate-id", "verified", "--trigger", "verifier_return")).code, 0);
  assert.equal((await call(root, "inbox", "add", "--title", "Ready", "--summary", "Evidence ready.", "--source-task-id", "task")).code, 0);
  // A separate failed task may stop immediately; its learning check remains visible at wrap-up.
  const events = await readFile(join(root, ".crewvane/events.jsonl"), "utf8");
  await writeFile(join(root, ".crewvane/events.jsonl"), events + JSON.stringify({ id: "evt_failed", type: "worker_dispatched", source_task_id: "failed-task", learning_required: true, status: "failed" }) + "\n");
  assert.equal(JSON.parse((await call(root, "lesson", "pending")).stdout).items[0].source_task_id, "failed-task");
}));

test("existing handbooks are referenced without replacing their content", async () => fixture(async (root) => {
  await writeFile(join(root, "TEAM.md"), "# Existing team\n");
  assert.equal((await call(root, "setup", "--shared")).code, 0);
  const config = JSON.parse(await readFile(join(root, "crewvane.team.json"), "utf8"));
  assert.equal(config.handbook, "TEAM.md");
  assert.equal(await readFile(join(root, "TEAM.md"), "utf8"), "# Existing team\n");
  await assert.rejects(readFile(join(root, "docs/agent-team/handbook.md")));
}));

test("managed review requires a fresh checked none/candidate outcome", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  await writeFile(join(root, ".crewvane/events.jsonl"), JSON.stringify({ id: "evt_start", type: "worker_dispatched", source_task_id: "task", contract_id: "c", slice_id: "a", status: "running", sequence: 1, learning_required: true }) + "\n");
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
  const events = await readFile(join(root, ".crewvane/events.jsonl"), "utf8");
  assert.ok(events.includes("learning_checked"));
  await writeFile(join(root, ".crewvane/events.jsonl"), events + JSON.stringify({ id: "evt_resume", type: "worker_progress", source_task_id: "task", status: "running", sequence: 1000 }) + "\n");
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
  await writeFile(join(root, ".crewvane/contracts/c.md"), "Status: frozen\nFrozen by: Test human\nFrozen at: 2026-11-01T00:00:00Z\nProposal id: proposal_c\nAccepted text: Isolated delivery of README.md\nAccepted by: Test human\nAccepted at: 2026-11-01T00:00:00Z\n## Allowed paths\n- README.md\n## Forbidden paths\n- forbidden.txt\n## Slices\nmax_parallel: 1\n| a | contract | pass |\n");
  const previous = process.env.CREWVANE_TIMER_PLATFORM, previousHome = process.env.CREWVANE_TIMER_HOME;
  process.env.CREWVANE_TIMER_PLATFORM = "unsupported";
  process.env.CREWVANE_TIMER_HOME = join(root, "timers");
  try {
    const started = await call(root, "slice", "start", "--contract", "c", "--slice", "a", "--branch", "main", "--source-task-id", "task", "--title", "Task", "--summary", "Isolated delivery.", "--tag", "git", "--project", "api", "--worker", "worker-ref", "--proposal", "proposal_c");
    assert.equal(started.code, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).context.lessons[0].id, "known");
    const events = (await readFile(join(root, ".crewvane/events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
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
    if (previous === undefined) delete process.env.CREWVANE_TIMER_PLATFORM; else process.env.CREWVANE_TIMER_PLATFORM = previous;
    if (previousHome === undefined) delete process.env.CREWVANE_TIMER_HOME; else process.env.CREWVANE_TIMER_HOME = previousHome;
  }
}));

test("learning_required can be turned off and pending history is bounded", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  const records = Array.from({ length: 25 }, (_, index) => JSON.stringify({ id: `evt_${index}`, type: "worker_dispatched", source_task_id: `task-${index}`, status: "cancelled", learning_required: true, created_at: new Date().toISOString(), sequence: index }));
  await writeFile(join(root, ".crewvane/events.jsonl"), records.join("\n") + "\n");
  const pending = JSON.parse((await call(root, "lesson", "pending")).stdout);
  assert.equal(pending.items.length, 20); assert.equal(pending.total_count, 25); assert.equal(pending.omitted_count, 5);
  const one = JSON.parse((await call(root, "lesson", "pending", "--source-task-id", "task-24")).stdout);
  assert.equal(one.items.length, 1);
  const config = JSON.parse(await readFile(join(root, "crewvane.team.json"), "utf8"));
  config.learning_required = false;
  await writeFile(join(root, "crewvane.team.json"), JSON.stringify(config));
  const context = await call(root, "team", "context");
  assert.equal(context.code, 0, context.stderr);
  assert.equal(JSON.parse(context.stdout).learning_required, false);
}));

test("plain setup turns learning off and shared setup deletes the local team file", async () => fixture(async (root) => {
  assert.equal((await call(root, "setup")).code, 0);
  const localPath = join(root, ".crewvane/team.json");
  assert.equal(JSON.parse(await readFile(localPath, "utf8")).learning_required, false);
  assert.equal((await call(root, "setup", "--shared")).code, 0);
  await assert.rejects(readFile(localPath));
  assert.equal(JSON.parse(await readFile(join(root, "crewvane.team.json"), "utf8")).learning_required, true);
}));

test("managed slice start requires consent text, a distinct worker, and the proposal id", async () => fixture(async (root) => {
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await writeFile(join(root, "README.md"), "baseline\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "baseline"], { cwd: root });
  await call(root, "setup", "--shared");
  const previous = process.env.CREWVANE_TIMER_PLATFORM;
  const previousHome = process.env.CREWVANE_TIMER_HOME;
  process.env.CREWVANE_TIMER_PLATFORM = "unsupported";
  process.env.CREWVANE_TIMER_HOME = join(root, "timers");
  const body = "Status: frozen\nFrozen by: Test human\nFrozen at: 2026-11-01T00:00:00Z\nProposal id: proposal_c\nAccepted text: Ship the README change only.\nAccepted by: Test human\nAccepted at: 2026-11-01T00:00:00Z\n## Allowed paths\n- README.md\n## Forbidden paths\n- forbidden.txt\n## Slices\n| a | contract | pass |\n";
  const path = join(root, ".crewvane/contracts/c.md");
  await writeFile(path, body.replace("Accepted text: Ship the README change only.\n", ""));
  const start = (...extra: string[]) => call(root, "slice", "start", "--contract", "c", "--slice", "a", "--branch", "main", "--source-task-id", "consent-task", "--title", "Task", "--summary", "Go.", ...extra);
  assert.match((await start("--worker", "worker-ref", "--proposal", "proposal_c")).stderr, /contract must record Accepted text/);
  await writeFile(path, body);
  assert.match((await start("--worker", "worker-ref", "--proposal", "other")).stderr, /proposal id mismatches proposal_c/);
  await mkdir(join(root, ".crewvane/proposals"), { recursive: true });
  await writeFile(join(root, ".crewvane/proposals/proposal_c.md"), "Proposal id: other_plan\n");
  assert.match((await start("--worker", "worker-ref", "--proposal", "proposal_c")).stderr, /proposal id mismatches/);
  await writeFile(join(root, ".crewvane/proposals/proposal_c.md"), "Proposal id: proposal_c\n");
  assert.match((await start("--proposal", "proposal_c")).stderr, /managed tasks require --worker/);
  const started = await start("--worker", "worker-ref", "--proposal", "proposal_c");
  assert.equal(started.code, 0, started.stderr);
  const event = JSON.parse((await readFile(join(root, ".crewvane/events.jsonl"), "utf8")).trim().split("\n")[0] ?? "{}");
  assert.equal(event.accepted_text, "Ship the README change only.");
  assert.equal(event.accepted_by, "Test human");
  assert.equal(event.accepted_at, "2026-11-01T00:00:00Z");
  assert.equal(event.proposal_id, "proposal_c");
  assert.equal(event.worker_ref, "worker-ref");
  if (previous === undefined) delete process.env.CREWVANE_TIMER_PLATFORM; else process.env.CREWVANE_TIMER_PLATFORM = previous;
  if (previousHome === undefined) delete process.env.CREWVANE_TIMER_HOME; else process.env.CREWVANE_TIMER_HOME = previousHome;
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

async function addAuto(root: string, input: Record<string, unknown>, ...extra: string[]) {
  const file = join(root, "lesson-input.json");
  await writeFile(file, JSON.stringify(input));
  return call(root, "lesson", "add", "--input", file, "--auto", ...extra);
}

test("auto candidates recirculate under auto/ and only a second demand suggests handbook review", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  const handbookPath = join(root, "docs/agent-team/handbook.md");
  const handbook = await readFile(handbookPath, "utf8");
  const config = JSON.parse(await readFile(join(root, "crewvane.team.json"), "utf8"));
  const bareHandbook = await call(root, "setup", "--handbook");
  assert.match(bareHandbook.stderr, /--handbook requires a value/);
  const valuedHandbook = await call(root, "lesson", "pending", "--handbook", "docs/agent-team/handbook.md");
  assert.match(valuedHandbook.stderr, /--handbook does not take a value on lesson pending/);
  const selfMark = await add(root, lesson("self-mark", { action: "Check self mark.", handbook_review_suggested: true }));
  assert.equal(selfMark.code, 1);
  assert.match(selfMark.stderr, /demand history and handbook review are recorded by the CLI/);
  const demandOnly = await call(root, "lesson", "add", "--input", join(root, "lesson-input.json"), "--demand", "billing");
  assert.equal(demandOnly.code, 1);
  assert.match(demandOnly.stderr, /--demand is only valid with lesson add --auto/);

  assert.equal((await add(root, lesson("library", { action: "Check the library copy." }))).code, 0);
  const libraryPath = join(root, "docs/agent-team/lessons/library.json");
  const libraryBefore = await readFile(libraryPath, "utf8");
  const libraryAuto = await addAuto(root, lesson("library-auto", { action: "Check the library copy.", source_task_id: "other-demand", evidence: ["https://example.com/other"] }));
  assert.equal(libraryAuto.code, 0, libraryAuto.stderr);
  assert.equal(JSON.parse(libraryAuto.stdout).duplicate, true);
  assert.equal(JSON.parse(libraryAuto.stdout).id, "library");
  assert.equal(JSON.parse(libraryAuto.stdout).handbook_review_suggested, false);
  assert.equal(await readFile(libraryPath, "utf8"), libraryBefore);
  await assert.rejects(readFile(join(root, "docs/agent-team/lessons/auto/library-auto.json")));

  const created = await addAuto(root, lesson("recur", { source_task_id: "task-a" }));
  assert.equal(created.code, 0, created.stderr);
  const createdBody = JSON.parse(created.stdout);
  assert.equal(createdBody.duplicate, false);
  assert.equal(createdBody.handbook_review_suggested, false);
  const autoPath = join(root, "docs/agent-team/lessons/auto/recur.json");
  assert.equal(createdBody.source, autoPath);
  await assert.rejects(readFile(join(root, "docs/agent-team/lessons/recur.json")));
  const firstCard = JSON.parse(await readFile(autoPath, "utf8"));
  assert.equal(firstCard.handbook_review_suggested, undefined);
  assert.deepEqual(firstCard.demands, [{ source_task_id: "task-a", tags: [] }]);
  assert.deepEqual(JSON.parse((await call(root, "lesson", "search", "--tag", "git")).stdout).lessons, []);
  assert.deepEqual(JSON.parse((await call(root, "lesson", "pending", "--handbook")).stdout).items, []);

  const beforeRepeat = await readFile(autoPath, "utf8");
  const repeated = await addAuto(root, lesson("recur-again", { source_task_id: "task-a", title: "Same demand", evidence: ["https://example.com/same"] }));
  assert.equal(JSON.parse(repeated.stdout).duplicate, true);
  assert.equal(JSON.parse(repeated.stdout).handbook_review_suggested, false);
  assert.equal(await readFile(autoPath, "utf8"), beforeRepeat);
  const manual = await add(root, lesson("manual-copy", { source_task_id: "task-manual", evidence: ["https://example.com/manual"] }));
  assert.equal(JSON.parse(manual.stdout).id, "recur");
  assert.equal(await readFile(autoPath, "utf8"), beforeRepeat);

  const second = await addAuto(root, lesson("recur-b", { source_task_id: "task-b", title: "Another demand", evidence: ["https://example.com/second"] }));
  assert.equal(second.code, 0, second.stderr);
  const secondBody = JSON.parse(second.stdout);
  assert.equal(secondBody.id, "recur");
  assert.equal(secondBody.duplicate, true);
  assert.equal(secondBody.handbook_review_suggested, true);
  await assert.rejects(readFile(join(root, "docs/agent-team/lessons/auto/recur-b.json")));
  const recurred = JSON.parse(await readFile(autoPath, "utf8"));
  assert.equal(recurred.handbook_review_suggested, true);
  assert.equal(recurred.title, "Lesson recur");
  assert.deepEqual(recurred.evidence, ["https://example.com/reports/verified"]);
  assert.equal(recurred.source_task_id, "task-a");
  assert.deepEqual(recurred.demands, [{ source_task_id: "task-a", tags: [] }, { source_task_id: "task-b", tags: [] }]);

  const routed = await addAuto(root, lesson("routed", { action: "Check the route owner.", source_task_id: "route-task" }), "--demand", "Billing", "--demand", "api");
  assert.equal(routed.code, 0, routed.stderr);
  const routedPath = join(root, "docs/agent-team/lessons/auto/routed.json");
  const routedBefore = await readFile(routedPath, "utf8");
  const sameTags = await addAuto(root, lesson("routed-again", { action: "Check the route owner.", source_task_id: "route-task" }), "--demand", "api", "--demand", "billing");
  assert.equal(JSON.parse(sameTags.stdout).handbook_review_suggested, false);
  assert.equal(await readFile(routedPath, "utf8"), routedBefore);
  const otherTags = await addAuto(root, lesson("routed-next", { action: "Check the route owner.", source_task_id: "route-task", evidence: ["https://example.com/route"] }), "--demand", "shipping");
  assert.equal(JSON.parse(otherTags.stdout).handbook_review_suggested, true);
  const routedCard = JSON.parse(await readFile(routedPath, "utf8"));
  assert.deepEqual(routedCard.tags, ["git", "parallel"]);
  assert.deepEqual(routedCard.demands, [{ source_task_id: "route-task", tags: ["api", "Billing"] }, { source_task_id: "route-task", tags: ["shipping"] }]);

  recurred.status = "active";
  recurred.reviewed_by = "maintainer";
  recurred.review_note = "Stays in auto until promotion.";
  await writeFile(autoPath, JSON.stringify(recurred));
  const hidden = JSON.parse((await call(root, "team", "context", "--tag", "git")).stdout);
  assert.deepEqual(hidden.lessons, []);
  assert.equal(hidden.review_required_count, 0);

  const queue = JSON.parse((await call(root, "lesson", "pending", "--handbook")).stdout);
  assert.deepEqual(queue.items.map((item: { id: string }) => item.id), ["recur", "routed"]);
  assert.equal(queue.items[0].handbook_review_suggested, true);
  assert.equal(queue.items[0].demands.length, 2);
  const filtered = JSON.parse((await call(root, "lesson", "pending", "--handbook", "--source-task-id", "task-b")).stdout);
  assert.deepEqual(filtered.items.map((item: { id: string }) => item.id), ["recur"]);
  assert.equal(JSON.parse((await call(root, "lesson", "pending")).stdout).total_count, 0);

  await writeFile(join(root, ".crewvane/events.jsonl"), `${JSON.stringify({ id: "evt_start", type: "worker_dispatched", source_task_id: "task", status: "running", learning_required: true, sequence: 0 })}\n`);
  assert.equal((await addAuto(root, lesson("checked", { action: "Check the audit link.", source_task_id: "task" }))).code, 0);
  const checked = await call(root, "lesson", "check", "--source-task-id", "task", "--outcome", "candidate", "--candidate-id", "checked", "--reason", "Auto candidate is a valid link.", "--reviewed-by", "verifier");
  assert.equal(checked.code, 0, checked.stderr);
  assert.equal(JSON.parse((await call(root, "lesson", "show", "--id", "checked")).stdout).lesson.status, "candidate");

  const retired = await call(root, "lesson", "review", "--id", "routed", "--status", "retired", "--reviewed-by", "maintainer", "--note", "Not handbook material.");
  assert.equal(retired.code, 0, retired.stderr);
  assert.equal(JSON.parse(await readFile(routedPath, "utf8")).status, "retired");
  assert.equal(JSON.parse(retired.stdout).promoted, undefined);

  const promoted = await call(root, "lesson", "review", "--id", "recur", "--status", "active", "--reviewed-by", "maintainer", "--note", "Promoted after a second demand.");
  assert.equal(promoted.code, 0, promoted.stderr);
  const promotedBody = JSON.parse(promoted.stdout);
  assert.equal(promotedBody.promoted, true);
  assert.equal(promotedBody.source, join(root, "docs/agent-team/lessons/recur.json"));
  await assert.rejects(readFile(autoPath));
  const visible = JSON.parse((await call(root, "lesson", "search", "--tag", "git")).stdout);
  assert.deepEqual(visible.lessons.map((item: { id: string }) => item.id), ["recur"]);
  const stillQueued = JSON.parse((await call(root, "lesson", "pending", "--handbook")).stdout);
  assert.deepEqual(stillQueued.items.map((item: { id: string }) => item.id), ["recur"]);
  assert.equal(await readFile(handbookPath, "utf8"), handbook);
  assert.deepEqual(JSON.parse(await readFile(join(root, "crewvane.team.json"), "utf8")).rules, config.rules);
  assert.deepEqual((await readdir(join(root, "docs/agent-team"))).sort(), ["handbook.md", "lessons"]);

  await writeFile(join(root, "docs/agent-team/lessons/auto/broken.json"), "{not-json");
  const afterBreak = await call(root, "team", "context", "--tag", "git");
  assert.equal(afterBreak.code, 0, afterBreak.stderr);
  assert.equal(JSON.parse(afterBreak.stdout).lessons[0].id, "recur");
  assert.equal((await call(root, "lesson", "pending", "--handbook")).code, 1);
}));

test("auto candidates follow the configured lessons directory and reject a linked auto directory", async () => fixture(async (root) => {
  const configured = await call(root, "setup", "--shared", "--lessons", "docs/engineering/lessons");
  assert.equal(configured.code, 0, configured.stderr);
  const added = await addAuto(root, lesson("custom", { action: "Check the configured directory." }));
  assert.equal(added.code, 0, added.stderr);
  const source = join(root, "docs/engineering/lessons/auto/custom.json");
  assert.equal(JSON.parse(added.stdout).source, source);
  assert.equal(JSON.parse(await readFile(source, "utf8")).status, "candidate");
  const outside = await mkdtemp(join(tmpdir(), "crewvane-auto-outside-"));
  try {
    await rm(join(root, "docs/engineering/lessons/auto"), { recursive: true, force: true });
    await symlink(outside, join(root, "docs/engineering/lessons/auto"));
    const escaped = await addAuto(root, lesson("escape", { action: "Should stay inside." }));
    assert.equal(escaped.code, 1);
    assert.match(escaped.stderr, /lesson auto directory cannot be a symlink/);
    assert.equal((await readdir(outside)).length, 0);
    const context = await call(root, "team", "context", "--tag", "git");
    assert.equal(context.code, 0, context.stderr);
    assert.deepEqual(JSON.parse(context.stdout).lessons, []);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test("handbook review queue is bounded to cross-demand suggestions", async () => fixture(async (root) => {
  const auto = join(root, "docs/agent-team/lessons/auto");
  await mkdir(auto, { recursive: true });
  const card = (id: string, demands: { source_task_id: string; tags: string[] }[], suggested = true) => ({
    ...lesson(id, { action: `Check boundary ${id}.`, source_task_id: demands[0]?.source_task_id }),
    status: "candidate",
    updated_at: "2026-11-02T00:00:00.000Z",
    demands,
    ...(suggested ? { handbook_review_suggested: true } : {}),
  });
  for (let index = 0; index < 21; index += 1) {
    const id = `queue-${index}`;
    await writeFile(join(auto, `${id}.json`), `${JSON.stringify(card(id, [{ source_task_id: `${id}-a`, tags: [] }, { source_task_id: `${id}-b`, tags: [] }]), null, 2)}\n`);
  }
  await writeFile(join(auto, "only-once.json"), `${JSON.stringify(card("only-once", [{ source_task_id: "once", tags: [] }], false), null, 2)}\n`);
  const retired = card("retired-suggestion", [{ source_task_id: "retired-a", tags: [] }, { source_task_id: "retired-b", tags: [] }]);
  retired.status = "retired";
  await writeFile(join(auto, "retired-suggestion.json"), `${JSON.stringify(retired, null, 2)}\n`);
  const pending = await call(root, "lesson", "pending", "--handbook");
  assert.equal(pending.code, 0, pending.stderr);
  const body = JSON.parse(pending.stdout);
  assert.equal(body.items.length, 20);
  assert.equal(body.total_count, 21);
  assert.equal(body.omitted_count, 1);
  assert.equal(body.items.some((item: { id: string }) => item.id === "only-once" || item.id === "retired-suggestion"), false);
  assert.equal(body.items.every((item: { handbook_review_suggested: boolean }) => item.handbook_review_suggested), true);
}));

test("bad JSON is reported without copying its contents into output", async () => fixture(async (root) => {
  await call(root, "setup", "--shared");
  const file = join(root, "bad-input.json");
  await writeFile(file, "not_json_with_test_marker_123");
  const result = await call(root, "lesson", "add", "--input", file);
  assert.equal(result.code, 1); assert.match(result.stderr, /not valid JSON/);
  assert.doesNotMatch(result.stderr, /test_marker_123/);
}));

test("200KB AGENTS is hashed without injection; oversized handbook names its path and byte count", () => fixture(async root => {
  await call(root, "setup", "--shared");
  const path = join(root, "AGENTS.md"), content = "# Owner rules\n" + "x".repeat(200 * 1024);
  await writeFile(path, content);
  const context = await call(root, "team", "context", "--auto"); assert.equal(context.code, 0, context.stderr);
  const source = JSON.parse(context.stdout).source_details.find((s: { path: string }) => s.path === path);
  const invoked = await exec(process.execPath, [fileURLToPath(new URL("../bin/crewvane.js", import.meta.url)), "team", "context", "--auto", "--root", root]);
  assert.equal(JSON.parse(invoked.stdout).source_details.find((s: { path: string }) => s.path === path).digest, source.digest);
  assert.equal(source.body_included, false); assert.match(source.digest, /^[a-f0-9]{64}$/);
  assert.ok(context.stdout.length < 20000);
  const handbook = join(root, "docs/agent-team/handbook.md"); await writeFile(handbook, "h".repeat(20000));
  const failed = await call(root, "team", "context", "--auto"); assert.equal(failed.code, 1); assert.ok(failed.stderr.includes(handbook)); assert.match(failed.stderr, /20000 bytes/);
}));
