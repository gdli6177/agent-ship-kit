// Real packaged-app regression: Finder PATH, native picker boundary, official
// Herdr download and a real interactive custom CLI (no model credentials).
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
const exec = promisify(execFile);
// macOS AF_UNIX has a short socket path limit. Keep isolated HOME/session short.
const home = await mkdtemp("/tmp/cv-onboarding-");
const session = `cv-${randomUUID().slice(0, 8)}`;
const userData = join(home, "userData"), managedHerdr = join(userData, "runtime/herdr");
const rootA = join(home, "所有事项"), rootB = join(home, "另一个工作区");
const legacy = join(home, "legacy");
const log = join(home, "custom-cli.jsonl"), customCli = join(home, "my custom agent");
const testEnvironment = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"),
  PATH: "/usr/bin:/bin", CREWVANE_TEST_HOME: home,
  CREWVANE_TEST_USER_DATA: userData, CREWVANE_TEST_WORKSPACE: "",
  CREWVANE_TEST_ISOLATE_TOOLS: "1", CREWVANE_TEST_SKIP_HERDR_SETUP: "",
  CREWVANE_HERDR_SESSION: session };
await mkdir(rootA); await mkdir(rootB);
await mkdir(join(legacy, ".crewvane"), {recursive:true});
await writeFile(join(legacy, ".crewvane/state.json"), '{"version":1}');
await writeFile(customCli, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify({kind:"start", args:process.argv.slice(2),pid:process.pid})+"\\n");
console.log("CUSTOM_CLI_READY");
readline.createInterface({input:process.stdin}).on("line", text => {
 fs.appendFileSync(log, JSON.stringify({kind:"input",text})+"\\n");
 if (text === "STOP") process.exit(0);
});
`, { mode: 0o700 });
let app, installed;
const errors = [];
async function picker(path, canceled = false) {
  await app.evaluate(({ dialog }, { path, canceled }) => {
    dialog.showOpenDialog = async () => ({ canceled, filePaths: canceled ? [] : [path] });
  }, { path, canceled });
}
try {
  app = await electron.launch({
    executablePath: resolve(process.env.CREWVANE_APP_PATH || "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    env: testEnvironment,
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", error => errors.push(String(error)));
  await page.getByRole("button", { name: "打开我的工作台" }).waitFor();
  // The app must install Herdr itself, with no Homebrew and no system Herdr.
  await expect.poll(async () => {
    const status = await page.evaluate(() => window.crewvane.herdrStatus());
    return status.installed && status.phase === "ready" && !!status.latestVersion;
  }, { timeout: 180_000 }).toBe(true);
  installed = await page.evaluate(() => window.crewvane.herdrStatus());
  assert.equal(installed.phase, "ready", JSON.stringify(installed)); assert.equal(installed.executable, managedHerdr, JSON.stringify(installed));
  assert.equal(installed.version, installed.latestVersion);
  const { stdout } = await exec(managedHerdr, ["--version"]); assert.ok(stdout.includes(installed.version));
  await picker(rootA);
  await page.getByRole("button", { name: "打开我的工作台" }).click();
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  await page.getByText("已打开工作区：所有事项", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.crewvane.environment())).workspace, await realpath(rootA));
  await page.getByRole("button", { name: "选择工作区", exact: true }).click();
  await page.getByRole("dialog").getByText("当前工作区", { exact: true }).waitFor();
  await page.getByRole("dialog").getByText(await realpath(rootA), { exact: true }).waitFor();
  // Re-selecting the same directory must acknowledge it.
  await page.getByRole("button", { name: "选择其他工作区文件夹" }).click();
  await page.getByText("你已在这个工作区。", { exact: true }).waitFor();
  // Cancel preserves the workspace and keeps a meaningful selection surface.
  await picker(rootB, true);
  await page.getByRole("button", { name: "选择工作区", exact: true }).click();
  await page.getByRole("button", { name: "选择其他工作区文件夹" }).click();
  assert.equal((await page.evaluate(() => window.crewvane.environment())).workspace, await realpath(rootA));
  assert.equal(await page.getByRole("dialog").isVisible(), true);
  await picker(legacy);
  await page.getByRole("button", { name: "选择其他工作区文件夹" }).click();
  await page.getByRole("dialog").getByRole("alert").filter({hasText:"不支持的工作区状态版本"}).waitFor();
  assert.equal((await page.evaluate(() => window.crewvane.environment())).workspace, await realpath(rootA));
  assert.ok(!(await page.getByRole("dialog").getByRole("alert").innerText()).includes("remote method"));
  await picker(rootB);
  await page.getByRole("button", { name: "选择其他工作区文件夹" }).click();
  await page.getByText("已打开工作区：另一个工作区", { exact: true }).waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const command = `"${customCli}" --model "local test model"`;
  await page.getByLabel("管家启动命令").fill(command);
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await page.getByText("Agent 偏好已保存，将用于新启动的会话。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "准备管家", exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).concierge.status, {timeout:90_000}).toBe("ready");
  let state = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
  assert.equal(state.concierge.transport, "pane");
  const firstReference = state.concierge;
  // A foreground PID proves process creation, not that its JS startup has
  // already opened the log. Wait for the fixture's actual readiness evidence.
  await expect.poll(() => readFile(log, "utf8").catch(() => ""), {timeout:10_000}).toContain('"kind":"start"');
  const started = JSON.parse((await readFile(log, "utf8")).split("\n")[0]);
  assert.deepEqual(started.args, ["--model", "local test model"]);
  assert.equal(started.pid, state.concierge.processId);
  await page.evaluate(() => window.crewvane.prepareConcierge());
  assert.equal((await readFile(log, "utf8")).split("\n").filter(line => line.includes('"kind":"start"')).length, 1);
  const created = await page.evaluate(() => window.crewvane.command({ type:"goal.create", input:{
    title:"自定义 CLI 收到真实目标",projectId:"personal",mode:"concierge",
  }}));
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return state.goals.find(goal => goal.id === created.id)?.dispatch?.status;
  }, {timeout:60_000}).toBe("sent");
  await expect.poll(() => readFile(log, "utf8"), {timeout:10_000}).toContain(created.id);
  const messages = await readFile(log, "utf8");
  assert.ok(messages.includes(created.id), "actual custom CLI stdin must receive the goal ID");
  const roleInputs = messages.trim().split("\n").map(line => JSON.parse(line))
    .filter(entry => entry.kind === "input" && entry.text.includes("不亲自执行目标"));
  assert.ok(roleInputs.length >= 2, "initial identity and new goal must both carry the no-execution boundary into real stdin");
  assert.ok(messages.includes("待执行的目标交给独立负责人"));
  await page.getByRole("button", { name: "打开 Herdr", exact: true }).click();
  await page.getByRole("region", { name: "Herdr 工作现场" }).waitFor();
  await page.screenshot({ path: join(home, "onboarding-dark.png"), animations:"disabled" });
  await page.getByRole("button", { name: "隐藏终端", exact: true }).click();
  await page.getByRole("button", { name: "浅色模式" }).click();
  await page.getByRole("button", { name: "选择工作区", exact: true }).click();
  await page.screenshot({ path: join(home, "workspace-light.png"), animations:"disabled" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const beforeRestart = (await stat(managedHerdr)).mtimeMs;
  await app.close();
  const restoredEnvironment = { ...testEnvironment };
  // The empty first-run override deliberately suppresses saved selection.
  // Remove it when testing a normal restart and persisted workspace recovery.
  delete restoredEnvironment.CREWVANE_TEST_WORKSPACE;
  app = await electron.launch({
    executablePath: resolve(process.env.CREWVANE_APP_PATH || "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    env:restoredEnvironment, timeout:60_000,
  });
  const restored = await app.firstWindow();
  restored.on("pageerror", error => errors.push(String(error)));
  await expect.poll(async () => (await restored.evaluate(() => window.crewvane.environment())).workspace).toBe(await realpath(rootB));
  await restored.evaluate(() => window.crewvane.prepareConcierge());
  assert.equal((await restored.evaluate(() => window.crewvane.command({type:"snapshot"}))).concierge.processId, firstReference.processId);
  assert.equal((await stat(managedHerdr)).mtimeMs, beforeRestart, "latest installed binary must be reused without replacing it");
  assert.equal((await readFile(log, "utf8")).split("\n").filter(line => line.includes('"kind":"start"')).length, 1);
  // Simulate the CLI exiting. Dispatch must fail, never type task text into a shell.
  process.kill(firstReference.processId, "SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 500));
  const exitedGoal = await restored.evaluate(() => window.crewvane.command({type:"goal.create", input:{
    title:"退出后的任务",projectId:"personal",mode:"manual",
  }}));
  // Automatic preparation may create a replacement; verify the old reference
  // itself cannot receive messages using the real Herdr transport.
  const { HerdrClient } = await import("../apps/desktop/electron/herdr.ts");
  const runner = { async run(args) {
    return (await exec(managedHerdr, args, {env:{...testEnvironment, HERDR_SESSION:session},timeout:10_000})).stdout;
  } };
  await assert.rejects(new HerdrClient(runner, session).notifyGoal(firstReference, exitedGoal.id, "不得发给 shell"), /已退出/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, home, version: installed.version, checks: [
    "official verified auto-install without Homebrew or system PATH", "first workspace selection feedback",
    "same directory feedback", "cancel preserves state", "invalid workspace preserves state and shows readable error", "workspace switching",
    "arbitrary CLI saves and starts", "native argv preserved", "reuse custom concierge",
    "real goal and delegation-only role delivered to CLI stdin", "raw Herdr opens independently", "restart reuses installed latest and running CLI",
    "exited CLI rejects dispatch",
  ] }));
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({path:join(home,"failure.png")}).catch(() => {});
  console.error(JSON.stringify({ home, error: String(error), errors }));
  throw error;
} finally {
  if (installed) await exec(managedHerdr, ["--session", session, "server", "stop"], { env:testEnvironment, timeout: 10_000 }).catch(() => {});
  await app?.close();
  if (process.env.CREWVANE_KEEP_TEST_ARTIFACTS !== "1") await rm(home, {recursive:true,force:true});
}
