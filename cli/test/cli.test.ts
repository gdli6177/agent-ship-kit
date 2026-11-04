import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";
import { WorkspaceService, type Goal } from "../../packages/core/src/index.js";
const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(prefix: string) { const root = await mkdtemp(join(tmpdir(), prefix)); fixtures.push(root); return root; }
async function call(root: string, argv: string[]) {
  let stdout = "", stderr = "";
  const code = await run([...argv, "--root", root, "--json"], { out: (text) => { stdout += text; }, error: (text) => { stderr += text; } });
  return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) : undefined };
}
test("real CLI writes goals that desktop service can read", async () => {
  const root = await fixture("crewvane-cli-");
  const created = await call(root, ["goal", "create", "--title", "从 CLI 交给管家", "--project", "personal"]);
  assert.equal(created.code, 0, created.stderr);
  const item = created.json as Goal;
  const progress = await call(root, ["goal", "progress", item.id, "--summary", "方案已完成", "--next", "开始实现", "--stage", "build"]);
  assert.equal(progress.json.stageId, "build");
  assert.equal((await new WorkspaceService(root).read()).goals[0]?.next, "开始实现");
  await call(root, ["goal", "wait", item.id, "--reason", "等审批", "--owner", "YR", "--remind-at", "2030-01-01T00:00:00Z"]);
  assert.equal((await call(root, ["attention"])).json.length, 0);
  const review = await call(root, ["goal", "review", item.id, "--summary", "交付已就绪", "--check", "测试::pnpm test::passed::全部通过"]);
  assert.equal(review.json.status, "review");
  await call(root, ["goal", "rework", item.id, "--note", "补充边界验证"]);
  await call(root, ["goal", "review", item.id, "--summary", "已补齐", "--check", "测试::pnpm test::passed"]);
  assert.equal((await call(root, ["goal", "accept", item.id])).json.status, "completed");
  assert.equal((await call(root, ["goal", "show", item.id])).json.activities.length, 7);
});
test("CLI rejects incomplete or fabricated review records", async () => {
  const root = await fixture("crewvane-cli-invalid-");
  const created = await call(root, ["goal", "create", "--title", "检查证据", "--project", "personal"]);
  const result = await call(root, ["goal", "review", created.json.id, "--summary", "声称完成"]);
  assert.equal(result.code, 1); assert.match(result.stderr, /至少提供一个/);
});
test("CLI records a custom terminal transport and rejects missing process identity", async () => {
  const root = await fixture("crewvane-cli-custom-");
  const created = await call(root, ["goal", "create", "--title", "自定义 CLI", "--project", "personal"]);
  const missing = await call(root, ["session", "set", created.json.id, "--pane", "w1:p1", "--transport", "pane"]);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /前台进程 ID/);
  const valid = await call(root, ["session", "set", created.json.id, "--pane", "w1:p1", "--transport", "pane", "--process-id", "123"]);
  assert.equal(valid.code, 0);
  assert.equal((await new WorkspaceService(root).read()).goals[0]?.herdr?.processId, 123);
  const invalid = await call(root, ["session", "set", created.json.id, "--pane", "w1:p1", "--transport", "shell", "--process-id", "123"]);
  assert.equal(invalid.code, 1);
});
test("CLI creates a goal without requiring a project", async () => {
  const root=await fixture("crewvane-cli-no-project-");
  const result=await call(root,["goal","create","--title","直接交代一件事"]);
  assert.equal(result.code,0);
  assert.equal(result.json.projectId,"personal");
  assert.equal(result.json.owner,"待分配负责人");
});
test("spawned CLI updates an item and rejects a late update after cancellation", async () => {
  const root = await fixture("crewvane-cli-process-");
  const cli = (...args: string[]) => promisify(execFile)("pnpm", ["--dir", "cli", "exec", "tsx", "src/main.ts",
    ...args, "--root", root, "--json"], { cwd: new URL("../../", import.meta.url), timeout: 30_000 });
  const goal = JSON.parse((await cli("goal", "create", "--title", "真实进程调用", "--project", "personal")).stdout);
  await cli("goal", "update", goal.id, "--next", "等待审批", "--status", "waiting", "--remind-at", "2030-01-01T00:00:00Z");
  const state = await new WorkspaceService(root).read();
  assert.equal(state.goals[0]?.status, "waiting");
  assert.equal(state.goals[0]?.next, "等待审批");
  await cli("goal", "drop", goal.id, "--reason", "无需继续");
  await assert.rejects(() => cli("goal", "progress", goal.id, "--summary", "迟到写回"), /已结束/);
});
