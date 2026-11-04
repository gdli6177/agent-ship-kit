import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceService,
  attentionGoals,
  type Goal,
  type Project,
  type ShipPolicy,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-governance-"));
  roots.push(root);
  return { root, service: new WorkspaceService(root) };
}
async function create(service: WorkspaceService, title: string, projectId = "personal") {
  return await service.execute({ type: "goal.create", input: {
    title, projectId, mode: "concierge",
  } }) as Goal;
}
async function setPolicy(service: WorkspaceService, projectId: string, shipPolicy: ShipPolicy) {
  await service.execute({
    type: "project.policy.set",
    projectId,
    policy: { shipPolicy, approvers: shipPolicy === "external-approval" ? ["YR"] : [] },
    actor: "你",
  });
}

test("projects default to external approval and agents cannot change ship policy", async () => {
  const { service } = await fixture();
  let state = await service.read();
  assert.equal(state.projects[0]?.policy.shipPolicy, "external-approval");
  assert.deepEqual(state.projects[0]?.policy.approvers, []);
  await assert.rejects(service.execute({
    type: "project.policy.set", projectId: "personal",
    policy: { shipPolicy: "auto", approvers: [] }, actor: "管家",
  }), /只能由人/);
  assert.equal((await service.read()).projects[0]?.policy.shipPolicy, "external-approval");
  await setPolicy(service, "personal", "auto");
  state = await service.read();
  assert.equal(state.projects[0]?.policy.shipPolicy, "auto");
  assert.equal(state.projects[0]?.policy.revision, 2);
});

test("external approval gates both merge and deploy until the human decision is recorded", async () => {
  const { service } = await fixture();
  const first = await create(service, "默认审批上线");
  const denied = await service.execute({
    type: "goal.ship", goalId: first.id, operation: "deploy", checksPassed: true,
  }) as { allowed: boolean; requiresHuman: boolean };
  assert.deepEqual([denied.allowed, denied.requiresHuman], [false, true]);
  assert.equal((await service.read()).goals[0]?.attention?.kind, "decision");

  await service.execute({
    type: "goal.resolve", goalId: first.id,
    note: "批准今天发布，但发布后必须核对版本。",
    outcome: "approved", actor: "你", source: "desktop",
  });
  const allowed = await service.execute({
    type: "goal.ship", goalId: first.id, operation: "deploy", checksPassed: true,
  }) as { allowed: boolean; reason: string };
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, "ledger");

  const second = await create(service, "同类上线不再打扰");
  const reused = await service.execute({
    type: "goal.ship", goalId: second.id, operation: "deploy", checksPassed: true,
  }) as { allowed: boolean };
  assert.equal(reused.allowed, true);
  assert.equal((await service.read()).goals.find(goal => goal.id === second.id)?.attention, null);
});

test("automatic policies still require passing checks and only skip their approved gates", async () => {
  const { service } = await fixture();
  const auto = await create(service, "全自动项目");
  await setPolicy(service, "personal", "auto");
  const failed = await service.execute({
    type: "goal.ship", goalId: auto.id, operation: "deploy", checksPassed: false,
  }) as { allowed: boolean; requiresHuman: boolean };
  assert.deepEqual([failed.allowed, failed.requiresHuman], [false, false]);
  const merged = await service.execute({
    type: "goal.ship", goalId: auto.id, operation: "merge", checksPassed: true,
  }) as { allowed: boolean };
  const deployed = await service.execute({
    type: "goal.ship", goalId: auto.id, operation: "deploy", checksPassed: true,
  }) as { allowed: boolean };
  assert.equal(merged.allowed, true);
  assert.equal(deployed.allowed, true);

  const project = await service.execute({ type: "project.add", name: "合并后手发布" }) as Project;
  await setPolicy(service, project.id, "auto-merge-manual-deploy");
  const manual = await create(service, "部署前审批", project.id);
  const autoMerge = await service.execute({
    type: "goal.ship", goalId: manual.id, operation: "merge", checksPassed: true,
  }) as { allowed: boolean };
  const manualDeploy = await service.execute({
    type: "goal.ship", goalId: manual.id, operation: "deploy", checksPassed: true,
  }) as { allowed: boolean; requiresHuman: boolean };
  assert.equal(autoMerge.allowed, true);
  assert.deepEqual([manualDeploy.allowed, manualDeploy.requiresHuman], [false, true]);
});

test("decision ledger suppresses repeated approvals and rejections and writes reviewable markdown", async () => {
  const { root, service } = await fixture();
  const first = await create(service, "周末上线");
  await service.execute({ type: "goal.decide", goalId: first.id, question: "是否周六上线？" });
  await service.execute({
    type: "goal.resolve", goalId: first.id, note: "批准周六上线。",
    outcome: "approved", actor: "你", source: "herdr",
  });
  const second = await create(service, "另一个周末上线");
  await service.execute({ type: "goal.decide", goalId: second.id, question: "是否周六上线？" });
  let current = (await service.read()).goals.find(goal => goal.id === second.id)!;
  assert.equal(current.attention, null);
  assert.match(current.next, /批准/);

  await service.execute({ type: "goal.decide", goalId: second.id, question: "是否删除旧数据？" });
  await service.execute({
    type: "goal.resolve", goalId: second.id, note: "拒绝删除旧数据。",
    outcome: "rejected", actor: "你", source: "desktop",
  });
  const third = await create(service, "再次询问删除");
  await service.execute({
    type: "goal.risk", goalId: third.id, category: "delete-data",
    summary: "删除旧数据库", actionKey: "是否删除旧数据？",
  });
  current = (await service.read()).goals.find(goal => goal.id === third.id)!;
  assert.equal(current.attention, null);
  assert.match(current.next, /拒绝/);

  const approved = await readFile(join(root, ".crewvane", "decisions.md"), "utf8");
  const rejected = await readFile(join(root, ".crewvane", "rejected.md"), "utf8");
  assert.match(approved, /批准周六上线/);
  assert.match(approved, /Herdr 注意力面板/);
  assert.match(rejected, /拒绝删除旧数据/);
  assert.match(rejected, /Crewvane 桌面/);
});

