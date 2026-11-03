import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WorkspaceService } from "../packages/orchestrator/src/index.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const output = join(repo, "docs/qa/design-qa");
const fixture = process.env.CREWVANE_DESIGN_FIXTURE;
if (!fixture)
  throw new Error("CREWVANE_DESIGN_FIXTURE must point to the local design fixture");
const executable = process.env.CREWVANE_APP_PATH
  ? resolve(process.env.CREWVANE_APP_PATH)
  : resolve("node_modules/.pnpm/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const executableLabel = executable.startsWith(repo)
  ? executable.slice(repo.length)
  : "configured-external-executable";
const runRoot = await mkdtemp(join(tmpdir(), "crewvane-design-qa-"));
const populated = join(runRoot, "workspace");
const project = join(runRoot, "project");
const empty = join(runRoot, "empty");
await mkdir(output, { recursive: true });
await cp(join(fixture, "workspace"), populated, { recursive: true });
await cp(join(fixture, "project"), project, { recursive: true });
await mkdir(empty);
await rm(join(populated, ".crewvane", "scheduler.json"), { force: true });
const service = new WorkspaceService(populated);
await service.store.update("design.qa.fixture", (state) => {
  state.projects[0].path = project;
  const waiting = state.tasks.find((task) => task.title === "优化图片加载性能");
  const completed = state.tasks.find((task) => task.title === "修复搜索结果重复加载");
  const running = state.tasks.find((task) => task.title === "完善错误监控告警");
  if (!waiting || !completed || !running) throw new Error("incomplete design fixture");
  waiting.createdAt = new Date(Date.now() - 18 * 60_000).toISOString();
  completed.createdAt = new Date(Date.now() - 42 * 60_000).toISOString();
  running.status = "running";
  running.workflow.stage = 1;
  running.summary = "独立验证进行中，运行时正在核对边界用例。";
  running.createdAt = new Date(Date.now() - 7 * 60_000).toISOString();
  delete running.error;
  state.agents = [{
    id: "agent_design_qa", taskId: running.id, role: "verifier", profileId: "trial",
    runtime: "omp", model: "magpie/codex/gpt-6.1-sol", cwd: project, status: "running",
    startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  }];
});
let app;
async function launch(workspace, name, snapshotOnly = false, viewport) {
  const home = join(runRoot, name);
  await mkdir(home, { recursive: true });
  const instance = await electron.launch({
    args: process.env.CREWVANE_APP_PATH ? [] : [resolve("apps/desktop")],
    executablePath: executable,
    env: { ...process.env, CREWVANE_TEST_USER_DATA: home, CREWVANE_TEST_WORKSPACE: workspace,
      ...(viewport ? {
        CREWVANE_TEST_WINDOW_WIDTH: String(viewport.width),
        CREWVANE_TEST_WINDOW_HEIGHT: String(viewport.height),
      } : {}),
      ...(snapshotOnly ? { CREWVANE_TEST_SNAPSHOT_ONLY: "1" } : {}) },
    timeout: 60_000,
  });
  const page = await instance.firstWindow();
  if (viewport) {
    await page.waitForFunction(
      (size) => innerWidth === size.width && innerHeight === size.height,
      viewport,
    );
  } else {
    await page.setViewportSize({ width: 1485, height: 1058 });
  }
  await page.getByRole("heading", { name: "全部目标" }).waitFor();
  return { instance, page };
}
async function stable(page) {
  await page.locator(".app-shell").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.mouse.move(20, 700);
  await page.waitForTimeout(300);
}
async function setTheme(page, theme) {
  const current = await page.locator(".app-shell").getAttribute("data-theme");
  if (current !== theme)
    await page.locator(".rail-bottom").getByRole("button", {
      name: theme === "light" ? "切换到浅色主题" : "切换到深色主题",
    }).click();
  await page.waitForFunction(
    (expected) =>
      document.documentElement.dataset.theme === expected &&
      document.querySelector(".app-shell")?.dataset.theme === expected,
    theme,
  );
  await stable(page);
}
async function assertThemeContrast(page) {
  const styles = await page.locator("html").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.getPropertyValue("--cv-bg").trim(),
      muted: style.getPropertyValue("--cv-muted").trim(),
      subtle: style.getPropertyValue("--cv-muted-2").trim(),
    };
  });
  const luminance = (hex) => {
    const values = hex.match(/[a-f\d]{2}/gi).map((value) => parseInt(value, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const background = luminance(styles.background);
  for (const color of [styles.muted, styles.subtle]) {
    const foreground = luminance(color);
    assert.ok((Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05) >= 4.5,
      `secondary text ${color} must meet 4.5:1 against ${styles.background}`);
  }
}
async function captureTask(page, title, theme) {
  await setTheme(page, theme);
  await assertThemeContrast(page);
  await page.locator(".queue-item").filter({ has: page.getByText(title, { exact: true }) }).click();
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  await stable(page);
  const name = title === "优化图片加载性能" ? "waiting" : title === "修复搜索结果重复加载" ? "completed" : "running";
  await page.screenshot({ path: join(output, `${name}-${theme}.png`) });
}
try {
  const { instance, page } = await launch(populated, "userData-populated", true);
  app = instance;
  for (const theme of ["dark", "light"])
    for (const title of ["优化图片加载性能", "修复搜索结果重复加载", "完善错误监控告警"])
      await captureTask(page, title, theme);
  await setTheme(page, "dark");
  await page.locator(".rail-bottom").getByRole("button", { name: "设置" }).click();
  await page.getByRole("heading", { name: "Herdr", exact: true }).waitFor();
  await stable(page);
  await page.screenshot({ path: join(output, "settings-herdr-dark.png") });
  await app.close();
  app = undefined;
  const terminalRun = await launch(empty, "userData-terminal");
  app = terminalRun.instance;
  await terminalRun.page.locator(".rail-bottom").getByRole("button", { name: "终端" }).click();
  await terminalRun.page.getByLabel("终端后端").waitFor();
  await terminalRun.page.waitForFunction(() => document.querySelector('[aria-label="终端后端"]')?.value === "herdr");
  await terminalRun.page.locator(".drawer-title small").getByText("Herdr", { exact: true }).waitFor({ timeout: 30_000 });
  await terminalRun.page.waitForTimeout(5000);
  assert.ok((await terminalRun.page.locator(".xterm-rows").innerText()).trim().length > 0);
  const terminalLabel = await terminalRun.page.locator(".terminal-controls label").boundingBox();
  assert.ok(terminalLabel.height < 50, "terminal backend label must stay on one line");
  await terminalRun.page.screenshot({ path: join(output, "herdr-terminal-dark.png") });
  await terminalRun.page.getByRole("button", { name: "关闭终端" }).click();
  await setTheme(terminalRun.page, "light");
  await terminalRun.page.locator(".rail-bottom").getByRole("button", { name: "终端" }).click();
  await terminalRun.page.locator(".drawer-title small").getByText("Herdr", { exact: true }).waitFor({ timeout: 30_000 });
  await terminalRun.page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent?.trim());
  await terminalRun.page.screenshot({ path: join(output, "herdr-terminal-light.png") });
  await terminalRun.page.getByLabel("终端后端").selectOption("shell");
  await terminalRun.page.locator(".drawer-title small").getByText(/zsh|bash|fish|sh/).waitFor({ timeout: 30_000 });
  await terminalRun.page.waitForFunction(() => /[$%]/.test(document.querySelector(".xterm-rows")?.textContent ?? ""));
  await terminalRun.page.getByLabel("交互式终端").click();
  await terminalRun.page.keyboard.type("printf __design_qa_terminal_ok__");
  await terminalRun.page.keyboard.press("Enter");
  await terminalRun.page.waitForFunction(() => ((document.querySelector(".xterm-rows")?.textContent ?? "").match(/__design_qa_terminal_ok__/g)?.length ?? 0) >= 2);
  await terminalRun.page.screenshot({ path: join(output, "shell-terminal-light.png") });
  await terminalRun.page.getByRole("button", { name: "关闭终端" }).click();
  await setTheme(terminalRun.page, "dark");
  await terminalRun.page.locator(".rail-bottom").getByRole("button", { name: "终端" }).click();
  await terminalRun.page.getByLabel("终端后端").selectOption("shell");
  await terminalRun.page.locator(".drawer-title small").getByText(/zsh|bash|fish|sh/).waitFor({ timeout: 30_000 });
  await terminalRun.page.waitForFunction(() => /[$%]/.test(document.querySelector(".xterm-rows")?.textContent ?? ""));
  await terminalRun.page.getByLabel("交互式终端").click();
  await terminalRun.page.keyboard.type("printf __design_qa_terminal_ok__");
  await terminalRun.page.keyboard.press("Enter");
  await terminalRun.page.waitForFunction(() => ((document.querySelector(".xterm-rows")?.textContent ?? "").match(/__design_qa_terminal_ok__/g)?.length ?? 0) >= 2);
  await terminalRun.page.screenshot({ path: join(output, "shell-terminal-dark.png") });
  await terminalRun.page.getByRole("button", { name: "关闭终端" }).click();
  await app.close();
  app = undefined;
  const emptyRun = await launch(empty, "userData-empty");
  app = emptyRun.instance;
  for (const theme of ["dark", "light"]) {
    await setTheme(emptyRun.page, theme);
    await emptyRun.page.getByText("还没有需求。交代一个目标，让团队开始推进。", { exact: true }).waitFor();
    await emptyRun.page.screenshot({ path: join(output, `empty-${theme}.png`) });
  }
  await app.close();
  app = undefined;
  const extraRun = await launch(populated, "userData-extra", true);
  app = extraRun.instance;
  for (const theme of ["dark", "light"]) {
    await setTheme(extraRun.page, theme);
    await extraRun.page.locator(".new-goal").click();
    await extraRun.page.getByRole("heading", { name: "交代一个新目标" }).waitFor();
    await extraRun.page.getByLabel("目标与验收").fill("仅用于界面验收：不会提交这个目标。");
    await extraRun.page.waitForFunction(() => getComputedStyle(document.querySelector(".modal")).opacity === "1");
    assert.ok((await extraRun.page.getByRole("button", { name: "交给船长", exact: true }).boundingBox()).height >= 36);
    await extraRun.page.screenshot({ path: join(output, `new-goal-${theme}.png`) });
    await extraRun.page.getByRole("button", { name: "关闭对话框" }).click();
    for (const [pageName, screenshot] of [["运行时", "runtimes"], ["工序", "workflow"]]) {
      await extraRun.page.locator("nav").getByRole("button", { name: pageName, exact: true }).click();
      await stable(extraRun.page);
      await extraRun.page.screenshot({ path: join(output, `${screenshot}-${theme}.png`) });
    }
  }
  await app.close();
  app = undefined;
  const narrowRun = await launch(
    populated,
    "userData-narrow",
    true,
    { width: 1050, height: 760 },
  );
  app = narrowRun.instance;
  await setTheme(narrowRun.page, "dark");
  await narrowRun.page.locator("nav").getByRole("button", { name: "目标", exact: true }).click();
  await narrowRun.page.locator(".queue-item").first().click();
  await stable(narrowRun.page);
  const layout = await narrowRun.page.evaluate(() => ({
    viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
    contentScroll: document.querySelector(".workspace-content")?.scrollWidth,
    contentClient: document.querySelector(".workspace-content")?.clientWidth,
  }));
  assert.equal(layout.documentWidth, 1050);
  assert.ok(layout.contentScroll <= layout.contentClient + 1);
  await narrowRun.page.screenshot({ path: join(output, "narrow-dark.png") });
  await narrowRun.page.locator(".new-goal").click();
  await narrowRun.page.waitForFunction(() => getComputedStyle(document.querySelector(".modal")).opacity === "1");
  await narrowRun.page.screenshot({ path: join(output, "new-goal-narrow-dark.png") });
  await narrowRun.page.getByRole("button", { name: "关闭对话框" }).click();
  await narrowRun.page.locator(".rail-bottom").getByRole("button", { name: "设置" }).click();
  await stable(narrowRun.page);
  await narrowRun.page.screenshot({ path: join(output, "settings-narrow-dark.png") });
  await app.close();
  app = undefined;
  await writeFile(join(output, "run.json"), JSON.stringify({
    viewport: { width: 1485, height: 1058 }, narrowViewport: { width: 1050, height: 760 },
    executable: executableLabel, capturedAt: new Date().toISOString(), layout,
    herdrVersion: await promisify(execFile)("/opt/homebrew/bin/herdr", ["--version"])
      .then((result) => result.stdout.trim())
      .catch(() => null),
  }, null, 2));
  console.log(JSON.stringify({ ok: true, output, layout }));
} finally {
  await app?.close();
}
