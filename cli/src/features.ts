import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface FeatureViolation {
  id: string;
  rule: "unknown_feature";
}

const ID_CELL = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Ids named as `feature:<id>` in a contract. Placeholders such as `feature:<id>` are ignored. */
export function featureIdsReferenced(markdown: string): string[] {
  const pattern = /(?:^|[^A-Za-z0-9_])feature:([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/g;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of markdown.matchAll(pattern)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/^`+|`+$/g, "").trim());
}

function isSeparator(row: readonly string[]): boolean {
  return row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * Ids from the Features table in an e2e index.
 * Returns null when that table is absent, so callers leave existing checks unchanged.
 */
export function parseFeatureIds(markdown: string): string[] | null {
  const lines = markdown.split(/\r?\n/);
  let inSection = false;
  const table: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      if (inSection) break;
      inSection = /^##\s+Features\b/i.test(line);
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith("|")) {
      table.push(line);
      continue;
    }
    if (table.length > 0) break;
  }
  const headerLine = table[0];
  if (!headerLine) return null;
  const header = cells(headerLine);
  const idIndex = header.findIndex((cell) => cell.toLowerCase() === "id");
  if (idIndex < 0) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const line of table.slice(1)) {
    const row = cells(line);
    if (isSeparator(row)) continue;
    const id = row[idIndex] ?? "";
    if (!ID_CELL.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Unknown `feature:<id>` refs. Empty when the contract names none, the index is missing, or it has no Features table. */
export async function featureViolationsInContract(root: string, contractMarkdown: string): Promise<FeatureViolation[]> {
  const referenced = featureIdsReferenced(contractMarkdown);
  if (referenced.length === 0) return [];
  const indexPath = join(root, ".crewvane", "e2e", "index.md");
  let index: string;
  try {
    index = await readFile(indexPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
  const known = parseFeatureIds(index);
  if (known === null) return [];
  const knownSet = new Set(known);
  return referenced.filter((id) => !knownSet.has(id)).map((id) => ({ id, rule: "unknown_feature" as const }));
}
