import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkContract, contractFile } from "./check.js";
import { addInboxItem, assertSummary, listInbox, newEventId, readInbox } from "./inbox.js";
import { kitRoot } from "./setup.js";
import { assertSingleRepository, baseCommit, repositoryRoot, gitOutput } from "./repository.js";
import { nextSequence, readEvents, withLock } from "./storage.js";
import { parseContractPaths } from "./paths.js";
import { assertLearningChecked, teamContext } from "./learning.js";
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
  repo_root?: string;
  base_ref?: string;
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
    if (parsed.global_max_parallel !== undefined) {
      if (typeof parsed.global_max_parallel !== "number" || !Number.isSafeInteger(parsed.global_max_parallel) || parsed.global_max_parallel < 1) throw new Error("global_max_parallel must be a positive integer");
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
        repo_root: text(event.repo_root) ?? current?.repo_root,
        base_ref: text(event.base_ref) ?? current?.base_ref,
        thread_refs: threadRefs(event.thread_refs) ?? current?.thread_refs,
        status: status ?? "running",
      });
      continue;
    }
    const current = slices.get(task);
    if (!current) continue;
    if (type === "worker_progress") {
      current.last_heartbeat_at = created;
      if (text(event.worker_ref)) current.worker_ref = text(event.worker_ref);
      if (status) current.status = status;
      continue;
    }
    if (status && TERMINAL.has(status)) current.status = status;
    if (type === "needs_review" || type === "blocked" || type === "needs_approval") current.status = type;
    // Human decisions close attention items, never silently restart a worker.
    if (type === "review_decided") current.status = event.decision === "reject" ? "cancelled" : event.decision === "changes_requested" ? "blocked" : current.status;
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
  return (await allSlices(root)).filter((slice) => slice.status === "queued" || slice.status === "running");
}

