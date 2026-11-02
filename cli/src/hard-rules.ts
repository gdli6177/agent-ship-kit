import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readInbox } from "./inbox.js";
import { pathMatches, type PathViolation } from "./paths.js";
import { withLock } from "./storage.js";
import type { InboxRecord } from "./types.js";

/** Local hard rules. The file is gitignored with the rest of `.agent-ship/`.
 * It binds clones that have the file and the kit hook. It is not shared CI.
 */
export const HARD_RULES_FILE = "hard-rules.json";
export const FEEDBACK_TAGS_FILE = "feedback-tags.json";

export const HARD_RULE_KINDS = ["hook", "contract_forbidden", "verify_checklist"] as const;
export type HardRuleKind = (typeof HARD_RULE_KINDS)[number];

const RULE_ID = /^hr_[A-Za-z0-9_-]+$/;
const INBOX_ID = /^evt_[A-Za-z0-9_-]+$/;
const GLOB = /^[\w./@*?-]+$/;
const TAG = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_RULES = 100;
const MAX_PATHS = 32;
const MAX_TEXT = 280;
const MAX_HINT = 200;
const STORE_BYTES = 262144;

const SECRET_PATTERNS = [
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|token|cookie)\s*[:=]\s*\S{6,}/i,
  /\bBearer\s+\S{8,}/i,
  /\b(?:ghp|github_pat|xox[baprs]|AKIA)[_-][A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/,
];

export interface HardRuleSource {
  inbox_id?: string;
  text?: string;
}

export interface HardRule {
  id: string;
  kind: HardRuleKind;
  source: HardRuleSource;
  paths: string[];
  message: string;
  command_hint?: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
}

export interface HardRulesFile {
  version: 1;
  rules: HardRule[];
}

export interface ChecklistHit {
  id: string;
  message: string;
  paths: string[];
  matched: string[];
  command_hint?: string;
}

export interface PromoteInput {
  id?: string;
  kind: HardRuleKind;
  inboxId?: string;
  sourceText?: string;
  message: string;
  paths: string[];
  commandHint?: string;
  tags?: string[];
}

export interface PromoteResult extends HardRule {
  action: "created" | "updated";
}

interface FeedbackTags {
  version: 1;
  counts: Record<string, number>;
}

export function hardRulesPath(root: string): string {
  return join(root, ".agent-ship", HARD_RULES_FILE);
}

export function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export function assertRuleKind(value: string): HardRuleKind {
  if (value === "hook") return "hook";
  if (value === "contract" || value === "contract_forbidden") return "contract_forbidden";
  if (value === "verify" || value === "verify_checklist") return "verify_checklist";
  throw new Error("kind must be one of: hook, contract, verify");
}

export function assertPromoteChoice(value: string): "none" | HardRuleKind {
  if (value === "none") return "none";
  return assertRuleKind(value);
}

export function assertTag(value: string): string {
  const tag = value.trim();
  if (!TAG.test(tag)) throw new Error("tag must match [a-z0-9][a-z0-9_-]{0,39}");
  return tag;
}

function singleLine(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (/[\r\n\0]/.test(trimmed)) throw new Error(`${label} must be a single line`);
  if (trimmed.length > max) throw new Error(`${label} must be at most ${max} characters`);
  if (containsSecret(trimmed)) throw new Error(`${label} looks like a secret; refusing to store it`);
  return trimmed;
}

