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

test("delivers deduplicated goal status changes with the previous and current state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewvane-webhook-status-")),
    hook = await webhookServer();
  try {
    const notifier = new WebhookNotifier(directory, "0.5.1");
    await notifier.save({
      enabled: true,
      url: hook.url,
      token: "status-token",
      statuses: ["waiting"],
    });
    const goal: Goal = {
      id: "goal_status",
      projectId: "project",
      title: "等待合同审批",
      description: "审批通过后安排签署。",
      mode: "concierge",
      steps: [],
      next: "等待法务确认条款",
      owner: "负责人",
      status: "waiting",
      waitingFor: "法务",
      attention: null,
      activities: [{
        id: "act_waiting",
        at: "2026-11-05T02:12:00.000Z",
        actor: "负责人",
        kind: "waiting",
        text: "已送法务审批。",
      }],
      createdAt: "2026-11-05T02:00:00.000Z",
      updatedAt: "2026-11-05T02:12:00.000Z",
    };
    const notification = {
      workspace: { name: "运营工作区" },
      goal,
      previousStatus: "active" as const,
    };

    assert.deepEqual(await notifier.deliverStatusChange(notification), { sent: true });
    assert.deepEqual(await notifier.deliverStatusChange(notification), { sent: false, reason: "duplicate" });
    assert.equal(hook.received.length, 1);
    assert.equal(hook.received[0]?.headers.authorization, "Bearer status-token");
    assert.equal(hook.received[0]?.headers["x-crewvane-event"], "goal.status_changed");
    assert.equal(hook.received[0]?.body.goal.previousStatus, "active");
    assert.equal(hook.received[0]?.body.goal.status, "waiting");
    assert.equal(hook.received[0]?.body.goal.waitingFor, "法务");
    assert.equal(hook.received[0]?.body.action.goalId, "goal_status");

    await notifier.save({ enabled: true, statuses: ["review"] });
    assert.deepEqual(await notifier.deliverStatusChange({
      ...notification,
      goal: { ...goal, id: "goal_unsubscribed", status: "completed" },
    }), { sent: false, reason: "status-not-subscribed" });
    assert.equal(hook.received.length, 1);
  } finally {
    await hook.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses Feishu's bot payload and treats a non-zero business code as a delivery failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewvane-webhook-feishu-"));
  try {
    const requests: Record<string, any>[] = [];
    let responseBody: Record<string, unknown> = { code: 0, msg: "success" };
    const notifier = new WebhookNotifier(
      directory,
      "0.5.1",
      async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    await notifier.save({
      enabled: true,
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
    });
    const goal: Goal = {
      id: "goal_feishu",
      projectId: "project",
      title: "确认上线窗口",
      description: "等待确认发布时间。",
      mode: "concierge",
      steps: [],
      next: "选择周四或周五",
      owner: "负责人",
      status: "review",
      attention: {
        kind: "review",
        summary: "负责人已提交上线计划",
        since: "2026-11-05T03:00:00.000Z",
      },
      activities: [],
      createdAt: "2026-11-05T02:00:00.000Z",
      updatedAt: "2026-11-05T03:00:00.000Z",
    };

    assert.deepEqual(await notifier.deliver({
      workspace: { name: "发布工作区" },
      goal,
      kind: "review",
    }), { sent: true });
    assert.equal(requests[0]?.msg_type, "text");
    assert.match(requests[0]?.content?.text, /Crewvane｜需要你处理/);
    assert.match(requests[0]?.content?.text, /确认上线窗口/);

    responseBody = { code: 19001, msg: "params error" };
    const failed = await notifier.deliverStatusChange({
      workspace: { name: "发布工作区" },
      goal: { ...goal, id: "goal_feishu_failed", status: "waiting" },
      previousStatus: "review",
    });
    assert.equal(failed.sent, false);
    assert.match(failed.reason ?? "", /飞书 Webhook 返回错误 19001/);
    const status = await notifier.status();
    assert.match(status.lastError ?? "", /params error/);

    responseBody = {};
    const malformed = await notifier.deliverStatusChange({
      workspace: { name: "发布工作区" },
      goal: { ...goal, id: "goal_feishu_malformed", status: "completed" },
      previousStatus: "review",
    });
    assert.equal(malformed.sent, false);
    assert.match(malformed.reason ?? "", /未返回可识别的业务结果/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses WeCom's robot payload and surfaces a non-zero errcode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewvane-webhook-wecom-"));
  try {
    const requests: Record<string, any>[] = [];
    let responseBody = { errcode: 0, errmsg: "ok" };
    const notifier = new WebhookNotifier(
      directory,
      "0.5.1",
      async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    await notifier.save({
      enabled: true,
      url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
    });
    const goal: Goal = {
      id: "goal_wecom",
      projectId: "project",
      title: "确认预算",
      description: "等待预算审批。",
      mode: "concierge",
      steps: [],
      next: "等待你选择预算方案",
      owner: "负责人",
      status: "review",
      attention: {
        kind: "review",
        summary: "预算方案已经提交",
        since: "2026-11-05T04:00:00.000Z",
      },
      activities: [],
      createdAt: "2026-11-05T03:00:00.000Z",
      updatedAt: "2026-11-05T04:00:00.000Z",
    };

    assert.deepEqual(await notifier.deliver({
      workspace: { name: "经营工作区" },
      goal,
      kind: "review",
    }), { sent: true });
    assert.equal(requests[0]?.msgtype, "text");
    assert.match(requests[0]?.text?.content, /Crewvane｜需要你处理/);
    assert.match(requests[0]?.text?.content, /确认预算/);

    responseBody = { errcode: 93000, errmsg: "invalid webhook url" };
    const failed = await notifier.deliverStatusChange({
      workspace: { name: "经营工作区" },
      goal: { ...goal, id: "goal_wecom_failed", status: "completed" },
      previousStatus: "review",
    });
    assert.equal(failed.sent, false);
    assert.match(failed.reason ?? "", /企业微信 Webhook 返回错误 93000/);
    assert.match((await notifier.status()).lastError ?? "", /invalid webhook url/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transition into review sends one WeCom message instead of duplicating status and attention", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crewvane-webhook-wecom-dedup-"));
  try {
    const requests: Record<string, any>[] = [];
    const notifier = new WebhookNotifier(
      directory,
      "0.5.2",
      async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    await notifier.save({
      enabled: true,
      url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
    });
    const goal: Goal = {
      id: "goal_wecom_once",
      projectId: "project",
      title: "确认发布结果",
      description: "需要人验收发布结果。",
      mode: "concierge",
      steps: [],
      next: "查看交付并完成验收",
      owner: "负责人",
      status: "review",
      attention: {
        kind: "review",
        summary: "负责人已提交发布结果",
        since: "2026-11-05T05:00:00.000Z",
      },
      activities: [],
      createdAt: "2026-11-05T04:50:00.000Z",
      updatedAt: "2026-11-05T05:00:00.000Z",
    };
    const workspace = { name: "发布工作区" };

    const status = await notifier.deliverStatusChange({
      workspace,
      goal,
      previousStatus: "active",
    });
    const attention = await notifier.deliver({
      workspace,
      goal,
      kind: "review",
    });

    assert.deepEqual(attention, { sent: true });
    assert.equal(status.sent, false);
    assert.equal(requests.length, 1, "one goal transition must produce one WeCom message");
    assert.match(requests[0]?.text?.content, /需要你处理/);
    assert.match(requests[0]?.text?.content, /确认发布结果/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
