import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkContract } from "./check.js";
import { addInboxItem, assertSummary, listInbox, newEventId } from "./inbox.js";
import { kitRoot } from "./setup.js";
import type { BlockReason, ThreadRefs } from "./types.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_STALE_MINUTES = 30;

export interface Limits {
  stale_minutes: number;
  speculative: boolean;
  global_max_parallel: number;
}

export interface WatchdogFlag {
  source_task_id: string;
  contract_id: string | null;
  slice_id: string | null;
  reason: "stalled" | "drift";
  idle_minutes: number;
  inbox_id: string | null;
  already_open: boolean;
}

export interface WatchdogReport {
  noop: boolean;
  stale_minutes: number;
  checked: number;
  flagged: WatchdogFlag[];
  timer: TimerAction;
}

export type TimerAction = "created" | "unchanged" | "removed" | "absent";

export interface TimerInstall {
  action: TimerAction;
  cron_file: string;
  launchd_file: string;
  project_root: string;
}

interface SliceState {
  source_task_id: string;
  contract_id?: string;
  slice_id?: string;
  title: string;
  summary: string;
  dispatched_at: string;
  last_progress_at: string;
  worker_ref?: string;
  branch?: string;
  thread_refs?: ThreadRefs;
  status: string;
}

const TERMINAL = new Set(["needs_review", "blocked", "failed", "cancelled"]);

export function eventsFile(root: string): string {
  return join(root, ".agent-ship", "events.jsonl");
}

export function timerHome(): string {
  return process.env.AGENT_SHIP_TIMER_HOME ?? homedir();
}