function eventTime(value: unknown): number | null {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function eventSequence(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Time order when both timestamps parse. Otherwise sequence, then original file order. */
export function compareEvents(left: Record<string, unknown>, right: Record<string, unknown>, leftIndex: number, rightIndex: number): number {
  const leftTime = eventTime(left.created_at);
  const rightTime = eventTime(right.created_at);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  const leftSequence = eventSequence(left.sequence);
  const rightSequence = eventSequence(right.sequence);
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) return leftSequence - rightSequence;
  return leftIndex - rightIndex;
}

export async function allSlices(root: string): Promise<SliceState[]> {
  const events = await readEvents(root);
  const inbox = await readInbox(root);
  // Fold the attention log directly instead of double-writing a second state event.
  const combined = [...events, ...inbox.map((event) => ({ ...event }))].map((event, index) => ({ event, index }));
  combined.sort((left, right) => compareEvents(left.event, right.event, left.index, right.index));
  return foldSlices(combined.map((item) => item.event));
}

async function drifted(root: string, slice: SliceState, checkDrift: boolean): Promise<boolean> {
  if (!checkDrift) return false;
  if (!slice.contract_id) throw new Error("slice has no contract_id");
  const result = await checkContract(root, slice.contract_id, { repoRoot: slice.repo_root, base: slice.base_ref, head: slice.branch });
  return !result.ok;
}

async function driftProblem(root: string, slice: SliceState, checkDrift: boolean): Promise<{ drift: boolean; error?: string }> {
  try {
    return { drift: await drifted(root, slice, checkDrift) };
  } catch (error) {
    return { drift: true, error: error instanceof Error ? error.message : String(error) };
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
    const commitAt = slice.branch ? await lastCommitIso(slice.repo_root ?? root, slice.branch) : null;
    const progressAt = laterIso(laterIso(slice.dispatched_at, slice.last_heartbeat_at), commitAt);
    const idle = idleMinutes(progressAt, now);
    const problem = await driftProblem(root, slice, options.checkDrift !== false);
    const drift = problem.drift;
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
        ? `Check failed for ${hop}. ${problem.error ? "Unable to inspect the recorded repository/branch; run check for details." : "Paths drifted outside the frozen contract."}`
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
  repoRoot?: string;
  base?: string;
  replace?: boolean;
  tags?: string[];
  project?: string;
}

async function dispatchTerms(root: string, contractId: string, sliceId: string) {
  const markdown = await readFile(contractFile(root, contractId), "utf8");
  const status = /^Status:[ \t]*(.+)$/im.exec(markdown)?.[1]?.trim();
  if (status !== "frozen") throw new Error("contract must be frozen before dispatch or resume");
  const human = /^Frozen by:[ \t]*(.+)$/im.exec(markdown)?.[1]?.trim().replace(/^`|`$/g, "");
  const frozenAt = /^Frozen at:[ \t]*(.+)$/im.exec(markdown)?.[1]?.trim().replace(/^`|`$/g, "");
  if (!human || human.startsWith("<")) throw new Error("contract must record Frozen by");
  if (!frozenAt || !Number.isFinite(Date.parse(frozenAt))) throw new Error("contract must record a valid Frozen at");
  const paths = parseContractPaths(markdown);
  if (!paths.allowed.length) throw new Error("contract needs non-empty Allowed paths");
  if (!paths.forbidden.length) throw new Error("contract needs non-empty Forbidden paths");
  const section = markdown.split(/^##[ \t]+/m).find((part) => /^Slices\b/i.test(part)) ?? "";
  const rows = section.split("\n").map((line) => /^\|[ \t]*`?([^|`]+)`?[ \t]*\|/.exec(line)?.[1]?.trim());
  if (!/^[A-Za-z0-9._-]+$/.test(sliceId) || !rows.includes(sliceId)) throw new Error(`slice ${sliceId} is not in the Slices table`);
  const cap = Number(/^max_parallel:[ \t]*(\S+)[ \t]*$/im.exec(section)?.[1] ?? 3);
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("max_parallel must be a positive integer");
  return { cap, paths };
}

/** Record a dispatched slice and install the local timer when work is open. */
export async function startSlice(root: string, input: SliceStartInput) {
  return withLock(join(root, ".agent-ship"), async () => {
    const summary = assertSummary(input.summary);
    for (const [name, value] of Object.entries({ title: input.title, sourceTaskId: input.sourceTaskId, sliceId: input.sliceId })) {
      if (!value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${name} must be non-empty single-line text`);
    }
    const { cap, paths } = await dispatchTerms(root, input.contractId, input.sliceId);
    const previous = await allSlices(root);
    if (previous.some((slice) => slice.source_task_id === input.sourceTaskId)) throw new Error("source_task_id has already been dispatched");
    const sameSlice = previous.filter((slice) => slice.contract_id === input.contractId && slice.slice_id === input.sliceId);
    if (sameSlice.length && !(input.replace && sameSlice.every((slice) => slice.status === "failed" || slice.status === "cancelled"))) throw new Error("slice already dispatched; only failed/cancelled work may be replaced with --replace");
    const active = previous.filter((slice) => slice.status === "running" || slice.status === "queued");
    const limits = await readLimits(root);
    if (active.length >= limits.global_max_parallel) throw new Error("global_max_parallel reached");
    if (active.filter((slice) => slice.contract_id === input.contractId).length >= cap) throw new Error("contract max_parallel reached");
    const repo = await repositoryRoot(input.repoRoot ?? root, true);
    const context = await teamContext(root, { tags: input.tags, project: input.project, repo });
    await assertSingleRepository(repo, paths.allowed);
    const base = await baseCommit(repo, input.base);
    const branch = input.branch ?? `ship/${input.contractId}/${input.sliceId}`;
    if (branch.startsWith("-")) throw new Error("branch must be a Git ref, not an option");
    const baseHint = input.base ?? "main";
    try {
      await gitOutput(repo, ["rev-parse", "--verify", `${branch}^{commit}`]);
    } catch {
      throw new Error(`branch ${branch} does not exist in ${repo}; create it first (git branch ${branch} ${baseHint})`);
    }
    const threadRefs: ThreadRefs = {};
    if (input.threadRefs?.pr) threadRefs.pr = input.threadRefs.pr;
    if (input.threadRefs?.issue) threadRefs.issue = input.threadRefs.issue;
    if (input.threadRefs?.chat) threadRefs.chat = input.threadRefs.chat;
    const event = {
      id: newEventId(),
      type: "worker_dispatched",
      title: input.title,
      summary,
      created_at: input.createdAt ?? new Date().toISOString(),
      source_task_id: input.sourceTaskId,
      contract_id: input.contractId,
      slice_id: input.sliceId,
      status: "running",
      ...(input.workerRef ? { worker_ref: input.workerRef } : {}),
      branch,
      repo_root: repo,
      base_ref: base,
      learning_required: context.learning_required,
      context_refs: context.required_sources,
      lesson_ids: context.lessons.map((lesson) => lesson.id),
      context_tags: context.query.tags,
      ...(context.query.project ? { project_id: context.query.project } : {}),
      sequence: await nextSequence(root),
      ...(Object.keys(threadRefs).length > 0 ? { thread_refs: threadRefs } : {}),
    };
    await mkdir(join(root, ".agent-ship"), { recursive: true });
    await appendFile(eventsFile(root), `${JSON.stringify(event)}\n`, "utf8");
    const count = (await activeSlices(root)).length;
    const timer = count > 0 ? await installWatchdogTimer(root) : await uninstallWatchdogTimer(root);
    return { timer, active: count, context };
  });
}

