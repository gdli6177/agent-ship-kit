import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceService,
  WorkspaceStore,
  attentionGoals,
  type Goal,
} from "../src/index.js";
const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-core-"));
  fixtures.push(root);
  return { root, service: new WorkspaceService(root) };
}
async function create(service: WorkspaceService) {
  return (await service.execute({
    type: "goal.create",
    input: {
      title: "验证注意力闭环",
      projectId: "personal",
      workflowId: "feature",
      mode: "concierge",
    },
  })) as Goal;
}
test("dispatch failures remain actionable and successful retry clears only its own intervention", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "failed", detail: "Herdr 未安装" });
  let saved = (await service.read()).goals[0]!;
  assert.equal(saved.attention?.source, "dispatch");
  assert.equal(attentionGoals([saved]).length, 1);
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "pending" });
  saved = (await service.read()).goals[0]!;
  assert.equal(saved.attention?.source, "dispatch");
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "sent" });
  assert.equal((await service.read()).goals[0]?.attention, null);
  await service.execute({ type: "goal.decide", goalId: item.id, question: "是否调整交付范围？" });
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "failed", detail: "管家暂时不可达" });
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "sent" });
  assert.equal((await service.read()).goals[0]?.attention?.kind, "decision");
});
test("late dispatch never reopens a dropped goal", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "pending" });
  await service.execute({ type: "goal.drop", goalId: item.id, note: "不再需要" });
  await assert.rejects(service.execute({ type: "goal.dispatch", goalId: item.id, status: "sent" }));
  assert.equal((await service.read()).goals[0]?.status, "dropped");
});
test("Agent role preferences persist without changing running concierge references", async () => {
  const { service } = await fixture();
  await service.execute({ type: "concierge.status", status: "ready",
    reference: { session: "crewvane-test", agent: "concierge", paneId: "w1:p1" } });
  await service.execute({ type: "agents.configure", preferences: { concierge: "codex --model my-model", owner: "omp --model other-model", worker: "qodercli" } });
  const state = await service.read();
  assert.deepEqual(state.agents, { concierge: "codex --model my-model", owner: "omp --model other-model", worker: "qodercli" });
  assert.equal(state.concierge.paneId, "w1:p1");
  await assert.rejects(service.execute({ type: "agents.configure", preferences: { concierge: "codex; echo injected" } }), /无效/);
});
test("creates a personal workspace and immutable workflow snapshot", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({
    type: "workflow.save",
    workflow: {
      id: "feature",
      name: "修改后的工序",
      steps: [{ id: "one", name: "一步", prompt: "新的说明" }],
    },
  });
  const state = await service.read();
  assert.equal(state.version, 2);
  assert.equal(state.goals[0]?.steps.length, 3);
  assert.equal(item.mode, "concierge");
  assert.equal(state.concierge.session, "crewvane");
});
test("waiting only becomes attention at the reminder time", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({
    type: "goal.wait",
    goalId: item.id,
    reason: "等 YR 审批",
    owner: "YR",
    remindAt: "2030-01-01T08:00:00Z",
  });
  assert.equal(
    attentionGoals(
      (await service.read()).goals,
      Date.parse("2029-12-31T08:00:00Z"),
    ).length,
    0,
  );
  assert.equal(
    attentionGoals(
      (await service.read()).goals,
      Date.parse("2030-01-01T08:00:00Z"),
    )[0]?.id,
    item.id,
  );
});
test("live done never means complete; blocked is first routed to the concierge", async () => {
  const { service } = await fixture();
  const item = await create(service),
    at = new Date().toISOString();
  await service.execute({
    type: "live.sync",
    presences: { [item.id]: { state: "done", checkedAt: at } },
  });
  assert.equal((await service.read()).goals[0]?.status, "active");
  assert.equal(attentionGoals((await service.read()).goals).length, 0);
  await service.execute({
    type: "live.sync",
    presences: { [item.id]: { state: "blocked", checkedAt: at } },
  });
  assert.equal((await service.read()).goals[0]?.attention, null);
  const requests = await service.execute({ type: "watchdog.inspect", at }) as { goalId: string }[];
  assert.equal(requests[0]?.goalId, item.id);
  assert.equal((await service.read()).goals[0]?.attention, null);
  await service.execute({
    type: "live.sync",
    presences: { [item.id]: { state: "working", checkedAt: at } },
  });
  assert.equal((await service.read()).goals[0]?.attention, null);
});
test("review requires checks and preserves rework and acceptance history", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await assert.rejects(
    () =>
      service.execute({
        type: "goal.review",
        goalId: item.id,
        delivery: { summary: "完成", checks: [] },
      }),
    /真实检查/,
  );
  const delivery = {
    summary: "实际改动已完成",
    location: "src/app.ts",
    checks: [{ name: "回归", command: "pnpm test", result: "passed" as const }],
  };
  await service.execute({ type: "goal.review", goalId: item.id, delivery });
  await assert.rejects(
    () =>
      service.execute({
        type: "goal.resolve",
        goalId: item.id,
        note: "假装验收",
      }),
    /验收通过或退回修改/,
  );
  await service.execute({
    type: "goal.rework",
    goalId: item.id,
    note: "补充移动端验证",
  });
  await service.execute({
    type: "goal.review",
    goalId: item.id,
    delivery: { ...delivery, summary: "已补充移动端验证" },
  });
  await service.execute({
    type: "goal.accept",
    goalId: item.id,
    note: "试用通过",
  });
  const state = await service.read();
  assert.equal(state.goals[0]?.status, "completed");
  assert.deepEqual(
    state.goals[0]?.activities.slice(-3).map((a) => a.kind),
    ["rework", "delivery", "accepted"],
  );
  assert.equal(attentionGoals(state.goals).length, 0);
});
test("concurrent services retain both updates and state file is valid", async () => {
  const { root, service } = await fixture(),
    other = new WorkspaceService(root);
  await Promise.all([create(service), create(other)]);
  const state = await new WorkspaceStore(root).read();
  assert.equal(state.goals.length, 2);
  assert.equal(
    JSON.parse(await readFile(join(root, ".crewvane/state.json"), "utf8"))
      .version,
    2,
  );
});
test("old state fails clearly rather than being migrated", async () => {
  const { root, service } = await fixture();
  await mkdir(join(root, ".crewvane"), { recursive: true });
  await writeFile(
    join(root, ".crewvane/state.json"),
    JSON.stringify({ version: 1, tasks: [] }),
  );
  await assert.rejects(() => service.read(), /不支持的工作区状态版本/);
});
test("resolving a due reminder clears it so it cannot notify twice", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({
    type: "goal.remind",
    goalId: item.id,
    at: "2020-01-01T00:00:00Z",
    note: "检查结果",
  });
  assert.equal(attentionGoals((await service.read()).goals).length, 1);
  await service.execute({
    type: "goal.resolve",
    goalId: item.id,
    note: "已处理",
  });
  assert.equal(attentionGoals((await service.read()).goals).length, 0);
  assert.equal((await service.read()).goals[0]?.remindAt, undefined);
});
test("background progress cannot dismiss a decision or take a delivery out of review", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({
    type: "goal.decide",
    goalId: item.id,
    question: "请选择交付范围",
  });
  await service.execute({
    type: "goal.progress",
    goalId: item.id,
    summary: "补充了调查结果",
  });
  assert.equal((await service.read()).goals[0]?.attention?.kind, "decision");
  await service.execute({
    type: "goal.resolve",
    goalId: item.id,
    note: "先做核心范围",
  });
  await service.execute({
    type: "goal.review",
    goalId: item.id,
    delivery: {
      summary: "核心范围已交付",
      checks: [{ name: "验证", command: "实际试用", result: "passed" }],
    },
  });
  await assert.rejects(
    () =>
      service.execute({
        type: "goal.progress",
        goalId: item.id,
        summary: "迟到的进度",
      }),
    /等待验收/,
  );
  assert.equal((await service.read()).goals[0]?.status, "review");
});
test("late agent commands never reopen completed or dropped goals", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({ type: "goal.drop", goalId: item.id, note: "已取消" });
  for (const command of [
    { type: "goal.progress", goalId: item.id, summary: "旧消息" },
    { type: "goal.wait", goalId: item.id, reason: "旧等待" },
    { type: "goal.decide", goalId: item.id, question: "旧问题" },
    { type: "goal.remind", goalId: item.id, at: "2030-01-01T00:00:00Z" },
    {
      type: "goal.review",
      goalId: item.id,
      delivery: {
        summary: "旧交付",
        checks: [{ name: "检查", command: "读取", result: "passed" }],
      },
    },
  ] as const) {
    await assert.rejects(
      () =>
        service.execute(
          structuredClone(command) as import("../src/index.js").CrewvaneCommand,
        ),
      /已结束/,
    );
  }
  assert.equal((await service.read()).goals[0]?.status, "dropped");
});
test("manual waiting can resume and stops an old follow-up notification", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({
    type: "goal.remind",
    goalId: item.id,
    at: "2020-01-01T00:00:00Z",
  });
  await service.execute({
    type: "notification.sent",
    goalId: item.id,
    kind: "follow_up",
    at: new Date().toISOString(),
  });
  await service.execute({
    type: "goal.progress",
    goalId: item.id,
    summary: "审批已通过，继续执行",
  });
  assert.equal(attentionGoals((await service.read()).goals).length, 0);
  assert.equal((await service.read()).goals[0]?.status, "active");
});