export function projectSlug(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export function cronFile(root: string): string {
  return join(timerHome(), ".config", "agent-ship", "cron.d", `agent-ship-${projectSlug(root)}`);
}

export function launchdFile(root: string): string {
  return join(
    timerHome(),
    ".config",
    "agent-ship",
    "launchd",
    `com.agent-ship.watchdog.${projectSlug(root)}.plist`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function watchdogCommand(root: string): { nodeBin: string; cli: string; workdir: string } {
  const kit = kitRoot();
  return {
    nodeBin: process.execPath,
    cli: join(kit, "cli", "src", "cli.ts"),
    workdir: join(kit, "cli"),
  };
}

function cronText(root: string): string {
  const command = watchdogCommand(root);
  const line = `*/5 * * * * cd ${shellQuote(command.workdir)} && ${shellQuote(command.nodeBin)} --import tsx src/cli.ts watchdog --root ${shellQuote(root)}`;
  return `# agent-ship watchdog for ${root}
# Local timer entry. Do not commit this file.
# cron: paste the line below into crontab -e, or: crontab -l | cat - ${cronFile(root)} | crontab -
# launchd: copy ${launchdFile(root)} to ~/Library/LaunchAgents and
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/$(basename ${launchdFile(root)})
# Remove that LaunchAgents copy when you uninstall if you loaded it.
${line}
`;
}

function launchdText(root: string): string {
  const command = watchdogCommand(root);
  const label = `com.agent-ship.watchdog.${projectSlug(root)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>WorkingDirectory</key>
  <string>${command.workdir}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${command.nodeBin}</string>
    <string>--import</string>
    <string>tsx</string>
    <string>${command.cli}</string>
    <string>watchdog</string>
    <string>--root</string>
    <string>${root}</string>
  </array>
</dict>
</plist>
`;
}

export async function installWatchdogTimer(root: string): Promise<TimerInstall> {
  const cronPath = cronFile(root);
  const plistPath = launchdFile(root);
  const cronBody = cronText(root);
  const plistBody = launchdText(root);
  const beforeCron = await readOptionalText(cronPath);
  const beforePlist = await readOptionalText(plistPath);
  await mkdir(join(cronPath, ".."), { recursive: true });
  await mkdir(join(plistPath, ".."), { recursive: true });
  if (beforeCron !== cronBody) await writeFile(cronPath, cronBody);
  if (beforePlist !== plistBody) await writeFile(plistPath, plistBody);
  const action: TimerAction = beforeCron === null || beforePlist === null ? "created" : "unchanged";
  return { action, cron_file: cronPath, launchd_file: plistPath, project_root: root };
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function uninstallWatchdogTimer(root: string): Promise<TimerInstall> {
  const cronPath = cronFile(root);
  const plistPath = launchdFile(root);
  const hadCron = (await readOptionalText(cronPath)) !== null;
  const hadPlist = (await readOptionalText(plistPath)) !== null;
  await rm(cronPath, { force: true });
  await rm(plistPath, { force: true });
  return {
    action: hadCron || hadPlist ? "removed" : "absent",
    cron_file: cronPath,
    launchd_file: plistPath,
    project_root: root,
  };
}

export async function readLimits(root: string): Promise<Limits> {
  const limits: Limits = {
    stale_minutes: DEFAULT_STALE_MINUTES,
    speculative: false,
    global_max_parallel: 3,
  };
  try {
    const parsed = JSON.parse(await readFile(join(root, ".agent-ship", "limits.json"), "utf8")) as {
      stale_minutes?: unknown;
      speculative?: unknown;
      global_max_parallel?: unknown;
    };
    if (typeof parsed.stale_minutes === "number" && parsed.stale_minutes > 0) {
      limits.stale_minutes = parsed.stale_minutes;
    }
    if (parsed.speculative === true) limits.speculative = true;
    if (typeof parsed.global_max_parallel === "number" && parsed.global_max_parallel > 0) {
      limits.global_max_parallel = parsed.global_max_parallel;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return limits;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

async function readEvents(root: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(eventsFile(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = asRecord(JSON.parse(trimmed) as unknown);
    if (parsed) events.push(parsed);
  }
  return events;
}

function threadRefs(value: unknown): ThreadRefs | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const refs: ThreadRefs = {};
  const pr = text(record.pr);
  const issue = text(record.issue);
  const chat = text(record.chat);
  if (pr) refs.pr = pr;
  if (issue) refs.issue = issue;
  if (chat) refs.chat = chat;
  return Object.keys(refs).length > 0 ? refs : undefined;
}

export function foldSlices(events: readonly Record<string, unknown>[]): SliceState[] {
  const slices = new Map<string, SliceState>();
  for (const event of events) {
    const type = text(event.type);
    const task = text(event.source_task_id);
    if (!type || !task) continue;
    const created = text(event.created_at) ?? new Date(0).toISOString();
    const status = text(event.status);
    if (type === "worker_dispatched") {
      const current = slices.get(task);
      slices.set(task, {
        source_task_id: task,
        contract_id: text(event.contract_id) ?? current?.contract_id,
        slice_id: text(event.slice_id) ?? current?.slice_id,
        title: text(event.title) ?? current?.title ?? task,
        summary: text(event.summary) ?? current?.summary ?? task,
        dispatched_at: created,
        last_progress_at: current?.last_progress_at ?? created,
        worker_ref: text(event.worker_ref) ?? current?.worker_ref,
        branch: text(event.branch) ?? current?.branch,
        thread_refs: threadRefs(event.thread_refs) ?? current?.thread_refs,
        status: status ?? "running",
      });
      continue;
    }
    const current = slices.get(task);
    if (!current) continue;
    if (type === "worker_progress") {
      current.last_progress_at = created;
      if (status) current.status = status;
      continue;
    }
    if (status && TERMINAL.has(status)) current.status = status;
    if (type === "needs_review" || type === "blocked") current.status = type === "needs_review" ? "needs_review" : "blocked";
  }
  return [...slices.values()];
}

function idleMinutes(fromIso: string, now: Date): number {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - from) / 60000);
}

function laterIso(left: string, right: string | null): string {
  if (!right) return left;
  const rightMs = Date.parse(right);
  if (Number.isNaN(rightMs)) return left;
  return rightMs > Date.parse(left) ? right : left;
}

async function lastCommitIso(root: string, branch: string | undefined): Promise<string | null> {
  try {
    const args = ["log", "-1", "--format=%cI"];
    if (branch) args.push(branch);
    const { stdout } = await execFileAsync("git", args, { cwd: root });
    const iso = stdout.trim();
    return iso || null;
  } catch {
    return null;
  }
}

export async function activeSlices(root: string): Promise<SliceState[]> {
  const events = await readEvents(root);
  return foldSlices(events).filter((slice) => slice.status === "queued" || slice.status === "running");
}

async function drifted(root: string, contractId: string | undefined, checkDrift: boolean): Promise<boolean> {
  if (!checkDrift || !contractId) return false;
  try {
    const result = await checkContract(root, contractId);
    return !result.ok;
  } catch {
    return false;
  }
}

export async function runWatchdog(
  root: string,
  options: { staleMinutes?: number; now?: Date; checkDrift?: boolean } = {},
): Promise<WatchdogReport> {
  const slices = await activeSlices(root);
  if (slices.length === 0) {
    const timer = await uninstallWatchdogTimer(root);
    return {
      noop: true,
      stale_minutes: options.staleMinutes ?? DEFAULT_STALE_MINUTES,
      checked: 0,
      flagged: [],
      timer: timer.action,
    };
  }

  const limits = await readLimits(root);
  const staleMinutes = options.staleMinutes ?? limits.stale_minutes;
  const now = options.now ?? new Date();
  const open = await listInbox(root, { openOnly: true, type: "blocked" });
  const flagged: WatchdogFlag[] = [];

  for (const slice of slices) {
    const commitAt = await lastCommitIso(root, slice.branch);
    const progressAt = laterIso(slice.last_progress_at, commitAt);
    const idle = idleMinutes(progressAt, now);
    const drift = await drifted(root, slice.contract_id, options.checkDrift !== false);
    const stalled = idle >= staleMinutes;
    if (!drift && !stalled) continue;
    const reason: BlockReason = drift ? "drift" : "stalled";
    const existing = open.find((item) => item.type === "blocked" && item.source_task_id === slice.source_task_id);
    if (existing) {
      flagged.push({
        source_task_id: slice.source_task_id,
        contract_id: slice.contract_id ?? null,
        slice_id: slice.slice_id ?? null,
        reason,
        idle_minutes: idle,
        inbox_id: existing.id,
        already_open: true,
      });
      continue;
    }
    const hop = [
      slice.contract_id ? `contract ${slice.contract_id}` : null,
      slice.slice_id ? `slice ${slice.slice_id}` : null,
      `task ${slice.source_task_id}`,
    ]
      .filter(Boolean)
      .join(" -> ");
    const summary =
      reason === "drift"
        ? `Check failed for ${hop}. Paths drifted outside the frozen contract.`
        : `No progress on ${hop} for ${idle}m.`;
    const filed = await addInboxItem(root, {
      type: "blocked",
      title: reason === "drift" ? `Drift: ${slice.title}` : `Stalled: ${slice.title}`,
      summary,
      priority: "high",
      sourceTaskId: slice.source_task_id,
      contractId: slice.contract_id,
      sliceId: slice.slice_id,
      workerRef: slice.worker_ref,
      branch: slice.branch,
      threadRefs: slice.thread_refs,
      reason,
    });
    flagged.push({
      source_task_id: slice.source_task_id,
      contract_id: slice.contract_id ?? null,
      slice_id: slice.slice_id ?? null,
      reason,
      idle_minutes: idle,
      inbox_id: filed.id,
      already_open: false,
    });
  }

  return { noop: false, stale_minutes: staleMinutes, checked: slices.length, flagged, timer: "unchanged" };
}

export interface SliceStartInput {
  title: string;
  summary: string;
  sourceTaskId: string;
  contractId: string;
  sliceId: string;
  workerRef?: string;
  branch?: string;
  threadRefs?: ThreadRefs;
  createdAt?: string;
}

/** Record a dispatched slice and install the local timer when work is open. */
export async function startSlice(root: string, input: SliceStartInput): Promise<{ timer: TimerInstall; active: number }> {
  const threadRefs: ThreadRefs = {};
  if (input.threadRefs?.pr) threadRefs.pr = input.threadRefs.pr;
  if (input.threadRefs?.issue) threadRefs.issue = input.threadRefs.issue;
  if (input.threadRefs?.chat) threadRefs.chat = input.threadRefs.chat;
  const event = {
    id: newEventId(),
    type: "worker_dispatched",
    title: input.title,
    summary: assertSummary(input.summary),
    created_at: input.createdAt ?? new Date().toISOString(),
    source_task_id: input.sourceTaskId,
    contract_id: input.contractId,
    slice_id: input.sliceId,
    status: "running",
    ...(input.workerRef ? { worker_ref: input.workerRef } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(Object.keys(threadRefs).length > 0 ? { thread_refs: threadRefs } : {}),
  };
  await mkdir(join(root, ".agent-ship"), { recursive: true });
  await appendFile(eventsFile(root), `${JSON.stringify(event)}\n`, "utf8");
  const active = (await activeSlices(root)).length;
  const timer = active > 0 ? await installWatchdogTimer(root) : await uninstallWatchdogTimer(root);
  return { timer, active };
}