export async function updateSlice(root: string, taskId: string, status: string, summary = "Worker status updated.", workerRef?: string): Promise<{ active: number; timer: TimerInstall }> {
  if (!["running", "queued", "needs_review", "blocked", "needs_approval", "failed", "cancelled"].includes(status)) throw new Error("invalid slice status");
  return withLock(join(root, ".agent-ship"), async () => {
    const slices = await allSlices(root);
    const current = slices.find((slice) => slice.source_task_id === taskId);
    if (!current) throw new Error(`unknown task ${taskId}`);
    if (status === "needs_review") await assertLearningChecked(root, taskId);
    if (status === "running" || status === "queued") {
      const decisions = (await readInbox(root)).filter((event) => event.type === "review_decided" && event.source_task_id === taskId);
      const latest = decisions[decisions.length - 1];
      if ((current.status === "needs_review" && (latest?.type !== "review_decided" || latest.decision !== "changes_requested")) || current.status === "failed" || current.status === "cancelled") throw new Error("closed or unreviewed work cannot resume; use a new contract or explicitly replace failed/cancelled work");
      if ((await listInbox(root, { openOnly: true })).some((event) => event.type !== "review_decided" && event.source_task_id === taskId)) throw new Error("task has an open attention item; record the human decision before resuming");
      const { cap } = await dispatchTerms(root, current.contract_id ?? "", current.slice_id ?? "");
      const active = slices.filter((slice) => slice.source_task_id !== taskId && (slice.status === "running" || slice.status === "queued"));
      if (active.length >= (await readLimits(root)).global_max_parallel || active.filter((slice) => slice.contract_id === current.contract_id).length >= cap) throw new Error("parallel limit reached; cannot resume");
    }
    await appendFile(eventsFile(root), `${JSON.stringify({ id: newEventId(), type: "worker_progress", title: current.title, summary: assertSummary(summary), source_task_id: taskId, contract_id: current.contract_id, slice_id: current.slice_id, created_at: new Date().toISOString(), sequence: await nextSequence(root), ...(workerRef ? { worker_ref: workerRef } : {}), status })}\n`);
    const active = (await activeSlices(root)).length;
    return { active, timer: active ? await installWatchdogTimer(root) : await uninstallWatchdogTimer(root) };
  });
}
