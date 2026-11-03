import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { readEvents } from "../src/storage.js";
import { parseRole } from "../src/roles.js";
import { guardTool } from "../src/tool-guard.js";

const exec = promisify(execFile);
async function call(root: string, ...args: string[]) {
  let stdout = "", stderr = "";
  const code = await main([...args, "--root", root], { stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}
async function ok(root: string, ...args: string[]) { const result = await call(root, ...args); assert.equal(result.code, 0, result.stderr + result.stdout); return result.json(); }
async function git(root: string, ...args: string[]) { return (await exec("git", args, { cwd: root })).stdout.trim(); }
async function fixture(body: (root: string) => Promise<void>) {
  const previous = { ...process.env };
  const root = await realpath(await mkdtemp(join(tmpdir(), "ship-lanes-")));
  delete process.env.CREWVANE_ACTOR;
  process.env.CREWVANE_TIMER_PLATFORM = "unsupported";
  process.env.CREWVANE_TIMER_HOME = join(root, "timer-home");
  try {
    await git(root, "init", "-b", "main"); await git(root, "config", "user.name", "Fixture"); await git(root, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, "a.txt"), "baseline\n"); await writeFile(join(root, "b.txt"), "baseline\n");
    await git(root, "add", "a.txt", "b.txt"); await git(root, "commit", "-m", "baseline");
    await ok(root, "setup"); await ok(root, "authority", "init", "--human", "human", "--captain", "captain");
    process.env.CREWVANE_ACTOR = "captain";
    await body(root);
  } finally { process.env = previous; await rm(root, { recursive: true, force: true }); }
}
async function claim(root: string, lane: string) {
  process.env.CREWVANE_ACTOR = "captain";
  await ok(root, "intake", "add", "--id", `request_${lane}`, "--text", `Request ${lane}`, "--project", "demo");
  return ok(root, "intake", "claim", `request_${lane}`, "--by", `owner_${lane}`, "--lane", lane);
}
async function draft(root: string, lane: string, role = "generic-worker") {
  const entry = await claim(root, lane);
  const path = join(root, `.crewvane/contracts/contract_${lane}.md`);
  const body = `Status: draft\nLane: ${lane}\nOwner: owner_${lane}\nProposal id: ${entry.proposal_id}\n## Allowed paths\n- ${lane === "B" ? "b" : "a"}.txt\n## Forbidden paths\n- forbidden.txt\n## Slices\nmax_parallel: 3\n| Slice id | role | Inputs | Done when |\n| --- | --- | --- | --- |\n| a | ${role} | contract | checks pass |\n| b | ${role} | contract | checks pass |\n| c | ${role} | contract | checks pass |\n`;
  await writeFile(path, body);
  return { path, body, proposal: entry.proposal_id as string };
}
async function freeze(root: string, lane: string) {
  process.env.CREWVANE_ACTOR = "human";
  return ok(root, "contract", "freeze", "--contract", `contract_${lane}`, "--by", "human", "--accepted-text", `Explicit fixture acceptance for lane ${lane}.`);
}
async function workerRepo(root: string, lane: string, slice = "a") {
  const path = join(root, `worker_${lane}_${slice}`);
  await git(root, "worktree", "add", "-b", `ship/${lane}/${slice}`, path, "main");
  return path;
}
async function start(root: string, lane: string, repo: string, slice = "a", ...extra: string[]) {
  process.env.CREWVANE_ACTOR = `owner_${lane}`;
  return call(root, "slice", "start", "--contract", `contract_${lane}`, "--slice", slice, "--lane", lane, "--repo", repo, "--branch", `ship/${lane}/${slice}`, "--worker", `worker_${lane}_${slice}`, "--source-task-id", `task_${lane}_${slice}`, "--project", "demo", "--title", lane, "--summary", "Fixture lane execution.", "--allow-untimed", ...extra);
}

test("two queued demands create independent lane proposals and contracts; no cross-lane guard mismatch", () => fixture(async root => {
  const a = await draft(root, "A"), b = await draft(root, "B");
  assert.equal((await ok(root, "status", "--brief")).pending_human, 2);
  assert.equal(await readFile(join(root, ".crewvane/active-proposal.A"), "utf8"), `${a.proposal}\n`);
  assert.equal(await readFile(join(root, ".crewvane/active-proposal.B"), "utf8"), `${b.proposal}\n`);
  assert.match(await readFile(join(root, `.crewvane/proposals/${a.proposal}.md`), "utf8"), /Status: draft/);
  await freeze(root, "A"); await freeze(root, "B");
  const ar = await workerRepo(root, "A"), br = await workerRepo(root, "B");
  assert.equal((await start(root, "A", ar)).code, 0);
  assert.equal((await start(root, "B", br)).code, 0);
  const guard = await call(root, "guard", "--contract", "contract_A", "--lane", "A", "--repo", ar, "--staged");
  assert.equal(guard.code, 0, guard.stderr + guard.stdout);
  const events = await readEvents(root);
  assert.deepEqual(events.filter(event => event.type === "worker_dispatched").map(event => [event.lane_id, event.owner_ref]), [["A", "owner_A"], ["B", "owner_B"]]);
  assert.equal((await call(root, "guard", "--contract", "contract_A", "--lane", "B", "--repo", ar, "--staged")).code, 1);
}));

test("queue append/idempotency and concurrent claims preserve all requests", () => fixture(async root => {
  const add = (id: string) => call(root, "intake", "add", "--id", id, "--text", id, "--project", "demo", "--channel", "im");
  const results = await Promise.all([add("one"), add("two"), add("one")]);
  assert.ok(results.every(result => result.code === 0));
  assert.equal((await ok(root, "intake", "list")).length, 2);
  const claims = await Promise.all([call(root, "intake", "claim", "one", "--by", "owner_1", "--lane", "one"), call(root, "intake", "claim", "one", "--by", "owner_2", "--lane", "two")]);
  assert.deepEqual(claims.map(result => result.code).sort(), [0, 1]);
  assert.equal((await ok(root, "intake", "list", "--state", "all")).length, 2);
  assert.ok((await readFile(join(root, ".crewvane/intake.jsonl"), "utf8")).trim().split("\n").length >= 3);
}));

test("pending_human equals the three counters and inbox filtering isolates lanes", () => fixture(async root => {
  await draft(root, "A"); await draft(root, "B");
  await ok(root, "intake", "add", "--id", "third", "--text", "Third request", "--project", "demo");
  process.env.CREWVANE_ACTOR = "owner_A";
  await ok(root, "inbox", "add", "--type", "needs_approval", "--title", "A decision", "--summary", "Scope decision.", "--source-task-id", "owner_A", "--lane", "A");
  process.env.CREWVANE_ACTOR = "owner_B";
  await ok(root, "inbox", "add", "--type", "blocked", "--title", "B blocker", "--summary", "Permission needed.", "--source-task-id", "owner_B", "--lane", "B");
  const status = await ok(root, "status", "--brief");
  assert.deepEqual(status.pending_human_components, { intake_open: 1, draft_proposals: 2, open_inbox: 2 });
  assert.equal(status.pending_human, 5);
  assert.equal(status.pending_human, Object.values(status.pending_human_components).reduce((sum, value) => Number(sum) + Number(value), 0));
  const inbox = await ok(root, "inbox", "list", "--lane", "A", "--json"); assert.equal(inbox.length, 1); assert.equal(inbox[0].lane_id, "A");
  const wrongDecision = await call(root, "inbox", "decide", inbox[0].id, "accept", "--lane", "B"); assert.equal(wrongDecision.code, 1);
}));

test("owner cannot forge human acceptance, edit limits or bypass the captain to notify", () => fixture(async root => {
  const a = await draft(root, "A");
  process.env.CREWVANE_ACTOR = "owner_A";
  const denied = await call(root, "contract", "freeze", "--contract", "contract_A", "--by", "human", "--accepted-text", "Owner pretending to be human.");
  assert.equal(denied.code, 1); assert.match(denied.stderr, /requires human/);
  await writeFile(a.path, a.body.replace("Status: draft", "Status: frozen") + "\nAccepted by: owner_A\nFrozen by: owner_A\nFrozen at: 2026-11-02T00:00:00Z\n");
  const forged = await call(root, "check", "--contract", "contract_A"); assert.equal(forged.code, 1); assert.match(forged.stdout, /owner cannot freeze/);
  await writeFile(a.path, a.body); await freeze(root, "A");
  process.env.CREWVANE_ACTOR = "owner_A";
  await ok(root, "inbox", "add", "--type", "blocked", "--title", "A blocked", "--summary", "Fixture needs a decision.", "--source-task-id", "owner_A", "--lane", "A");
  const sentinel = join(root, "notification.txt"), script = join(root, "send.cjs");
  await writeFile(script, "require('node:fs').writeFileSync(process.argv[2], 'sent');");
  const action = `${process.execPath} ${script} ${sentinel}`;
  await writeFile(join(root, "policy.md"), `## Rule: fixture\nwhen.type: blocked\naction: ${action}\n`);
  await writeFile(join(root, "allow.json"), JSON.stringify({ patterns: [action] }));
  const notification = await call(root, "notify", "run", "--latest", "--policy", join(root, "policy.md"), "--allowlist", join(root, "allow.json"));
  assert.equal(notification.code, 1); assert.match(notification.stderr, /requires captain/);
  await assert.rejects(readFile(sentinel), /ENOENT/);
  process.env.CREWVANE_ACTOR = "captain";
  assert.equal((await call(root, "notify", "run", "--latest", "--policy", join(root, "policy.md"), "--allowlist", join(root, "allow.json"))).code, 0);
  assert.equal(await readFile(sentinel, "utf8"), "sent");
  process.env.CREWVANE_ACTOR = "owner_A";
  assert.equal((await call(root, "limits", "set", "--global-max-parallel", "9", "--by", "human")).code, 1);
  await writeFile(join(root, ".crewvane/limits.json"), '{"global_max_parallel":9}');
  const tampered = await call(root, "check", "--contract", "contract_A"); assert.equal(tampered.code, 1); assert.match(tampered.stdout, /fingerprint/);
  process.env.CREWVANE_ACTOR = "human";
  await ok(root, "limits", "set", "--global-max-parallel", "3", "--by", "human");
  assert.equal((await call(root, "check", "--contract", "contract_A")).code, 0);
}));

test("global cap remains three across lanes and human receipt detects post-freeze edits", () => fixture(async root => {
  await draft(root, "A"); await draft(root, "B"); await freeze(root, "A"); await freeze(root, "B");
  for (const slice of ["a", "b", "c"]) { const repo = await workerRepo(root, "A", slice); const started = await start(root, "A", repo, slice); assert.equal(started.code, 0, started.stderr); }
  const br = await workerRepo(root, "B"); const fourth = await start(root, "B", br); assert.equal(fourth.code, 1); assert.match(fourth.stderr, /global_max_parallel/);
  const file = join(root, ".crewvane/contracts/contract_A.md"); await writeFile(file, (await readFile(file, "utf8")) + "\nChanged acceptance after freezing.\n");
  const check = await call(root, "check", "--contract", "contract_A", "--slice", "a"); assert.equal(check.code, 1); assert.match(check.stdout, /changed after approval/);
}));

test("portable role cards validate and inject; forbidden paths cannot widen contract scope", () => fixture(async root => {
  const directory = join(root, ".agents/team/roles"); await mkdir(directory, { recursive: true });
  const card = "---\nid: custom\npurpose: Review boundary\nmay_see: [contract_slice, acceptance]\ndefault_allowed_paths: [b.txt]\nforbidden_paths: [a.txt]\nmust_produce:\n  - command + exit code\n  - evidence pointer\nlesson_tags: [scope]\nout_of_scope: [merge, deploy]\n---\nStable role only.\n";
  await writeFile(join(directory, "custom.md"), card);
  assert.equal(parseRole(card).id, "custom"); assert.throws(() => parseRole(card.replace("purpose:", "runtime: codex\npurpose:")), /runtime\/model/);
  await draft(root, "A", "custom"); await freeze(root, "A");
  const ar = await workerRepo(root, "A"); const result = await start(root, "A", ar); assert.equal(result.code, 0, result.stderr);
  assert.match(result.json().role_warnings[0], /contract Allowed paths take precedence/);
  assert.equal(result.json().role.id, "custom"); assert.match(result.json().role.markdown, /must_produce/);
  assert.equal((await ok(root, "team", "context", "--role", "custom")).role.id, "custom");
  await writeFile(join(ar, "a.txt"), "forbidden by role\n"); await git(ar, "add", "a.txt"); await git(ar, "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture role violation");
  const check = await call(root, "check", "--contract", "contract_A", "--slice", "a"); assert.equal(check.code, 1); assert.ok(check.json().forbidden.includes("a.txt"));
  await writeFile(join(directory, "custom.md"), card.replace("id: custom", "id: wrong"));
  assert.equal((await call(root, "check", "--contract", "contract_A", "--slice", "a")).code, 1);
}));

test("captain command hook denies repo work, cross-root policy switches and exhausted turn budgets", () => fixture(async root => {
  await ok(root, "captain", "heartbeat", "--busy-until", new Date(Date.now() + 60000).toISOString());
  assert.ok((await ok(root, "status", "--brief")).captain_busy_until);
  assert.equal((await guardTool(root, { tool: "shell", argv: ["git", "diff"] })).allowed, false);
  assert.equal((await guardTool(root, { tool: "shell", argv: ["pnpm", "test"] })).allowed, false);
  assert.equal((await guardTool(root, { tool: "shell", argv: [process.execPath, "/tmp/evil-crewvane.js", "status"] })).allowed, false);
  assert.equal((await guardTool(root, { tool: "shell", argv: ["/tmp/crewvane", "status"] })).allowed, false);
  assert.equal((await guardTool(root, { tool: "shell", argv: ["crewvane", "captain", "heartbeat"] })).allowed, false);
  assert.equal((await guardTool(root, { tool: "read", path: "a.txt" })).allowed, false);
  assert.equal((await guardTool(root, { tool: "shell", argv: ["crewvane", "intake", "list"] })).allowed, true);
  assert.equal((await guardTool(root, { tool: "shell", argv: ["crewvane", "notify", "run", "--policy", ".crewvane/packets/policy.md", "--allowlist", ".crewvane/packets/allow.json"] })).allowed, false);
  assert.equal((await guardTool(root, { tool: "shell", argv: ["crewvane", "notify", "run", "--policy", ".crewvane/notify.policy.md", "--allowlist", ".crewvane/notify.allowlist.json"] })).allowed, true);
  assert.equal((await guardTool(root, { tool: "shell", argv: ["crewvane", "intake", "list", "--root", "/tmp"] })).allowed, false);
  for (let i = 0; i < 12; i++) await guardTool(root, { tool: "shell", argv: ["crewvane", "status"] });
  assert.match((await guardTool(root, { tool: "shell", argv: ["crewvane", "status"] })).reason, /budget/);
  await claim(root, "A"); process.env.CREWVANE_ACTOR = "owner_A";
  assert.equal((await guardTool(root, { tool: "shell", argv: ["crewvane", "notify", "run"] })).allowed, false);
}));


test("slice open handles 200KB owner rules and prepares an independent checkout; invalid roles cannot create a worktree", () => fixture(async root => {
  await writeFile(join(root, "AGENTS.md"), "# Owner rules\n" + "x".repeat(200 * 1024));
  await draft(root, "A"); await freeze(root, "A");
  process.env.CREWVANE_ACTOR = "owner_A";
  const repo = join(root, "prepared");
  const opened = await ok(root, "slice", "open", "--contract", "contract_A", "--slice", "a", "--lane", "A", "--repo", repo, "--branch", "ship/A/prepared", "--worker", "prepared-worker", "--source-task-id", "prepared", "--title", "Prepared A", "--summary", "Preparation fixture.", "--allow-untimed");
  assert.equal(opened.spawn_required, true); assert.equal(opened.check.ok, true);
  assert.match(await readFile(opened.packet, "utf8"), /Lane: A/);
  assert.equal(await git(repo, "branch", "--show-current"), "ship/A/prepared");
  process.env.CREWVANE_ACTOR = "prepared-worker";
  assert.equal((await guardTool(root, { tool: "write", path: "a.txt" }, repo)).allowed, true);
  assert.equal((await guardTool(root, { tool: "write", path: "b.txt" }, repo)).allowed, false);
  process.env.CREWVANE_ACTOR = "owner_A";
  assert.equal((await call(root, "slice", "update", "--source-task-id", "prepared", "--status", "failed", "--worker", "impostor")).code, 1);
  await ok(root, "slice", "update", "--source-task-id", "prepared", "--status", "failed");
  process.env.CREWVANE_ACTOR = "prepared-worker";
  assert.equal((await guardTool(root, { tool: "write", path: "a.txt" }, repo)).allowed, false);
  await draft(root, "B"); await freeze(root, "B");
  await mkdir(join(root, ".agents/team/roles"), { recursive: true });
  await writeFile(join(root, ".agents/team/roles/generic-worker.md"), "malformed role card");
  const bad = join(root, "must-not-exist");
  process.env.CREWVANE_ACTOR = "owner_B";
  assert.equal((await call(root, "slice", "open", "--contract", "contract_B", "--slice", "a", "--repo", bad, "--worker", "bad-worker", "--source-task-id", "bad", "--title", "Bad", "--summary", "Bad role fixture.", "--allow-untimed")).code, 1);
  await assert.rejects(readFile(join(bad, ".git")), /ENOENT/);
}));

test("closed owners retire, cross-lane stop is refused, and a new turn restores the captain budget", () => fixture(async root => {
  await draft(root, "A"); await draft(root, "B"); await freeze(root, "B");
  const repo = await workerRepo(root, "B"); assert.equal((await start(root, "B", repo)).code, 0);
  process.env.CREWVANE_ACTOR = "owner_A";
  assert.equal((await call(root, "slice", "update", "--source-task-id", "task_B_a", "--status", "cancelled", "--lane", "B")).code, 1);
  await ok(root, "intake", "update", "request_A", "--state", "done");
  assert.equal((await guardTool(root, { tool: "write", path: ".crewvane/packets/A.md", content: "Lane: A\n" })).allowed, false);
  process.env.CREWVANE_ACTOR = "captain";
  await writeFile(join(root, ".crewvane/captain-state.json"), JSON.stringify({ turn_started_at: new Date(Date.now() - 180000).toISOString(), tool_calls: 1, captain_busy_until: new Date(Date.now() - 1000).toISOString() }));
  assert.equal((await ok(root, "status", "--brief")).captain_available, true);
  assert.equal((await guardTool(root, { tool: "shell", argv: ["crewvane", "status"] })).allowed, false);
  await ok(root, "captain", "heartbeat");
  assert.equal((await guardTool(root, { tool: "shell", argv: ["crewvane", "status"] })).allowed, true);
}));

test("five demand lanes share three worker slots and a human-approved cap can admit more", () => fixture(async root => {
  const repos = new Map<string, string>();
  for (const lane of ["A", "B", "C", "D", "E"]) {
    await draft(root, lane); await freeze(root, lane); repos.set(lane, await workerRepo(root, lane));
  }
  for (const lane of ["A", "B", "C"]) assert.equal((await start(root, lane, repos.get(lane)!)).code, 0);
  const fourth = await start(root, "D", repos.get("D")!); assert.equal(fourth.code, 1); assert.match(fourth.stderr, /global_max_parallel/);
  const status = await ok(root, "status", "--brief"); assert.equal(status.lanes.length, 5);
  assert.deepEqual(status.lanes.map((lane: { lane_id: string; stage: string }) => [lane.lane_id, lane.stage]), [["A", "running"], ["B", "running"], ["C", "running"], ["D", "frozen"], ["E", "frozen"]]);
  process.env.CREWVANE_ACTOR = "owner_A";
  await ok(root, "slice", "update", "--source-task-id", "task_A_a", "--lane", "A", "--status", "cancelled");
  assert.equal((await start(root, "D", repos.get("D")!)).code, 0);
  assert.equal((await start(root, "E", repos.get("E")!)).code, 1);
  process.env.CREWVANE_ACTOR = "human";
  await ok(root, "limits", "set", "--global-max-parallel", "4", "--by", "human");
  assert.equal((await start(root, "E", repos.get("E")!)).code, 0);
  const after = await ok(root, "status", "--brief"); assert.equal(after.lanes.filter((lane: { stage: string }) => lane.stage === "running").length, 4);
}));


test("repeated intake claims never revive a superseded proposal or old approval", () => fixture(async root => {
  const first = await draft(root, "A"); await freeze(root, "A");
  process.env.CREWVANE_ACTOR = "owner_A";
  const fresh = await ok(root, "intake", "--id", "proposal_A_revision", "--lane", "A", "--owner", "owner_A", "--text", "A changed scope needs new approval.");
  process.env.CREWVANE_ACTOR = "captain";
  await ok(root, "intake", "claim", "request_A", "--by", "owner_A", "--lane", "A");
  assert.equal((await readFile(join(root, ".crewvane/active-proposal.A"), "utf8")).trim(), fresh.proposal_id);
  const repo = await workerRepo(root, "A"); const denied = await start(root, "A", repo); assert.equal(denied.code, 1); assert.match(denied.stderr, /newer current proposal/);
  assert.equal((await call(root, "intake", "--id", first.proposal, "--lane", "A", "--owner", "owner_A", "--text", "Request A")).code, 1);
}));
