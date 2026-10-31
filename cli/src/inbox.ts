import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRIORITIES,
  type EventLinks,
  type InboxAddInput,
  type NeedsReviewEvent,
  type Priority,
} from "./types.js";

const ID_PATTERN = /^evt_[A-Za-z0-9_-]+$/;

export function inboxFile(root: string): string {
  return join(root, ".agent-ship", "inbox.jsonl");
}

export function newEventId(now = new Date()): string {
  const stamp = now.getTime().toString(36);
  const nonce = randomBytes(4).toString("hex");
  return `evt_${stamp}_${nonce}`;
}

export function assertPriority(value: string): Priority {
  if (value === "normal" || value === "high") return value;
  throw new Error(`priority must be one of: ${PRIORITIES.join(", ")}`);
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (/[\r\n\0]/.test(trimmed)) throw new Error(`${label} must be a single line`);
  return trimmed;
}

function optionalLink(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label);
}

export async function addInboxItem(root: string, input: InboxAddInput): Promise<NeedsReviewEvent> {
  const title = requiredText(input.title, "title");
  const summary = requiredText(input.summary, "summary");
  const sourceTaskId = requiredText(input.sourceTaskId, "source_task_id");
  const evidence = (input.evidenceUrls ?? []).map((url) => {
    const trimmed = requiredText(url, "evidence url");
    if (/\s/.test(trimmed)) throw new Error("evidence URLs must be single tokens");
    return trimmed;
  });

  const links: EventLinks = {};
  const pr = optionalLink(input.links?.pr, "links.pr");
  const issue = optionalLink(input.links?.issue, "links.issue");
  const path = optionalLink(input.links?.path, "links.path");
  if (pr) links.pr = pr;
  if (issue) links.issue = issue;
  if (path) links.path = path;

  const event: NeedsReviewEvent = {
    id: input.id === undefined ? newEventId() : requiredText(input.id, "id"),
    type: "needs_review",
    title,
    summary,
    evidence_urls: evidence,
    priority: input.priority ?? "normal",
    created_at: input.createdAt ?? new Date().toISOString(),
    source_task_id: sourceTaskId,
    links,
  };

  if (!ID_PATTERN.test(event.id)) {
    throw new Error("id must match evt_[A-Za-z0-9_-]+");
  }

  const existing = await listInbox(root);
  if (existing.some((item) => item.id === event.id)) {
    throw new Error(`inbox already contains ${event.id}`);
  }

  const file = inboxFile(root);
  await mkdir(join(root, ".agent-ship"), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function listInbox(root: string, priority?: Priority): Promise<NeedsReviewEvent[]> {
  let raw: string;
  try {
    raw = await readFile(inboxFile(root), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const items: NeedsReviewEvent[] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`inbox line ${index + 1} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "needs_review") {
      throw new Error(`inbox line ${index + 1} is not a needs_review event`);
    }
    items.push(parsed as NeedsReviewEvent);
  }

  if (!priority) return items;
  return items.filter((item) => item.priority === priority);
}
