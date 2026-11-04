import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

// Opt-in real-agent trial: no scripted worker creation or fabricated checks.
// The sole agent input goes through the same embedded terminal used by a person.
const resume = Boolean(process.env.CREWVANE_TRIAL_DIRECTORY);
if (resume && !process.env.CREWVANE_TRIAL_SESSION) throw new Error("Resuming requires the exact isolated trial session");
const trial = process.env.CREWVANE_TRIAL_DIRECTORY || await mkdtemp(join(tmpdir(), "crewvane-concierge-trial-"));
const home = join(trial, "home"), workspace = join(trial, "workspace"), userData = join(trial, "userData");
const session = process.env.CREWVANE_TRIAL_SESSION || `crewvane-trial-${randomUUID().slice(0, 8)}`;
if (!/^crewvane-trial-[a-f0-9]{8}$/.test(session)) throw new Error("Only isolated trial sessions are allowed");
for (const directory of [home, workspace, userData, join(workspace, "alpha"), join(workspace, "beta")])
  await mkdir(directory, { recursive: true });
await writeFile(join(workspace, "AGENTS.md"), `# 隔离产品验收工作区
只可修改本工作区内文件。不得访问其他项目或用户数据，不执行发布、提交或外部消息。
交付检查必须实际运行；不能把测试要求当作检查已通过的证据。
`);
const executablePath = resolve(process.env.CREWVANE_APP_PATH ||
  "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane");
const env = { ...process.env, CREWVANE_TEST_HOME: home, CREWVANE_TEST_USER_DATA: userData,
  CREWVANE_TEST_WORKSPACE: workspace, CREWVANE_HERDR_SESSION: session };
