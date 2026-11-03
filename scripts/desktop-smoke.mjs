import { _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), "crewvane-desktop-smoke-"));
const workspace = join(home, "workspace");
await mkdir(workspace);
const project = join(home, "project");
await mkdir(project);
await mkdir(join(project, "src"));
await exec("git", ["init", "-b", "main"], { cwd: project });
await writeFile(
  join(project, "AGENTS.md"),
  "This is a desktop smoke-test fixture. Read-only planning only until explicit start. Do not create subagents or publish.",
);
await writeFile(join(project, "src/app.txt"), "baseline\n");
await exec("git", ["add", "AGENTS.md", "src/app.txt"], { cwd: project });
await exec(
  "git",
  [
    "-c",
    "user.name=Desktop Trial",
    "-c",
    "user.email=trial@localhost",
    "commit",
    "-m",
    "baseline",
  ],
  { cwd: project },
);
const app = await electron.launch({
  args: process.env.CREWVANE_APP_PATH ? [] : [resolve("apps/desktop")],
  executablePath: process.env.CREWVANE_APP_PATH
    ? resolve(process.env.CREWVANE_APP_PATH)
    : resolve(
        "node_modules/.pnpm/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
  env: {
    ...process.env,
    CREWVANE_TEST_USER_DATA: join(home, "userData"),
    CREWVANE_TEST_WORKSPACE: workspace,
  },
  timeout: 60000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  page.on("crash", () => errors.push("renderer process crashed"));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.getByRole("heading", { name: "全部目标" }).waitFor();
  await page
    .locator("nav")
    .getByRole("button", { name: "待办", exact: true })
    .click();
  await page.getByRole("heading", { name: "把精力留给真正的决定。" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "设置", exact: true }).count(),
    1,
  );
  const initialTheme = await page
    .locator(".app-shell")
    .getAttribute("data-theme");
  await page
    .locator(".rail-bottom")
    .getByRole("button", {
      name:
        initialTheme === "dark"
          ? "切换到浅色主题"
          : "切换到深色主题",
    })
    .click();
  assert.notEqual(
    await page.locator(".app-shell").getAttribute("data-theme"),
    initialTheme,
  );
  await page.locator(".rail-bottom").getByRole("button", { name: "设置" }).click();
  await page
    .getByText("推荐终端底座 · 可选", { exact: true })
    .waitFor();
  await page.getByRole("heading", { name: "Herdr", exact: true }).waitFor();
  await page.getByRole("heading", { name: "协作不依赖 Herdr。" }).waitFor();
  const herdr = await page.evaluate(() => window.crewvane.herdrStatus());
  if (herdr.installed) {
    await page.getByText("已安装", { exact: true }).waitFor();
    await page.getByRole("button", { name: "重新检测" }).click();
  } else {
    await page.getByRole("button", { name: "安装 Herdr" }).waitFor();
    await page.getByText("brew install herdr", { exact: true }).waitFor();
  }
  await page.screenshot({ path: join(home, "settings.png") });
  await page.locator(".rail-bottom").getByRole("button", { name: "终端" }).click();
  await page.getByLabel("终端后端").waitFor();
  const defaultBackend = herdr.installed ? "herdr" : "shell";
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[aria-label="终端后端"]')?.value === expected,
    defaultBackend,
  );
  if (herdr.installed) {
    await page
      .locator(".drawer-title")
      .getByText("Herdr", { exact: true })
      .waitFor({ timeout: 30000 });
    await page.waitForTimeout(5000);
    const herdrScreen = await page.locator(".xterm-rows").innerText();
    assert.ok(
      herdrScreen.trim().length > 0,
      "Herdr terminal rendered an empty screen",
    );
    await page.screenshot({ path: join(home, "terminal-herdr.png") });
  }
  await page.getByLabel("终端后端").selectOption("shell");
  await page
    .locator(".drawer-title")
    .getByText(/zsh|bash|fish|sh/, { exact: false })
    .waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => /[$%]/.test(document.querySelector(".xterm-rows")?.textContent ?? ""),
    {},
    { timeout: 30000 },
  );
  await page.getByLabel("交互式终端").click();
  await page.keyboard.type("printf __terminal_ok__");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    ((
      document.querySelector(".xterm-rows")?.textContent ?? ""
    ).match(/__terminal_ok__/g)?.length ?? 0) >= 2,
  );
  await page.screenshot({ path: join(home, "terminal-shell.png") });
  await page.getByRole("button", { name: "关闭终端" }).click();
  await page
    .locator("nav")
    .getByRole("button", { name: "运行时", exact: true })
    .click();
  await page.getByRole("button", { name: "扫描本机运行时" }).click();
  await page.getByRole("heading", { name: "Oh My Pi", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await page.locator("nav").getByRole("button", { name: "工序", exact: true }).click();
  await page.getByRole("heading", { name: "工序可以随任务而变" }).waitFor();
  await page.getByRole("button", { name: "保存新版本" }).click();
  await page.getByText("已保存 v2，现有需求保持原版本。").waitFor();
  await page.locator("nav").getByRole("button", { name: "目标", exact: true }).click();
  await page
    .locator(".empty")
    .getByText("还没有需求。交代一个目标，让团队开始推进。")
    .waitFor();
  await page
    .locator("nav")
    .getByRole("button", { name: "运行时", exact: true })
    .click();
  await page
    .locator(".runtime-card")
    .filter({
      has: page.getByRole("heading", { name: "Oh My Pi", exact: true }),
    })
    .getByRole("button", { name: "连接测试" })
    .click();
  await page
    .locator(".runtime-card")
    .filter({
      has: page.getByRole("heading", { name: "Oh My Pi", exact: true }),
    })
    .getByText("可调度", { exact: true })
    .waitFor({ timeout: 60000 });
  await page.getByLabel("配置名称").fill("桌面试用配置");
  await page.getByLabel("运行时", { exact: true }).selectOption("omp");
  await page
    .getByLabel("模型", { exact: true })
    .selectOption("magpie/codex/gpt-6.1-sol");
  await page.getByLabel("推理强度", { exact: true }).selectOption("low");
  await page.getByRole("button", { name: "保存执行配置" }).click();
  await page
    .locator(".profile-row")
    .getByText("桌面试用配置", { exact: true })
    .waitFor();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, project);
  await page.locator("nav").getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "选择目录", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("input")].some(
      (input) => input.readOnly && input.value.endsWith("/project"),
    ),
  );
  await page.getByLabel("项目名称", { exact: true }).fill("桌面试用项目");
  const profileId = await page.evaluate(
    async () =>
      (await window.crewvane.command({ type: "snapshot" })).profiles[0].id,
  );
  await page.getByLabel("项目默认执行配置").selectOption(profileId);
  await page
    .getByLabel("完整分支验证命令（JSON argv 数组）")
    .fill('[["node","--test"]]');
  await page.getByRole("button", { name: "保存项目设置" }).click();
  await page.getByRole("button", { name: "配置并授权", exact: true }).waitFor();
  await page.getByRole("button", { name: "配置并授权", exact: true }).click();
  await page.getByRole("button", { name: "确认授权", exact: true }).click();
  await page.getByText("已授权", { exact: true }).waitFor();
  await page.locator(".new-goal").click();
  await page.getByRole("heading", { name: "交代一个新目标" }).waitFor();
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector(".modal")).opacity === "1",
  );
  assert.ok(
    (await page.getByRole("button", { name: "交给船长", exact: true }).boundingBox())
      .height >= 36,
    "new goal primary action must retain a usable button height",
  );
  assert.equal(
    await page
      .locator(".modal")
      .evaluate((element) => getComputedStyle(element).opacity),
    "1",
  );
  await page
    .getByRole("checkbox", {
      name: "先沟通方案，由我确认后开工",
    })
    .evaluate((element) => element.click());
  await page
    .getByLabel("目标与验收")
    .fill(
      "桌面端到端试用：先讨论如何为 src/app.txt 增加回归验证，方案出来后等人确认，不修改文件。",
    );
  await page.getByRole("button", { name: "创建讨论", exact: true }).click();
  await page.waitForFunction(
    async () => {
      const state = await window.crewvane.command({ type: "snapshot" });
      return state.tasks[0]?.status === "waiting_human";
    },
    {},
    { timeout: 120000 },
  );
  const planned = await page.evaluate(() =>
    window.crewvane.command({ type: "snapshot" }),
  );
  assert.equal(
    planned.agents.some((a) => a.role === "worker"),
    false,
  );
  assert.equal(
    await readFile(join(project, "src/app.txt"), "utf8"),
    "baseline\n",
  );
  await page.screenshot({ path: join(home, "discussion.png") });
  const cli = await exec(process.execPath, [
    resolve("cli/bin/crewvane.js"),
    "workspace",
    "status",
    "--root",
    workspace,
  ]);
  assert.equal(JSON.parse(cli.stdout).tasks[0].id, planned.tasks[0].id);
  await page.getByRole("button", { name: "停止目标", exact: true }).click();
  await page.getByText("已停止", { exact: true }).waitFor();
  await page.locator(".context-actions").getByRole("button", { name: "船长", exact: true }).click();
  await page.getByLabel("给船长发消息").fill("请只读总结刚才的讨论结果，不启动工人，不修改文件。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.waitForFunction(
    async () => {
      const state = await window.crewvane.command({ type: "snapshot" });
      const question = state.messages.find((message) => message.text.includes("请只读总结刚才的讨论结果"));
      return question && state.messages.some((message) => message.replyTo === question.id);
    },
    {},
    { timeout: 120000 },
  );
  await page.getByRole("button", { name: "关闭船长对话" }).click();
  await page.locator("nav").getByRole("button", { name: "待办", exact: true }).click();
  await page
    .getByRole("heading", { name: "把精力留给真正的决定。", exact: true })
    .waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(home, "inbox.png") });
  const state = await page.evaluate(() =>
    window.crewvane.command({ type: "snapshot" }),
  );
  assert.equal(state.workflows.find((w) => w.id === "feature").version, 2);
  const denied = await page.evaluate(async () => {
    try {
      await window.crewvane.command({
        type: "run-shell",
        command: "echo unsafe",
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(denied, true);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      home,
      screenshot: join(home, "inbox.png"),
      checks: [
        "Electron launch",
        "light and dark theme",
        "settings and Herdr detection",
        "Herdr preferred terminal backend",
        "real Shell terminal output",
        "runtime scan",
        "workflow save",
        "shared snapshot",
        "constrained IPC",
        "renderer isolation",
        "real OMP connection",
        "profile and project setup",
        "project grant",
        "discussion plan without workers",
        "CLI/desktop shared task",
        "single-task cancellation",
        "captain conversation without workers",
      ],
      errors,
    }),
  );
} catch (error) {
  const page = await app.firstWindow();
  await page.screenshot({ path: join(home, "failure.png") });
  console.log(
    JSON.stringify({
      home,
      error: String(error),
      renderer: errors,
      alert: await page.getByRole("alert").allTextContents(),
      invalid: await page
        .locator("input:invalid,select:invalid,textarea:invalid")
        .evaluateAll((nodes) =>
          nodes.map((n) => ({
            tag: n.tagName,
            value: n.value,
            validation: n.validationMessage,
          })),
        ),
      main: await page.locator("main").innerText({ timeout: 5000 }).catch(
        () => "<missing>",
      ),
    }),
  );
  throw error;
} finally {
  await app.close();
}
