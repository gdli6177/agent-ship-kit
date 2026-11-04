import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { watch, type FSWatcher } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readlink, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  attentionGoals,
  attentionKind,
  attachmentAbsolutePath,
  importAttachmentBytes,
  validateGoalAttachments,
  WorkspaceService,
  type CrewvaneCommand,
  type WatchdogRequest,
} from "../../../packages/core/src/index.js";
import { HerdrClient, herdrRunner, quoteShell } from "./herdr.js";
import { TerminalHost } from "./terminal-host.js";
import { parseAgentCommand } from "./agent-command.js";
import { Executables } from "./executables.js";
import { HerdrInstallation, type HerdrStatus } from "./herdr-install.js";
import { HerdrPlugin } from "./herdr-plugin.js";
import { deliverGoalUpdate } from "./goal-delivery.js";
import { CoordinatorQueue } from "./coordinator-queue.js";
const exec = promisify(execFile);
let window: BrowserWindow, tray: Tray, root: string | undefined, service: WorkspaceService | undefined, syncing = false, quitting = false;
let stateWatcher: FSWatcher | undefined, stateRefreshTimer: ReturnType<typeof setTimeout> | undefined;
const selections = new Set<string>();
const here = __dirname;
const terminals = new TerminalHost((event) => {
  if (window && !window.isDestroyed()) window.webContents.send("crewvane:event", event);
});
const rendererURL = pathToFileURL(join(here, "renderer/index.html")).href;
let tools: Executables, herdrInstallation: HerdrInstallation, herdrPlugin: HerdrPlugin;
function sessionName(path = root) { return process.env.CREWVANE_HERDR_SESSION ?? `crewvane-${createHash("sha256").update(path ?? "").digest("hex").slice(0, 10)}`; }
function sender(event: Electron.IpcMainInvokeEvent) { if (event.sender !== window.webContents || event.senderFrame?.url !== rendererURL) throw new Error("不受信任的界面请求"); }
function activeService() { if (!service) throw new Error("请先打开工作区"); return service; }
async function snapshot() { return activeService().read(); }
async function validatedAttachment(goalId: string, attachmentId: string) {
  if (typeof goalId !== "string" || typeof attachmentId !== "string")
    throw new Error("附件参数无效");
  const target = activeService(), state = await target.read(),
    item = state.goals.find(goal => goal.id === goalId),
    attachment = item?.attachments?.find(candidate => candidate.id === attachmentId);
  if (!attachment) throw new Error("找不到这个附件");
  const [validated] = await validateGoalAttachments(target.root, [attachment]);
  return { target, attachment: validated!, path: attachmentAbsolutePath(target.root, validated!) };
}
function broadcastHerdrStatus(status: HerdrStatus) {
  if (!window || window.isDestroyed()) return;
  window.webContents.send("crewvane:event", {
    type: "herdr-status",
    status: {
      ...status,
      session: sessionName(),
      plugin: herdrPlugin?.status() ?? { phase: "idle", installed: false },
    },
  });
}
async function executable(command: string, cwd?: string) {
  return tools.find(command, cwd);
}
async function herdrStatus() {
  return {
    ...await herdrInstallation.status(),
    session: sessionName(),
    plugin: herdrPlugin?.status() ?? { phase: "idle", installed: false },
  };
}
async function agentChoices() {
  const status = await herdrStatus();
  if (!status.executable) return [];
  const help = (await exec(status.executable, ["agent", "start", "--help"], { timeout: 10_000 })).stdout;
  const kinds = /\[possible values:\s*([^\]]+)\]/.exec(help)?.[1]?.split(",").map(value => value.trim()) ?? [];
  return Promise.all(kinds.filter(kind => /^[a-z][a-z0-9_-]{0,31}$/.test(kind)).map(async kind => ({
    kind, installed: Boolean(await executable(kind)),
  })));
}
let companionPreparation: Promise<Awaited<ReturnType<typeof prepareHerdrCompanionsNow>>> | undefined;
function prepareHerdrCompanions(workspace = root) {
  companionPreparation ??= prepareHerdrCompanionsNow(workspace).finally(() => {
    companionPreparation = undefined;
  });
  return companionPreparation;
}
async function prepareHerdrCompanionsNow(workspace = root) {
  const status = await herdrInstallation.ensure();
  if (!status.executable) return status;
  try {
    await installCli(workspace);
  } catch (error) {
    herdrPlugin.fail(`Crewvane CLI 准备失败：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  const plugin = await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  if (plugin.phase === "error") throw new Error(plugin.detail);
  return status;
}
async function installHerdr() {
  const status = await herdrInstallation.ensure(true);
  if (!status.executable) return status;
  try {
    await installCli();
  } catch (error) {
    herdrPlugin.fail(`Crewvane CLI 准备失败：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  return status;
}
async function cliStatus() {
  const bundled = join(here, "cli/crewvane.cjs"), path = join(app.getPath("home"), ".local/bin/crewvane"), directory = join(app.getPath("userData"), "bin");
  return { bundled: Boolean(await access(bundled).then(() => true).catch(() => false)), installed: Boolean(await lstat(path).then(() => true).catch(() => false)), path, directory };
}
let cliInstallQueue: Promise<{ output: string }> = Promise.resolve({ output: "" });
function installCli(workspace = root) {
  const installing = cliInstallQueue.catch(() => undefined).then(() => installCliNow(workspace));
  cliInstallQueue = installing;
  return installing;
}
async function installCliNow(workspace = root) {
  const status = await cliStatus(); if (!status.bundled) throw new Error("安装包缺少内置 CLI");
  await mkdir(status.directory, { recursive: true });
  await mkdir(join(app.getPath("home"), ".local/bin"), { recursive: true });
  if (status.installed) {
    const existing = await readFile(status.path, "utf8").catch(() => "");
    const linked = await realpath(status.path).catch(() => "");
    const target = await readlink(status.path).catch(() => "");
    if (!existing.startsWith("#!/bin/sh\n# Crewvane embedded CLI\n") &&
      linked !== join(status.directory, "crewvane") && target !== join(status.directory, "crewvane"))
      throw new Error(`${status.path} 已存在，且不是 Crewvane 安装的 CLI。请手动处理后重试。`);
  }
  const cliRuntime = app.isPackaged ? join(process.resourcesPath, "cli-node") : process.execPath;
  const cliBundle = app.isPackaged ? join(process.resourcesPath, "app.asar.unpacked/dist/cli/crewvane.cjs") : join(here, "cli/crewvane.cjs");
  const launcher = join(status.directory, "crewvane");
  const defaultRoot = workspace ? quoteShell(workspace) : '""';
  await writeFile(launcher, `#!/bin/sh\n# Crewvane embedded CLI\n[ -n "\${CREWVANE_WORKSPACE:-}" ] || CREWVANE_WORKSPACE=${defaultRoot}\nexport CREWVANE_WORKSPACE\nELECTRON_RUN_AS_NODE=1 exec ${quoteShell(cliRuntime)} ${quoteShell(cliBundle)} "$@"\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  if (status.installed) await unlink(status.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await symlink(launcher, status.path);
  const checked = await exec(status.path, ["status", ...(workspace ? ["--root", workspace] : [])], { timeout: 15_000 });
  const installed = await cliStatus();
  if (window && !window.isDestroyed()) {
    window.webContents.send("crewvane:event", { type: "cli-status", status: installed });
  }
  return { ...installed, output: checked.stdout.trim() };
}
function client(path: string, workspace = root) {
  const session = sessionName(workspace);
  return new HerdrClient(herdrRunner(path, session), session, async () => {
    await terminals.attach(path, session, workspace!);
    if (root === workspace) window.webContents.send("crewvane:event", { type: "terminal-available", session, title: "全局管家" });
  });
}
async function closeEndedGoalSession(target: WorkspaceService, goalId: string, executable?: string) {
  const item = (await target.read()).goals.find(goal => goal.id === goalId);
  if (!item || !["completed", "dropped"].includes(item.status) || !item.herdr) return false;
  const herdrExecutable = executable ?? (await herdrStatus()).executable;
  if (!herdrExecutable) throw new Error("Herdr 当前不可用，负责人现场将在恢复后自动关闭");
  await client(herdrExecutable, target.root).closeGoal(item.herdr);
  await target.execute({ type: "session.release", goalId });
  return true;
}
const preparations = new Map<string, Promise<import("../../../packages/core/src/index.js").HerdrReference>>();
const refreshedConcierges = new Map<string, string>();
function conciergeIdentity(reference: import("../../../packages/core/src/index.js").HerdrReference) {
  return JSON.stringify([reference.session, reference.paneId, reference.agent, reference.processId]);
}
const handoffs = new Map<string, Promise<void>>();
const coordinatorQueue = new CoordinatorQueue();
function coordinate<T>(target: WorkspaceService, task: () => Promise<T>): Promise<T> {
  return coordinatorQueue.run(target.root, task);
}
function coordinatorScope(target: WorkspaceService) {
  return join(target.root, ".crewvane", "coordinator-scope.json");
}
async function setCoordinatorScope(target: WorkspaceService, goalId: string, requestId?: string) {
  await writeFile(coordinatorScope(target), `${JSON.stringify({
    goalId, requestId, setAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}
async function dispatchGoal(target: WorkspaceService, goalId: string): Promise<void> {
  const key = `${target.root}:${goalId}`;
  const pending = handoffs.get(key); if (pending) return pending;
  const work = coordinate(target, async () => {
    try {
      await deliverGoalUpdate(target, goalId, async item => {
        const reference = await prepareConcierge(target);
        const latest = (await target.read()).goals.find(goal => goal.id === goalId);
        if (!latest || latest.mode !== "concierge" || ["completed", "dropped"].includes(latest.status) ||
          latest.dispatch?.id !== item.dispatch?.id) return;
        const status = await herdrStatus();
        if (!status.executable) throw new Error("Herdr 尚未准备好");
        const herdrExecutable = status.executable;
        const messenger = client(herdrExecutable, target.root);
        await setCoordinatorScope(target, item.id, item.dispatch?.id);
        if (item.dispatch?.kind === "follow_up")
          await messenger.notifyFollowUp(reference, item.id, item.dispatch.note || "", item, target.root);
        else await messenger.notifyGoal(reference, item.id, item.title, item, target.root);
      });
    } finally {
      if (root === target.root && !window.isDestroyed()) window.webContents.send("crewvane:event", {
        type: "snapshot", state: await target.read(), workspace: target.root,
      });
    }
  });
  handoffs.set(key, work);
  try { await work; } finally { handoffs.delete(key); }
}
async function prepareConcierge(target = activeService()) {
  const pending = preparations.get(target.root);
  if (pending) return pending;
  const preparing = doPrepareConcierge(target);
  preparations.set(target.root, preparing);
  try { return await preparing; } finally { preparations.delete(target.root); }
}
async function doPrepareConcierge(target: WorkspaceService) {
  const status = await herdrInstallation.ensure();
  if (!status.executable) throw new Error(status.detail ?? "Herdr 尚未准备好，请在设置中重试");
  await installCli(target.root);
  const plugin = await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  if (plugin.phase === "error") throw new Error(plugin.detail);
  await rm(coordinatorScope(target), { force: true });
  const state = await target.read();
  await target.execute({ type: "concierge.status", status: "not_ready", reference: state.concierge, detail: "正在准备全局管家…" });
  try {
    const existing = await client(status.executable, target.root).findConcierge(state.concierge);
    if (existing) {
      const identity = conciergeIdentity(existing);
      if (refreshedConcierges.get(target.root) !== identity) {
        await client(status.executable, target.root).refreshConcierge(existing, target.root, state.agents);
        refreshedConcierges.set(target.root, identity);
      }
      await target.execute({ type: "concierge.status", status: "ready", reference: existing });
      return existing;
    }
    const home = app.getPath("home");
    const preferences = state.agents ?? { concierge: "codex" };
    const command = parseAgentCommand(preferences.concierge, (await agentChoices()).map(option => option.kind));
    const agentExecutable = await executable(command.executable, target.root);
    if (!agentExecutable) throw new Error(`未找到 ${command.executable} CLI，请先安装，或在设置中修改管家启动命令。`);
    const reference = await client(status.executable, target.root).prepareConcierge(
      target.root,
      state.concierge,
      command.kind ?? "",
      join(home, ".local/bin"),
      `${dirname(status.executable)}:${join(home, ".local/bin")}`,
      dirname(agentExecutable),
      async (reference) => {
        await target.execute({ type: "concierge.status", status: "not_ready", reference, detail: "正在启动管家…" });
      },
      preferences,
      command.args,
      agentExecutable,
    );
    refreshedConcierges.set(target.root, conciergeIdentity(reference));
    await target.execute({ type: "concierge.status", status: "ready", reference });
    return reference;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await target.execute({ type: "concierge.status", status: "error", reference: (await target.read()).concierge, detail });
    throw new Error(`管家尚未准备好：${detail}`);
  }
}
async function openHerdr(reference?: import("../../../packages/core/src/index.js").HerdrReference) {
  const target = activeService(), session = sessionName(target.root);
  const status = await herdrInstallation.ensure(); if (!status.executable) throw new Error("Herdr 尚未准备好，请在设置中重试");
  const connection = client(status.executable, target.root);
  await terminals.attach(status.executable, session, target.root);
  await connection.ensureSession();
  if (reference?.tabId || reference?.agent) await connection.open(reference);
  if (root === target.root) window.webContents.send("crewvane:event", {
    type: "terminal-open", session, title: reference?.agent === "concierge" ? "全局管家" : "工作现场",
  });
}
function watchWorkspaceState(target: WorkspaceService) {
  stateWatcher?.close();
  if (stateRefreshTimer) clearTimeout(stateRefreshTimer);
  stateWatcher = watch(join(target.root, ".crewvane"), { persistent: false }, (_event, filename) => {
    const name = filename?.toString();
    if (name && name !== "state.json" && name !== "events.jsonl") return;
    if (stateRefreshTimer) clearTimeout(stateRefreshTimer);
    stateRefreshTimer = setTimeout(async () => {
      if (root !== target.root || service !== target) return;
      try {
        const state = await target.read();
        if (!window.isDestroyed())
          window.webContents.send("crewvane:event", { type: "snapshot", state, workspace: target.root });
      } catch (error) {
        if (!window.isDestroyed()) window.webContents.send("crewvane:event", {
          type: "diagnostic",
          message: `工作区更新暂未同步：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }, 80);
  });
}
async function openWorkspace(path: string) {
  const canonical = await realpath(path); if (!(await stat(canonical)).isDirectory()) throw new Error("工作区必须是目录");
  const opened = new WorkspaceService(canonical); await opened.read();
  root = canonical; service = opened;
  watchWorkspaceState(opened);
  void opened.execute({ type: "attachments.cleanup", retentionDays: 30 }).catch(error => {
    if (!window.isDestroyed()) window.webContents.send("crewvane:event", {
      type: "diagnostic",
      message: `附件清理暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "workspaces.json"), JSON.stringify({ selected: root }), { mode: 0o600 });
  window.webContents.send("crewvane:event", { type: "refresh", workspace: root });
  if (process.env.CREWVANE_TEST_SKIP_HERDR_SETUP !== "1")
    void prepareHerdrCompanions(canonical).catch(error => {
      if (!window.isDestroyed()) window.webContents.send("crewvane:event", {
        type: "diagnostic", message: error instanceof Error ? error.message : String(error),
      });
    });
}
async function synchronize() {
  if (syncing || !service || !root) return;
  syncing = true;
  const target = service, workspace = root;
  try {
    let state = await target.read(), status = await herdrStatus();
    if (status.executable) {
      for (const goal of state.goals.filter(goal =>
        ["completed", "dropped"].includes(goal.status) && goal.herdr)) {
        await closeEndedGoalSession(target, goal.id, status.executable).catch(() => {});
      }
      state = await target.read();
    }
    for (const goal of state.goals.filter(goal => goal.mode === "concierge" && goal.dispatch?.status === "pending" &&
      !["completed", "dropped"].includes(goal.status))) {
      void dispatchGoal(target, goal.id).catch(() => {});
    }
    const tracked = state.goals.filter(goal => goal.status === "active" && (goal.herdr?.agent || goal.herdr?.transport === "pane"));
    if (status.executable && tracked.length) {
      try {
        const all = await client(status.executable, workspace).presences(tracked);
        const presences = Object.fromEntries(Object.entries(all).filter(([id, presence]) => {
          const previous = tracked.find(goal => goal.id === id)?.live;
          return previous?.state !== presence.state || previous?.reachable !== presence.reachable ||
            Date.now() - Date.parse(previous?.checkedAt ?? "") >= 60_000;
        }));
        if (Object.keys(presences).length) await target.execute({ type: "live.sync", presences });
      } catch {
        const presences = Object.fromEntries(tracked.filter(goal => goal.live?.reachable !== false)
          .map(goal => [goal.id, { state: "unknown" as const, reachable: false, checkedAt: new Date().toISOString() }]));
        if (Object.keys(presences).length) await target.execute({ type: "live.sync", presences });
      }
    }
    const requests = (await target.execute({ type: "watchdog.inspect", at: new Date().toISOString() }) as WatchdogRequest[]).slice(0, 10);
    state = await target.read();
    for (const goal of attentionGoals(state.goals)) {
      if (root !== workspace) break;
      const kind = attentionKind(goal)!;
      if (goal.attention?.notifiedAt || !Notification.isSupported()) continue;
      const notification = new Notification({ title: kind === "review" ? "有一份成果等你验收" : kind === "follow_up" ? "到了该跟进的时候" : "Crewvane · 需要你处理", body: `${goal.title}\n${goal.attention?.summary ?? goal.next}`.slice(0, 220) });
      notification.on("click", () => { window.show(); window.webContents.send("crewvane:event", { type: "open-goal", goalId: goal.id }); }); notification.show();
      await target.execute({ type: "notification.sent", goalId: goal.id, kind, at: new Date().toISOString() });
    }
    if (requests.length && root === workspace) {
      let failure: string | undefined;
      try {
        if (!status.executable || state.concierge.status !== "ready") throw new Error("管家尚未连接，请点击「找管家」恢复");
        const coordinator = client(status.executable, workspace);
        await coordinate(target, async () => {
          for (const request of requests) {
            await setCoordinatorScope(target, request.goalId, `watchdog-${Date.parse(request.basis)}`);
            await coordinator.notifyWatchdog(state.concierge, [request]);
          }
        });
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      for (const request of requests) await target.execute({
        type: "watchdog.report", goalId: request.goalId, at: new Date().toISOString(), basis: request.basis,
        outcome: failure ? "failed" : "contacted", ...(failure ? { detail: failure.slice(0, 1000) } : {}),
      });
    }
    state = await target.read();
    if (root === workspace && !window.isDestroyed()) window.webContents.send("crewvane:event", { type: "snapshot", state, workspace });
  } catch (error) {
    if (root === workspace && !window.isDestroyed()) window.webContents.send("crewvane:event", { type: "diagnostic", message: `后台同步暂未成功：${error instanceof Error ? error.message : String(error)}` });
  } finally { syncing = false; }
}
const singleInstance = process.env.CREWVANE_TEST_USER_DATA ? true : app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on("second-instance", () => { window?.show(); window?.focus(); });
app.whenReady().then(async () => {
  if (process.env.CREWVANE_TEST_USER_DATA) app.setPath("userData", process.env.CREWVANE_TEST_USER_DATA);
  if (process.env.CREWVANE_TEST_HOME) app.setPath("home", process.env.CREWVANE_TEST_HOME);
  const managedBin = join(app.getPath("userData"), "runtime");
  tools = new Executables(app.getPath("home"), managedBin, process.env,
    !!process.env.CREWVANE_TEST_HOME && process.env.CREWVANE_TEST_ISOLATE_TOOLS === "1");
  herdrInstallation = new HerdrInstallation(tools, join(managedBin, "herdr"), broadcastHerdrStatus);
  const integrationEnvironment = process.env.CREWVANE_TEST_HOME ? {
    ...process.env,
    HOME: app.getPath("home"),
    XDG_CONFIG_HOME: join(app.getPath("home"), ".config"),
    XDG_STATE_HOME: join(app.getPath("home"), ".local/state"),
  } : process.env;
  herdrPlugin = new HerdrPlugin(
    app.isPackaged ? join(process.resourcesPath, "herdr-plugin") : join(app.getAppPath(), "herdr-plugin"),
    join(app.getPath("userData"), "herdr-plugin"),
    app.getVersion(),
    integrationEnvironment,
  );
  app.setName("Crewvane");
  // BrowserWindow.icon is ignored by the macOS Dock in development.
  // Packaged builds embed the same artwork as their CFBundleIconFile.
  app.dock?.setIcon(nativeImage.createFromPath(join(here, "assets/crewvane-icon.png")));
  process.env.PATH = (await tools.paths()).join(":");
  const width = Number(process.env.CREWVANE_TEST_WINDOW_WIDTH), height = Number(process.env.CREWVANE_TEST_WINDOW_HEIGHT);
  window = new BrowserWindow({ width: Number.isFinite(width) && width >= 900 ? width : 1440, height: Number.isFinite(height) && height >= 700 ? height : 960, minWidth: 900, minHeight: 700, title: "Crewvane · 协航", titleBarStyle: "hiddenInset", backgroundColor: "#10131e", icon: join(here, "assets/crewvane-icon.png"), webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" })); window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.on("close", (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
  ipcMain.handle("crewvane:environment", (event) => { sender(event); return { workspace: root, version: app.getVersion() }; });
  ipcMain.handle("crewvane:import-attachments", async (event, inputs: { name: string; bytes: ArrayBuffer }[]) => {
    sender(event);
    const target = activeService();
    if (!Array.isArray(inputs) || inputs.length > 8) throw new Error("附件列表无效");
    return importAttachmentBytes(target.root, inputs.map(input => ({ name: input?.name, bytes: input?.bytes })));
  });
  ipcMain.handle("crewvane:attachment-preview", async (event, goalId: string, attachmentId: string) => {
    sender(event);
    const { attachment, path } = await validatedAttachment(goalId, attachmentId),
      image = nativeImage.createFromPath(path);
    if (image.isEmpty()) throw new Error(`无法读取图片：${attachment.name}`);
    const size = image.getSize(), scale = Math.min(1, 360 / size.width, 240 / size.height);
    return image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: "best",
    }).toDataURL();
  });
  ipcMain.handle("crewvane:open-attachment", async (event, goalId: string, attachmentId: string) => {
    sender(event);
    const { path } = await validatedAttachment(goalId, attachmentId),
      error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  ipcMain.handle("crewvane:workspace", async (event) => { sender(event); const picked = await dialog.showOpenDialog(window, { title: "选择 Crewvane 工作区", properties: ["openDirectory", "createDirectory"] }); if (picked.canceled || !picked.filePaths[0]) return null; await openWorkspace(picked.filePaths[0]); return root; });
  ipcMain.handle("crewvane:project", async (event) => { sender(event); const picked = await dialog.showOpenDialog(window, { title: "选择项目目录", properties: ["openDirectory"] }); const path = picked.filePaths[0]; if (!path) return null; const real = await realpath(path); selections.add(real); return real; });
  ipcMain.handle("crewvane:command", async (event, command: CrewvaneCommand) => {
    sender(event); if (!command || JSON.stringify(command).length > 256_000) throw new Error("无效的命令");
    if (command.type === "project.add" && command.path && !selections.has(command.path)) throw new Error("请通过文件选择器选择项目目录");
    if (command.type === "agents.configure") {
      const kinds = (await agentChoices()).map(option => option.kind);
      for (const value of Object.values(command.preferences)) if (value?.trim()) parseAgentCommand(value, kinds);
    }
    const target = activeService();
    if (command.type === "goal.delete") {
      const item = (await target.read()).goals.find(goal => goal.id === command.goalId);
      if (item && ["completed", "dropped"].includes(item.status) && item.herdr)
        await closeEndedGoalSession(target, item.id);
    }
    const result = await target.execute(command);
    if (command.type === "goal.intake" || (command.type === "goal.create" && command.input.mode === "concierge") ||
      command.type === "goal.followup" || command.type === "goal.delegate" || (command.type === "goal.resume" && command.mode === "concierge") ||
      command.type === "goal.resolve" ||
      (command.type === "goal.progress" && command.actor === "你" && (result as import("../../../packages/core/src/index.js").Goal).mode === "concierge")) {
      const item = result as import("../../../packages/core/src/index.js").Goal;
      if (item.dispatch?.status === "pending") void dispatchGoal(target, item.id).catch((error) => {
        if (root === target.root) window.webContents.send("crewvane:event", { type: "diagnostic", message: String(error) });
      });
    }
    if (["goal.accept", "goal.drop"].includes(command.type)) {
      const item = result as import("../../../packages/core/src/index.js").Goal;
      await closeEndedGoalSession(target, item.id).catch((error) => {
        if (root === target.root) window.webContents.send("crewvane:event", {
          type: "diagnostic",
          message: `目标已结束，负责人现场暂未关闭，将自动重试：${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }
    if (["goal.rework", "goal.resolve", "goal.update"].includes(command.type)) {
      const item = result as import("../../../packages/core/src/index.js").Goal, current = await target.read();
      if (item.mode === "concierge" && current.concierge.status === "ready" && item.dispatch?.status !== "pending") {
        const status = await herdrStatus();
        if (status.executable) {
          const herdrExecutable = status.executable;
          try { await coordinate(target, async () => {
            await setCoordinatorScope(target, item.id, `event-${Date.now()}`);
            await client(herdrExecutable, target.root).notifyGoal(current.concierge, item.id, item.title, item, target.root);
          }); }
          catch (error) { window.webContents.send("crewvane:event", { type: "diagnostic", message: error instanceof Error ? error.message : String(error) }); }
        }
      }
    }
    if (root === target.root) window.webContents.send("crewvane:event", { type: "snapshot", state: await target.read(), workspace: target.root }); return result;
  });
  ipcMain.handle("crewvane:herdr-status", (event) => { sender(event); return herdrStatus(); });
  ipcMain.handle("crewvane:agent-choices", (event) => { sender(event); return agentChoices(); });
  ipcMain.handle("crewvane:install-herdr", (event) => { sender(event); return installHerdr(); });
  ipcMain.handle("crewvane:cli-status", (event) => { sender(event); return cliStatus(); });
  ipcMain.handle("crewvane:install-cli", (event) => { sender(event); return installCli(); });
  ipcMain.handle("crewvane:prepare-concierge", (event) => { sender(event); return prepareConcierge(); });
  ipcMain.handle("crewvane:dispatch-goal", (event, goalId: string) => { sender(event); return dispatchGoal(activeService(), goalId); });
  ipcMain.handle("crewvane:open-terminal", async event => { sender(event); await openHerdr(); });
  ipcMain.handle("crewvane:open-herdr", async (event, goalId?: string) => {
    sender(event);
    const state = await snapshot();
    const item = goalId ? state.goals.find((goal) => goal.id === goalId) : undefined;
    if (goalId && !item) throw new Error("目标不存在");
    if (!goalId || (item?.mode === "concierge" && !item.herdr)) await prepareConcierge();
    await openHerdr(item?.herdr ?? (item?.mode === "manual" ? undefined : (await snapshot()).concierge));
  });
  ipcMain.handle("crewvane:terminal-snapshot", (event) => { sender(event); activeService(); return terminals.snapshot(sessionName()); });
  ipcMain.handle("crewvane:terminal-write", (event, session: string, data: string) => {
    sender(event); activeService(); if (session !== sessionName()) throw new Error("终端不属于当前工作区"); terminals.write(session, data);
  });
  ipcMain.handle("crewvane:terminal-resize", (event, session: string, cols: number, rows: number) => {
    sender(event); activeService(); if (session !== sessionName()) throw new Error("终端不属于当前工作区"); terminals.resize(session, cols, rows);
  });
  ipcMain.handle("crewvane:open-url", async (event, url: string) => { sender(event); if (typeof url !== "string" || !url.startsWith("https://")) throw new Error("只允许打开 HTTPS 链接"); await shell.openExternal(url); });
  ipcMain.handle("crewvane:show-cli", async (event) => { sender(event); shell.showItemInFolder((await cliStatus()).path); });
  // Use the approved application artwork, with a Retina representation.
  const traySource = nativeImage.createFromPath(join(here, "assets/crewvane-icon.png"));
  const trayIcon = traySource.resize({ width: 18, height: 18, quality: "best" });
  trayIcon.addRepresentation({ scaleFactor: 2, buffer: traySource.resize({ width: 36, height: 36, quality: "best" }).toPNG() });
  trayIcon.setTemplateImage(false);
  tray = new Tray(trayIcon); tray.setToolTip("Crewvane · 协航"); tray.setContextMenu(Menu.buildFromTemplate([{ label: "打开 Crewvane", click: () => { window.show(); window.focus(); } }, { type: "separator" }, { label: "退出", click: () => app.quit() }])); tray.on("click", () => { window.show(); window.focus(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Crewvane", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "quit" }] }, { role: "editMenu" }, { role: "viewMenu" }]));
  await window.loadURL(rendererURL);
  if (process.env.CREWVANE_TEST_SKIP_HERDR_SETUP !== "1")
    void prepareHerdrCompanions().catch(() => { /* persistent readiness error is shown by the renderer */ });
  const saved = await readFile(join(app.getPath("userData"), "workspaces.json"), "utf8").then(JSON.parse).catch(() => null), workspace = process.env.CREWVANE_TEST_WORKSPACE ?? saved?.selected;
  if (workspace) await openWorkspace(workspace).catch((error) => window.webContents.send("crewvane:event", { type: "diagnostic", message: String(error) }));
  if (process.env.CREWVANE_TEST_PREPARE_CONCIERGE === "1") {
    void prepareConcierge().catch((error) => window.webContents.send("crewvane:event", { type: "diagnostic", message: String(error) }));
  }
  setInterval(() => void synchronize(), 10_000); void synchronize();
});
app.on("activate", () => window?.show());
app.on("before-quit", () => {
  quitting = true;
  stateWatcher?.close();
  if (stateRefreshTimer) clearTimeout(stateRefreshTimer);
  terminals.dispose();
});
