import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertReference, boundedText, DEFAULT_LESSONS, optionalText, ownedDirectory, parseJson, readTeam, requiredSources } from "./team.js";
import { nextSequence, readEvents, withLock } from "./storage.js";

const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const STATUSES = ["candidate", "active", "needs_review", "retired"] as const;
type LessonStatus = typeof STATUSES[number];
export interface Lesson {
  id: string;
  title: string;
  summary: string;
  when: string;
  action: string;
  tags: string[];
  project?: string;
  evidence: string[];
  source_task_id: string;
  reuse_reason: string;
  status: LessonStatus;
  updated_at: string;
  reviewed_by?: string;
  review_note?: string;
  review_after?: string;
  authored_by?: string;
  /** Demand identities that produced this conclusion. Recorded for auto candidates. */
  demands?: { source_task_id: string; tags: string[] }[];
  /** Set only after the same conclusion is seen from a second distinct demand. */
  handbook_review_suggested?: true;
}
function text(value: unknown, name: string, max = 400): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw new Error(`invalid ${name}; must be a single line of at most ${max} characters`);
  }
  return value.trim();
}
function strings(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error(`invalid ${name}`);
  return [...new Set(value.map((item) => text(item, name)))];
}
function parseLesson(value: unknown): Lesson {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lesson must be an object");
  const c = value as Record<string, unknown>;
  const keys = ["id", "title", "summary", "when", "action", "tags", "project", "evidence", "source_task_id", "reuse_reason", "status", "updated_at", "reviewed_by", "review_note", "review_after", "authored_by", "demands", "handbook_review_suggested"];
  if (Object.keys(c).some((key) => !keys.includes(key))) throw new Error("unknown lesson field");
  const id = text(c.id, "id", 80);
  if (!ID.test(id) || !STATUSES.includes(c.status as LessonStatus)) throw new Error("invalid lesson id/status");
  const lesson: Lesson = { id, title: text(c.title, "title", 120), summary: text(c.summary, "summary", 240), when: text(c.when, "when", 200), action: text(c.action, "action"), tags: strings(c.tags, "tags", 12), evidence: strings(c.evidence, "evidence", 10), source_task_id: text(c.source_task_id, "source_task_id"), reuse_reason: text(c.reuse_reason, "reuse_reason"), status: c.status as LessonStatus, updated_at: text(c.updated_at, "updated_at") };
  if (lesson.evidence.some((pointer) => pointer.includes("<") || pointer.includes(">")) || lesson.source_task_id.includes("<")) throw new Error("lesson evidence/task placeholders must be replaced");
  if (!Number.isFinite(Date.parse(lesson.updated_at))) throw new Error("invalid lesson updated_at");
  if (c.project !== undefined) lesson.project = text(c.project, "project", 120);
  if (c.authored_by !== undefined) lesson.authored_by = text(c.authored_by, "authored_by", 120);
  if (c.reviewed_by !== undefined) lesson.reviewed_by = text(c.reviewed_by, "reviewed_by", 120);
  if (c.review_note !== undefined) lesson.review_note = text(c.review_note, "review_note");
  if (c.review_after !== undefined) {
    lesson.review_after = text(c.review_after, "review_after");
    if (!Number.isFinite(Date.parse(lesson.review_after))) throw new Error("invalid review_after");
  }
  if (c.demands !== undefined) lesson.demands = parseDemands(c.demands);
  if (c.handbook_review_suggested !== undefined) {
    if (c.handbook_review_suggested !== true) throw new Error("invalid handbook_review_suggested");
    if ((lesson.demands?.length ?? 0) < 2) throw new Error("handbook review requires a second distinct demand");
    lesson.handbook_review_suggested = true;
  }
  if (lesson.status === "active" && (!lesson.reviewed_by || !lesson.review_note)) throw new Error("active lesson needs an explicit review");
  return lesson;
}
const DEMAND_LIMIT = 20;
function canonicalDemandTags(tags: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, tag);
  }
  return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, tag]) => tag);
}
function demandKey(sourceTaskId: string, tags: string[]): string {
  return JSON.stringify([sourceTaskId.toLowerCase(), tags.map((tag) => tag.toLowerCase()).sort()]);
}
function parseDemands(value: unknown): { source_task_id: string; tags: string[] }[] {
  if (!Array.isArray(value) || !value.length || value.length > DEMAND_LIMIT) throw new Error("invalid demands");
  const demands = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid demands");
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "source_task_id" && key !== "tags")) throw new Error("invalid demands");
    const source_task_id = text(record.source_task_id, "demand source_task_id");
    if (source_task_id.includes("<")) throw new Error("lesson evidence/task placeholders must be replaced");
    const rawTags = record.tags === undefined ? [] : record.tags;
    if (!Array.isArray(rawTags) || rawTags.length > 12) throw new Error("invalid demand tags");
    const tags = canonicalDemandTags(rawTags.map((tag) => text(tag, "demand tag", 120)));
    const key = demandKey(source_task_id, tags);
    if (seen.has(key)) throw new Error("duplicate demand fingerprint");
    seen.add(key);
    demands.push({ source_task_id, tags });
  }
  return demands;
}
async function lessonDirectory(root: string) {
  const path = resolve(root, (await readTeam(root))?.config.lessons ?? DEFAULT_LESSONS);
  try { const actual = await realpath(path); assertReference(actual); return actual; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return path; throw error; }
}
async function readLessonFiles(directory: string): Promise<{ lesson: Lesson; source: string }[]> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const cards = [];
  for (const name of names.sort()) {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}\.json$/.test(name)) continue;
    const source = join(directory, name);
    if ((await lstat(source)).isSymbolicLink()) throw new Error("lesson cards cannot be symlinks");
    const lesson = parseLesson(parseJson(await boundedText(source), "lesson card"));
    if (name !== `${lesson.id}.json`) throw new Error("lesson filename/id mismatch");
    cards.push({ lesson, source });
  }
  return cards;
}
async function assertAutoDirectory(lessonsRoot: string): Promise<void> {
  try {
    const info = await lstat(join(lessonsRoot, "auto"));
    if (info.isSymbolicLink()) throw new Error("lesson auto directory cannot be a symlink");
    if (!info.isDirectory()) throw new Error("lesson auto path is not a directory");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
/** Top-level cards are the reviewed library. auto/ is included only for admission, review, and the handbook queue. */
async function readLessons(root: string, includeAuto = true): Promise<{ lesson: Lesson; source: string; auto: boolean }[]> {
  const directory = await lessonDirectory(root);
  const top = (await readLessonFiles(directory)).map((card) => ({ ...card, auto: false }));
  if (!includeAuto) return top;
  const autoDir = join(directory, "auto");
  let info;
  try { info = await lstat(autoDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return top; throw error; }
  if (info.isSymbolicLink()) throw new Error("lesson auto directory cannot be a symlink");
  if (!info.isDirectory()) throw new Error("lesson auto path is not a directory");
  const auto = (await readLessonFiles(autoDir)).map((card) => ({ ...card, auto: true }));
  const seen = new Set(top.map((card) => card.lesson.id));
  for (const card of auto) {
    if (seen.has(card.lesson.id)) throw new Error("duplicate lesson id");
    seen.add(card.lesson.id);
  }
  return [...top, ...auto];
}
function fingerprint(lesson: Lesson): string {
  const normalized = [lesson.when, lesson.action, lesson.project ?? "", ...[...lesson.tags].sort()].map((s) => s.toLowerCase().replace(/\s+/g, " ").trim());
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function writeLesson(source: string, lesson: Lesson) {
  const temporary = `${source}.tmp`;
  await writeFile(temporary, `${JSON.stringify(lesson, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, source);
}
async function noteAutoDemand(card: { lesson: Lesson; source: string }, incoming: Lesson, tags: string[]) {
  const demand = { source_task_id: incoming.source_task_id, tags: canonicalDemandTags(tags) };
  const recorded = card.lesson.demands ?? [{ source_task_id: card.lesson.source_task_id, tags: [] }];
  const known = recorded.some((item) => demandKey(item.source_task_id, item.tags) === demandKey(demand.source_task_id, demand.tags));
  if (known) return { id: card.lesson.id, source: card.source, duplicate: true, handbook_review_suggested: card.lesson.handbook_review_suggested === true };
  const atCap = recorded.length >= DEMAND_LIMIT;
  const demands = atCap ? recorded : [...recorded, demand];
  const suggested = demands.length >= 2;
  if (atCap && card.lesson.handbook_review_suggested) return { id: card.lesson.id, source: card.source, duplicate: true, handbook_review_suggested: true };
  const payload: Record<string, unknown> = { ...card.lesson, demands, updated_at: new Date().toISOString() };
  if (suggested) payload.handbook_review_suggested = true;
  else delete payload.handbook_review_suggested;
  const lesson = parseLesson(payload);
  await writeLesson(card.source, lesson);
  return { id: lesson.id, source: card.source, duplicate: true, handbook_review_suggested: suggested };
}
export async function addLesson(root: string, inputFile: string, options: { auto?: boolean; demandTags?: string[] } = {}) {
  if (options.demandTags?.length && !options.auto) throw new Error("--demand is only valid with lesson add --auto");
  if ((options.demandTags?.length ?? 0) > 12) throw new Error("invalid demand tags");
  const demandTags = canonicalDemandTags((options.demandTags ?? []).map((tag) => text(tag, "demand tag", 120)));
  assertReference(await realpath(inputFile));
  const raw = parseJson(await boundedText(inputFile), "lesson input");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("lesson input must be an object");
  const input = raw as Record<string, unknown>;
  if (input.status !== undefined && input.status !== "candidate") throw new Error("new lessons must start as candidate");
  if (input.reviewed_by !== undefined || input.review_note !== undefined) throw new Error("new lessons cannot pre-approve their own review");
  if (input.demands !== undefined || input.handbook_review_suggested !== undefined) throw new Error("demand history and handbook review are recorded by the CLI");
  const draft = parseLesson({ ...input, status: "candidate", updated_at: new Date().toISOString() });
  const candidate = options.auto ? parseLesson({ ...draft, demands: [{ source_task_id: draft.source_task_id, tags: demandTags }] }) : draft;
  return withLock(join(root, ".agent-ship"), async () => {
    const lessonsRoot = await ownedDirectory(root, await lessonDirectory(root));
    if (options.auto) await assertAutoDirectory(lessonsRoot);
    const existing = await readLessons(root);
    const duplicate = existing.find(({ lesson }) => fingerprint(lesson) === fingerprint(candidate));
    if (duplicate) {
      if (options.auto && duplicate.auto) return noteAutoDemand(duplicate, candidate, demandTags);
      return { id: duplicate.lesson.id, source: duplicate.source, duplicate: true, ...(options.auto ? { handbook_review_suggested: false } : {}) };
    }
    if (existing.some(({ lesson }) => lesson.id === candidate.id)) throw new Error("lesson id already exists; revise the existing card through review");
    const directory = options.auto ? join(lessonsRoot, "auto") : lessonsRoot;
    await mkdir(directory, { recursive: true });
    const source = join(directory, `${candidate.id}.json`);
    await writeFile(source, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
    return { id: candidate.id, source, duplicate: false, ...(options.auto ? { handbook_review_suggested: false } : {}) };
  });
}

export async function reviewLesson(root: string, id: string, status: string, reviewer: string, note: string, reviewAfter?: string) {
  if (!ID.test(id) || !["active", "needs_review", "retired"].includes(status)) throw new Error("invalid lesson review id/status");
  return withLock(join(root, ".agent-ship"), async () => {
    await ownedDirectory(root, await lessonDirectory(root));
    const card = (await readLessons(root)).find((entry) => entry.lesson.id === id);
    if (!card) throw new Error("lesson not found");
    const lesson = parseLesson({ ...card.lesson, status, reviewed_by: text(reviewer, "reviewed_by", 120), review_note: text(note, "review_note"), updated_at: new Date().toISOString(), ...(reviewAfter ? { review_after: reviewAfter } : {}) });
    if (status === "active") {
      const events = await readEvents(root);
      const worker = events.filter((event) => event.source_task_id === lesson.source_task_id && typeof event.worker_ref === "string").at(-1)?.worker_ref;
      const author = lesson.authored_by ?? (typeof worker === "string" ? worker : undefined);
      if (author && author === lesson.reviewed_by) throw new Error("lesson author and reviewer must differ");
      if (lesson.review_after && Date.parse(lesson.review_after) <= Date.now()) throw new Error("active lesson needs a future review_after date");
    }
    // Active review is the existing promotion path. It moves an auto card into the library and never writes the handbook.
    if (card.auto && status === "active") {
      const directory = await ownedDirectory(root, await lessonDirectory(root));
      const destination = join(directory, `${lesson.id}.json`);
      try { await writeFile(destination, `${JSON.stringify(lesson, null, 2)}\n`, { flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("lesson id already exists; revise the existing card through review"); throw error; }
      await rm(card.source);
      return { id, status, source: destination, promoted: true };
    }
    await writeLesson(card.source, lesson);
    return { id, status, source: card.source };
  });
}
export async function showLesson(root: string, id: string) {
  if (!ID.test(id)) throw new Error("invalid lesson id");
  const card = (await readLessons(root)).find((entry) => entry.lesson.id === id);
  if (!card) throw new Error("lesson not found");
  return { lesson: card.lesson, source: card.source };
}

export async function teamContext(root: string, options: { tags?: string[]; project?: string; repo?: string } = {}) {
  const profile = await readTeam(root);
  const required_sources = await requiredSources(root, options.repo);
  if ((options.tags?.length ?? 0) > 12) throw new Error("at most 12 retrieval tags");
  const project = options.project === undefined ? undefined : text(options.project, "project", 120);
  const tags = new Set((options.tags ?? []).map((tag) => text(tag, "tag", 120).toLowerCase()));
  const max = profile?.config.max_lessons ?? 3, budget = profile?.config.summary_chars ?? 1200;
  const matches = tags.size ? (await readLessons(root, false)).filter(({ lesson }) => (!lesson.project || lesson.project === project) && lesson.tags.some((tag) => tags.has(tag.toLowerCase()))) : [];
  const ranked = matches.map((entry) => ({ ...entry, score: entry.lesson.tags.filter((tag) => tags.has(tag.toLowerCase())).length })).sort((a, b) => b.score - a.score || a.lesson.id.localeCompare(b.lesson.id));
  const lessons: { id: string; title: string; summary: string; when: string; action: string; source: string }[] = [];
  const review_required: { id: string }[] = [];
  let chars = 0, omitted = 0, reviewCount = 0;
  for (const { lesson, source, auto } of ranked) {
    if (auto) continue; // auto/ cards are not execution summaries until review promotes them out of auto/.
    const expired = lesson.review_after && Date.parse(lesson.review_after) <= Date.now();
    if (lesson.status === "needs_review" || (lesson.status === "active" && expired)) {
      reviewCount++;
      if (review_required.length < max) review_required.push({ id: lesson.id });
      continue;
    }
    if (lesson.status !== "active") continue;
    const summary = { id: lesson.id, title: lesson.title, summary: lesson.summary, when: lesson.when, action: lesson.action, source };
    const size = JSON.stringify(summary).length;
    if (lessons.length >= max || chars + size > budget) { omitted++; continue; }
    lessons.push(summary); chars += size;
  }
  const executionProfile = options.repo && options.repo !== root ? await readTeam(options.repo) : undefined;
  return { profile: profile?.source ?? executionProfile?.source ?? null, required_sources, lessons, review_required, review_required_count: reviewCount, omitted_count: omitted, summary_chars: chars, budget: { max_lessons: max, summary_chars: budget }, query: { tags: [...tags], project: project ?? null }, learning_required: profile?.config.learning_required ?? executionProfile?.config.learning_required ?? false };
}

async function inboxRecords(root: string): Promise<Record<string, unknown>[]> {
  const raw = await optionalText(join(root, ".agent-ship/inbox.jsonl"));
  return (raw ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}
function workVersion(events: Record<string, unknown>[], task: string): number {
  return events.reduce((max, event) => event.source_task_id === task && (event.type === "worker_dispatched" || (event.type === "worker_progress" && (event.status === undefined || event.status === "running" || event.status === "queued"))) ? Math.max(max, Number(event.sequence ?? 0)) : max, 0);
}
export async function checkLearning(root: string, task: string, outcome: string, reason: string, reviewer: string, ids: string[] = [], triggers: string[] = []) {
  if (outcome !== "none" && outcome !== "candidate") throw new Error("outcome must be none or candidate");
  const allowed = ["user_correction", "verifier_return", "recurrence", "scope_discovery"];
  if (triggers.some((trigger) => !allowed.includes(trigger))) throw new Error("invalid learning trigger");
  task = text(task, "source_task_id");
  reason = text(reason, "reason", 280); reviewer = text(reviewer, "reviewed_by", 120);
  if (ids.length > 10) throw new Error("at most 10 candidate links per check");
  return withLock(join(root, ".agent-ship"), async () => {
    const events = await readEvents(root);
    const dispatch = events.find((event) => event.type === "worker_dispatched" && event.source_task_id === task);
    if (!dispatch) throw new Error("learning check requires a dispatched task");
    const worker = events.filter((event) => event.source_task_id === task && typeof event.worker_ref === "string").at(-1)?.worker_ref;
    if (typeof worker === "string" && worker === reviewer) throw new Error("reviewed-by must differ from the recorded worker");
    if (outcome === "none" && ids.length) throw new Error("none outcome cannot create candidate links");
    if (outcome === "candidate" && !ids.length) throw new Error("candidate outcome needs at least one candidate id");
    const cards = ids.length ? await readLessons(root) : [];
    for (const id of ids) {
      const card = cards.find((entry) => entry.lesson.id === id);
      if (!card || card.lesson.status === "retired") throw new Error("candidate reference is missing or retired");
    }
    if ((await inboxRecords(root)).some((event) => event.source_task_id === task && event.type === "review_decided" && event.decision === "changes_requested")) triggers = [...new Set([...triggers, "user_correction"])];
    const sequence = await nextSequence(root);
    const event = { id: `evt_learning_${sequence}`, sequence, type: "learning_checked", title: "Learning check", summary: reason, created_at: new Date().toISOString(), source_task_id: task, outcome, learning_reason: reason, reviewed_by: reviewer, lesson_ids: [...new Set(ids)], triggers: [...new Set(triggers)], work_sequence: workVersion(events, task) };
    await appendFile(join(root, ".agent-ship/events.jsonl"), `${JSON.stringify(event)}\n`);
    return event;
  });
}

/** Structural gate only; the verifier remains responsible for evidence and semantic value. */
export async function assertLearningChecked(root: string, task: string): Promise<void> {
  const events = await readEvents(root);
  const dispatch = events.find((event) => event.type === "worker_dispatched" && event.source_task_id === task);
  if (!dispatch || dispatch.learning_required !== true) return; // Existing, unmanaged tasks keep their old contract.
  const checked = events.filter((event) => event.type === "learning_checked" && event.source_task_id === task).at(-1);
  if (!checked || Number(checked.work_sequence) !== workVersion(events, task)) throw new Error("a fresh lesson check (none/candidate, reason and verifier) is required before review");
  if (checked.outcome !== "none" && checked.outcome !== "candidate") throw new Error("invalid learning outcome");
  text(checked.learning_reason, "learning reason", 280); text(checked.reviewed_by, "learning reviewer", 120);
  const corrections = (await inboxRecords(root)).filter((event) => event.source_task_id === task && event.type === "review_decided" && event.decision === "changes_requested");
  if (corrections.some((event) => Number(event.sequence ?? 0) >= Number(checked.sequence ?? 0))) throw new Error("human corrections require a new learning check");
  if (checked.outcome === "candidate") {
    const ids = strings(checked.lesson_ids, "candidate links", 10);
    const cards = await readLessons(root);
    if (ids.some((id) => !cards.some((card) => card.lesson.id === id && card.lesson.status !== "retired"))) throw new Error("candidate links must remain available before review");
  }
}

async function pendingHandbookReview(root: string, onlyTask?: string) {
  const cards = (await readLessons(root)).filter(({ lesson }) => {
    if (lesson.handbook_review_suggested !== true || lesson.status === "retired" || (lesson.demands?.length ?? 0) < 2) return false;
    if (!onlyTask) return true;
    return lesson.source_task_id === onlyTask || (lesson.demands ?? []).some((demand) => demand.source_task_id === onlyTask);
  }).sort((a, b) => a.lesson.id.localeCompare(b.lesson.id));
  return {
    items: cards.slice(0, 20).map(({ lesson, source }) => ({ id: lesson.id, source, status: lesson.status, demands: lesson.demands ?? [], handbook_review_suggested: true })),
    total_count: cards.length,
    omitted_count: Math.max(0, cards.length - 20),
  };
}
/** Cancellation never waits for documentation. Surface unfinished checks to the captain at wrap-up. */
export async function pendingLearning(root: string, onlyTask?: string, handbook = false) {
  if (handbook) return pendingHandbookReview(root, onlyTask);
  const events = await readEvents(root);
  const inbox = await inboxRecords(root);
  const records = [...events, ...inbox].sort((a, b) => Date.parse(String(a.created_at)) - Date.parse(String(b.created_at)) || Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
  const states = new Map<string, string>();
  for (const event of records) {
    if (typeof event.source_task_id !== "string") continue;
    if (event.type === "worker_dispatched") states.set(event.source_task_id, String(event.status ?? "running"));
    if (event.type === "worker_progress" && typeof event.status === "string") states.set(event.source_task_id, event.status);
    if (["needs_review", "blocked", "needs_approval"].includes(String(event.type))) states.set(event.source_task_id, String(event.type));
    if (event.type === "review_decided" && event.decision === "reject") states.set(event.source_task_id, "cancelled");
  }
  const pending = [];
  for (const event of events.filter((item) => item.type === "worker_dispatched" && item.learning_required === true)) {
    const task = String(event.source_task_id), status = states.get(task);
    if (onlyTask && task !== onlyTask) continue;
    if (!status || !["needs_review", "failed", "cancelled"].includes(status)) continue;
    try { await assertLearningChecked(root, task); }
    catch { pending.push({ source_task_id: task, status }); }
  }
  return { items: pending.slice(0, 20), total_count: pending.length, omitted_count: Math.max(0, pending.length - 20) };
}
