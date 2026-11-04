import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, posix, relative, resolve } from "node:path";
import { newId } from "./model.js";
import type { GoalAttachment } from "./types.js";

export const ATTACHMENT_LIMITS = {
  count: 8,
  bytesPerFile: 10 * 1024 * 1024,
  bytesTotal: 30 * 1024 * 1024,
} as const;

const formats = {
  png: { mime: "image/png", extension: "png" },
  jpeg: { mime: "image/jpeg", extension: "jpg" },
  webp: { mime: "image/webp", extension: "webp" },
  gif: { mime: "image/gif", extension: "gif" },
} as const;

type ImageFormat = (typeof formats)[keyof typeof formats];
const formatByMime = new Map<string, ImageFormat>(
  Object.values(formats).map(format => [format.mime, format]),
);

export interface AttachmentBytesInput {
  name: string;
  bytes: Uint8Array | ArrayBuffer;
  mime?: string;
}

function asBuffer(value: unknown): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("图片内容无效");
}

export function detectImageFormat(value: Uint8Array | ArrayBuffer): ImageFormat | undefined {
  const bytes = asBuffer(value);
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return formats.png;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return formats.jpeg;
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return formats.gif;
  }
  if (bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP") return formats.webp;
  return undefined;
}

function displayName(value: unknown, format: ImageFormat): string {
  if (typeof value !== "string") throw new Error("图片名称无效");
  const leaf = basename(value.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 180);
  return leaf || `图片.${format.extension}`;
}

function assertByteLimits(inputs: AttachmentBytesInput[], buffers: Buffer[]) {
  if (!inputs.length) throw new Error("至少选择一张图片");
  if (inputs.length > ATTACHMENT_LIMITS.count)
    throw new Error(`每个目标最多添加 ${ATTACHMENT_LIMITS.count} 张图片`);
  let total = 0;
  for (const [index, buffer] of buffers.entries()) {
    if (!buffer.length) throw new Error(`图片「${inputs[index]?.name || "未命名"}」为空`);
    if (buffer.length > ATTACHMENT_LIMITS.bytesPerFile)
      throw new Error(`单张图片不能超过 ${ATTACHMENT_LIMITS.bytesPerFile / 1024 / 1024} MB`);
    total += buffer.length;
  }
  if (total > ATTACHMENT_LIMITS.bytesTotal)
    throw new Error(`图片总计不能超过 ${ATTACHMENT_LIMITS.bytesTotal / 1024 / 1024} MB`);
}

async function attachmentDirectory(root: string) {
  const owner = await realpath(root), state = join(owner, ".crewvane");
  await mkdir(state, { recursive: true });
  if ((await lstat(state)).isSymbolicLink()) throw new Error("状态目录不能是符号链接");
  const directory = join(state, "attachments");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("附件目录不能是符号链接");
  return { owner, directory };
}

export function attachmentAbsolutePath(root: string, attachment: Pick<GoalAttachment, "path">): string {
  if (typeof attachment.path !== "string" || !attachment.path.startsWith(".crewvane/attachments/"))
    throw new Error("附件路径不在工作区附件目录中");
  const base = resolve(root, ".crewvane/attachments"), path = resolve(root, attachment.path),
    rel = relative(base, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("附件路径不在工作区附件目录中");
  return path;
}

export async function importAttachmentBytes(root: string, inputs: AttachmentBytesInput[]): Promise<GoalAttachment[]> {
  if (!Array.isArray(inputs)) throw new Error("图片列表无效");
  const buffers = inputs.map(input => asBuffer(input?.bytes));
  assertByteLimits(inputs, buffers);

  const prepared = inputs.map((input, index) => {
    const bytes = buffers[index]!, format = detectImageFormat(bytes);
    if (!format) throw new Error(`「${input.name || "未命名图片"}」不是支持的 PNG、JPEG、WebP 或 GIF 图片`);
    const id = newId("att");
    return {
      bytes, id, format, metadata: {
        id,
        name: displayName(input.name, format),
        path: posix.join(".crewvane", "attachments", `${id}.${format.extension}`),
        mime: format.mime,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        addedAt: new Date().toISOString(),
      } satisfies GoalAttachment,
    };
  });

  const { directory } = await attachmentDirectory(root), written: string[] = [];
  try {
    for (const item of prepared) {
      const temporary = join(directory, `.${item.id}.tmp`);
      await writeFile(temporary, item.bytes, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, join(directory, `${item.id}.${item.format.extension}`));
      written.push(join(directory, `${item.id}.${item.format.extension}`));
    }
    return prepared.map(item => item.metadata);
  } catch (error) {
    await Promise.all(written.map(path => rm(path, { force: true })));
    throw error;
  }
}

export async function importAttachmentFiles(root: string, paths: string[]): Promise<GoalAttachment[]> {
  if (!Array.isArray(paths) || !paths.length) return [];
  if (paths.length > ATTACHMENT_LIMITS.count)
    throw new Error(`每个目标最多添加 ${ATTACHMENT_LIMITS.count} 张图片`);
  const inputs = await Promise.all(paths.map(async value => {
    if (typeof value !== "string" || !value.trim()) throw new Error("附件路径不能为空");
    const path = resolve(value);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new Error(`找不到图片：${path}`);
      throw error;
    });
    if (!info.isFile()) throw new Error(`附件不是普通文件：${path}`);
    return { name: basename(path), bytes: await readFile(path) };
  }));
  return importAttachmentBytes(root, inputs);
}

