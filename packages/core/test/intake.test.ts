import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService, type Goal } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("one natural-language request preserves the full request without a workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-intake-")); roots.push(root);
  const service = new WorkspaceService(root);
  const request = "修复等待审批后无法继续的问题\nYR 已通过，验证真实通知管家和负责人。";
  const goal = await service.execute({ type: "goal.intake", text: request }) as Goal;
  assert.equal(goal.title, "修复等待审批后无法继续的问题");
  assert.equal(goal.description, request);
  assert.equal(goal.projectId, "personal");
  assert.deepEqual(goal.steps, []);
  assert.equal(goal.activities[0]?.text, request);
  assert.equal(goal.mode, "concierge");
  assert.equal(goal.owner, "待分配负责人");
});

test("project context is preserved when already selected; an unknown project is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-intake-project-")); roots.push(root);
  const service = new WorkspaceService(root);
  const project = await service.execute({ type: "project.add", name: "Crewvane" }) as { id: string };
  const goal = await service.execute({ type: "goal.intake", text: "修复目标创建", projectId: project.id }) as Goal;
  assert.equal(goal.projectId, project.id);
  await assert.rejects(service.execute({ type: "goal.intake", text: "其他事", projectId: "missing" }), /有效项目/);
});

test("taking over a new goal prevents new or late concierge dispatch receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-intake-takeover-")); roots.push(root);
  const service = new WorkspaceService(root);
  const goal = await service.execute({ type: "goal.intake", text: "先记录，再由我亲自处理" }) as Goal;
  await service.execute({ type: "goal.dispatch", goalId: goal.id, status: "pending", requestId: "handoff-before-takeover" });
  const taken = await service.execute({ type: "goal.takeover", goalId: goal.id }) as Goal;
  assert.equal(taken.mode, "manual");
  assert.equal(taken.status, "active");
  assert.equal(taken.owner, "你");
  assert.equal(taken.dispatch, undefined);
  assert.equal(taken.attention, null);
  await assert.rejects(service.execute({ type: "goal.dispatch", goalId: goal.id, status: "pending" }), /由你接管/);
  await service.execute({ type: "goal.dispatch", goalId: goal.id, status: "sent", requestId: "handoff-before-takeover" });
  assert.equal((await service.read()).goals[0]?.dispatch, undefined);
});

test("an intake request beginning with a newline still has a title", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-intake-title-")); roots.push(root);
  const service = new WorkspaceService(root);
  const goal = await service.execute({ type: "goal.intake", text: "\n\n整理今天所有的事情" }) as Goal;
  assert.equal(goal.title, "整理今天所有的事情");
});

test("human feedback replaces an in-flight notification and can be handed back to the concierge", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-intake-feedback-")); roots.push(root);
  const service = new WorkspaceService(root);
  const goal = await service.execute({ type: "goal.intake", text: "先理解目标" }) as Goal;
  await service.execute({ type: "goal.dispatch", goalId: goal.id, status: "pending", requestId: "initial" });
  const updated = await service.execute({
    type: "goal.message", goalId: goal.id, text: "保留现有范围",
  }) as Goal;
  assert.equal(updated.dispatch?.kind, "feedback");
  assert.notEqual(updated.dispatch?.id, "initial");
  await service.execute({ type: "goal.dispatch", goalId: goal.id, status: "sent", requestId: "initial" });
  assert.equal((await service.read()).goals[0]?.dispatch?.status, "pending");
  await service.execute({ type: "goal.takeover", goalId: goal.id });
  const delegated = await service.execute({ type: "goal.delegate", goalId: goal.id }) as Goal;
  assert.equal(delegated.mode, "concierge");
  assert.equal(delegated.dispatch?.status, "pending");
});
