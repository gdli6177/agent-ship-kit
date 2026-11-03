import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addLesson, readLessons, reviewLesson, teamContext, type Lesson } from "../../../cli/src/learning.js";
import { assertReference, boundedText, ownedDirectory, readTeam } from "../../../cli/src/team.js";
import { containsSecret } from "../../../cli/src/hard-rules.js";
import { newId, redact, type Project, type Task } from "../../core/src/index.js";
import { limited } from "./tasks.js";

export interface KnowledgeConfiguration { handbook: string | null; rules: string[]; lessons?: string }
export async function configureKnowledge(project: Project, config: KnowledgeConfiguration) {
  if (!config || Object.keys(config).some(key => !["handbook", "rules", "lessons"].includes(key)) ||
    (config.handbook !== null && typeof config.handbook !== "string") ||
    !Array.isArray(config.rules) || config.rules.some(rule => typeof rule !== "string") || config.rules.length > 12 ||
    (config.lessons !== undefined && typeof config.lessons !== "string")) throw new Error("invalid knowledge source configuration");
  const previous = await readTeam(project.path);
  const profile = { version: 1, max_lessons: 3, summary_chars: 5000,
    lessons: ".crewvane/lessons", ...previous?.config, ...config, learning_required: true };
  profile.lessons ??= previous?.config.lessons ?? ".crewvane/lessons";
  for (const ref of [profile.handbook, ...profile.rules]) {
    if (!ref) continue;
    assertReference(ref);
    const actual = await realpath(resolve(project.path, ref));
    assertReference(actual);
    if (!/\.md$/i.test(actual)) throw new Error("knowledge sources must be Markdown");
    const body = await boundedText(actual);
    if (containsSecret(body)) throw new Error("knowledge source contains possible credentials");
  }
  // An external library may be read, but generated candidates always need an owned destination.
  await ownedDirectory(project.path, profile.lessons);
  const file = previous?.source ?? join(project.path, ".crewvane", "team.json");
  await ownedDirectory(project.path, file);
  await mkdir(join(project.path, ".crewvane"), { recursive: true });
  await writeFile(file, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
  return profile;
}

function words(query: string) {
  return [...new Set([...new Intl.Segmenter("zh", { granularity: "word" }).segment(query.toLowerCase())]
    .filter(part => part.isWordLike && part.segment.length > 1).map(part => part.segment))].slice(0, 80);
}
export async function knowledgeLibrary(project: Project, query = "") {
  const terms = words(query);
  const cards = (await readLessons(project.path)).filter(({ lesson }) => !lesson.project || lesson.project === project.id)
    .map(entry => {
      if (containsSecret(JSON.stringify(entry.lesson))) throw new Error("knowledge entry contains possible credentials");
      const text = `${entry.lesson.title} ${entry.lesson.summary} ${entry.lesson.when} ${entry.lesson.action} ${entry.lesson.tags.join(" ")}`.toLowerCase();
      return { ...entry, score: terms.filter(term => text.includes(term)).length };
    })
    .filter(entry => !terms.length || entry.score > 0)
    .sort((a, b) => b.score - a.score || b.lesson.updated_at.localeCompare(a.lesson.updated_at));
  return { config: (await readTeam(project.path))?.config ?? null, cards };
}

export async function knowledgeContext(project: Project, query: string) {
  const context = await teamContext(project.path, { project: project.id, auto: true });
  const profile = await readTeam(project.path);
  const bodies = new Map<string, string>();
  let bytes = 0;
  for (const ref of [profile?.config.handbook, ...(profile?.config.rules ?? [])]) {
    if (!ref) continue;
    const path = await realpath(resolve(project.path, ref));
    assertReference(path);
    const body = await boundedText(path);
    if (containsSecret(body)) throw new Error("knowledge source contains possible credentials");
    bytes += Buffer.byteLength(body);
    if (bytes > 64 * 1024) throw new Error("combined handbook and rules exceed 64KB injection budget");
    bodies.set(path, body);
  }
  const { cards } = await knowledgeLibrary(project, query);
  const lessons = cards.filter(({ lesson, auto }) => !auto && lesson.status === "active" &&
    (!lesson.review_after || Date.parse(lesson.review_after) > Date.now())).slice(0, 3)
    .map(({ lesson, source }) => ({ id: lesson.id, title: lesson.title, when: lesson.when, action: lesson.action, summary: lesson.summary, source }));
  return {
    // AGENTS.md can be large: retain its streaming receipt; the runtime reads its checkout's owner rules.
    sources: context.source_details.map(source => ({ path: source.path, digest: source.digest,
      bodyIncluded: bodies.has(source.path), ...(bodies.has(source.path) ? { body: bodies.get(source.path) } : {}) })),
    lessons,
  };
}

export async function reviewKnowledge(project: Project, id: string, status: "active" | "needs_review" | "retired", by: string, note: string) {
  const card = (await readLessons(project.path)).find(c => c.lesson.id === id && (!c.lesson.project || c.lesson.project === project.id));
  if (!card) throw new Error("lesson not found in project");
  return reviewLesson(project.path, id, status, by, note);
}

export interface LearningProposal {
  outcome: "none" | "candidate";
  reason: string;
  title?: string;
  summary?: string;
  when?: string;
  action?: string;
  tags?: string[];
}
export async function persistLearning(project: Project, task: Task, raw: string, author: string) {
  const proposal = JSON.parse(raw) as LearningProposal;
  if (!proposal || !["none", "candidate"].includes(proposal.outcome)) throw new Error("invalid learning outcome");
  const reason = limited(proposal.reason, 400);
  if (containsSecret(raw)) throw new Error("learning proposal contains possible credentials");
  if (proposal.outcome === "none") return { outcome: "none" as const, reason, lessonIds: [] };
  // Host supplies actual task and verified head evidence, never a model-invented pointer.
  const card: Omit<Lesson, "updated_at"> = {
    id: `lesson_${createHash("sha256").update(`${task.id}:${task.integrationHead}`).digest("hex").slice(0, 16)}`,
    title: proposal.title!, summary: proposal.summary!, when: proposal.when!, action: proposal.action!, tags: proposal.tags!,
    project: project.id, evidence: [`task:${task.id}`, `git:${task.integrationHead}`], source_task_id: task.id,
    reuse_reason: reason, authored_by: author, status: "candidate",
  };
  const temp = await mkdtemp(join(tmpdir(), "crewvane-learning-"));
  try {
    const file = join(temp, `${newId("proposal")}.json`);
    await writeFile(file, JSON.stringify(card), { mode: 0o600 });
    const result = await addLesson(project.path, file, { auto: true });
    return { outcome: "candidate" as const, reason: redact(reason), lessonIds: [result.id] };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function knowledgeEnabled(project: Project) {
  return (await readTeam(project.path))?.config.learning_required ?? false;
}
