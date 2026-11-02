import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
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
    cli: join(kit, "cli", "bin", "agent-ship.js"),
    workdir: join(kit, "cli"),
  };
}

export function cronMarker(root: string): { begin: string; end: string; line: string } {
  const slug = projectSlug(root);
  const command = watchdogCommand(root);
  const line = `*/5 * * * * ${shellQuote(command.nodeBin)} ${shellQuote(command.cli)} watchdog --root ${shellQuote(root)}`;
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

function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

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
  <string>${xml(command.workdir)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(command.nodeBin)}</string>
    <string>${xml(command.cli)}</string>
    <string>watchdog</string>
    <string>--root</string>
    <string>${xml(root)}</string>
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

async function launchctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = process.env.AGENT_SHIP_LAUNCHCTL_CMD ?? "launchctl";
  try {
    const result = await runCommand(bin, args);
    return result;
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function registerLaunchd(root: string, dryRun: boolean): Promise<{ registered: boolean; warning?: string; action: TimerAction }> {
  const dest = installedPlistPath(root);
  const body = launchdText(root);
  const previous = await readOptionalText(dest);
  const domain = `gui/${userId()}`;
  const label = plistLabel(root);
  if (dryRun) return { registered: false, action: previous === body ? "unchanged" : "created" };
  if (previous === body && (await launchctl(["print", `${domain}/${label}`])).code === 0) return { registered: true, action: "unchanged" };
  await mkdir(launchAgentsDir(), { recursive: true, mode: 0o700 });
  if (previous !== body) await writeFile(dest, body, { mode: 0o600 });
  await chmod(dest, 0o600);
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

export interface WatchdogStatus {
  registered: boolean;
  platform: "cron" | "launchd" | "unsupported";
  healthy: boolean | null;
  runs: number | null;
  last_exit_code: number | null;
  last_run_at: string | null;
  last_success_at: string | null;
  warning: string | null;
}
export async function watchdogStatus(root: string): Promise<WatchdogStatus> {
  const platform = timerPlatform();
  const result: WatchdogStatus = { registered: false, platform, healthy: null, runs: null, last_exit_code: null, last_run_at: null, last_success_at: null, warning: null };
  let runtime: Record<string, unknown> = {};
  const raw = await readOptionalText(join(root, ".agent-ship/watchdog-health.json"));
  if (raw) { try { runtime = JSON.parse(raw) as Record<string, unknown>; } catch { result.warning = "watchdog health record is invalid"; } }
  if (typeof runtime.last_run_at === "string") result.last_run_at = runtime.last_run_at;
  if (typeof runtime.last_success_at === "string") result.last_success_at = runtime.last_success_at;
  if (platform === "launchd") {
    const printed = await launchctl(["print", `gui/${userId()}/${plistLabel(root)}`]);
    result.registered = printed.code === 0;
    result.runs = Number(/\bruns = (\d+)/.exec(printed.stdout)?.[1] ?? 0);
    const exit = /last exit code = (-?\d+)/.exec(printed.stdout)?.[1];
    if (exit !== undefined) result.last_exit_code = Number(exit);
    if (!result.registered) result.warning = "launchd job is not registered";
    const installed = await readOptionalText(installedPlistPath(root));
    if (result.registered && installed !== launchdText(root)) { result.healthy = false; result.warning = "Registered plist differs from this kit/runtime; explicitly reinstall the timer."; }
  } else if (platform === "cron") {
    const listed = await crontabList();
    const marker = cronMarker(root);
    result.registered = listed.ok && listed.text.includes(`${marker.begin}\n${marker.line}\n${marker.end}`);
    if (!result.registered) result.warning = listed.warning ?? "Expected crontab entry is not registered";
    if (typeof runtime.last_exit_code === "number") result.last_exit_code = runtime.last_exit_code;
  } else result.warning = "Unsupported timer platform; explicitly use --allow-untimed for manual supervision.";
  if (result.registered && result.healthy !== false) {
    if (result.last_exit_code !== null) result.healthy = result.last_exit_code === 0;
    if (result.last_run_at && Date.now() - Date.parse(result.last_run_at) > 15 * 60000) { result.healthy = false; result.warning = "No watchdog completion in the last 15 minutes"; }
    if (result.healthy === false && !result.warning) result.warning = `watchdog last exited ${result.last_exit_code}`;
    if (result.healthy === null && !result.warning) result.warning = "Registered, but no successful timer run has been observed yet";
  }
  return result;
}
export async function watchdogDoctor(root: string) {
  const status = await watchdogStatus(root);
  const command = watchdogCommand(root);
  const checks = [];
  for (const [name, path] of [["node", command.nodeBin], ["cli", command.cli]] as const) {
    let ok = true; try { await access(path); } catch { ok = false; }
    checks.push({ name, path, ok });
  }
  let tsx = true;
  try { createRequire(join(kitRoot(), "cli/bin/agent-ship.js")).resolve("tsx/cli"); } catch { tsx = false; }
  checks.push({ name: "tsx", path: kitRoot(), ok: tsx });
  return { ok: checks.every(c => c.ok) && status.registered && status.healthy !== false, status, checks, templates_are_registration_evidence: false };
}
export async function timerIsActive(root: string): Promise<boolean> {
  const status = await watchdogStatus(root);
  return status.registered && status.healthy !== false;
}

export async function installWatchdogTimer(root: string, options: { dryRun?: boolean } = {}): Promise<TimerInstall> {
  const dryRun = options.dryRun === true;
  const platform = timerPlatform();
  const cronPath = cronFile(root);
  const plistPath = launchdFile(root);
  const entry = cronMarker(root).line;
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
  if (!dryRun && result.registered) {
    await mkdir(join(cronPath, ".."), { recursive: true });
    await mkdir(join(plistPath, ".."), { recursive: true });
    await writeFile(cronPath, cronText(root));
    await writeFile(plistPath, launchdText(root));
  }
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

async function driftProblem(root: string, slice: SliceState, checkDrift: boolean): Promise<{ drift: boolean; error?: string; detail?: string }> {
  if (!checkDrift) return { drift: false };
  try {
    if (!slice.contract_id) throw new Error("slice has no contract_id");
    const result = await checkContract(root, slice.contract_id, { repoRoot: slice.repo_root, base: slice.base_ref, head: slice.branch });
    if (result.ok) return { drift: false };
    const parts: string[] = [];
    if (result.violations.length > 0) parts.push("Paths drifted outside the frozen contract.");
    const features = result.feature_violations ?? [];
    if (features.length > 0) {
      parts.push(`Feature id not in the e2e index: ${features.map((item) => item.id).join(", ")}.`);
    }
    if ((result.human_review_violations ?? []).length > 0) {
      parts.push("Human review budget failed the check.");
    }
    return { drift: true, detail: parts.join(" ") || "Paths drifted outside the frozen contract." };
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
    const registered = await timerIsActive(root);
    return {
      noop: true,
      stale_minutes: options.staleMinutes ?? DEFAULT_STALE_MINUTES,
      checked: 0,
      flagged: [],
      timer: registered ? "unchanged" : "absent",
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
        ? `Check failed for ${hop}. ${problem.error ? "Unable to inspect the recorded repository/branch; run check for details." : problem.detail ?? "Paths drifted outside the frozen contract."}`
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
  proposalId?: string;
  allowUntimed?: boolean;
}

function contractField(markdown: string, label: string): string {
  const match = new RegExp(`^${label}:[ \\t]*(.+)$`, "im").exec(markdown);
  const value = match?.[1]?.trim().replace(/^`|`$/g, "") ?? "";
  if (!value || (value.startsWith("<") && value.endsWith(">"))) return "";
  return value;
}

/** Exact plan the human accepted. Required when the team turns learning / natural-language consent on. */
export async function assertDispatchConsent(root: string, contractId: string, proposalId?: string): Promise<{ proposalId: string; acceptedText: string; acceptedBy: string; acceptedAt: string }> {
  const markdown = await readFile(contractFile(root, contractId), "utf8");
  const acceptedText = contractField(markdown, "Accepted text");
  const acceptedBy = contractField(markdown, "Accepted by");
  const acceptedAt = contractField(markdown, "Accepted at");
  const recordedProposal = contractField(markdown, "Proposal id");
  if (!acceptedText) throw new Error("contract must record Accepted text");
  if (!acceptedBy) throw new Error("contract must record Accepted by");
  if (!acceptedAt || !Number.isFinite(Date.parse(acceptedAt))) throw new Error("contract must record a valid Accepted at");
  if (!recordedProposal) throw new Error("contract must record Proposal id");
  if (proposalId && proposalId !== recordedProposal) throw new Error(`proposal id mismatches ${recordedProposal}`);
  const proposalPath = join(root, ".agent-ship", "proposals", `${recordedProposal}.md`);
  try {
    const proposal = await readFile(proposalPath, "utf8");
    const proposalRecorded = contractField(proposal, "Proposal id");
    if (proposalRecorded && proposalRecorded !== recordedProposal) throw new Error(`proposal id mismatches ${proposalPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { proposalId: recordedProposal, acceptedText, acceptedBy, acceptedAt };
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
    const context = await teamContext(root, { tags: input.tags, project: input.project, repo, auto: true });
    const consent = context.learning_required ? await assertDispatchConsent(root, input.contractId, input.proposalId) : undefined;
    if (context.learning_required && !input.workerRef?.trim()) throw new Error("managed tasks require --worker");
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
    const timer = await installWatchdogTimer(root);
    const health = await watchdogStatus(root);
    if ((!timer.registered || health.healthy === false) && !input.allowUntimed) throw new Error(`watchdog admission failed: ${timer.warning ?? health.warning ?? "timer not registered"}; no slice was dispatched. Repair the timer or explicitly pass --allow-untimed for manual supervision.`);
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
      monitored: timer.registered && health.healthy !== false,
      monitoring_status: !timer.registered || health.healthy === false ? "manual" : health.healthy === null ? "registered_unverified" : "healthy",
      allow_untimed: input.allowUntimed === true,
      learning_required: context.learning_required,
      ...(consent ? { proposal_id: consent.proposalId, accepted_text: consent.acceptedText, accepted_by: consent.acceptedBy, accepted_at: consent.acceptedAt } : {}),
      context_refs: context.required_sources,
      lesson_ids: context.lessons.map((lesson) => lesson.id),
      context_tags: context.query.tags,
      ...(context.query.project ? { project_id: context.query.project } : {}),
      sequence: await nextSequence(root),
      ...(Object.keys(threadRefs).length > 0 ? { thread_refs: threadRefs } : {}),
    };
    await mkdir(join(root, ".agent-ship"), { recursive: true });
    await appendFile(eventsFile(root), `${JSON.stringify(event)}\n`, "utf8");
    if (context.lessons.length) await appendFile(eventsFile(root), `${JSON.stringify({ id: newEventId(), type: "lesson_used", title: "Dispatch guidance", summary: "Reviewed soft guidance supplied.", source_task_id: input.sourceTaskId, project: input.project ?? null, lesson_ids: context.lessons.map(l => l.id), checkpoint: "slice_start", sequence: await nextSequence(root), created_at: new Date().toISOString() })}\n`);
    const count = (await activeSlices(root)).length;
    await mkdir(join(repo, ".agent-ship"), { recursive: true });
    await writeFile(join(repo, ".agent-ship/active-contract"), `${input.contractId}\n`);
    await writeFile(join(repo, ".agent-ship/state-root"), `${root}\n`);
    return { timer, monitored: event.monitored, monitoring_status: event.monitoring_status, active: count, context };
  });
}

export async function updateSlice(root: string, taskId: string, status: string, summary = "Worker status updated.", workerRef?: string, allowUntimed = false): Promise<{ active: number; timer: TimerInstall }> {
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
    const resume = status === "running" || status === "queued";
    const timer = resume ? await installWatchdogTimer(root) : { action: "unchanged" as const, registered: await timerIsActive(root), platform: timerPlatform(), dry_run: false, entry: cronMarker(root).line, cron_file: cronFile(root), launchd_file: launchdFile(root), project_root: root };
    if (resume && (!timer.registered || !(await timerIsActive(root))) && !allowUntimed) throw new Error("watchdog registration/runtime unhealthy; resume rejected (or explicitly pass --allow-untimed)");
    await appendFile(eventsFile(root), `${JSON.stringify({ id: newEventId(), type: "worker_progress", title: current.title, summary: assertSummary(summary), source_task_id: taskId, contract_id: current.contract_id, slice_id: current.slice_id, created_at: new Date().toISOString(), sequence: await nextSequence(root), ...(workerRef ? { worker_ref: workerRef } : {}), status })}\n`);
    const active = (await activeSlices(root)).length;
    return { active, timer };
  });
}