function normalizedMetadata(value: unknown): GoalAttachment {
  if (!value || typeof value !== "object") throw new Error("附件记录无效");
  const item = value as Partial<GoalAttachment>;
  if (typeof item.id !== "string" || !/^att_[a-f0-9]{16}$/.test(item.id))
    throw new Error("附件 ID 无效");
  if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 180 || /[\x00-\x1f\x7f]/.test(item.name))
    throw new Error("附件名称无效");
  const format = typeof item.mime === "string" ? formatByMime.get(item.mime) : undefined;
  if (!format) throw new Error("附件类型无效");
  const expectedPath = posix.join(".crewvane", "attachments", `${item.id}.${format.extension}`);
  if (item.path !== expectedPath) throw new Error("附件路径无效");
  if (!Number.isSafeInteger(item.size) || item.size! < 1 || item.size! > ATTACHMENT_LIMITS.bytesPerFile)
    throw new Error("附件大小无效");
  if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))
    throw new Error("附件摘要无效");
  if (typeof item.addedAt !== "string" || !Number.isFinite(Date.parse(item.addedAt)))
    throw new Error("附件时间无效");
  return {
    id: item.id,
    name: item.name.trim(),
    path: expectedPath,
    mime: format.mime,
    size: item.size!,
    sha256: item.sha256,
    addedAt: new Date(item.addedAt).toISOString(),
  };
}

export async function validateGoalAttachments(root: string, values: unknown): Promise<GoalAttachment[]> {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new Error("附件列表无效");
  if (values.length > ATTACHMENT_LIMITS.count)
    throw new Error(`每个目标最多添加 ${ATTACHMENT_LIMITS.count} 张图片`);
  const attachments = values.map(normalizedMetadata);
  if (new Set(attachments.map(item => item.id)).size !== attachments.length ||
    new Set(attachments.map(item => item.path)).size !== attachments.length)
    throw new Error("附件不能重复");
  const total = attachments.reduce((sum, item) => sum + item.size, 0);
  if (total > ATTACHMENT_LIMITS.bytesTotal)
    throw new Error(`图片总计不能超过 ${ATTACHMENT_LIMITS.bytesTotal / 1024 / 1024} MB`);
  await attachmentDirectory(root);
  for (const item of attachments) {
    const path = attachmentAbsolutePath(root, item), info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`附件文件不存在或无效：${item.name}`);
    if (info.size !== item.size) throw new Error(`附件大小已变化：${item.name}`);
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (digest !== item.sha256) throw new Error(`附件内容已变化：${item.name}`);
  }
  return attachments;
}

export async function removeAttachmentFiles(root: string, values: Pick<GoalAttachment, "path">[]): Promise<void> {
  if (!values.length) return;
  await attachmentDirectory(root);
  await Promise.all(values.map(item => rm(attachmentAbsolutePath(root, item), { force: true })));
}

export async function cleanupOrphanAttachmentFiles(
  root: string,
  referencedPaths: Iterable<string>,
  minimumAgeMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
): Promise<number> {
  const { directory } = await attachmentDirectory(root), referenced = new Set(referencedPaths);
  let removed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name), relativePath = posix.join(".crewvane", "attachments", entry.name);
    if (referenced.has(relativePath)) continue;
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || now - info.mtimeMs < minimumAgeMs) continue;
    await rm(path, { force: true });
    removed += 1;
  }
  return removed;
}
