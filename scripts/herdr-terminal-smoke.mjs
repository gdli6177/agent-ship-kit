import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), "crewvane-embedded-terminal-"));
const workspace = join(home, "workspace"), session = `crewvane-tty-${randomUUID().slice(0, 8)}`;
await mkdir(workspace);
let app;
const errors = [];
try {
  app = await electron.launch({
    executablePath: resolve(process.env.CREWVANE_APP_PATH ||
      "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    args: [],
    env: { ...process.env, CREWVANE_TEST_HOME: home, CREWVANE_TEST_USER_DATA: join(home, "userData"),
      CREWVANE_TEST_WORKSPACE: workspace, CREWVANE_HERDR_SESSION: session },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.crewvane);
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  const goal = await page.evaluate(() => window.crewvane.command({
    type: "goal.create", input: { title: "隔离的真实终端测试", projectId: "personal", mode: "manual" },
  }));
  // A manually recorded goal opens the workspace TUI without starting a model.
  await page.evaluate((id) => window.crewvane.openHerdr(id), goal.id);
  await page.getByRole("region", { name: "Herdr 工作现场" }).waitFor();
  await page.waitForFunction(() => document.querySelector(".xterm-screen")?.clientWidth > 200);
  let connection = await page.evaluate(() => window.crewvane.terminalSnapshot());
  assert.equal(connection.session, session);
  assert.equal(connection.running, true);
  const marker = `tty_${randomUUID().replaceAll("-", "")}`;
  const resultFile = join(workspace, "terminal-result.txt");
  await page.evaluate(async ({ session, marker, resultFile }) => {
    const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
    await window.crewvane.writeTerminal(session,
      `/usr/bin/printf '%s' ${quote(marker)} > ${quote(resultFile)} && /bin/cat ${quote(resultFile)}\r`);
  }, { session, marker, resultFile });
  // TUI redraws can split or omit unchanged bytes in the PTY stream. Require an
  // actual shell-side effect rather than mistaking echoed input for execution.
  await expect.poll(() => readFile(resultFile, "utf8").catch(() => ""), { timeout: 30_000 }).toBe(marker);
  await page.locator(".xterm-accessibility").filter({ hasText: marker }).waitFor({ state: "attached" });
  const firstPid = await app.evaluate(({ app }) => app.getAppMetrics().filter(item => item.name === "Crewvane Herdr terminal").map(item => item.pid));
  assert.equal(firstPid.length, 1);
  await page.getByRole("button", { name: "隐藏终端", exact: true }).click();
  assert.equal(await page.locator(".terminal-panel").isVisible(), false);
  await page.locator(".top-actions").getByRole("button", { name: "新目标", exact: true }).click();
  await page.getByLabel("要交给管家的事情").fill("不能被终端抢走的草稿");
  // An arriving connection/open event must not dismiss a form or steal its focus.
  await page.evaluate((id) => window.crewvane.openHerdr(id), goal.id);
  assert.equal(await page.locator(".terminal-panel").isVisible(), false);
  assert.equal(await page.getByLabel("要交给管家的事情").inputValue(), "不能被终端抢走的草稿");
  await page.getByLabel("要交给管家的事情").type("，可以继续输入");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("region", { name: "Herdr 工作现场" }).waitFor();
  await page.getByRole("button", { name: "隐藏终端", exact: true }).click();
  await page.evaluate((id) => window.crewvane.openHerdr(id), goal.id);
  await page.locator(".terminal-panel").waitFor();
  await page.locator(".xterm-accessibility").filter({ hasText: marker }).waitFor({ state: "attached" });
  const nextPid = await app.evaluate(({ app }) => app.getAppMetrics().filter(item => item.name === "Crewvane Herdr terminal").map(item => item.pid));
  assert.deepEqual(nextPid, firstPid);
  const herdr = async (args) => JSON.parse((await exec("herdr", ["--session", session, ...args], {
    timeout: 20_000,
  })).stdout);
  const workspaceList = await herdr(["workspace", "list"]),
    workspaces = workspaceList.result?.workspaces ?? workspaceList.workspaces ?? workspaceList,
    workspaceId = (Array.isArray(workspaces) ? workspaces[0] : workspaces[0] ?? Object.values(workspaces)[0])
      ?.workspace_id ?? (Array.isArray(workspaces) ? workspaces[0] : Object.values(workspaces)[0])?.id;
  assert.ok(workspaceId);
  const tabCreated = await herdr(["tab", "create", "--workspace", workspaceId, "--cwd", workspace, "--label", "goal-close-trial", "--no-focus"]),
    tab = tabCreated.result?.tab ?? tabCreated.tab,
    rootPane = tabCreated.result?.root_pane ?? tabCreated.root_pane,
    tabId = tab?.tab_id ?? tab?.id,
    paneId = rootPane?.pane_id ?? rootPane?.id;
  assert.ok(tabId); assert.ok(paneId);
  await page.evaluate(({ id, reference }) => window.crewvane.command({
    type: "session.set", goalId: id, reference,
  }), {
    id: goal.id,
    reference: { session, workspaceId, tabId, paneId, agent: "closure-test-owner" },
  });
  await page.evaluate((id) => window.crewvane.command({
    type: "goal.drop", goalId: id, note: "验证结束目标自动关闭负责人 Tab", actor: "你",
  }), goal.id);
  await expect.poll(() => page.evaluate(async (id) => {
    const state = await window.crewvane.command({ type: "snapshot" });
    return state.goals.find(item => item.id === id)?.herdr;
  }, goal.id)).toBe(undefined);
  const tabs = await herdr(["tab", "list", "--workspace", workspaceId]),
    tabList = tabs.result?.tabs ?? tabs.tabs ?? tabs,
    stillOpen = (Array.isArray(tabList) ? tabList : Object.values(tabList)).some(item =>
      (item?.tab_id ?? item?.id) === tabId);
  assert.equal(stillOpen, false);
  await page.getByRole("button", { name: "展开现场面板" }).click();
  await page.locator(".terminal-panel.expanded").waitFor();
  await page.screenshot({ path: join(home, "embedded-dark.png") });
  await page.getByRole("button", { name: "浅色模式" }).click();
  await page.screenshot({ path: join(home, "embedded-light.png") });
  await page.evaluate(async () => {
    let rejected = false;
    try { await window.crewvane.writeTerminal("unrelated-session", "echo should-not-run\r"); } catch { rejected = true; }
    if (!rejected) throw new Error("Cross-workspace terminal input was accepted");
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, home, session, checks: [
    "real Herdr TUI in embedded PTY", "real shell input/output", "collapse/reopen reuses PID",
    "expanded panel", "dark/light", "reject unrelated terminal input", "terminal events preserve modal draft and input",
    "ended goal closes its real Herdr tab",
  ] }));
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: join(home, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ home, session, errors, error: String(error) }));
  throw error;
} finally {
  if (app) {
    // Stop only the uniquely named session created by this isolated integration.
    await app.evaluate(async (_electron, session) => {
      const { execFile } = process.getBuiltinModule("node:child_process");
      await new Promise((resolve) => execFile("herdr", ["--session", session, "server", "stop"], { timeout: 10_000 }, () => resolve()));
    }, session).catch(() => {});
    await app.close();
  }
  if (process.env.CREWVANE_KEEP_TEST_ARTIFACTS !== "1") await rm(home, { recursive: true, force: true });
}
