import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReference, boundedText, readTeam } from "./team.js";
import { safeId, safeText, sliceRows } from "./records.js";

export interface RoleCard {
  id: string;
  purpose: string;
  may_see: string[];
  default_allowed_paths: string[];
  forbidden_paths: string[];
  must_produce: string[];
  lesson_tags: string[];
  out_of_scope: string[];
}
const arrayKeys = ["may_see", "default_allowed_paths", "forbidden_paths", "must_produce", "lesson_tags", "out_of_scope"] as const;
const keys = ["id", "purpose", ...arrayKeys];
function scalar(value: string): string {
  const raw = value.trim();
  if (/^[&*!|>]/.test(raw)) throw new Error("role cards support flat YAML scalars/lists only");
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}
/** Deliberately limited portable frontmatter: no YAML tags, aliases or host-specific fields. */
export function parseRole(markdown: string): RoleCard {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("role card needs YAML frontmatter");
  const record: Record<string, unknown> = {};
  let current = "";
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && Array.isArray(record[current])) { (record[current] as string[]).push(scalar(item[1]!)); continue; }
    const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!pair || !keys.includes(pair[1]!) || Object.hasOwn(record, pair[1]!)) throw new Error("invalid/duplicate role field; runtime/model and memory do not belong in portable role cards");
    current = pair[1]!;
    const value = pair[2]!.trim();
    if (arrayKeys.includes(current as typeof arrayKeys[number])) {
      if (!value) record[current] = [];
      else if (value.startsWith("[") && value.endsWith("]")) record[current] = value.slice(1, -1).trim() ? value.slice(1, -1).split(",").map(scalar) : [];
      else throw new Error(`role ${current} must be a list`);
    } else record[current] = scalar(value);
  }
  const id = safeId(safeText(String(record.id ?? ""), "role id", 80));
  const purpose = safeText(String(record.purpose ?? ""), "role purpose", 240);
  for (const key of arrayKeys) {
    if (!Array.isArray(record[key]) || record[key].length > 24) throw new Error(`role ${key} must be a bounded list`);
    record[key] = (record[key] as unknown[]).map(value => {
      if (typeof value !== "string") throw new Error(`role ${key} entries must be text`);
      const item = safeText(value, `role ${key}`, 400);
      if (key.includes("paths") && (item.startsWith("/") || item.split(/[/\\]/).includes(".."))) throw new Error("role paths must be repository-relative");
      return item;
    });
  }
  if (!(record.must_produce as string[]).length) throw new Error("role must_produce cannot be empty");
  return { ...record, id, purpose } as unknown as RoleCard;
}
const builtinDirectory = fileURLToPath(new URL("../../templates/roles/", import.meta.url));
async function roleDirectory(root: string): Promise<string> {
  return resolve(root, (await readTeam(root))?.config.roles ?? ".agents/team/roles");
}
export async function showRole(root: string, id: string) {
  safeId(id);
  for (const directory of [await roleDirectory(root), builtinDirectory]) {
    const path = join(directory, `${id}.md`);
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("role cards cannot be symlinks");
      const source = await realpath(path); assertReference(source);
      const markdown = await boundedText(source);
      const card = parseRole(markdown);
      if (card.id !== id) throw new Error("role filename/id mismatch");
      return { card, source, markdown };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new Error(`role not found: ${id}`);
}
export async function listRoles(root: string) {
  const names = new Set<string>();
  for (const directory of [builtinDirectory, await roleDirectory(root)]) {
    for (const name of await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })) {
      if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.md$/.test(name)) names.add(name.slice(0, -3));
    }
  }
  const cards = [];
  for (const id of [...names].sort()) { const role = await showRole(root, id); cards.push({ ...role.card, source: role.source }); }
  return cards;
}
export async function contractRoles(root: string, markdown: string, slice?: string) {
  const rows = sliceRows(markdown);
  if (slice && !rows.some(row => row.id === slice)) throw new Error(`slice ${slice} is not in the Slices table`);
  const ids = [...new Set((slice ? rows.filter(row => row.id === slice) : rows).map(row => row.role))];
  const roles = [];
  for (const id of ids.length ? ids : ["generic-worker"]) roles.push(await showRole(root, id));
  return roles;
}

/** Defaults never grant scope; make disagreement visible instead of silently replacing it. */
export function roleWarnings(roles: { card: RoleCard }[], allowed: string[]): string[] {
  return roles.filter(role => role.card.default_allowed_paths.length && JSON.stringify(role.card.default_allowed_paths) !== JSON.stringify(allowed))
    .map(role => `Role ${role.card.id} default_allowed_paths differ from frozen scope; contract Allowed paths take precedence.`);
}
