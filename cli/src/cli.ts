import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { addInboxItem, assertPriority, listInbox } from "./inbox.js";
import { loadAllowlistFile, loadPolicyFile, planNotification, type NotifyEvent } from "./notify.js";
import type { EventLinks, NeedsReviewEvent, Priority } from "./types.js";

export interface Io {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

const defaultIo: Io = {
  stdout: (chunk) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk) => {
    process.stderr.write(chunk);
  },
};

const USAGE = `agent-ship — local inbox and notify dry-run

Usage:
  agent-ship inbox add --title TEXT --summary TEXT --source-task-id ID
                       [--priority normal|high] [--evidence URL ...]
                       [--pr URL] [--issue URL] [--path PATH]
                       [--id evt_...] [--root DIR]
  agent-ship inbox list [--priority normal|high] [--json] [--root DIR]
  agent-ship notify dry-run --policy FILE --allowlist FILE
                       (--latest | --event FILE) [--root DIR]

The inbox is <root>/.agent-ship/inbox.jsonl (root defaults to the working directory).
notify dry-run prints a plan and does not start a command. There is no execute command.
`;

const VALUE_OPTIONS = new Set([
  "title",
  "summary",
  "priority",
  "source-task-id",
  "evidence",
  "pr",
  "issue",
  "path",
  "id",
  "root",
  "policy",
  "allowlist",
  "event",
]);
const REPEATABLE = new Set(["evidence"]);
const BOOL_FLAGS = new Set(["json", "latest", "help"]);

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") {
      for (const rest of argv.slice(index + 1)) {
        if (rest !== undefined) positionals.push(rest);
      }
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    if (!name) throw new Error("empty flag");
    if (BOOL_FLAGS.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} does not take a value`);
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`unknown flag --${name}`);
    const next = argv[index + 1];
    const value = inline !== undefined ? inline : next;
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new Error(`--${name} requires a value`);
    }
    if (inline === undefined) index += 1;
    const existing = values.get(name) ?? [];
    if (existing.length > 0 && !REPEATABLE.has(name)) {
      throw new Error(`--${name} was given more than once`);
    }
    existing.push(value);
    values.set(name, existing);
  }

  return { positionals, values, flags };
}

function one(values: Map<string, string[]>, name: string): string | undefined {
  const all = values.get(name);
  if (!all || all.length === 0) return undefined;
  return all[0];
}

function requireOne(values: Map<string, string[]>, name: string): string {
  const value = one(values, name);
  if (value === undefined || value.trim() === "") throw new Error(`--${name} is required`);
  return value;
}

function formatRow(priority: string, created: string, id: string, title: string): string {
  return `${priority.padEnd(8)}  ${created.padEnd(24)}  ${id.padEnd(28)}  ${title}`;
}

function formatList(items: NeedsReviewEvent[]): string {
  if (items.length === 0) return "inbox empty\n";
  const lines = [formatRow("priority", "created_at", "id", "title")];
  for (const item of items) {
    lines.push(formatRow(item.priority, item.created_at, item.id, item.title));
  }
  return `${lines.join("\n")}\n`;
}

async function readEventFile(path: string): Promise<NotifyEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`event file is not valid JSON: ${path}`);
    throw error;
  }
  if (!parsed || typeof parsed !== "object") throw new Error("event must be a JSON object");
  const event = parsed as Record<string, unknown>;
  if (typeof event.id !== "string" || event.id.trim() === "") throw new Error("event.id is required");
  if (typeof event.type !== "string" || event.type.trim() === "") throw new Error("event.type is required");
  return event as unknown as NotifyEvent;
}

async function inboxAdd(parsed: ParsedArgs, io: Io): Promise<number> {
  const priorityText = one(parsed.values, "priority");
  const priority: Priority | undefined = priorityText === undefined ? undefined : assertPriority(priorityText);
  const root = one(parsed.values, "root") ?? process.cwd();
  const links: EventLinks = {};
  const pr = one(parsed.values, "pr");
  const issue = one(parsed.values, "issue");
  const path = one(parsed.values, "path");
  if (pr) links.pr = pr;
  if (issue) links.issue = issue;
  if (path) links.path = path;

  const evidence = parsed.values.get("evidence") ?? [];
  const event = await addInboxItem(root, {
    title: requireOne(parsed.values, "title"),
    summary: requireOne(parsed.values, "summary"),
    sourceTaskId: requireOne(parsed.values, "source-task-id"),
    priority,
    evidenceUrls: evidence,
    links,
    id: one(parsed.values, "id"),
  });
  if (event.priority === "high" && event.evidence_urls.length === 0) {
    io.stderr("warning: high priority needs_review has no evidence URLs\n");
  }
  io.stdout(`${JSON.stringify(event, null, 2)}\n`);
  return 0;
}

async function inboxList(parsed: ParsedArgs, io: Io): Promise<number> {
  const priorityText = one(parsed.values, "priority");
  const priority = priorityText === undefined ? undefined : assertPriority(priorityText);
  const root = one(parsed.values, "root") ?? process.cwd();
  const items = await listInbox(root, priority);
  if (parsed.flags.has("json")) {
    io.stdout(`${JSON.stringify(items, null, 2)}\n`);
    return 0;
  }
  io.stdout(formatList(items));
  return 0;
}

async function notifyDryRun(parsed: ParsedArgs, io: Io): Promise<number> {
  const root = one(parsed.values, "root") ?? process.cwd();
  const policyPath = requireOne(parsed.values, "policy");
  const allowlistPath = requireOne(parsed.values, "allowlist");
  const eventPath = one(parsed.values, "event")?.trim();
  const latest = parsed.flags.has("latest");
  if (latest === Boolean(eventPath)) {
    throw new Error("pass exactly one of --latest or --event FILE");
  }

  let event: NotifyEvent;
  if (eventPath) {
    event = await readEventFile(eventPath);
  } else {
    const items = await listInbox(root);
    const newest = items[items.length - 1];
    if (!newest) throw new Error("inbox is empty; add an item or pass --event");
    event = newest;
  }

  const rules = await loadPolicyFile(policyPath);
  const allowlist = await loadAllowlistFile(allowlistPath);
  const plan = planNotification(event, rules, allowlist);
  io.stdout(`${JSON.stringify(plan, null, 2)}\n`);
  return 0;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    io.stderr(USAGE);
    return 1;
  }

  if (parsed.flags.has("help") || parsed.positionals.length === 0) {
    io.stdout(USAGE);
    return 0;
  }

  const [group, sub] = parsed.positionals;
  try {
    if (group === "inbox" && sub === "add") return await inboxAdd(parsed, io);
    if (group === "inbox" && sub === "list") return await inboxList(parsed, io);
    if (group === "notify" && sub === "dry-run") return await notifyDryRun(parsed, io);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  io.stderr(USAGE);
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
