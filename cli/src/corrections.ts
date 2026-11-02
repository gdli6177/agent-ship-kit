import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lessonDirectory, readLessons, writeLesson, type Lesson } from "./learning.js";
import { safeId, safeText, writeEvent } from "./intake.js";
import { nextSequence, readEvents, withLock } from "./storage.js";
import { boundedText, ownedDirectory, readTeam } from "./team.js";

type Scope = "event" | "lesson" | "handbook";
export interface CorrectionInput {
  text: string; scope: string; source: string; correctedBy: string;
  project?: string; team?: boolean; when?: string; action?: string; tags?: string[]; evidence?: string[];
}
async function validateSource(root: string, source: string) {
  const match = /^(proposal|contract|task|session):([A-Za-z0-9][A-Za-z0-9_-]{0,79})$/.exec(source);
  if (!match) throw new Error("source must be proposal:ID, contract:ID, task:ID or session:ID");
  const [, kind, id] = match;
  if (kind === "proposal" || kind === "contract") await readFile(join(root, `.agent-ship/${kind}s/${id}.md`), "utf8");
  if (kind === "task" && !(await readEvents(root)).some(event => event.source_task_id === id)) throw new Error("unknown source task");
  return { kind: kind!, id: id! };
}

export async function addCorrection(root: string, input: CorrectionInput) {
  const text = safeText(input.text, "correction", 280);
  if (!["event", "lesson", "handbook"].includes(input.scope)) throw new Error("scope must be event, lesson or handbook");
  const scope = input.scope as Scope;
  const correctedBy = safeText(input.correctedBy, "corrected-by", 120);
  const source = await validateSource(root, input.source);
  if (input.team && input.project) throw new Error("choose --project or --team, not both");
  if (scope !== "event" && !input.project && !input.team) throw new Error("lesson/handbook corrections require --project ID or explicit --team");
  const project = input.project ? safeText(input.project, "project", 120) : null;
  const when = input.when ? safeText(input.when, "when", 200) : undefined;
  const action = input.action ? safeText(input.action, "action", 400) : undefined;
  if (scope !== "event" && (!when || !action)) throw new Error("reusable corrections require --when and --action; use --scope event for one-time facts");
  const tags = (input.tags?.length ? input.tags : [scope === "handbook" ? "process" : "user_correction"]).map(tag => safeText(tag, "tag", 120));
  if (tags.length > 12) throw new Error("at most 12 tags");
  const evidence = (input.evidence ?? []).map(ref => safeText(ref, "evidence", 400));
  if (evidence.length > 9) throw new Error("at most 9 evidence references");
  const event = await writeEvent(root, { type: "correction", title: "Human correction", summary: text, corrected_by: correctedBy, source: input.source, source_task_id: source.id, scope, project, tags, when, action, evidence_urls: evidence, trigger: "user_correction" });
  // Append a resolution annotation rather than guessing which old risk sentence to replace.
  if (source.kind === "proposal") await appendFile(join(root, `.agent-ship/proposals/${source.id}.md`), `\n## Human correction ${event.id}\nStatus: resolved_by_human\nSource: ${event.id}\nCorrected by: ${correctedBy}\n${text}\nPrevious risks remain historical; use this correction when revising the plan.\n`);
  const extraction = scope === "event" ? null : await extractLearning(root, { eventId: event.id });
  return { event, extraction };
}

export async function recordLessonUse(root: string, ids: string[], checkpoint: string, task?: string, project?: string) {
  if (!ids.length) return;
  return writeEvent(root, { type: "lesson_used", title: "Lessons supplied", summary: "Reviewed soft guidance supplied; not an authorization or proof of compliance.", source_task_id: task ?? "session", lesson_ids: ids, checkpoint, project: project ?? null });
}

