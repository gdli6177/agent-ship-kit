import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { actorIdentity, assertInboxActor, readAuthority } from "./authority.js";
import { laneId } from "./records.js";
import { nextSequence, readEvents, withLock } from "./storage.js";
import { assertLearningChecked } from "./learning.js";
import {
  ATTENTION_TYPES,
  DECISIONS,
  PRIORITIES,
  type AttentionEvent,
  type AttentionType,
  type Decision,
  type EventLinks,
  type BlockReason,
  type InboxAddInput,
  type InboxRecord,
  type ListInboxOptions,
  type Priority,
  type ReviewDecidedEvent,
  type ThreadRefs,
  BLOCK_REASONS,
  SUMMARY_MAX,
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

export function assertAttentionType(value: string): AttentionType {
  if (value === "needs_review" || value === "blocked" || value === "needs_approval") return value;
  throw new Error(`type must be one of: ${ATTENTION_TYPES.join(", ")}`);
}

export function assertDecision(value: string): Decision {
  if (value === "accept" || value === "changes_requested" || value === "reject") return value;
  throw new Error(`decision must be one of: ${DECISIONS.join(", ")}`);
}

function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (/[\r\n\0]/.test(trimmed)) throw new Error(`${label} must be a single line`);
  return trimmed;
}

export function assertSummary(value: string): string {
  const summary = requiredText(value, "summary");
  if (summary.length > SUMMARY_MAX) {
    throw new Error(`summary must be at most ${SUMMARY_MAX} characters`);
  }
  return summary;
}

export function assertBlockReason(value: string): BlockReason {
  if (value === "stalled" || value === "drift" || value === "other") return value;
  throw new Error(`reason must be one of: ${BLOCK_REASONS.join(", ")}`);
}

function optionalLink(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label);
}

