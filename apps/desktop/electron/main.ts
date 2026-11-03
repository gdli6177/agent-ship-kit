import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  shell,
  safeStorage,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  access,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, delimiter, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceCommand } from "../../../packages/orchestrator/src/service.js";
import type { WorkspaceState } from "../../../packages/core/src/types.js";
import { CredentialVault } from "../../../packages/orchestrator/src/credentials.js";
import { activeGrant } from "../../../packages/core/src/authority.js";
const here = __dirname;
const exec = promisify(execFile);
let window: BrowserWindow,
  tray: Tray,
  child: UtilityProcess | undefined,
  root: string | undefined,
  quitting = false,
  stopped = false;
let state: WorkspaceState | undefined,
  counter = 0;
const pending = new Map<
  number,
  {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }
>();
const projectSelections = new Set<string>();
const rendererURL = pathToFileURL(join(here, "renderer/index.html")).href;
function credentialVault() {
  return new CredentialVault(join(app.getPath("userData"), "credential-vault"), {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: value => safeStorage.encryptStringAsync(value),
    decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
  });
}
function sender(event: Electron.IpcMainInvokeEvent) {
  if (
    event.sender !== window.webContents ||
    event.senderFrame?.url !== rendererURL
  )
    throw new Error("untrusted IPC sender");
}
function rpc(command: ServiceCommand): Promise<unknown> {
  if (!child) return Promise.reject(new Error("请先打开工作区"));
  const id = ++counter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("操作超时，请检查运行时状态后重试"));
    }, 90_000);
    pending.set(id, { resolve, reject, timer });
    child!.postMessage({ type: "command", command, id });
  });
}
function terminalRequest(
  message: Record<string, unknown>,
  timeout = 15_000,
): Promise<unknown> {
  if (!child) return Promise.reject(new Error("请先打开工作区"));
  const id = ++counter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("终端操作超时"));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    child!.postMessage({ ...message, requestId: id });
  });
}
async function executable(command: string) {
  const paths = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  for (const dir of new Set(paths)) {
    if (!dir) continue;
    const path = join(dir, command);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return await realpath(path);
    } catch {
      /* absent candidate */
    }
  }
}
async function versionOf(path: string) {
  try {
    return (
      await exec(path, ["--version"], {
        timeout: 10_000,
        maxBuffer: 4096,
      })
    ).stdout.trim();
  } catch {
    return undefined;
  }
}
async function herdrStatus() {
  const herdr = await executable("herdr"),
    brew = await executable("brew"),
    version = herdr ? await versionOf(herdr) : undefined;
  return {
    installed: Boolean(herdr),
    ...(herdr ? { executable: herdr } : {}),
    ...(version ? { version } : {}),
    ...(brew ? { homebrew: brew } : {}),
    installAvailable: Boolean(brew),
    installCommand: "brew install herdr" as const,
    docsUrl: "https://herdr.dev" as const,
  };
}
async function installHerdr() {
  const before = await herdrStatus();
  if (before.installed) return { ...before, output: "Herdr 已安装。" };
  if (!before.homebrew)
    throw new Error("未找到 Homebrew，请先安装 Homebrew 或运行官方安装命令。");
  const result = await exec(before.homebrew, ["install", "herdr"], {
    timeout: 15 * 60_000,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  const after = await herdrStatus();
  if (!after.installed) throw new Error("Homebrew 已完成，但仍未找到 Herdr。");
  return {
    ...after,
    output: `${result.stdout}${result.stderr}`.trim().slice(0, 20_000),
  };
}
async function terminalBackends() {
  if (child) state = (await rpc({ type: "snapshot" })) as WorkspaceState;
  const shell = process.env.SHELL,
    shellName = shell ? basename(shell) : "",
    shellPath =
      shell && isAbsolute(shell) && ["bash", "zsh", "fish", "sh"].includes(shellName)
        ? shell
        : await executable("zsh"),
    herdr = await executable("herdr");
  return [
    {
      id: "shell",
      name: shellName || "Shell",
      status: shellPath ? "ready" : "missing",
      reason: shellPath ? "本地登录 Shell" : "未找到 Shell",
    },
    {
      id: "herdr",
      name: "Herdr",
      status: herdr ? "ready" : "missing",
      reason: herdr
        ? "可选的多 Agent 终端会话底座"
        : "未找到 Herdr CLI",
    },
    ...(state?.runtimes ?? [])
      .filter((runtime) => runtime.executable)
      .map((runtime) => ({
        id: `runtime:${runtime.id}`,
        name: runtime.name,
        status: runtime.capabilities?.interactiveTerminal === false ? "unavailable" : "ready",
        reason:
          runtime.status === "ready"
            ? "已通过连接测试"
            : "CLI 已发现，运行时状态由 Crewvane 独立管理",
      })),
  ];
}
async function resolveTerminalBackend(id: string) {
  if (!root) throw new Error("请先打开工作区");
  if (id === "shell") {
    const shell = process.env.SHELL,
      name = shell ? basename(shell) : "",
      path =
        shell && isAbsolute(shell) && ["bash", "zsh", "fish", "sh"].includes(name)
          ? shell
          : await executable("zsh");
    if (!path) throw new Error("未找到本地 Shell");
    return { executable: path, args: ["-l"] };
  }
  if (id === "herdr") {
    const path = await executable("herdr");
    if (!path) throw new Error("未找到 Herdr CLI");
    return { executable: path, args: ["--session", "crewvane"] };
  }
  if (id.startsWith("runtime:")) {
    const runtime = state?.runtimes.find(
      (item) => item.id === id.slice("runtime:".length),
    );
    if (
      !runtime?.executable ||
      runtime.capabilities?.interactiveTerminal === false
    )
      throw new Error("该运行时没有可用的交互式 CLI");
    return {
      executable: runtime.executable,
      args: runtime.interactiveArgs ?? [],
    };
  }
  throw new Error("unknown terminal backend");
}
async function resolveTerminalCwd(candidate?: string) {
  if (!root) throw new Error("请先打开工作区");
  if (child) state = (await rpc({ type: "snapshot" })) as WorkspaceState;
  const path = await realpath(candidate || root),
    allowed = new Set([
      root,
      ...(state?.projects.map((project) => project.path) ?? []),
      ...(state?.tasks.map((task) => task.checkout).filter(Boolean) ?? []),
    ]);
  if (!allowed.has(path)) throw new Error("终端目录不在当前工作区授权范围");
  return path;
}
async function shutdown() {
  if (!child || stopped) return;
  const proc = child;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error("仍有运行中的任务，暂未退出；请在需求页停止后重试。")),
      15_000,
    );
    const handler = (data: any) => {
      if (data.type === "stopped") {
        clearTimeout(timer);
        proc.removeListener("message", handler);
        stopped = true;
        proc.kill();
        child = undefined;
        resolve();
      }
    };
    proc.on("message", handler);
    proc.postMessage({ type: "stop" });
  });
}
async function openWorkspace(path: string) {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory())
    throw new Error("workspace must be a directory");
  await shutdown();
  stopped = false;
  root = canonical;
  state = undefined;
  child = utilityProcess.fork(join(here, "utility.cjs"), [], {
    serviceName: "Crewvane Orchestrator",
    stdio: "pipe",
  });
  const workspaceChild = child;
  child.on("message", (data: any) => {
    if (data.type === "credential.request") {
      const requestedRoot = root;
      void (async () => {
        try {
          const current = await rpc({ type: "snapshot" }) as WorkspaceState;
          const task = current.tasks.find(t => t.id === data.taskId);
          const project = current.projects.find(p => p.id === task?.projectId);
          if (!task || !project || task.status !== "running" || task.cancelledAt ||
            activeGrant(project).id !== task.grantId || !Number.isInteger(data.checkIndex) ||
            data.checkIndex < 0 || data.checkIndex >= project.checks.length || root !== requestedRoot || child !== workspaceChild)
            throw new Error("task is not authorized for credential use");
          const environment = await credentialVault().environment(project, data.checkIndex);
          if (root !== requestedRoot || child !== workspaceChild) throw new Error("workspace changed during secure storage access");
          workspaceChild.postMessage({ type: "credential.response", id: data.id, environment });
        } catch {
          workspaceChild.postMessage({ type: "credential.response", id: data.id, error: "测试凭据不可用或授权已改变，验证未执行。请检查系统安全存储与项目授权。" });
        }
      })();
      return; // Secure broker traffic is never forwarded to the renderer.
    }
    if (data.type === "reply") {
      const p = pending.get(data.id);
      if (p) {
        pending.delete(data.id);
        clearTimeout(p.timer);
        data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
      }
    }
    if (data.type === "snapshot") state = data.state;
    if (
      (data.type === "terminal.data" || data.type === "terminal.exit") &&
      !window.isDestroyed()
    )
      window.webContents.send("crewvane:event", data);
    if (data.type === "attention" && Notification.isSupported())
      new Notification({
        title: "协航 · 需要你决定",
        body: String(data.event.question).slice(0, 120),
      })
        .on("click", () => window.show())
        .show();
    if (!data.type.startsWith("terminal.") && !window.isDestroyed())
      window.webContents.send("crewvane:event", { ...data, workspace: root });
  });
  child.on("exit", (code) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`后台进程已退出 (${code})`));
    }
    pending.clear();
    if (!stopped && !window.isDestroyed())
      window.webContents.send("crewvane:event", {
        type: "diagnostic",
        message: "后台进程中断，重启应用后核对未完成需求。",
      });
  });
  child.postMessage({ type: "init", root });
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(
    join(app.getPath("userData"), "workspaces.json"),
    JSON.stringify({ selected: root }),
    { mode: 0o600 },
  );
}
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  window?.show();
  window?.focus();
});
app.whenReady().then(async () => {
  app.setName("Crewvane");
  process.env.PATH = [
    ...new Set([
      ...(process.env.PATH ?? "").split(":"),
      join(app.getPath("home"), ".bun/bin"),
      join(app.getPath("home"), ".local/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]),
  ].join(":");
  if (process.env.CREWVANE_TEST_USER_DATA)
    app.setPath("userData", process.env.CREWVANE_TEST_USER_DATA);
  const testWidth = Number(process.env.CREWVANE_TEST_WINDOW_WIDTH);
  const testHeight = Number(process.env.CREWVANE_TEST_WINDOW_HEIGHT);
  const hasTestSize =
    Number.isFinite(testWidth) &&
    testWidth >= 1050 &&
    Number.isFinite(testHeight) &&
    testHeight >= 700;
  window = new BrowserWindow({
    width: hasTestSize ? Math.round(testWidth) : 1440,
    height: hasTestSize ? Math.round(testHeight) : 960,
    useContentSize: hasTestSize,
    minWidth: 1050,
    minHeight: 700,
    title: "Crewvane · 协航",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f5f5f2",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  ipcMain.handle("crewvane:environment", (event) => {
    sender(event);
    return { workspace: root, version: app.getVersion() };
  });
  ipcMain.handle("crewvane:vault-status", async event => {
    sender(event);
    return { available: await safeStorage.isAsyncEncryptionAvailable(), provider: "系统钥匙串 / Electron safeStorage" };
  });
  ipcMain.handle("crewvane:vault-save", async (event, input: { projectId: string; label: string; env: string; checkIndex: number; value: string }) => {
    sender(event);
    if (!input || typeof input !== "object") throw new Error("invalid credential input");
    const current = await rpc({ type: "snapshot" }) as WorkspaceState;
    const project = current.projects.find(p => p.id === input.projectId);
    if (!project) throw new Error("project not found");
    const vault = credentialVault();
    const reference = await vault.save(project, input);
    try {
      await rpc({ type: "credential.register", projectId: project.id, reference });
      return reference;
    } catch (error) { await vault.remove(reference.id); throw error; }
  });
  ipcMain.handle("crewvane:vault-remove", async (event, input: { projectId: string; credentialId: string }) => {
    sender(event);
    await rpc({ type: "credential.remove", projectId: input.projectId, credentialId: input.credentialId });
    await credentialVault().remove(input.credentialId);
    return true;
  });
  ipcMain.handle("crewvane:workspace", async (event) => {
    sender(event);
    const picked = await dialog.showOpenDialog(window, {
      title: "选择协航工作区（共享状态存放位置）",
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    await openWorkspace(picked.filePaths[0]);
    return root;
  });
  ipcMain.handle("crewvane:project", async (event) => {
    sender(event);
    const picked = await dialog.showOpenDialog(window, {
      title: "选择项目 Git 仓库",
      properties: ["openDirectory"],
    });
    const path = picked.filePaths[0];
    if (!path) return null;
    const real = await realpath(path);
    projectSelections.add(real);
    return real;
  });
  ipcMain.handle("crewvane:command", async (event, command: ServiceCommand) => {
    sender(event);
    if (
      !command ||
      typeof command !== "object" ||
      typeof command.type !== "string" ||
      JSON.stringify(command).length > 128_000
    )
      throw new Error("invalid IPC command");
    if (
      command.type === "project.save" &&
      !projectSelections.has(command.project.path) &&
      !state?.projects.some(
        (p) => p.id === command.project.id && p.path === command.project.path,
      )
    )
      throw new Error("请通过文件选择器选择项目目录");
    const result = await rpc(command);
    if (command.type === "snapshot" && result)
      state = result as WorkspaceState;
    return result;
  });
  ipcMain.handle("crewvane:evidence", async (event, id: string) => {
    sender(event);
    if (
      !state?.tasks.some((t) => t.id === id) ||
      !/^[a-zA-Z0-9_-]+$/.test(id) ||
      !root
    )
      throw new Error("task not found");
    const path = join(root, ".crewvane", "evidence", id, "report.md");
    await stat(path);
    shell.showItemInFolder(path);
  });
  ipcMain.handle("crewvane:pr", async (event, id: string) => {
    sender(event);
    const url = state?.tasks.find((t) => t.id === id)?.pr;
    if (
      !url ||
      !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/pull\/\d+$/.test(
        url.trim(),
      )
    )
      throw new Error("invalid PR URL");
    await shell.openExternal(url.trim());
  });
  ipcMain.handle("crewvane:terminal-backends", async (event) => {
    sender(event);
    return terminalBackends();
  });
  ipcMain.handle(
    "crewvane:terminal-start",
    async (
      event,
      options: { backend?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown },
    ) => {
      sender(event);
      if (
        !options ||
        typeof options.backend !== "string" ||
        options.backend.length > 160 ||
        (options.cwd !== undefined && typeof options.cwd !== "string") ||
        !Number.isInteger(options.cols) ||
        !Number.isInteger(options.rows)
      )
        throw new Error("invalid terminal options");
      const backend = await resolveTerminalBackend(options.backend),
        cwd = await resolveTerminalCwd(
          typeof options.cwd === "string" ? options.cwd : undefined,
        ),
        id = `term_${randomUUID().replaceAll("-", "")}`;
      await terminalRequest({
        type: "terminal.start",
        id,
        executable: backend.executable,
        args: backend.args,
        cwd,
        cols: options.cols,
        rows: options.rows,
      });
      return { id };
    },
  );
  ipcMain.handle(
    "crewvane:terminal-write",
    async (event, id: string, data: string) => {
      sender(event);
      if (!/^term_[a-zA-Z0-9_-]{8,80}$/.test(id) || typeof data !== "string")
        throw new Error("invalid terminal write");
      return terminalRequest({ type: "terminal.write", id, data });
    },
  );
  ipcMain.handle(
    "crewvane:terminal-resize",
    async (event, id: string, cols: number, rows: number) => {
      sender(event);
      if (
        !/^term_[a-zA-Z0-9_-]{8,80}$/.test(id) ||
        !Number.isInteger(cols) ||
        !Number.isInteger(rows)
      )
        throw new Error("invalid terminal resize");
      return terminalRequest({ type: "terminal.resize", id, cols, rows });
    },
  );
  ipcMain.handle("crewvane:terminal-stop", async (event, id: string) => {
    sender(event);
    if (!/^term_[a-zA-Z0-9_-]{8,80}$/.test(id))
      throw new Error("invalid terminal id");
    return terminalRequest({ type: "terminal.stop", id });
  });
  ipcMain.handle("crewvane:herdr-status", async (event) => {
    sender(event);
    return herdrStatus();
  });
  ipcMain.handle("crewvane:install-herdr", async (event) => {
    sender(event);
    return installHerdr();
  });
  ipcMain.handle("crewvane:open-herdr-docs", async (event) => {
    sender(event);
    await shell.openExternal("https://herdr.dev");
  });
  const icon = nativeImage.createFromDataURL(
    `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAH0lEQVQ4T2NkoBAwUqifYdQAhtFAYjSQYTSQYTSQYQQDAEpqAhGTSwJmAAAAAElFTkSuQmCC`,
  );
  tray = new Tray(icon);
  tray.setToolTip("Crewvane · 协航");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开协航", click: () => window.show() },
      { type: "separator" },
      { label: "停止任务并退出", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => window.show());
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Crewvane",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "quit", label: "停止任务并退出" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
    ]),
  );
  await window.loadURL(rendererURL);
  const saved = await readFile(
    join(app.getPath("userData"), "workspaces.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch(() => null);
  const workspace = process.env.CREWVANE_TEST_WORKSPACE ?? saved?.selected;
  if (workspace)
    await openWorkspace(workspace).catch((error) =>
      window.webContents.send("crewvane:event", {
        type: "diagnostic",
        message: String(error),
      }),
    );
  powerMonitor.on("resume", () =>
    window.webContents.send("crewvane:event", {
      type: "diagnostic",
      message: "电脑已唤醒，后台正在核对任务与会话。",
    }),
  );
});
app.on("activate", () => window?.show());
app.on("before-quit", (event) => {
  if (stopped || !child) {
    quitting = true;
    return;
  }
  event.preventDefault();
  void shutdown()
    .then(() => {
      quitting = true;
      app.quit();
    })
    .catch((error) => {
      window.show();
      void dialog.showMessageBox(window, {
        type: "error",
        message: String(error),
      });
    });
});
