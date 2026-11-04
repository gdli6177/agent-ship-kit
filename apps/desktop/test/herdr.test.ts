import test from "node:test";
import assert from "node:assert/strict";
import { HerdrClient, terminalPrompt, type HerdrRunner } from "../electron/herdr.ts";

function fake(responses: Record<string, string>) {
  const calls: string[][] = [];
  const runner: HerdrRunner = { async run(args) {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const value = responses[key] ?? responses[args[0]!];
    if (value === undefined) throw new Error(`unexpected Herdr call ${key}`);
    if (value.startsWith("!")) throw new Error(value.slice(1));
    return value;
  } };
  return { calls, runner };
}

test("reuses only a persisted control-plane concierge", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "concierge", agent_status: "idle", workspace_id: "w7", tab_id: "w7:t1", pane_id: "w7:p1",
    }] } }),
  });
  const reference = await new HerdrClient(mock.runner, "crewvane-test").prepareConcierge(
    "/tmp/workspace",
    {
      session: "crewvane-test", workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1",
      agent: "concierge", launchPolicy: "control-plane-v1",
    },
  );
  assert.deepEqual(reference, {
    session: "crewvane-test", workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1",
    agent: "concierge", launchPolicy: "control-plane-v1",
  });
  assert.equal(mock.calls.some((args) => args[0] === "workspace"), false);
  assert.equal(mock.calls.some((args) => args[0] === "agent" && args[1] === "start"), false);
});

test("closes an orphaned concierge without a governed launch reference", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "concierge", agent_status: "idle", workspace_id: "w7", tab_id: "w7:t1", pane_id: "w7:p1",
    }] } }),
    "tab close": "{}",
  });
  const reference = await new HerdrClient(mock.runner, "crewvane-test").findConcierge();
  assert.equal(reference, undefined);
  assert.deepEqual(mock.calls.at(-1), ["tab", "close", "w7:t1"]);
});

test("closes an old ungoverned concierge once before rebuilding the control plane", async () => {
  const mock = fake({
    "tab close": "{}",
    "agent list": JSON.stringify({ result: { agents: [{
      name: "concierge", agent_status: "idle", workspace_id: "w7", tab_id: "w7:t1", pane_id: "w7:p1",
    }] } }),
  });
  const reference = await new HerdrClient(mock.runner, "crewvane-test").findConcierge({
    session: "crewvane-test", workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1", agent: "concierge",
  });
  assert.equal(reference, undefined);
  assert.deepEqual(mock.calls, [["agent", "list"], ["tab", "close", "w7:t1"]]);
});

test("new goals notify the same concierge without creating an owner or another session", async () => {
  const mock = fake({ "agent prompt": "{}" });
  const client = new HerdrClient(mock.runner, "crewvane-test");
  const reference = { session: "crewvane-test", agent: "concierge" };
  await client.notifyGoal(reference, "goal_one", "事项一");
  await client.notifyGoal(reference, "goal_two", "事项二");
  await client.notifyGoal(reference, "goal_three", "事项三", {
    id: "goal_three", projectId: "personal", title: "事项三",
    description: "完整原文\n保留全部约束", mode: "concierge", status: "active",
    steps: [{ id: "intake", name: "待管家梳理", prompt: "先整理，再分发" }], stageId: "intake",
    next: "管家正在整理", owner: "待分配负责人", attention: null,
    activities: [{ id: "activity", at: new Date().toISOString(), actor: "你", kind: "created", text: "完整原文\n保留全部约束" }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.every(args => args.slice(0, 3).join(" ") === "agent prompt concierge"));
  assert.match(mock.calls[0]![3]!, /goal_one/);
  assert.match(mock.calls[1]![3]!, /goal_two/);
  for (const args of mock.calls) {
    assert.match(args[3]!, /不亲自执行目标/);
    assert.match(args[3]!, /整理后交给本目标独立负责人/);
    assert.match(args[3]!, /退回修改转交原负责人/);
    assert.match(args[3]!, /向人交接/);
    assert.equal((args[3]!.match(/\[CREWVANE_CASE_BEGIN\]/g) ?? []).length, 1);
    assert.equal((args[3]!.match(/\[CREWVANE_CASE_END\]/g) ?? []).length, 1);
  }
  assert.match(mock.calls[2]![3]!, /完整原文\\n保留全部约束/);
  assert.match(mock.calls[2]![3]!, /待管家梳理/);
  assert.ok(mock.calls.every(args => args.includes("--wait") && args.includes("--timeout")));
});

test("watchdog keeps recovery with owners instead of asking the concierge to execute", async () => {
  const mock = fake({ "agent prompt": "{}" });
  await new HerdrClient(mock.runner, "crewvane-test").notifyWatchdog(
    { session: "crewvane-test", agent: "concierge" }, [
      { goalId: "goal_blocked", reason: "blocked" },
      { goalId: "goal_stale", reason: "stale" },
    ],
  );
  assert.equal(mock.calls.length, 2);
  for (const [index, goalId] of ["goal_blocked", "goal_stale"].entries()) {
    const message = mock.calls[index]![3]!;
    assert.match(message, new RegExp(goalId));
    assert.match(message, /不亲自执行目标/);
    assert.match(message, /联系其他负责人协调恢复/);
    assert.match(message, /不能自己接手执行/);
    assert.equal((message.match(/case_id:/g) ?? []).length, 1);
    assert.doesNotMatch(message, /能处理的由你处理/);
  }
  assert.doesNotMatch(mock.calls[0]![3]!, /goal_stale/);
  assert.doesNotMatch(mock.calls[1]![3]!, /goal_blocked/);
});
test("resumed concierge receives current role instructions without starting another agent", async () => {
  const mock=fake({"agent prompt":"{}"});
  await new HerdrClient(mock.runner,"test").refreshConcierge(
    {session:"test",agent:"concierge",paneId:"w1:p1"},"/workspace",{concierge:"codex",owner:"custom-cli"},
  );
  assert.equal(mock.calls.length,1);
  assert.deepEqual(mock.calls[0]!.slice(0,3),["agent","prompt","concierge"]);
  assert.match(mock.calls[0]![3]!,/不亲自执行目标/);
  assert.match(mock.calls[0]![3]!,/custom-cli/);
  assert.doesNotMatch(mock.calls[0]![3]!,/Codex 负责人使用 workspace-write/);
});

test("surfaces a stopped server without inventing a session", async () => {
  const mock = fake({ "agent list": '!Herdr agent list：{"error":"server_not_running"}' });
  await assert.rejects(
    () => new HerdrClient(mock.runner, "crewvane-test").prepareConcierge("/tmp/workspace"),
    /server_not_running/,
  );
});

test("starts one replacement only after a stale pane is rejected", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [] } }),
    "pane get": '!Herdr pane get：{"error":"pane_not_found"}',
    "workspace create": JSON.stringify({ result: {
      workspace: { workspace_id: "w8" }, tab: { tab_id: "w8:t1" }, root_pane: { pane_id: "w8:p1" },
    } }),
    "pane run": "{}", "pane wait-output": "{}", "agent start": "{}", "agent prompt": "{}",
    "tab close": "{}", "tab focus": "{}",
  });
  const reference = await new HerdrClient(mock.runner, "crewvane-test").prepareConcierge(
    "/tmp/workspace",
    { session: "crewvane-test", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agent: "concierge" },
    "codex",
    "/tmp/bin",
    "/home/test/.local/bin",
    "/home/test/.local/bin",
  );
  assert.equal(reference.paneId, "w8:p1");
  assert.equal(mock.calls.filter((args) => args[0] === "workspace" && args[1] === "create").length, 1);
  const start = mock.calls.find((args) => args[0] === "agent" && args[1] === "start");
  assert.deepEqual(start?.slice(0, 6), ["agent", "start", "concierge", "--kind", "codex", "--pane"]);
  assert.ok(mock.calls.some(args => args[0] === "tab" && args[1] === "close" && args[2] === "w1:t1"));
  assert.ok(!start?.includes("workspace-write"));
  assert.ok(!start?.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(!start?.includes("danger-full-access"));
  const instructions = mock.calls.find(args => args[0] === "agent" && args[1] === "prompt")?.[3];
  assert.match(instructions!, /不亲自执行目标/);
  assert.match(instructions!, /不能因为任务简单而自己执行/);
  assert.match(instructions!, /由负责人产出真实成果、实际运行检查/);
  assert.match(instructions!, /crewvane direct --new/);
  assert.match(instructions!, /不能在终端里处理完却不写回 App/);
  assert.doesNotMatch(instructions!, /简单事项你可以自己完成/);
});

