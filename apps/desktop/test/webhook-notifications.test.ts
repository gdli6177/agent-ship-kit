import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebhookNotifier } from "../electron/webhook-notifications.ts";
import type { Goal } from "../../../packages/core/src/index.js";

async function webhookServer() {
  const received: { headers: Record<string, string | string[] | undefined>; body: any }[] = [];
  let responseStatus = 204;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(responseStatus).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    received,
    url: `http://127.0.0.1:${address.port}/attention`,
    respond(status: number) { responseStatus = status; },
    close: () => new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())),
  };
}

test("persists a private webhook config without returning its secret URL or token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewvane-webhook-config-"));
  try {
    const notifier = new WebhookNotifier(directory, "0.5.0");
    const settings = await notifier.save({
      enabled: true,
      url: "https://hooks.example.test/path/secret",
      token: "very-secret-token",
    });
    assert.equal(settings.enabled, true);
    assert.equal(settings.configured, true);
    assert.equal(settings.tokenConfigured, true);
    assert.equal(settings.endpoint, "https://hooks.example.test/…");
    assert.doesNotMatch(JSON.stringify(settings), /very-secret-token|path\/secret/);
    const stored = await readFile(join(directory, "notification-webhooks.json"), "utf8");
    assert.match(stored, /very-secret-token/);
    assert.equal((await stat(join(directory, "notification-webhooks.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects insecure remote endpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewvane-webhook-config-"));
  try {
    const notifier = new WebhookNotifier(directory, "0.5.0");
    await assert.rejects(
      notifier.save({ enabled: true, url: "http://hooks.example.test/secret" }),
      /必须使用 HTTPS/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delivers an attention event once, sends the configured bearer token, and retries failures after backoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewvane-webhook-delivery-")),
    hook = await webhookServer();
  try {
    let now = new Date("2026-11-04T10:00:00.000Z");
    const notifier = new WebhookNotifier(directory, "0.5.0", fetch, () => now, 5 * 60_000);
    await notifier.save({ enabled: true, url: hook.url, token: "test-token" });
    const goal: Goal = {
      id: "goal_webhook",
      projectId: "project",
      title: "确认年度价格",
      description: "等待定价负责人给出两档方案。",
      mode: "concierge",
      steps: [],
      next: "选择方案 A 或 B",
      owner: "concierge",
      status: "review",
      attention: {
        kind: "review",
        summary: "定价负责人提交了两档方案",
        since: "2026-11-04T09:50:00.000Z",
      },
      herdr: { session: "test" },
      activities: [],
      createdAt: "2026-11-04T09:00:00.000Z",
      updatedAt: "2026-11-04T09:50:00.000Z",
    };
    const notification = { workspace: { name: "产品工作区" }, goal, kind: "review" as const };

    assert.deepEqual(await notifier.deliver(notification), { sent: true });
    assert.deepEqual(await notifier.deliver(notification), { sent: false, reason: "duplicate" });
    assert.equal(hook.received.length, 1);
    assert.equal(hook.received[0]?.headers.authorization, "Bearer test-token");
    assert.equal(hook.received[0]?.headers["x-crewvane-event"], "attention.required");
    assert.equal(hook.received[0]?.body.goal.id, "goal_webhook");
    assert.equal(hook.received[0]?.body.goal.summary, "定价负责人提交了两档方案");
    assert.equal(hook.received[0]?.body.action.goalId, "goal_webhook");

    hook.respond(503);
    const laterGoal = { ...goal, id: "goal_retry", attention: { ...goal.attention, since: "2026-11-04T10:00:00.000Z" } };
    const later = { ...notification, goal: laterGoal };
    const failed = await notifier.deliver(later);
    assert.equal(failed.sent, false);
    assert.match(failed.reason ?? "", /HTTP 503/);
    assert.match((await notifier.status()).lastError ?? "", /HTTP 503/);

    assert.equal((await notifier.deliver(later)).reason, "backoff");
    assert.equal(hook.received.length, 2);
    now = new Date("2026-11-04T10:06:00.000Z");
    hook.respond(204);
    assert.deepEqual(await notifier.deliver(later), { sent: true });
    assert.equal(hook.received.length, 3);
    assert.equal((await notifier.status()).lastError, undefined);
  } finally {
    await hook.close();
    await rm(directory, { recursive: true, force: true });
  }
});