function assertGlob(value: string): string {
  const token = value.trim();
  if (!token) throw new Error("glob is required");
  if (token.startsWith("/") || token.split("/").includes("..")) {
    throw new Error("globs must be repository-relative");
  }
  if (!GLOB.test(token)) throw new Error(`glob ${token} has unsupported characters`);
  if (containsSecret(token)) throw new Error("glob looks like a secret; refusing to store it");
  return token;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function normalizePromoteInput(input: PromoteInput): PromoteInput {
  const kind = input.kind;
  if (!HARD_RULE_KINDS.includes(kind)) throw new Error("kind must be one of: hook, contract, verify");
  const id = input.id === undefined ? undefined : input.id.trim();
  if (id !== undefined && !RULE_ID.test(id)) throw new Error("rule id must match hr_[A-Za-z0-9_-]+");
  const inboxId = input.inboxId === undefined ? undefined : input.inboxId.trim();
  if (inboxId !== undefined && !INBOX_ID.test(inboxId)) throw new Error("inbox id must match evt_[A-Za-z0-9_-]+");
  const sourceText = input.sourceText === undefined ? undefined : singleLine(input.sourceText, "source", MAX_TEXT);
  if (!inboxId && !sourceText) throw new Error("pass --inbox or --source");
  const message = singleLine(input.message, "message", MAX_TEXT);
  const paths = dedupe((input.paths ?? []).map(assertGlob));
  if (paths.length > MAX_PATHS) throw new Error(`a hard rule can list at most ${MAX_PATHS} globs`);
  if (kind !== "verify_checklist" && paths.length === 0) {
    throw new Error("--glob is required for hook and contract rules");
  }
  const commandHint = input.commandHint === undefined ? undefined : singleLine(input.commandHint, "command hint", MAX_HINT);
  if (commandHint !== undefined && /[$`;|&<>\\]/.test(commandHint)) {
    throw new Error("command hint must be a single literal line");
  }
  const tags = dedupe((input.tags ?? []).map(assertTag));
  if (tags.length > 8) throw new Error("a hard rule can list at most 8 tags");
  return { id, kind, inboxId, sourceText, message, paths, commandHint, tags };
}

function sourceOf(input: PromoteInput): HardRuleSource {
  const source: HardRuleSource = {};
  if (input.inboxId) source.inbox_id = input.inboxId;
  if (input.sourceText) source.text = input.sourceText;
  return source;
}

function buildRule(id: string, input: PromoteInput, createdAt: string, updatedAt: string): HardRule {
  const rule: HardRule = {
    id,
    kind: input.kind,
    source: sourceOf(input),
    paths: input.paths,
    message: input.message,
    created_at: createdAt,
    updated_at: updatedAt,
  };
  if (input.commandHint) rule.command_hint = input.commandHint;
  if (input.tags && input.tags.length > 0) rule.tags = input.tags;
  if (containsSecret(JSON.stringify(rule))) throw new Error("hard rule looks like a secret; refusing to store it");
  return rule;
}

function allocateId(rules: readonly HardRule[], input: PromoteInput): string {
  if (input.id) return input.id;
  if (input.inboxId) {
    const base = `hr_${input.inboxId}`;
    if (!rules.some((rule) => rule.id === base)) return base;
  }
  const slug = input.message.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "rule";
  let candidate = `hr_${slug}`;
  let suffix = 2;
  while (rules.some((rule) => rule.id === candidate)) {
    candidate = `hr_${slug}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseRule(value: unknown, index: number): HardRule {
  const label = `hard-rules.json rules[${index}]`;
  const record = asObject(value, label);
  const id = record.id;
  const kind = record.kind;
  if (typeof id !== "string" || !RULE_ID.test(id)) throw new Error(`${label} has an invalid id`);
  if (kind !== "hook" && kind !== "contract_forbidden" && kind !== "verify_checklist") {
    throw new Error(`${label} has an invalid kind`);
  }
  const source = asObject(record.source, `${label}.source`);
  const inboxId = source.inbox_id;
  const text = source.text;
  if (inboxId !== undefined && (typeof inboxId !== "string" || !INBOX_ID.test(inboxId))) {
    throw new Error(`${label}.source.inbox_id is invalid`);
  }
  if (text !== undefined && (typeof text !== "string" || text.trim() === "")) {
    throw new Error(`${label}.source.text is invalid`);
  }
  if (inboxId === undefined && text === undefined) throw new Error(`${label}.source is empty`);
  if (!Array.isArray(record.paths) || !record.paths.every((item) => typeof item === "string")) {
    throw new Error(`${label}.paths must be an array of strings`);
  }
  if (kind !== "verify_checklist" && record.paths.length === 0) throw new Error(`${label} needs at least one path`);
  if (typeof record.message !== "string" || record.message.trim() === "") throw new Error(`${label}.message is required`);
  const hint = record.command_hint;
  if (hint !== undefined && typeof hint !== "string") throw new Error(`${label}.command_hint is invalid`);
  const tags = record.tags;
  if (tags !== undefined && (!Array.isArray(tags) || !tags.every((item) => typeof item === "string"))) {
    throw new Error(`${label}.tags must be an array of strings`);
  }
  const created = record.created_at;
  const updated = record.updated_at;
  if (typeof created !== "string" || typeof updated !== "string") throw new Error(`${label} is missing timestamps`);
  const rule: HardRule = {
    id,
    kind,
    source: {
      ...(typeof inboxId === "string" ? { inbox_id: inboxId } : {}),
      ...(typeof text === "string" ? { text } : {}),
    },
    paths: record.paths as string[],
    message: record.message,
    created_at: created,
    updated_at: updated,
  };
  if (typeof hint === "string") rule.command_hint = hint;
  if (Array.isArray(tags)) rule.tags = tags as string[];
  const secretSurface = [rule.message, rule.source.text ?? "", rule.command_hint ?? "", ...(rule.tags ?? [])].join("\n");
  if (containsSecret(secretSurface)) throw new Error(`hard rule ${id} contains a secret; remove it from hard-rules.json`);
  return rule;
}

function parseStore(value: unknown): HardRulesFile {
  const record = asObject(value, "hard-rules.json");
  if (record.version !== 1) throw new Error("hard-rules.json version must be 1");
  if (!Array.isArray(record.rules)) throw new Error("hard-rules.json rules must be an array");
  if (record.rules.length > MAX_RULES) throw new Error(`hard-rules.json can list at most ${MAX_RULES} rules`);
  const rules = record.rules.map((item, index) => parseRule(item, index));
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new Error(`duplicate hard rule id ${rule.id}`);
    seen.add(rule.id);
  }
  return { version: 1, rules };
}

export async function loadHardRules(root: string): Promise<HardRulesFile> {
  let raw: string;
  try {
    raw = await readFile(hardRulesPath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, rules: [] };
    throw error;
  }
  if (raw.length > STORE_BYTES) throw new Error("hard-rules.json exceeds its size limit");
  try {
    return parseStore(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("hard-rules.json is not valid JSON");
    throw error;
  }
}

async function writeStore(root: string, store: HardRulesFile): Promise<void> {
  const directory = join(root, ".agent-ship");
  await mkdir(directory, { recursive: true });
  const file = hardRulesPath(root);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`);
  await rename(tmp, file);
}

export async function promoteHardRule(root: string, input: PromoteInput, now = new Date()): Promise<PromoteResult> {
  const normalized = normalizePromoteInput(input);
  return withLock(join(root, ".agent-ship"), async () => {
    if (normalized.inboxId) {
      const items = await readInbox(root);
      if (!items.some((item) => item.id === normalized.inboxId)) {
        throw new Error(`inbox has no item ${normalized.inboxId}`);
      }
    }
    const store = await loadHardRules(root);
    const byId = normalized.id ? store.rules.find((rule) => rule.id === normalized.id) : undefined;
    const byInbox = normalized.inboxId
      ? store.rules.find((rule) => rule.kind === normalized.kind && rule.source.inbox_id === normalized.inboxId)
      : undefined;
    if (byId && byInbox && byId.id !== byInbox.id) {
      throw new Error(`hard rule for this inbox item already exists as ${byInbox.id}; pass --id ${byInbox.id} to update it`);
    }
    const existing = byId ?? byInbox;
    if (!existing && store.rules.length >= MAX_RULES) {
      throw new Error(`hard-rules.json can list at most ${MAX_RULES} rules`);
    }
    const stamp = now.toISOString();
    const id = existing?.id ?? allocateId(store.rules, normalized);
    const merged: PromoteInput = {
      ...normalized,
      inboxId: normalized.inboxId ?? existing?.source.inbox_id,
      sourceText: normalized.sourceText ?? existing?.source.text,
    };
    const rule = buildRule(id, merged, existing?.created_at ?? stamp, stamp);
    if (existing) {
      const index = store.rules.findIndex((item) => item.id === existing.id);
      if (index < 0) throw new Error(`hard rule ${existing.id} disappeared`);
      store.rules.splice(index, 1, rule);
    } else {
      store.rules.push(rule);
    }
    await writeStore(root, store);
    return { ...rule, action: existing ? "updated" : "created" };
  });
}

export function matchHardRules(files: readonly string[], rules: readonly HardRule[]): {
  violations: PathViolation[];
  checklist: ChecklistHit[];
} {
  const normalized = files
    .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((file) => file.length > 0);
  const violations: PathViolation[] = [];
  const checklist: ChecklistHit[] = [];
  for (const rule of rules) {
    const matched = normalized.filter((file) => rule.paths.some((pattern) => pathMatches(file, pattern)));
    if (rule.kind === "verify_checklist") {
      if (rule.paths.length === 0 || matched.length > 0) {
        const hit: ChecklistHit = { id: rule.id, message: rule.message, paths: rule.paths, matched };
        if (rule.command_hint) hit.command_hint = rule.command_hint;
        checklist.push(hit);
      }
      continue;
    }
    for (const file of matched) {
      violations.push({
        path: file,
        rule: "hard_rule",
        pattern: rule.paths.find((pattern) => pathMatches(file, pattern)) ?? null,
        rule_id: rule.id,
        kind: rule.kind,
        message: rule.message,
      });
    }
  }
  return { violations, checklist };
}

export function repeatedNoteCount(items: readonly InboxRecord[], note: string): number {
  const key = note.trim().toLowerCase();
  if (!key) return 0;
  let count = 0;
  for (const item of items) {
    if (item.type === "review_decided" && item.decision === "changes_requested" && item.note?.trim().toLowerCase() === key) {
      count += 1;
    }
  }
  return count;
}

function feedbackTagsPath(root: string): string {
  return join(root, ".agent-ship", FEEDBACK_TAGS_FILE);
}

async function readFeedbackTags(root: string): Promise<FeedbackTags> {
  let raw: string;
  try {
    raw = await readFile(feedbackTagsPath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, counts: {} };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("feedback-tags.json is not valid JSON");
  }
  const record = asObject(parsed, "feedback-tags.json");
  if (record.version !== 1 || !record.counts || typeof record.counts !== "object" || Array.isArray(record.counts)) {
    throw new Error("feedback-tags.json is invalid");
  }
  const counts: Record<string, number> = {};
  for (const [tag, count] of Object.entries(record.counts as Record<string, unknown>)) {
    if (!TAG.test(tag) || typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      throw new Error("feedback-tags.json is invalid");
    }
    counts[tag] = count;
  }
  return { version: 1, counts };
}

export async function noteFeedbackTags(root: string, tags: readonly string[]): Promise<{ tag: string; count: number }[]> {
  const unique = dedupe(tags.map(assertTag));
  if (unique.length === 0) return [];
  return withLock(join(root, ".agent-ship"), async () => {
    const store = await readFeedbackTags(root);
    const noted = unique.map((tag) => {
      const count = (store.counts[tag] ?? 0) + 1;
      store.counts[tag] = count;
      return { tag, count };
    });
    const directory = join(root, ".agent-ship");
    await mkdir(directory, { recursive: true });
    const file = feedbackTagsPath(root);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`);
    await rename(tmp, file);
    return noted;
  });
}

export function promotionSuggestions(tagCounts: readonly { tag: string; count: number }[], noteCount: number): string[] {
  const lines: string[] = [];
  for (const item of tagCounts) {
    if (item.count >= 2) lines.push(`suggest promote: tag "${item.tag}" count ${item.count}`);
  }
  if (noteCount >= 2) lines.push(`suggest promote: changes_requested note repeated ${noteCount} times`);
  return lines;
}
