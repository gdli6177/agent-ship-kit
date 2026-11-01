import { execFile, spawn } from "node:child_process";
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
  registered: boolean;
  platform: "cron" | "launchd" | "unsupported";
  dry_run: boolean;
  warning?: string;
  entry: string;
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
  /** Set only by worker_progress events. Dispatch time is not progress. */
  last_heartbeat_at: string | null;
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

export function cronMarker(root: string): { begin: string; end: string; line: string } {
  const slug = projectSlug(root);
  const command = watchdogCommand(root);
  const line = `*/5 * * * * cd ${shellQuote(command.workdir)} && ${shellQuote(command.nodeBin)} --import tsx src/cli.ts watchdog --root ${shellQuote(root)}`;
  return {
    begin: `# agent-ship-watchdog-begin ${slug}`,
    end: `# agent-ship-watchdog-end ${slug}`,
    line,
  };
}

function cronText(root: string): string {
  const marked = cronMarker(root);
  return `${marked.begin}\n${marked.line}\n${marked.end}\n`;
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

export function timerPlatform(): "cron" | "launchd" | "unsupported" {
  const override = process.env.AGENT_SHIP_TIMER_PLATFORM;
  if (override === "cron" || override === "launchd" || override === "unsupported") return override;
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") return "cron";
  return "unsupported";
}

export function launchAgentsDir(): string {
  return process.env.AGENT_SHIP_LAUNCH_AGENTS_DIR ?? join(timerHome(), "Library", "LaunchAgents");
}

function userId(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function runCommand(cmd: string, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function crontabList(): Promise<{ ok: boolean; text: string; warning?: string }> {
  const bin = process.env.AGENT_SHIP_CRONTAB_CMD ?? "crontab";
  try {
    const result = await runCommand(bin, ["-l"]);
    if (result.code === 0) return { ok: true, text: result.stdout };
    if (/no crontab/i.test(`${result.stderr}\n${result.stdout}`)) return { ok: true, text: "" };
    return { ok: false, text: "", warning: `crontab -l failed: ${result.stderr.trim() || result.stdout.trim()}` };
  } catch (error) {
    return { ok: false, text: "", warning: `crontab -l failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function crontabReplace(text: string): Promise<string | undefined> {
  const bin = process.env.AGENT_SHIP_CRONTAB_CMD ?? "crontab";
  try {
    const result = await runCommand(bin, ["-"], text.endsWith("\n") || text === "" ? text : `${text}\n`);
    if (result.code !== 0) return `crontab - failed: ${result.stderr.trim() || result.stdout.trim()}`;
    return undefined;
  } catch (error) {
    return `crontab - failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function upsertCronBlock(existing: string, root: string): string {
  const marked = cronMarker(root);
  const lines = existing.split("\n");
  const start = lines.findIndex((line) => line.trim() === marked.begin);
  const finish = lines.findIndex((line) => line.trim() === marked.end);
  if (start !== -1 && finish >= start) lines.splice(start, finish - start + 1);
  const kept = lines.join("\n").replace(/\n+$/, "");
  return `${kept}${kept ? "\n" : ""}${marked.begin}\n${marked.line}\n${marked.end}\n`;
}

function stripCronBlock(existing: string, root: string): string {
  const marked = cronMarker(root);
  const lines = existing.split("\n");
  const start = lines.findIndex((line) => line.trim() === marked.begin);
  const finish = lines.findIndex((line) => line.trim() === marked.end);
  if (start === -1 || finish < start) return existing;
  lines.splice(start, finish - start + 1);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

async function registerCron(root: string, dryRun: boolean): Promise<{ registered: boolean; warning?: string; action: TimerAction }> {
  const listed = await crontabList();
  if (!listed.ok) return { registered: false, warning: listed.warning, action: "unchanged" };
  const next = upsertCronBlock(listed.text, root);
  if (next === (listed.text.endsWith("\n") || listed.text === "" ? listed.text : `${listed.text}\n`)) {
    return { registered: true, action: "unchanged" };
  }
  if (dryRun) return { registered: false, action: "unchanged" };
  const warning = await crontabReplace(next);
  return { registered: warning === undefined, warning, action: listed.text.includes(cronMarker(root).begin) ? "unchanged" : "created" };
}

async function unregisterCron(root: string, dryRun: boolean): Promise<{ removed: boolean; warning?: string }> {
  const listed = await crontabList();
  if (!listed.ok) return { removed: false, warning: listed.warning };
  if (!listed.text.includes(cronMarker(root).begin)) return { removed: false };
  if (dryRun) return { removed: true };
  const next = stripCronBlock(listed.text, root);
  const warning = await crontabReplace(next.endsWith("\n") || next === "" ? next : `${next}\n`);
  return { removed: warning === undefined, warning };
}

function plistLabel(root: string): string {
  return `com.agent-ship.watchdog.${projectSlug(root)}`;
}

function installedPlistPath(root: string): string {
  return join(launchAgentsDir(), `${plistLabel(root)}.plist`);
}

async function launchctl(args: string[]): Promise<{ code: number; stderr: string }> {
  const bin = process.env.AGENT_SHIP_LAUNCHCTL_CMD ?? "launchctl";
  try {
    const result = await runCommand(bin, args);
    return { code: result.code, stderr: result.stderr };
  } catch (error) {
    return { code: 1, stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function registerLaunchd(root: string, dryRun: boolean): Promise<{ registered: boolean; warning?: string; action: TimerAction }> {
  const dest = installedPlistPath(root);
  const body = launchdText(root);
  const previous = await readOptionalText(dest);
  const domain = `gui/${userId()}`;
  const label = plistLabel(root);
  if (dryRun) return { registered: false, action: previous === body ? "unchanged" : "created" };
  await mkdir(launchAgentsDir(), { recursive: true });
  if (previous !== body) await writeFile(dest, body);
  await launchctl(["bootout", `${domain}/${label}`]);
  const boot = await launchctl(["bootstrap", domain, dest]);
  if (boot.code !== 0) {
    return {
      registered: false,
      warning: `launchctl bootstrap failed: ${boot.stderr.trim() || "unknown error"}`,
      action: previous === null ? "created" : "unchanged",
    };
  }
  return { registered: true, action: previous === null ? "created" : "unchanged" };
}

async function unregisterLaunchd(root: string, dryRun: boolean): Promise<{ removed: boolean; warning?: string }> {
  const dest = installedPlistPath(root);
  const domain = `gui/${userId()}`;
  const label = plistLabel(root);
  const had = (await readOptionalText(dest)) !== null;
  if (dryRun) return { removed: had };
  const boot = await launchctl(["bootout", `${domain}/${label}`]);
  await rm(dest, { force: true });
  if (!had && boot.code !== 0) return { removed: false };
  return { removed: had || boot.code === 0 };
}

export async function timerIsActive(root: string): Promise<boolean> {
  const platform = timerPlatform();
  if (platform === "cron") {
    const listed = await crontabList();
    return listed.ok && listed.text.includes(cronMarker(root).begin);
  }
  if (platform === "launchd") {
    const print = await launchctl(["print", `gui/${userId()}/${plistLabel(root)}`]);
    return print.code === 0;
  }
  return false;
}

export async function installWatchdogTimer(root: string, options: { dryRun?: boolean } = {}): Promise<TimerInstall> {
  const dryRun = options.dryRun === true;
  const platform = timerPlatform();
  const cronPath = cronFile(root);
  const plistPath = launchdFile(root);
  const entry = cronMarker(root).line;
  if (!dryRun) {
    await mkdir(join(cronPath, ".."), { recursive: true });
    await mkdir(join(plistPath, ".."), { recursive: true });
    await writeFile(cronPath, cronText(root));
    await writeFile(plistPath, launchdText(root));
  }
  if (platform === "unsupported") {
    return {
      action: "unchanged",
      registered: false,
      platform,
      dry_run: dryRun,
      warning: `watchdog timer is not registered on platform ${process.platform}. Use the cron line or launchd plist printed by --dry-run.`,
      entry,
      cron_file: cronPath,
      launchd_file: plistPath,
      project_root: root,
    };
  }
  const result = platform === "cron" ? await registerCron(root, dryRun) : await registerLaunchd(root, dryRun);
  return {
    action: result.action,
    registered: result.registered,
    platform,
    dry_run: dryRun,
    warning: result.warning,
    entry,
    cron_file: cronPath,
    launchd_file: plistPath,
    project_root: root,
  };
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function uninstallWatchdogTimer(root: string, options: { dryRun?: boolean } = {}): Promise<TimerInstall> {
  const dryRun = options.dryRun === true;
  const platform = timerPlatform();
  const cronPath = cronFile(root);
  const plistPath = launchdFile(root);
  const entry = cronMarker(root).line;
  let warning: string | undefined;
  let removed = false;
  if (platform === "cron") {
    const result = await unregisterCron(root, dryRun);
    removed = result.removed;
    warning = result.warning;
  } else if (platform === "launchd") {
    const result = await unregisterLaunchd(root, dryRun);
    removed = result.removed;
    warning = result.warning;
  } else {
    warning = `watchdog timer is not registered on platform ${process.platform}.`;
  }
  if (!dryRun) {
    await rm(cronPath, { force: true });
    await rm(plistPath, { force: true });
  }
  return {
    action: removed ? "removed" : "absent",
    registered: false,
    platform,
    dry_run: dryRun,
    warning,
    entry,
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
        last_heartbeat_at: current?.last_heartbeat_at ?? null,
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
      current.last_heartbeat_at = created;
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

/** Commit time on the slice branch only. Never `git log` of the current checkout. */
async function lastCommitIso(root: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%cI", branch], { cwd: root });
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
    const commitAt = slice.branch ? await lastCommitIso(root, slice.branch) : null;
    const progressAt = laterIso(laterIso(slice.dispatched_at, slice.last_heartbeat_at), commitAt);
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
    branch: input.branch ?? `ship/${input.contractId}/${input.sliceId}`,
    ...(Object.keys(threadRefs).length > 0 ? { thread_refs: threadRefs } : {}),
  };
  await mkdir(join(root, ".agent-ship"), { recursive: true });
  await appendFile(eventsFile(root), `${JSON.stringify(event)}\n`, "utf8");
  const active = (await activeSlices(root)).length;
  const timer = active > 0 ? await installWatchdogTimer(root) : await uninstallWatchdogTimer(root);
  return { timer, active };
}
