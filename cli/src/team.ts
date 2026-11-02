import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const TEAM_CONFIG = "agent-ship.team.json";
export const DEFAULT_HANDBOOK = "docs/agent-team/handbook.md";
export const DEFAULT_LESSONS = "docs/agent-team/lessons";
export interface TeamConfig {
  version: 1;
  handbook: string | null;
  rules: string[];
  lessons: string;
  learning_required: boolean;
  max_lessons: number;
  summary_chars: number;
}
export interface TeamProfile { config: TeamConfig; source: string }

export function assertReference(path: string): void {
  if (!path.trim() || /[\r\n\0]/.test(path) || /(^|[/\\])(?:\.env[^/\\]*|secrets|credentials|private-exports)([/\\]|$)/i.test(path) || /(?:storage[-_]?state|cookies?)\.json$|\.(?:db|sqlite|sqlite3)$/i.test(path)) throw new Error("unsafe team source path");
}
export async function optionalText(path: string): Promise<string | null> {
  try { const actual = await realpath(path); assertReference(actual); return await readFile(actual, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function boundedText(path: string, bytes = 16384): Promise<string> {
  if ((await stat(path)).size > bytes) throw new Error("team/lesson document exceeds its size limit");
  return readFile(path, "utf8");
}
export function parseJson(raw: string, label: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw new Error(`${label} is not valid JSON`); }
}
function parseConfig(value: unknown): TeamConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("team config must be an object");
  const c = value as Record<string, unknown>;
  const keys = ["version", "handbook", "rules", "lessons", "learning_required", "max_lessons", "summary_chars"];
  if (Object.keys(c).some((key) => !keys.includes(key)) || c.version !== 1 || (c.handbook !== null && typeof c.handbook !== "string") || !Array.isArray(c.rules) || !c.rules.every((item) => typeof item === "string") || typeof c.lessons !== "string" || typeof c.learning_required !== "boolean") throw new Error("invalid team config");
  if (typeof c.max_lessons !== "number" || !Number.isInteger(c.max_lessons) || c.max_lessons < 0 || c.max_lessons > 10 || typeof c.summary_chars !== "number" || !Number.isInteger(c.summary_chars) || c.summary_chars < 0 || c.summary_chars > 20000) throw new Error("invalid lesson retrieval budget");
  for (const path of [c.handbook, ...c.rules, c.lessons]) if (typeof path === "string") assertReference(path);
  return c as unknown as TeamConfig;
}
export async function readTeam(root: string): Promise<TeamProfile | undefined> {
  for (const source of [join(root, TEAM_CONFIG), join(root, ".agent-ship/team.json")]) {
    const raw = await optionalText(source);
    if (raw !== null) {
      if (raw.length > 16384) throw new Error("team config exceeds its size limit");
      return { config: parseConfig(parseJson(raw, "team config")), source };
    }
  }
  return undefined;
}

/** References can be outside the project; CLI writes must stay inside the owner root. */
export async function ownedDirectory(root: string, path: string): Promise<string> {
  assertReference(path);
  const owner = await realpath(root);
  const requested = resolve(owner, path);
  let existing = requested;
  const suffix: string[] = [];
  for (;;) {
    try { existing = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(relative(parent, existing)); existing = parent;
    }
  }
  const destination = join(existing, ...suffix);
  const rel = relative(owner, destination);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("external team sources are read-only; use the source owner's workflow to write");
  return destination;
}

async function createOnce(root: string, path: string, text: string) {
  const parent = await ownedDirectory(root, dirname(path));
  await mkdir(parent, { recursive: true });
  try { await writeFile(join(parent, path.split(/[/\\]/).pop()!), text, { flag: "wx" }); return { path, action: "created" as const }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return { path, action: "unchanged" as const }; throw error; }
}

async function removeLocalTeamCopy(root: string): Promise<void> {
  await rm(join(root, ".agent-ship", "team.json"), { force: true });
}

export async function initializeTeam(root: string, options: { shared: boolean; kit: string; handbook?: string; lessons?: string }) {
  const shared = await optionalText(join(root, TEAM_CONFIG));
  const local = await optionalText(join(root, ".agent-ship/team.json"));
  const existing = shared !== null ? parseConfig(parseJson(shared, "team config")) : local !== null ? parseConfig(parseJson(local, "team config")) : undefined;
  if (shared !== null || (!options.shared && existing)) {
    if ((options.handbook && options.handbook !== existing?.handbook) || (options.lessons && options.lessons !== existing?.lessons)) throw new Error("team sources already configured; edit the owner config explicitly instead of overwriting it");
    if (shared !== null) await removeLocalTeamCopy(root);
    return [{ path: shared !== null ? TEAM_CONFIG : ".agent-ship/team.json", action: "unchanged" as const }];
  }
  let handbook = options.handbook ?? existing?.handbook ?? null;
  if (handbook !== null) {
    assertReference(handbook);
    if (!/\.md$/i.test(handbook) || !(await stat(resolve(root, handbook))).isFile()) throw new Error("handbook must reference an existing Markdown file");
  } else {
    for (const candidate of [DEFAULT_HANDBOOK, "TEAM.md", "docs/TEAM.md", "docs/team/handbook.md"]) {
      if (await optionalText(join(root, candidate)) !== null) { handbook = candidate; break; }
    }
  }
  const actions: { path: string; action: "created" | "unchanged" }[] = [];
  if (options.shared && !handbook) {
    handbook = DEFAULT_HANDBOOK;
    actions.push(await createOnce(root, handbook, await readFile(join(options.kit, "templates/team-handbook.md"), "utf8")));
  }
  const learning_required = options.shared ? true : (existing?.learning_required ?? false);
  const config: TeamConfig = { version: 1, handbook, rules: existing?.rules ?? [], lessons: options.lessons ?? (options.shared && existing?.lessons === ".agent-ship/lessons" ? DEFAULT_LESSONS : existing?.lessons) ?? (options.shared ? DEFAULT_LESSONS : ".agent-ship/lessons"), learning_required, max_lessons: existing?.max_lessons ?? 3, summary_chars: existing?.summary_chars ?? 1200 };
  parseConfig(config);
  if (options.shared && config.lessons === DEFAULT_LESSONS) actions.push(await createOnce(root, `${DEFAULT_LESSONS}/README.md`, await readFile(join(options.kit, "templates/lesson-index.md"), "utf8")));
  const destination = options.shared ? TEAM_CONFIG : ".agent-ship/team.json";
  actions.push(await createOnce(root, destination, `${JSON.stringify(config, null, 2)}\n`));
  if (options.shared) await removeLocalTeamCopy(root);
  return actions;
}

export async function requiredSources(root: string, repo = root): Promise<string[]> {
  const sources = new Set<string>();
  for (const location of [...new Set([root, repo])]) {
    const profile = await readTeam(location);
    for (const reference of [profile?.config.handbook, ...(profile?.config.rules ?? [])]) {
      if (!reference) continue;
      assertReference(reference);
      if (!/\.md$/i.test(reference)) throw new Error("rule references must be Markdown files");
      const path = await realpath(resolve(location, reference));
      assertReference(path);
      if (!(await stat(path)).isFile()) throw new Error("required team source is not a file");
      sources.add(path);
    }
    if (await optionalText(join(location, "AGENTS.md")) !== null) sources.add(await realpath(join(location, "AGENTS.md")));
    if (await optionalText(join(location, ".agent-ship/AGENTS.local.md")) !== null) sources.add(await realpath(join(location, ".agent-ship/AGENTS.local.md")));
  }
  return [...sources];
}
