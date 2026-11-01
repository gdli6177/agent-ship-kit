import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  addInboxItem,
  assertAttentionType,
  assertBlockReason,
  assertDecision,
  assertPriority,
  decideInboxItem,
  listInbox,
} from "./inbox.js";
import { loadAllowlistFile, loadPolicyFile, planNotification, type NotifyEvent } from "./notify.js";
import { executeArgv } from "./run.js";
import { checkContract } from "./check.js";
import { setupProject } from "./setup.js";
import { addLesson, checkLearning, reviewLesson, showLesson, teamContext, pendingLearning } from "./learning.js";
import { activeSlices, installWatchdogTimer, runWatchdog, startSlice, updateSlice, timerIsActive, uninstallWatchdogTimer } from "./watchdog.js";
import type { AttentionType, EventLinks, InboxRecord, Priority } from "./types.js";

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

const USAGE = `agent-ship — local inbox, path check, and notify

Usage:
  agent-ship setup|init [--state-root DIR] [--shared] [--handbook FILE] [--lessons DIR] [--uninstall] [--purge] [--root DIR]
  agent-ship team context [--tag TAG ...] [--project ID] [--repo DIR] [--root DIR]
  agent-ship lesson search [--tag TAG ...] [--project ID] [--root DIR]
  agent-ship lesson show --id ID [--root DIR]
  agent-ship lesson add --input FILE [--root DIR]
  agent-ship lesson review --id ID --status active|needs_review|retired --reviewed-by REF --note TEXT [--review-after DATE] [--root DIR]
  agent-ship lesson check --source-task-id ID --outcome none|candidate --reason TEXT --reviewed-by REF [--candidate-id ID ...] [--trigger TYPE ...] [--root DIR]
  agent-ship lesson pending [--source-task-id ID] [--root DIR]
  agent-ship check --contract ID [--repo DIR] [--slice ID] [--base REF] [--head REF] [--staged] [--root DIR]
  agent-ship watchdog [--stale-minutes N] [--root DIR]
  agent-ship watchdog install|uninstall [--dry-run] [--root DIR]
  agent-ship slice start --contract ID --slice ID --source-task-id ID
                       --title TEXT --summary TEXT [--repo DIR] [--base REF] [--replace] [--worker REF] [--proposal ID] [--tag TAG ...] [--project ID] [--root DIR]
  agent-ship slice update --source-task-id ID --status STATUS [--summary TEXT] [--root DIR]
  agent-ship status --stale [--stale-minutes N] [--root DIR]
  agent-ship inbox add --title TEXT --summary TEXT --source-task-id ID
                       [--type needs_review|blocked|needs_approval]
                       [--priority normal|high] [--evidence URL ...]
                       [--pr URL] [--issue URL] [--path PATH]
                       [--id evt_...] [--root DIR]
  agent-ship inbox list [--type TYPE] [--priority normal|high]
                       [--sort priority] [--all] [--json] [--root DIR]
  agent-ship inbox decide ID accept|changes_requested|reject
                       [--note TEXT] [--root DIR]
  agent-ship notify dry-run --policy FILE --allowlist FILE
                       (--latest | --event FILE) [--action ARGV] [--root DIR]
  agent-ship notify run --policy FILE --allowlist FILE
                       (--latest | --event FILE) [--action ARGV] [--root DIR]

Captain-facing skills: /ship-setup, /ship-contract, /ship-dispatch, /ship-inbox [id], /ship-notify, /ship-e2e, /ship-watchdog.
setup is local to this clone: hooks go in .git/hooks only, and ignore rules
go in .git/info/exclude. Pass --shared to write a .gitignore block and a
shared AGENTS.md rules section, team profile and handbook. setup never sets core.hooksPath.
notify dry-run prints a plan and does not start a command.
notify run starts the allowlisted argv with no shell, and only when the plan allows it.
A high-priority needs_review with no evidence URLs is not paged.
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
  "type",
  "note",
  "action",
  "contract",
  "base",
  "head",
  "sort",
  "stale-minutes",
  "slice",
  "worker",
  "branch",
  "thread-pr",
  "thread-issue",
  "thread-chat",
  "reason",
  "repo",
  "state-root",
  "status",
  "handbook", "lessons", "tag", "project", "proposal", "input", "reviewed-by", "review-after", "outcome", "candidate-id", "trigger",
]);
const REPEATABLE = new Set(["evidence", "tag", "candidate-id", "trigger"]);
const BOOL_FLAGS = new Set(["json", "latest", "help", "all", "shared", "uninstall", "purge", "staged", "stale", "dry-run", "replace"]);

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

function formatRow(type: string, priority: string, id: string, title: string): string {
  return `${type.padEnd(16)}  ${priority.padEnd(8)}  ${id.padEnd(28)}  ${title}`;
}

function formatList(items: readonly InboxRecord[]): string {
  if (items.length === 0) return "inbox empty\n";
  const lines = [formatRow("type", "priority", "id", "title")];
  for (const item of items) {
    const priority = item.type === "review_decided" ? "-" : item.priority;
    lines.push(formatRow(item.type, priority, item.id, item.title));
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
  const typeText = one(parsed.values, "type");
  const type: AttentionType | undefined = typeText === undefined ? undefined : assertAttentionType(typeText);
  const event = await addInboxItem(root, {
    type,
    title: requireOne(parsed.values, "title"),
    summary: requireOne(parsed.values, "summary"),
    sourceTaskId: requireOne(parsed.values, "source-task-id"),
    priority,
    evidenceUrls: evidence,
    links,
    contractId: one(parsed.values, "contract"),
    sliceId: one(parsed.values, "slice"),
    workerRef: one(parsed.values, "worker"),
    branch: one(parsed.values, "branch"),
    threadRefs: {
      pr: one(parsed.values, "thread-pr"),
      issue: one(parsed.values, "thread-issue"),
      chat: one(parsed.values, "thread-chat"),
    },
    reason: one(parsed.values, "reason") ? assertBlockReason(one(parsed.values, "reason") as string) : undefined,
    id: one(parsed.values, "id"),
  });
  if (event.type === "needs_review" && event.priority === "high" && event.evidence_urls.length === 0) {
    io.stderr("warning: high priority needs_review has no evidence URLs and will not be paged\n");
  }
  io.stdout(`${JSON.stringify(event, null, 2)}\n`);
  return 0;
}

async function inboxList(parsed: ParsedArgs, io: Io): Promise<number> {
  const priorityText = one(parsed.values, "priority");
  const priority = priorityText === undefined ? undefined : assertPriority(priorityText);
  const typeText = one(parsed.values, "type");
  const type = typeText === undefined ? undefined : typeText === "review_decided" ? typeText : assertAttentionType(typeText);
  const root = one(parsed.values, "root") ?? process.cwd();
  const items = await listInbox(root, {
    priority,
    type,
    openOnly: !parsed.flags.has("all"),
  });
  await warnIfTimerInactive(root, io);
  if (one(parsed.values, "sort") === "priority") {
    const rank = (item: InboxRecord) => (item.type === "review_decided" ? 0 : item.priority === "high" ? 2 : 1);
    items.sort((left, right) => rank(right) - rank(left));
  }
  if (parsed.flags.has("json")) {
    io.stdout(`${JSON.stringify(items, null, 2)}\n`);
    return 0;
  }
  io.stdout(formatList(items));
  return 0;
}

async function inboxDecide(parsed: ParsedArgs, io: Io): Promise<number> {
  const subjectId = parsed.positionals[2];
  const decisionText = parsed.positionals[3];
  if (!subjectId || !decisionText) {
    throw new Error("usage: inbox decide <id> accept|changes_requested|reject");
  }
  const root = one(parsed.values, "root") ?? process.cwd();
  const event = await decideInboxItem(root, subjectId, assertDecision(decisionText), one(parsed.values, "note"));
  io.stdout(`${JSON.stringify(event, null, 2)}\n`);
  return 0;
}

async function resolveNotifyEvent(parsed: ParsedArgs): Promise<NotifyEvent> {
  const root = one(parsed.values, "root") ?? process.cwd();
  const eventPath = one(parsed.values, "event")?.trim();
  const latest = parsed.flags.has("latest");
  if (latest === Boolean(eventPath)) {
    throw new Error("pass exactly one of --latest or --event FILE");
  }
  if (eventPath) return readEventFile(eventPath);
  const items = await listInbox(root, { openOnly: true });
  const newest = items[items.length - 1];
  if (!newest || newest.type === "review_decided") {
    throw new Error("inbox has no open item; add one or pass --event");
  }
  return newest;
}

async function notifyCommand(parsed: ParsedArgs, io: Io, execute: boolean): Promise<number> {
  const policyPath = requireOne(parsed.values, "policy");
  const allowlistPath = requireOne(parsed.values, "allowlist");
  const event = await resolveNotifyEvent(parsed);
  const rules = await loadPolicyFile(policyPath);
  const allowlist = await loadAllowlistFile(allowlistPath);
  const plan = planNotification(event, rules, allowlist, one(parsed.values, "action"));

  if (!execute) {
    io.stdout(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }

  if (!plan.allow || !plan.argv) {
    io.stdout(
      `${JSON.stringify({ ...plan, mode: "run", executed: false, exit_code: null }, null, 2)}\n`,
    );
    return 1;
  }

  const exitCode = await executeArgv(plan.argv, io);
  const result = {
    ...plan,
    mode: "run" as const,
    executed: exitCode === 0,
    exit_code: exitCode,
  };
  io.stderr(`${JSON.stringify(result, null, 2)}\n`);
  return exitCode === 0 ? 0 : exitCode;
}

async function runSetup(parsed: ParsedArgs, io: Io): Promise<number> {
  if (parsed.positionals.length > 1) {
    throw new Error("usage: agent-ship setup [--shared] [--uninstall] [--purge]");
  }
  const root = one(parsed.values, "root") ?? process.cwd();
  const report = await setupProject(root, {
    shared: parsed.flags.has("shared"),
    uninstall: parsed.flags.has("uninstall"),
    purge: parsed.flags.has("purge"),
    stateRoot: one(parsed.values, "state-root"),
    handbook: one(parsed.values, "handbook"),
    lessons: one(parsed.values, "lessons"),
  });
  io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

async function runSliceStart(parsed: ParsedArgs, io: Io): Promise<number> {
  const root = one(parsed.values, "root") ?? process.cwd();
  const contractId = requireOne(parsed.values, "contract");
  const sliceId = requireOne(parsed.values, "slice");
  const started = await startSlice(root, {
    title: requireOne(parsed.values, "title"),
    summary: requireOne(parsed.values, "summary"),
    sourceTaskId: requireOne(parsed.values, "source-task-id"),
    contractId,
    sliceId,
    workerRef: one(parsed.values, "worker"),
    branch: one(parsed.values, "branch") ?? `ship/${contractId}/${sliceId}`,
    repoRoot: one(parsed.values, "repo"),
    base: one(parsed.values, "base"),
    replace: parsed.flags.has("replace"),
    tags: parsed.values.get("tag"),
    project: one(parsed.values, "project"),
    proposalId: one(parsed.values, "proposal"),
    threadRefs: {
      pr: one(parsed.values, "thread-pr"),
      issue: one(parsed.values, "thread-issue"),
      chat: one(parsed.values, "thread-chat"),
    },
  });
  io.stdout(`${JSON.stringify(started, null, 2)}\n`);
  return 0;
}

async function runWatchdogCommand(parsed: ParsedArgs, io: Io): Promise<number> {
  const root = one(parsed.values, "root") ?? process.cwd();
  const minutesText = one(parsed.values, "stale-minutes");
  const staleMinutes = minutesText === undefined ? undefined : Number(minutesText);
  if (staleMinutes !== undefined && (!Number.isFinite(staleMinutes) || staleMinutes <= 0)) {
    throw new Error("--stale-minutes must be a positive number");
  }
  const report = await runWatchdog(root, { staleMinutes });
  if (!report.noop) await warnIfTimerInactive(root, io);
  io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

async function warnIfTimerInactive(root: string, io: Io): Promise<void> {
  const slices = await activeSlices(root);
  if (slices.length === 0) return;
  if (await timerIsActive(root)) return;
  io.stderr("warning: slices are active but the watchdog timer is not registered. Run: agent-ship watchdog install\n");
}

function printTimer(result: { warning?: string }, io: Io): void {
  if (result.warning) io.stderr(`warning: ${result.warning}\n`);
}

async function runCheck(parsed: ParsedArgs, io: Io): Promise<number> {
  const root = one(parsed.values, "root") ?? process.cwd();
  const result = await checkContract(root, requireOne(parsed.values, "contract"), {
    staged: parsed.flags.has("staged"),
    base: one(parsed.values, "base"),
    head: one(parsed.values, "head"),
    repoRoot: one(parsed.values, "repo"),
    sliceId: one(parsed.values, "slice"),
  });
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
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
    const root = one(parsed.values, "root") ?? process.cwd();
    if ((group === "team" && sub === "context") || (group === "lesson" && sub === "search")) {
      const context = await teamContext(root, { tags: parsed.values.get("tag"), project: one(parsed.values, "project"), repo: one(parsed.values, "repo") });
      io.stdout(`${JSON.stringify(context, null, 2)}\n`); return 0;
    }
    if (group === "lesson") {
      let result: unknown;
      if (sub === "add") result = await addLesson(root, requireOne(parsed.values, "input"));
      else if (sub === "show") result = await showLesson(root, requireOne(parsed.values, "id"));
      else if (sub === "review") result = await reviewLesson(root, requireOne(parsed.values, "id"), requireOne(parsed.values, "status"), requireOne(parsed.values, "reviewed-by"), requireOne(parsed.values, "note"), one(parsed.values, "review-after"));
      else if (sub === "check") result = await checkLearning(root, requireOne(parsed.values, "source-task-id"), requireOne(parsed.values, "outcome"), requireOne(parsed.values, "reason"), requireOne(parsed.values, "reviewed-by"), parsed.values.get("candidate-id"), parsed.values.get("trigger"));
      else if (sub === "pending") result = await pendingLearning(root, one(parsed.values, "source-task-id"));
      else throw new Error("unknown lesson command");
      io.stdout(`${JSON.stringify(result, null, 2)}\n`); return 0;
    }
    if ((group === "setup" || group === "init") && sub === undefined) return await runSetup(parsed, io);
    if (group === "check" && sub === undefined) return await runCheck(parsed, io);
    if (group === "watchdog" && sub === "install") {
      const root = one(parsed.values, "root") ?? process.cwd();
      const result = await installWatchdogTimer(root, { dryRun: parsed.flags.has("dry-run") });
      printTimer(result, io);
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.registered || result.dry_run ? 0 : 1;
    }
    if (group === "watchdog" && sub === "uninstall") {
      const root = one(parsed.values, "root") ?? process.cwd();
      const result = await uninstallWatchdogTimer(root, { dryRun: parsed.flags.has("dry-run") });
      printTimer(result, io);
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.warning ? 1 : 0;
    }
    if (group === "watchdog" && sub === undefined) return await runWatchdogCommand(parsed, io);
    if (group === "slice" && sub === "start") return await runSliceStart(parsed, io);
    if (group === "slice" && sub === "update") {
      const result = await updateSlice(one(parsed.values, "root") ?? process.cwd(), requireOne(parsed.values, "source-task-id"), requireOne(parsed.values, "status"), one(parsed.values, "summary"), one(parsed.values, "worker"));
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (group === "status" && sub === undefined && parsed.flags.has("stale")) {
      return await runWatchdogCommand(parsed, io);
    }
    if (group === "inbox" && sub === "add") return await inboxAdd(parsed, io);
    if (group === "inbox" && sub === "list") return await inboxList(parsed, io);
    if (group === "inbox" && sub === "decide") return await inboxDecide(parsed, io);
    if (group === "notify" && sub === "dry-run") return await notifyCommand(parsed, io, false);
    if (group === "notify" && sub === "run") return await notifyCommand(parsed, io, true);
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
