import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachmentAbsolutePath,
  importAttachmentBytes,
  WorkspaceService,
  type Goal,
} from "../src/index.js";

const roots: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAVUlEQVR4nGPUMIr6z4AEAqKWInMZNiyLZqClPBPDAAOmEe8Axoqe///pGefo8kwMAwyYRrwDGEfLAYaR7gDG0XKAYaQ7gHG0HGAY6Q5gHC0HGEa6AwC58E1KmpVcaAAAAABJRU5ErkJggg==",
  "base64",
);
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

test("imports images with a stable workspace-relative path and private file mode", async () => {
  const root = await fixture("crewvane-attachment-import-"),
    [attachment] = await importAttachmentBytes(root, [{ name: "../../截图.png", bytes: png }]);
  assert.ok(attachment);
  assert.equal(attachment.name, "截图.png");
  assert.equal(attachment.mime, "image/png");
  assert.equal(attachment.size, png.length);
  assert.match(attachment.path, /^\.crewvane\/attachments\/att_[a-f0-9]{16}\.png$/);
  assert.match(attachment.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await stat(attachmentAbsolutePath(root, attachment))).mode & 0o777, 0o600);
});

test("rejects fake images, oversized files, and paths outside the attachment directory", async () => {
  const root = await fixture("crewvane-attachment-reject-");
  await assert.rejects(
    importAttachmentBytes(root, [{ name: "fake.png", bytes: Buffer.from("not an image"), mime: "image/png" }]),
    /不是支持的/,
  );
  await assert.rejects(
    importAttachmentBytes(root, [{ name: "large.png", bytes: Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]) }]),
    /不能超过/,
  );
  const [valid] = await importAttachmentBytes(root, [{ name: "valid.png", bytes: png }]);
  const service = new WorkspaceService(root);
  await assert.rejects(service.execute({
    type: "goal.intake",
    text: "路径穿越",
    attachments: [{ ...valid!, path: ".crewvane/attachments/../state.json" }],
  }), /附件路径无效/);
});

test("goal intake and terminal follow-ups retain image metadata without embedding bytes", async () => {
  const root = await fixture("crewvane-attachment-goal-"),
    service = new WorkspaceService(root),
    [first, second] = await importAttachmentBytes(root, [
      { name: "first.png", bytes: png },
      { name: "second.png", bytes: png },
    ]);
  const goal = await service.execute({
    type: "goal.intake",
    text: "根据这两张图整理问题",
    attachments: [first!],
  }) as Goal;
  assert.deepEqual(goal.attachments, [first]);
  const followed = await service.execute({
    type: "goal.direct",
    goalId: goal.id,
    text: "再补充一张",
    attachments: [second!],
  }) as Goal;
  assert.deepEqual(followed.attachments, [first, second]);
  assert.match(followed.activities.at(-1)!.text, /second\.png/);
  const [third] = await importAttachmentBytes(root, [{ name: "third.png", bytes: png }]);
  const directNew = await service.execute({
    type: "goal.direct",
    text: "从终端新建并带图",
    attachments: [third!],
  }) as Goal;
  assert.deepEqual(directNew.attachments, [third]);
  const stateText = await readFile(join(root, ".crewvane", "state.json"), "utf8");
  assert.doesNotMatch(stateText, /iVBORw0KGgo|data:image|base64/i);
});

test("expired ended-goal images are deleted while active and recent images remain", async () => {
  const root = await fixture("crewvane-attachment-cleanup-"),
    service = new WorkspaceService(root),
    [expired, active] = await importAttachmentBytes(root, [
      { name: "expired.png", bytes: png },
      { name: "active.png", bytes: png },
    ]);
  const ended = await service.execute({
    type: "goal.intake", text: "已结束", attachments: [expired!],
  }) as Goal;
  await service.execute({ type: "goal.takeover", goalId: ended.id });
  await service.execute({
    type: "goal.review",
    goalId: ended.id,
    actor: "owner",
    delivery: {
      summary: "完成",
      checks: [{ name: "读取", command: "cat result", result: "passed" }],
    },
  });
  await service.execute({ type: "goal.accept", goalId: ended.id });
  await service.execute({
    type: "goal.intake", text: "仍在进行", attachments: [active!],
  });
  const at = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
    result = await service.execute({ type: "attachments.cleanup", retentionDays: 30, at }) as { removed: number };
  assert.equal(result.removed, 1);
  await assert.rejects(access(attachmentAbsolutePath(root, expired!)));
  await access(attachmentAbsolutePath(root, active!));
  const state = await service.read();
  assert.equal(state.goals.find(goal => goal.id === ended.id)?.attachments, undefined);
  assert.equal(state.goals.find(goal => goal.status === "active")?.attachments?.length, 1);
});

test("a person can remove one image immediately and its metadata is removed atomically", async () => {
  const root = await fixture("crewvane-attachment-remove-"),
    service = new WorkspaceService(root),
    [attachment] = await importAttachmentBytes(root, [{ name: "remove.png", bytes: png }]),
    goal = await service.execute({
      type: "goal.intake", text: "删除单张", attachments: [attachment!],
    }) as Goal;
  await service.execute({
    type: "goal.attachment.remove",
    goalId: goal.id,
    attachmentId: attachment!.id,
    actor: "你",
  });
  assert.equal((await service.read()).goals[0]?.attachments, undefined);
  await assert.rejects(access(attachmentAbsolutePath(root, attachment!)));
  assert.equal((await service.read()).goals[0]?.activities.at(-1)?.text, "已删除图片：remove.png");
});

test("only ended goals can be permanently deleted, including their image files", async () => {
  const root = await fixture("crewvane-goal-delete-"),
    service = new WorkspaceService(root),
    [attachment] = await importAttachmentBytes(root, [{ name: "ended.png", bytes: png }]),
    goal = await service.execute({
      type: "goal.intake", text: "完成后可删除", attachments: [attachment!],
    }) as Goal;
  await assert.rejects(
    service.execute({ type: "goal.delete", goalId: goal.id, actor: "你" }),
    /只有已完成或已放弃/,
  );
  await service.execute({ type: "goal.takeover", goalId: goal.id });
  await service.execute({
    type: "goal.review",
    goalId: goal.id,
    actor: "owner",
    delivery: {
      summary: "完成",
      checks: [{ name: "读取", command: "cat result", result: "passed" }],
    },
  });
  await service.execute({ type: "goal.accept", goalId: goal.id });
  assert.deepEqual(await service.execute({
    type: "goal.delete", goalId: goal.id, actor: "你",
  }), { deleted: goal.id });
  assert.equal((await service.read()).goals.length, 0);
  await assert.rejects(access(attachmentAbsolutePath(root, attachment!)));
});