function asRecord(value: unknown, lineNumber: number): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`inbox line ${lineNumber} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseRecord(value: unknown, lineNumber: number): InboxRecord {
  const record = asRecord(value, lineNumber);
  const type = record.type;
  if (type === "review_decided") {
    const decision = record.decision;
    const subjectId = record.subject_id;
    if (typeof decision !== "string" || !DECISIONS.includes(decision as Decision)) {
      throw new Error(`inbox line ${lineNumber} has an invalid decision`);
    }
    if (typeof subjectId !== "string" || subjectId.trim() === "") {
      throw new Error(`inbox line ${lineNumber} is missing subject_id`);
    }
    return record as unknown as ReviewDecidedEvent;
  }
  if (type === "needs_review" || type === "blocked" || type === "needs_approval") {
    return record as unknown as AttentionEvent;
  }
  throw new Error(`inbox line ${lineNumber} has unsupported type ${String(type)}`);
}

export async function readInbox(root: string): Promise<InboxRecord[]> {
  let raw: string;
  try {
    raw = await readFile(inboxFile(root), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const items: InboxRecord[] = [];
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
    items.push(parseRecord(parsed, index + 1));
  }
  return items;
}

function decidedSubjects(items: readonly InboxRecord[]): Set<string> {
  const subjects = new Set<string>();
  for (const item of items) {
    if (item.type === "review_decided") subjects.add(item.subject_id);
  }
  return subjects;
}

export async function listInbox(root: string, options: ListInboxOptions = {}): Promise<InboxRecord[]> {
  const all = await readInbox(root);
  const decided = decidedSubjects(all);
  return all.filter((item) => {
    if (options.openOnly) {
      if (item.type === "review_decided") return false;
      if (decided.has(item.id)) return false;
    }
    if (options.lane && (item.lane_id ?? "default") !== laneId(options.lane)) return false;
    if (options.type && item.type !== options.type) return false;
    if (options.priority) {
      if (item.type === "review_decided" || item.priority !== options.priority) return false;
    }
    return true;
  });
}

async function appendRecord(root: string, record: InboxRecord): Promise<void> {
  const file = inboxFile(root);
  await mkdir(join(root, ".agent-ship"), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

export async function addInboxItem(root: string, input: InboxAddInput, internalWatchdog = false): Promise<AttentionEvent> {
  return withLock(join(root, ".agent-ship"), async () => {
    const title = requiredText(input.title, "title");
    const summary = assertSummary(input.summary);
    const sourceTaskId = requiredText(input.sourceTaskId, "source_task_id");
    const events = await readEvents(root);
    const dispatch = events.filter(event => event.type === "worker_dispatched" && event.source_task_id === sourceTaskId).at(-1);
    const actor = await actorIdentity(root);
    const recordedLane = typeof dispatch?.lane_id === "string" ? dispatch.lane_id : undefined;
    if (input.laneId && recordedLane && input.laneId !== recordedLane) throw new Error("inbox lane does not match its dispatched task");
    const lane = input.laneId ?? recordedLane ?? actor.lane ?? undefined;
    const claim = events.filter(event => event.type === "intake_claimed" && event.lane_id === lane).at(-1);
    const recordedOwner = typeof dispatch?.owner_ref === "string" ? dispatch.owner_ref : typeof claim?.owner_ref === "string" ? claim.owner_ref : undefined;
    if (input.ownerRef && recordedOwner && input.ownerRef !== recordedOwner) throw new Error("inbox owner does not match its lane");
    if (await readAuthority(root) && lane && lane !== "default" && !claim) throw new Error("inbox lane has no intake claim");
    const owner = recordedOwner ?? input.ownerRef;
    if (!internalWatchdog) {
      await assertInboxActor(root, lane);
      if (actor.role === "worker" && dispatch?.worker_ref !== actor.ref) throw new Error("worker may only report its own dispatched task");
    }
    if ((input.type ?? "needs_review") === "needs_review") await assertLearningChecked(root, sourceTaskId);
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

    const threadRefs: ThreadRefs = {};
    const threadPr = optionalLink(input.threadRefs?.pr, "thread_refs.pr");
    const threadIssue = optionalLink(input.threadRefs?.issue, "thread_refs.issue");
    const threadChat = optionalLink(input.threadRefs?.chat, "thread_refs.chat");
    if (threadPr) threadRefs.pr = threadPr;
    if (threadIssue) threadRefs.issue = threadIssue;
    if (threadChat) threadRefs.chat = threadChat;

    const event: AttentionEvent = {
      id: input.id === undefined ? newEventId() : requiredText(input.id, "id"),
      type: input.type ?? "needs_review",
      title,
      summary,
      evidence_urls: evidence,
      priority: input.priority ?? "normal",
      created_at: input.createdAt ?? new Date().toISOString(),
      source_task_id: sourceTaskId,
      links,
      ...(lane ? { lane_id: laneId(lane) } : {}),
      ...(owner ? { owner_ref: owner } : {}),
    };
    const contractId = optionalLink(input.contractId, "contract_id");
    const sliceId = optionalLink(input.sliceId, "slice_id");
    const workerRef = optionalLink(input.workerRef, "worker_ref");
    const branch = optionalLink(input.branch, "branch");
    if (contractId) event.contract_id = contractId;
    if (sliceId) event.slice_id = sliceId;
    if (workerRef) event.worker_ref = workerRef;
    if (branch) event.branch = branch;
    if (Object.keys(threadRefs).length > 0) event.thread_refs = threadRefs;
    if (input.reason) event.reason = input.reason;

    if (!ID_PATTERN.test(event.id)) {
      throw new Error("id must match evt_[A-Za-z0-9_-]+");
    }

    const existing = await readInbox(root);
    if (existing.some((item) => item.id === event.id)) {
      throw new Error(`inbox already contains ${event.id}`);
    }

    event.sequence = await nextSequence(root);
    await appendRecord(root, event);
    return event;
  });
}

export async function decideInboxItem(
  root: string,
  subjectId: string,
  decision: Decision,
  note?: string,
): Promise<ReviewDecidedEvent> {
  return withLock(join(root, ".agent-ship"), async () => {
    await assertInboxActor(root, undefined, true);
    const id = requiredText(subjectId, "id");
    const all = await readInbox(root);
    const subject = all.find((item) => item.id === id);
    if (!subject || subject.type === "review_decided") {
      throw new Error(`inbox has no open item ${id}`);
    }
    if (all.some((item) => item.type === "review_decided" && item.subject_id === id)) {
      throw new Error(`inbox item ${id} is already decided`);
    }

    const cleanedNote = note === undefined ? undefined : requiredText(note, "note");
    const event: ReviewDecidedEvent = {
      id: newEventId(),
      type: "review_decided",
      title: `Decision ${decision}: ${subject.title}`,
      summary: assertSummary(cleanedNote ?? `Human ${decision} on ${subject.id}.`),
      created_at: new Date().toISOString(),
      source_task_id: subject.source_task_id,
      decision,
      subject_id: subject.id,
      ...(subject.lane_id ? { lane_id: subject.lane_id } : {}),
      ...(subject.owner_ref ? { owner_ref: subject.owner_ref } : {}),
    };
    if (cleanedNote) event.note = cleanedNote;

    event.sequence = await nextSequence(root);
    await appendRecord(root, event);
    return event;
  });
}
