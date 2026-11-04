import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceService,
  type Goal,
} from "../../../packages/core/src/index.ts";
import { presentGoal } from "../src/features/goals/goalPresentation.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "crewvane-goal-presentation-"));
}

test("dispatch failure is presented as contact failure, not owner intervention", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "离线派发",
      projectId: "personal",
      mode: "concierge",
    },
  }) as Goal;
  await service.execute({
    type: "goal.dispatch",
    goalId: goal.id,
    status: "failed",
    requestId: goal.dispatch!.id,
    detail: "管家暂时不可达",
  });

  const state = await service.read();
  const current = state.goals.find((item) => item.id === goal.id)!;
  const view = presentGoal(current, state);
  assert.equal(view.dispatchFailed, true);
  assert.equal(view.needsIntervention, false);
  assert.equal(view.label, "联系管家失败");
  assert.equal(view.tone, "blocked");
});

test("the latest raw message and its attachments remain visible without changing status", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "消息详情",
      projectId: "personal",
      mode: "manual",
      next: "按原计划继续",
    },
  }) as Goal;
  await service.execute({
    type: "goal.message",
    goalId: goal.id,
    text: "只补充背景，不改下一步。",
  });

  const state = await service.read();
  const current = state.goals.find((item) => item.id === goal.id)!;
  const view = presentGoal(current, state);
  assert.equal(view.latest?.kind, "message");
  assert.equal(view.latest?.text, "只补充背景，不改下一步。");
  assert.equal(current.next, "按原计划继续");
  assert.equal(current.status, "waiting");
});

test("a manual active goal is presented as owned by the human", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "人工推进",
      projectId: "personal",
      mode: "concierge",
      next: "整理结论后提交",
    },
  }) as Goal;
  await service.execute({ type: "goal.takeover", goalId: goal.id });

  const state = await service.read();
  const current = state.goals.find((item) => item.id === goal.id)!;
  const view = presentGoal(current, state);
  assert.equal(current.mode, "manual");
  assert.equal(view.label, "由你处理");
  assert.match(view.detail, /提交成果/);
});