test("all mandatory high-risk actions escalate even when the project policy is automatic", async () => {
  const { service } = await fixture();
  const categories = [
    "delete-data", "stop-service", "spend-money", "external-message",
    "product-direction", "create-secret", "rotate-secret", "change-permissions",
    "change-ship-policy",
  ] as const;
  for (const policy of ["auto", "auto-merge-manual-deploy", "external-approval"] as const) {
    await setPolicy(service, "personal", policy);
    for (const category of categories) {
    const goal = await create(service, `${category} ${policy}`);
    await service.execute({
      type: "goal.risk", goalId: goal.id, category,
      summary: `执行 ${category}`, actor: "管家",
    });
    const saved = (await service.read()).goals.find(item => item.id === goal.id)!;
    assert.equal(saved.attention?.kind, "decision");
    assert.equal(saved.attention?.source, "governance");
    assert.match(saved.attention?.summary ?? "", /高风险动作必须由你确认/);
    assert.equal(attentionGoals([saved]).length, 1);
    }
  }
});

test("a risk raised on a waiting goal becomes an active decision and a human decision is handed back", async () => {
  const { service } = await fixture();
  const goal = await create(service, "等待中的权限变更");
  await service.execute({
    type: "goal.wait", goalId: goal.id, reason: "等 YR 返回",
    owner: "YR", remindAt: "2030-01-01T00:00:00Z",
  });
  await service.execute({
    type: "goal.risk", goalId: goal.id, category: "change-permissions",
    summary: "给生产环境增加一名管理员", actor: "管家",
  });
  let saved = (await service.read()).goals.find(item => item.id === goal.id)!;
  assert.equal(saved.status, "active");
  assert.equal(saved.waitingFor, undefined);
  assert.equal(saved.remindAt, undefined);
  assert.equal(saved.attention?.kind, "decision");

  await service.execute({
    type: "goal.resolve", goalId: goal.id,
    note: "只允许只读权限。", outcome: "approved",
    actor: "你", source: "herdr",
  });
  saved = (await service.read()).goals.find(item => item.id === goal.id)!;
  assert.equal(saved.status, "active");
  assert.equal(saved.waitingFor, undefined);
  assert.equal(saved.remindAt, undefined);
  assert.equal(saved.next, "你已批准：只允许只读权限。");
  assert.equal(saved.dispatch?.kind, "feedback");
  assert.equal(saved.dispatch?.status, "pending");
  assert.equal(saved.dispatch?.note, "你已批准：只允许只读权限。");
});

test("resolving a reminder without a decision still updates the next step", async () => {
  const { service } = await fixture();
  const goal = await create(service, "到点跟进");
  await service.execute({
    type: "goal.wait", goalId: goal.id, reason: "等 YR 回复",
    owner: "YR", remindAt: "2020-01-01T00:00:00Z",
  });
  await service.execute({
    type: "goal.resolve", goalId: goal.id,
    note: "YR 已回复，下一步整理结论。", actor: "你", source: "cli",
  });
  const saved = (await service.read()).goals.find(item => item.id === goal.id)!;
  assert.equal(saved.next, "YR 已回复，下一步整理结论。");
  assert.equal(saved.remindAt, undefined);
  assert.equal(saved.attention, null);
});

test("a fourth review submission is blocked and a human can authorize one more round", async () => {
  const { service } = await fixture();
  const item = await create(service, "限制审查轮次");
  const delivery = {
    summary: "实现完成",
    checks: [{ name: "回归", command: "pnpm test", result: "passed" as const }],
  };
  for (let round = 1; round <= 3; round++) {
    await service.execute({ type: "goal.review", goalId: item.id, delivery });
    assert.equal((await service.read()).goals[0]?.reviewRounds, round);
    await service.execute({ type: "goal.rework", goalId: item.id, note: `第 ${round} 轮意见` });
  }
  await service.execute({ type: "goal.review", goalId: item.id, delivery });
  let saved = (await service.read()).goals[0]!;
  assert.equal(saved.status, "active");
  assert.equal(saved.reviewRounds, 3);
  assert.equal(saved.attention?.kind, "intervention");
  assert.match(saved.attention?.summary ?? "", /3 轮上限/);

  await service.execute({
    type: "goal.resolve", goalId: item.id, note: "允许再审查一轮。",
    actor: "你", source: "desktop",
  });
  assert.equal((await service.read()).goals[0]?.reviewLimit, 4);
  await service.execute({ type: "goal.review", goalId: item.id, delivery });
  saved = (await service.read()).goals[0]!;
  assert.equal(saved.status, "review");
  assert.equal(saved.reviewRounds, 4);
});