let app, page;
const errors = [];
const launch = async () => {
  app = await electron.launch({ executablePath, args: [], env, timeout: 60_000 });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect.poll(async () => Boolean((await page.evaluate(() => window.crewvane.environment())).workspace)).toBe(true);
};
const state = async () => JSON.parse(await readFile(join(workspace, ".crewvane/state.json"), "utf8"));
const captureAgents = async (label) => {
  const diagnostics = await app.evaluate(async (_electron, session) => {
    const { execFile } = process.getBuiltinModule("node:child_process");
    const run = (args) => new Promise(resolve => execFile("herdr", ["--session", session, ...args],
      { timeout: 10_000, maxBuffer: 512_000 }, (error, stdout, stderr) => resolve({ error: error?.message, stdout, stderr })));
    return { agents: await run(["agent", "list"]),
      owner: await run(["agent", "read", "trial-owner", "--source", "recent-unwrapped", "--lines", "100"]),
      concierge: await run(["agent", "read", "concierge", "--source", "visible", "--lines", "40"]) };
  }, session);
  await writeFile(join(trial, `${label}-agents.json`), JSON.stringify(diagnostics, null, 2));
  await page.screenshot({ path: join(trial, `${label}.png`) });
};
const wait = async (predicate, description, timeout = 180_000) => {
  const start = Date.now();
  let inspected = false;
  while (Date.now() - start < timeout) {
    const current = await state();
    if (predicate(current)) return current;
    if (current.concierge.status === "error") throw new Error(current.concierge.detail);
    if (!inspected && Date.now() - start > 45_000 && description === "负责人实际交付") {
      inspected = true;
      await captureAgents("during-delivery");
      console.log(JSON.stringify({ step: "owner-diagnostics", trial }));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`真实试用超时：${description}`);
};
const say = async (text) => {
  await page.evaluate(async ({ session, text }) => {
    await window.crewvane.writeTerminal(session, `\x1b[200~${text}\x1b[201~`);
  }, { session, text });
  // Separate the paste and Enter, matching a human submitting the terminal.
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");
};
try {
  await launch();
  for (const [name, directory] of resume ? [] : [["项目 Alpha", "alpha"], ["项目 Beta", "beta"]]) {
    const path = join(workspace, directory);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, path);
    await page.evaluate(async (name) => {
      const path = await window.crewvane.selectProject();
      await window.crewvane.command({ type: "project.add", name, path });
    }, name);
  }
  console.log(JSON.stringify({ step: "prepare", trial, session }));
  await page.getByRole("button", { name: "回到现场", exact: true }).click();
  await wait((state) => state.concierge.status === "ready", "准备管家", 120_000);
  await page.locator(".terminal-panel").waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: "展开现场面板" }).click();
  const remindAt = new Date(Date.now() + 90_000).toISOString();
  if (!resume) await say(`这是隔离工作区的真实产品试用。请直接落实三个事项，不要求我填写表单：第一，在项目 Alpha 创建目标“交付样稿”，请你创建名为 trial-owner 的真实负责人会话完成，给它身份和任务，不要自己代做。负责人在 alpha/result.md 写入一段包含 READY 的说明，并实际运行一个读取该文件且断言 READY 存在的命令，检查通过后提交交付，记录真实文件位置、实际命令和结果，绑定真实负责人现场。第二，在项目 Beta 创建“等待 YR 审批”，现在等 YR，下一步是确认审批结果，提醒时间 ${remindAt}，不发送外部消息。第三，在个人事项创建“确认出行日期”，这个日期必须由我决定，给我“周四还是周五出行？”这个问题。先把三个事项全部记录，然后推进负责人交付；其中一个事项等待人，不要停止另外两个事项。`);
  if (resume) await captureAgents("resumed");
  let current = await wait((state) => state.goals.length >= 3, "管家通过自然语言建立三个目标", 240_000);
  console.log(JSON.stringify({ step: "goals-created", goals: current.goals.map(({ id, title, status }) => ({ id, title, status })) }));
  current = await wait((state) => state.goals.some(goal => goal.title === "交付样稿" && goal.status === "review"), "负责人实际交付", 360_000);
  let deliveryGoal = current.goals.find(goal => goal.title === "交付样稿");
  assert.equal(deliveryGoal.herdr?.agent, "trial-owner");
  assert.equal(deliveryGoal.herdr?.session, session);
  assert.match(await readFile(join(workspace, "alpha/result.md"), "utf8"), /READY/);
  assert.ok(deliveryGoal.delivery.checks.every(check => check.result === "passed"));
  assert.ok(current.goals.some(goal => goal.title === "等待 YR 审批" && goal.status === "waiting" && goal.waitingFor === "YR" && goal.remindAt));
  assert.ok(current.goals.some(goal => goal.title === "确认出行日期" && goal.attention?.kind === "decision"));
  await page.getByRole("button", { name: "隐藏终端", exact: true }).click();
  await page.getByText("交付样稿", { exact: true }).first().click();
  await page.getByText("交付与证据", { exact: true }).waitFor();
  await page.screenshot({ path: join(trial, "actual-delivery.png") });
  await page.getByLabel("退回原因").fill("请负责人在 result.md 再加入 VERIFIED，并实际检查 READY 与 VERIFIED 均存在后重新提交。");
  await page.getByRole("button", { name: "退回修改", exact: true }).click();
  current = await wait((state) => {
    const goal = state.goals.find(goal => goal.id === deliveryGoal.id);
    return goal.status === "review" && goal.activities.filter(item => item.kind === "delivery").length >= 2;
  }, "管家转达退回与负责人重新交付", 360_000);
  assert.match(await readFile(join(workspace, "alpha/result.md"), "utf8"), /VERIFIED/);
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  current = await wait((state) => state.goals.some(goal => goal.title === "等待 YR 审批" && goal.attention?.notifiedAt), "到期提醒", 120_000);
  const notifiedAt = current.goals.find(goal => goal.title === "等待 YR 审批").attention.notifiedAt;
  await new Promise(resolve => setTimeout(resolve, 12_000));
  assert.equal((await state()).goals.find(goal => goal.title === "等待 YR 审批").attention.notifiedAt, notifiedAt);
  await app.close();
  await launch();
  current = await state();
  assert.equal(current.goals.find(goal => goal.id === deliveryGoal.id).status, "completed");
  assert.equal(current.goals.find(goal => goal.title === "等待 YR 审批").attention.notifiedAt, notifiedAt);
  await page.getByRole("button", { name: "回到现场", exact: true }).click();
  await page.locator(".terminal-panel").waitFor({ timeout: 120_000 });
  await page.screenshot({ path: join(trial, "restored-concierge.png") });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, trial, session, goalId: deliveryGoal.id, checks: [
    "natural-language creation of three goals", "concierge-created real owner", "real file and checks",
    "automatic waiting/reminder/decision writes", "desktop rework relayed by concierge",
    "owner resubmission", "human acceptance", "notification deduplication", "restart and restored session",
  ] }));
} catch (error) {
  if (app) await captureAgents("failure").catch(() => {});
  if (page) await page.screenshot({ path: join(trial, "failure.png") }).catch(() => {});
  if (page) {
    const snapshot = await page.evaluate(() => window.crewvane.terminalSnapshot()).catch(() => null);
    if (snapshot) await writeFile(join(trial, "terminal-output.txt"), snapshot.data);
  }
  console.error(JSON.stringify({ trial, session, errors, error: String(error) }));
  throw error;
} finally {
  if (app) {
    await app.evaluate(async (_electron, session) => {
      const { execFile } = process.getBuiltinModule("node:child_process");
      await new Promise(resolve => execFile("herdr", ["--session", session, "server", "stop"], { timeout: 10_000 }, () => resolve()));
    }, session).catch(() => {});
    await app.close().catch(() => {});
  }
  if (process.env.CREWVANE_KEEP_TEST_ARTIFACTS !== "1") await rm(trial, { recursive: true, force: true });
}
