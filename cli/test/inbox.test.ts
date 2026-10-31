import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addInboxItem, inboxFile, listInbox } from "../src/inbox.js";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-ship-inbox-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("inbox add appends a needs_review line and list reads it back", async () => {
  await withRoot(async (root) => {
    const added = await addInboxItem(root, {
      id: "evt_test_auth",
      title: "Auth middleware ready",
      summary: "Contract checks passed on the slice branch.",
      priority: "high",
      sourceTaskId: "task_auth_mw",
      evidenceUrls: ["https://ci.example/runs/1001"],
      links: {
        pr: "https://example.com/pull/12",
        path: ".agent-ship/packets/task_auth_mw.md",
      },
      createdAt: "2026-10-31T17:05:00.000Z",
    });

    assert.equal(added.type, "needs_review");
    assert.equal(added.priority, "high");
    assert.deepEqual(added.evidence_urls, ["https://ci.example/runs/1001"]);
    assert.equal(added.links.pr, "https://example.com/pull/12");
    assert.equal(added.links.issue, undefined);

    const raw = await readFile(inboxFile(root), "utf8");
    assert.equal(raw.endsWith("\n"), true);
    assert.equal(raw.trim().split("\n").length, 1);
    assert.equal(JSON.parse(raw).id, "evt_test_auth");

    const listed = await listInbox(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.source_task_id, "task_auth_mw");

    const high = await listInbox(root, "high");
    const normal = await listInbox(root, "normal");
    assert.equal(high.length, 1);
    assert.equal(normal.length, 0);
  });
});

test("inbox list is empty when the file does not exist", async () => {
  await withRoot(async (root) => {
    assert.deepEqual(await listInbox(root), []);
  });
});

test("inbox rejects a duplicate id and a blank title", async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      () => addInboxItem(root, { title: "  ", summary: "x", sourceTaskId: "task_1" }),
      /title is required/,
    );
    await addInboxItem(root, {
      id: "evt_once",
      title: "First",
      summary: "One line.",
      sourceTaskId: "task_1",
    });
    await assert.rejects(
      () =>
        addInboxItem(root, {
          id: "evt_once",
          title: "Again",
          summary: "Duplicate.",
          sourceTaskId: "task_1",
        }),
      /already contains/,
    );
  });
});
