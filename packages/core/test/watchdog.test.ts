import test from "node:test";
import assert from "node:assert/strict";
import { inspectWatchdog, reportWatchdog } from "../src/watchdog.js";
import { attentionGoals, type Goal } from "../src/index.js";
const start = "2030-01-01T08:00:00.000Z";
const after = (minutes: number) => new Date(Date.parse(start) + minutes * 60_000).toISOString();
function goal(): Goal {
  return { id: "goal_test", projectId: "personal", title: "巡检事项", description: "", mode: "concierge",
    status: "active", steps: [], next: "推进", owner: "负责人", attention: null,
    activities: [{ id: "created", kind: "created", at: start, actor: "你", text: "已交代事项" }],
    createdAt: start, updatedAt: start };
}
test("no-progress check contacts concierge first, deduplicates, and escalates only after no recovery", () => {
  const item = goal();
  assert.deepEqual(inspectWatchdog([item], after(29)), []);
  const [request] = inspectWatchdog([item], after(31));
  assert.equal(request?.reason, "stale");
  assert.equal(attentionGoals([item], Date.parse(after(31))).length, 0);
  reportWatchdog(item, after(31), request!.basis, "contacted");
  assert.deepEqual(inspectWatchdog([item], after(32)), []);
  assert.equal(item.attention, null);
  assert.deepEqual(inspectWatchdog([item], after(41)), []);
  assert.equal(structuredClone(item).attention?.source, "watchdog");
  const count = item.activities.length;
  inspectWatchdog([item], after(42));
  assert.equal(item.activities.length, count);
});
test("blocked or missing owner is checked without treating idle or waiting as failure", () => {
  const item = goal();
  item.live = { state: "idle", checkedAt: start };
  assert.deepEqual(inspectWatchdog([item], after(1)), []);
  item.live = { state: "blocked", checkedAt: after(1), reachable: true };
  assert.equal(inspectWatchdog([item], after(1))[0]?.reason, "blocked");
  assert.equal(item.attention, null);
  item.live = { state: "unknown", checkedAt: after(2), reachable: false };
  assert.equal(inspectWatchdog([item], after(2))[0]?.reason, "missing");
  item.status = "waiting"; item.remindAt = after(60);
  assert.deepEqual(inspectWatchdog([item], after(40)), []);
  assert.equal(item.attention, null);
});
test("an unreachable concierge becomes actionable, and successful retry clears only its own failure", () => {
  const item = goal(), [request] = inspectWatchdog([item], after(31));
  reportWatchdog(item, after(31), request!.basis, "failed", "会话未运行");
  assert.equal(item.attention?.kind, "intervention");
  assert.deepEqual(inspectWatchdog([item], after(31.5)), []);
  assert.equal(inspectWatchdog([item], after(32)).length, 1);
  reportWatchdog(item, after(32), request!.basis, "contacted");
  assert.equal(item.attention, null);
  item.attention = { kind: "decision", summary: "范围由人决定", since: after(33) };
  reportWatchdog(item, after(33), request!.basis, "failed", "再度断线");
  assert.equal(item.attention.kind, "decision");
});
test("late patrol replies cannot override fresh progress or completed work", () => {
  const item = goal(), [request] = inspectWatchdog([item], after(31));
  item.activities.push({ id: "progress", kind: "progress", at: after(32), actor: "负责人", text: "检查已通过" });
  reportWatchdog(item, after(33), request!.basis, "failed", "旧请求失败");
  assert.equal(item.attention, null);
  assert.deepEqual(inspectWatchdog([item], after(33)), []);
  assert.equal(item.watchdog, undefined);
  item.status = "completed";
  assert.deepEqual(inspectWatchdog([item], after(90)), []);
});