test("custom commands start in the real pane, preserve argv and reuse the recorded foreground process", async () => {
  const mock = fake({
    "agent list": '{"result":{"agents":[]}}',
    "workspace create": '{"result":{"workspace":{"workspace_id":"w8"},"tab":{"tab_id":"w8:t1"},"root_pane":{"pane_id":"w8:p1"}}}',
    "pane run": "{}", "pane wait-output": "{}", "tab focus": "{}",
    "pane process-info": '{"result":{"process_info":{"shell_pid":12,"foreground_processes":[{"pid":42,"name":"custom-cli"}]}}}',
  });
  const client = new HerdrClient(mock.runner, "custom-session");
  const reference = await client.prepareConcierge("/workspace", undefined, "", "/cli", "/bin", "/agents",
    undefined, { concierge: 'custom-cli --model "custom model"' }, ["--model", "custom model"], "/agents/custom-cli");
  assert.equal(reference.transport, "pane"); assert.equal(reference.processId, 42);
  assert.ok(mock.calls.some(args => args[0] === "pane" && args[3] === "'/agents/custom-cli' '--model' 'custom model'"));
  assert.ok(!mock.calls.some(args => args[0] === "agent" && args[1] === "start"));
  assert.equal((await client.prepareConcierge("/workspace", reference)).processId, 42);
  await client.notifyGoal(reference, "g1", "目标");
  assert.equal(mock.calls.filter(args => args[0] === "workspace" && args[1] === "create").length, 1);
  assert.ok(mock.calls.some(args => args[0] === "pane" && args[1] === "run" && args[3]?.includes("g1")));
  const messages = mock.calls.filter(args => args[0] === "pane" && args[1] === "run" && args[3]?.includes("不亲自执行目标"));
  assert.equal(messages.length, 2, "both initial instructions and a reused custom CLI receive the role boundary");
});

test("custom command exit or a replaced foreground process never receives task text", async () => {
  for (const foreground_processes of [[], [{ pid: 99 }]]) {
    const mock = fake({ "pane process-info": JSON.stringify({ result: { process_info: { shell_pid: 12, foreground_processes } } }) });
    const client = new HerdrClient(mock.runner);
    await assert.rejects(client.notifyGoal({ session: "crewvane", paneId: "w1:p1", transport: "pane", processId: 42 }, "g1", "任务"), /已退出或现场已更换/);
    assert.ok(!mock.calls.some(args => args[1] === "run"), "never send instructions to an idle shell or replacement program");
  }
});
test("custom CLI prompt fits canonical terminal lines and preserves Unicode content", () => {
  const text = "长提示词✨".repeat(400);
  const wrapped = terminalPrompt(text);
  assert.equal(wrapped.replaceAll("\n", ""), text);
  assert.ok(wrapped.split("\n").every(line => Buffer.byteLength(line) <= 768));
});