export async function extractLearning(root: string, options: { since?: string; project?: string; dryRun?: boolean; eventId?: string } = {}) {
  if (options.since && !Number.isFinite(Date.parse(options.since))) throw new Error("invalid --since date");
  return withLock(join(root, ".agent-ship"), async () => {
    const events = await readEvents(root);
    const inbox = (await readFile(join(root, ".agent-ship/inbox.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; })).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const signals = [...events, ...inbox].filter(event => (event.type === "correction" && event.scope !== "event") || (event.type === "review_decided" && event.decision === "changes_requested" && typeof event.note === "string") || event.type === "scope_discovered");
    const directory = await lessonDirectory(root);
    const cards = await readLessons(root);
    const processed = new Set(events.filter(event => event.type === "learning_extracted").map(event => String(event.signal_id)));
    const items: { id: string; source: string; duplicate: boolean; event_id: string; deferred?: string }[] = [];
    for (const signal of signals) {
      if (options.eventId && signal.id !== options.eventId) continue;
      if (options.since && Date.parse(String(signal.created_at)) < Date.parse(options.since)) continue;
      const dispatch = events.find(event => event.type === "worker_dispatched" && event.source_task_id === signal.source_task_id);
      const knownProject = Object.hasOwn(signal, "project") ? signal.project : dispatch?.project_id;
      const project = knownProject === undefined ? options.project : knownProject;
      if (options.project && knownProject !== undefined && knownProject !== null && knownProject !== options.project) continue;
      if (project === undefined) { items.push({ id: "", source: "", event_id: String(signal.id), duplicate: false, deferred: "Project unknown; run extract --project ID or record an explicitly scoped correction." }); continue; }
      const summary = safeText(String(signal.note ?? signal.summary), "signal summary", 280);
      const trigger = signal.type === "correction" ? "user_correction" : signal.type === "scope_discovered" ? "scope_discovery" : "verifier_return";
      const key = createHash("sha256").update(JSON.stringify([trigger, summary.toLowerCase().replace(/\s+/g, " "), project])).digest("hex").slice(0, 24);
      const id = `lesson_${key}`;
      const existing = cards.find(card => card.lesson.id === id);
      const evidence = String(signal.id);
      if ((processed.has(evidence) && existing) || existing?.lesson.evidence.includes(`event:${evidence}`) || existing?.lesson.evidence.includes(`inbox:${evidence}`)) {
        items.push({ id, source: existing.source, duplicate: true, event_id: evidence }); continue;
      }
      const task = safeText(String(signal.source_task_id), "source task", 120);
      const pointer = `${signal.type === "review_decided" ? "inbox" : "event"}:${evidence}`;
      const next: Lesson = existing ? structuredClone(existing.lesson) : {
        id, title: summary.slice(0, 120), summary: summary.slice(0, 240),
        when: safeText(String(signal.when ?? "When handling the same verified review or scope condition."), "when", 200),
        action: safeText(String(signal.action ?? summary), "action", 400),
        tags: Array.isArray(signal.tags) ? signal.tags.map(tag => safeText(String(tag), "tag", 120)) : [trigger],
        ...(project === null ? {} : { project: safeText(String(project), "project", 120) }),
        evidence: [], source_task_id: task, reuse_reason: "Evidence-backed correction or review signal; a maintainer must verify reuse value before activation.",
        authored_by: "agent-ship-extractor", status: "candidate", updated_at: new Date().toISOString(), demands: [],
      };
      next.evidence = [...new Set([...next.evidence, pointer])].slice(-10);
      next.demands ??= [{ source_task_id: next.source_task_id, tags: [] }];
      if (!next.demands.some(d => d.source_task_id === task) && next.demands.length < 20) next.demands.push({ source_task_id: task, tags: [] });
      if (signal.scope === "handbook") { next.handbook_review_suggested = true; next.handbook_review_reason = "human_definition"; }
      if (next.demands.length >= 2) next.handbook_review_suggested = true;
      // Only recurrence AFTER supply to this source task invalidates an active lesson.
      const supplied = events.some(event => event.type === "lesson_used" && event.source_task_id === task && Array.isArray(event.lesson_ids) && event.lesson_ids.includes(id) && Date.parse(String(event.created_at)) > Date.parse(next.updated_at) && Date.parse(String(event.created_at)) <= Date.parse(String(signal.created_at)));
      if (next.status === "active" && supplied) next.status = "needs_review";
      next.updated_at = new Date().toISOString();
      const source = existing?.source ?? join(directory, "auto", `${id}.json`);
      if (!options.dryRun) {
        await ownedDirectory(root, source);
        await mkdir(join(source, ".."), { recursive: true });
        if (existing) { await writeLesson(source, next); existing.lesson = next; }
        else { await writeFile(source, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" }); cards.push({ lesson: next, source, auto: true }); }
        const sequence = await nextSequence(root);
        await appendFile(join(root, ".agent-ship/events.jsonl"), `${JSON.stringify({ id: `evt_extracted_${sequence}`, sequence, type: "learning_extracted", title: "Signal extracted", summary: "Candidate captured; no automatic activation.", source_task_id: task, signal_id: evidence, lesson_ids: [id], created_at: new Date().toISOString() })}\n`);
        processed.add(evidence);
      }
      items.push({ id, source, duplicate: !!existing, event_id: evidence });
    }
    return { items, dry_run: options.dryRun === true, auto_activation: false };
  });
}

export async function reviewLearning(root: string, outcome?: string, reason?: string, project?: string) {
  const events = await readEvents(root);
  const inbox = (await readFile(join(root, ".agent-ship/inbox.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; })).split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const reviews = events.filter(event => event.type === "learning_reviewed");
  const pending = [...events, ...inbox].filter(event => {
    const signal = event.type === "correction" || event.type === "scope_discovered" || (event.type === "review_decided" && event.decision === "changes_requested" && typeof event.note === "string");
    if (!signal) return false;
    const dispatch = events.find(item => item.type === "worker_dispatched" && item.source_task_id === event.source_task_id);
    const owner = Object.hasOwn(event, "project") ? event.project : dispatch?.project_id;
    if (project !== undefined && owner !== project) return false;
    const through = reviews.filter(review => review.project === null || review.project === owner).reduce((max, review) => Math.max(max, Number(review.through_sequence ?? 0)), 0);
    return Number(event.sequence) > through;
  });
  if (outcome && !["none", "candidate"].includes(outcome)) throw new Error("outcome must be none or candidate");
  if (outcome) {
    const why = safeText(reason ?? "", "reason", 280);
    const candidates = (await readLessons(root)).filter(card => pending.some(event => card.lesson.evidence.includes(`event:${event.id}`) || card.lesson.evidence.includes(`inbox:${event.id}`)));
    if (outcome === "candidate" && pending.some(event => event.scope !== "event") && !candidates.length) throw new Error("extract pending reusable corrections before recording candidate");
    if (outcome === "none" && pending.some(event => event.scope !== "event")) throw new Error("reusable corrections have candidates; record candidate or classify them as event at capture");
    await writeEvent(root, { type: "learning_reviewed", title: "Session learning reviewed", summary: why, source_task_id: "session", outcome, project: project ?? null, through_sequence: [...events, ...inbox].reduce((max, event) => Math.max(max, Number(event.sequence ?? 0)), 0) });
    return { ok: true, outcome, reviewed: pending.map(event => event.id) };
  }
  return { ok: pending.length === 0, pending: pending.map(event => ({ id: event.id, scope: event.scope, source: event.source })), next: "Classify corrections; run learning extract and learning review --outcome none|candidate --reason TEXT." };
}

export async function proposeHandbook(root: string, id: string) {
  safeId(id);
  const card = (await readLessons(root)).find(card => card.lesson.id === id);
  if (!card) throw new Error("lesson not found");
  const profile = await readTeam(root);
  if (!profile?.config.handbook) throw new Error("no handbook configured");
  const target = resolve(root, profile.config.handbook);
  const body = await boundedText(target);
  const insertion = ["", `## ${card.lesson.title}`, "", `When: ${card.lesson.when}`, "", `Action: ${card.lesson.action}`, "", `Evidence: ${card.lesson.evidence.join(", ")}`];
  const lines = body ? body.replace(/\n$/, "").split("\n") : [];
  const last = lines.at(-1);
  const context = last === undefined ? "" : body.endsWith("\n") ? ` ${last}\n` : `-${last}\n\\ No newline at end of file\n+${last}\n`;
  const added = insertion.map(line => `+${line}`).join("\n");
  const diff = `--- a/${profile.config.handbook}\n+++ b/${profile.config.handbook}\n@@ -${lines.length},${last === undefined ? 0 : 1} +${last === undefined ? 1 : lines.length},${insertion.length + (last === undefined ? 0 : 1)} @@\n${context}${added}\n`;
  return { target, section: card.lesson.title, insertion_point: "end-of-file", status: "proposal_only", diff };
}
