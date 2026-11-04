import test from "node:test";
import assert from "node:assert/strict";
import { CoordinatorQueue } from "../electron/coordinator-queue.ts";

test("serializes one workspace while allowing separate workspaces to proceed", async () => {
  const queue = new CoordinatorQueue(), events: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  const first = queue.run("workspace-a", async () => {
    events.push("a1:start");
    await firstBlocked;
    events.push("a1:end");
  });
  const second = queue.run("workspace-a", async () => {
    events.push("a2:start");
    events.push("a2:end");
  });
  const other = queue.run("workspace-b", async () => {
    events.push("b1:end");
  });

  await other;
  assert.deepEqual(events, ["a1:start", "b1:end"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a1:start", "b1:end", "a1:end", "a2:start", "a2:end"]);
});

test("a failed notification does not block the next case", async () => {
  const queue = new CoordinatorQueue(), events: string[] = [];
  await assert.rejects(queue.run("workspace", async () => {
    events.push("failed");
    throw new Error("offline");
  }), /offline/);
  await queue.run("workspace", async () => { events.push("next"); });
  assert.deepEqual(events, ["failed", "next"]);
});
