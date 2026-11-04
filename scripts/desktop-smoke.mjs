import { _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { WorkspaceService } from "../packages/core/src/index.ts";
const run = promisify(execFile);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAVUlEQVR4nGPUMIr6z4AEAqKWInMZNiyLZqClPBPDAAOmEe8Axoqe///pGefo8kwMAwyYRrwDGEfLAYaR7gDG0XKAYaQ7gHG0HGAY6Q5gHC0HGEa6AwC58E1KmpVcaAAAAABJRU5ErkJggg==",
  "base64",
);
const home = await mkdtemp(join(tmpdir(), "crewvane-desktop-v04-")),
  workspace = join(home, "workspace");
await mkdir(workspace);
await mkdir(join(home, "userData"), { recursive: true });
await mkdir(join(home, ".local/bin"), { recursive: true });
const service = new WorkspaceService(workspace);
// UI regression tests never start the user's signed-in model or Herdr Session.
// Real transport and arbitrary CLI behavior are covered by onboarding-smoke.
await service.execute({ type: "agents.configure", preferences: { concierge: "/missing/crewvane-test-agent" } });
const app = await electron.launch({
  executablePath: resolve(process.env.CREWVANE_APP_PATH ||
    "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
  args: [],
  env: {
    ...process.env,
    CREWVANE_TEST_USER_DATA: join(home, "userData"),
    CREWVANE_TEST_HOME: home,
    CREWVANE_TEST_WORKSPACE: workspace,
    CREWVANE_TEST_ISOLATE_TOOLS: "1",
    CREWVANE_TEST_SKIP_HERDR_SETUP: "1",
  },
  timeout: 60_000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  await page.screenshot({ path: join(home, "empty-dark.png") });
  await page.getByRole("button", { name: "浅色模式" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: "深色模式" }).click();
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  assert.ok(await page.locator(".app.collapsed").count());
  await page.getByRole("button", { name: "展开侧边栏" }).click();
  await page.getByRole("button", { name: "我的工作台", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 0, "workspace overview must not open a directory picker");
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  await page.getByRole("button", { name: "添加项目", exact: true }).click();
  await page.getByRole("dialog", { name: "添加项目" }).waitFor();
  await page.getByLabel("项目名称").fill("界面测试项目");
  await page.getByRole("button", { name: "添加项目", exact: true }).last().click();
  await page.locator(".projects").getByRole("button", { name: /界面测试项目/ }).click();
  await page.locator(".topbar").getByText("界面测试项目", { exact: true }).waitFor();
  await page.getByRole("button", { name: "我的工作台", exact: true }).click();
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  assert.equal(await page.locator(".projects button.active").count(), 0);
  await page
    .locator(".top-actions")
    .getByRole("button", { name: "新目标" })
    .click();
  await page.getByLabel("要交给管家的事情").fill("桌面试用交付");
  await page.getByLabel("选择图片").setInputFiles({
    name: "selected.png",
    mimeType: "image/png",
    buffer: png,
  });
  await page.getByText("selected.png", { exact: true }).waitFor();
  await page.getByLabel("要交给管家的事情").evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "dragged.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, png.toString("base64"));
  await page.getByText("dragged.png", { exact: true }).waitFor();
  await page.getByLabel("要交给管家的事情").evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, png.toString("base64"));
  await page.getByText("pasted.png", { exact: true }).waitFor();
  await page.getByRole("button", { name: "移除图片 dragged.png" }).click();
  assert.equal(await page.getByText("dragged.png", { exact: true }).count(), 0);
  await page.screenshot({ path: join(home, "intake-with-images-dark.png"), animations: "disabled" });
  assert.equal(await page.locator('[role="dialog"] input:not([type="file"]), [role="dialog"] select').count(), 0);
  await page.getByRole("button", { name: "交给管家", exact: true }).click();
  await page.getByRole("dialog", { name: "桌面试用交付", exact: true }).waitFor();
  await page.getByText("selected.png", { exact: true }).waitFor();
  await page.getByText("pasted.png", { exact: true }).waitFor();
  let state = await page.evaluate(() => window.crewvane.command({ type: "snapshot" })),
    goalId = state.goals[0].id;
  assert.equal(state.goals[0].attachments.length, 2);
  for (const attachment of state.goals[0].attachments) {
    const attachmentPath = join(workspace, attachment.path);
    assert.ok((await stat(attachmentPath)).isFile());
    assert.equal((await stat(attachmentPath)).mode & 0o777, 0o600);
  }
  const attachmentPreview = await page.evaluate(async ({ goalId, attachmentId }) =>
    window.crewvane.attachmentPreview(goalId, attachmentId), {
    goalId: state.goals[0].id,
    attachmentId: state.goals[0].attachments[0].id,
  });
  assert.match(attachmentPreview, /^data:image\/png;base64,/);
  const persistedState = await readFile(join(workspace, ".crewvane", "state.json"), "utf8");
  assert.doesNotMatch(persistedState, /data:image|iVBORw0KGgo|base64/i);
  const removedAttachment = state.goals[0].attachments[0];
  page.once("dialog", dialog => void dialog.accept());
  await page.getByRole("button", { name: `删除图片 ${removedAttachment.name}` }).click();
  await page.getByText(removedAttachment.name, { exact: true }).waitFor({ state: "detached" });
  await assert.rejects(stat(join(workspace, removedAttachment.path)), /ENOENT/);
  state = await page.evaluate(() => window.crewvane.command({ type: "snapshot" }));
  assert.equal(state.goals[0].attachments.length, 1);
  assert.ok(!state.goals[0].attachments.some(item => item.id === removedAttachment.id));
  await page.getByLabel("补充意见", { exact: true }).fill("请保留现有验收记录，不要扩大范围。");
  const nextBeforeFeedback = (await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).goals[0].next;
  await page.getByRole("button", { name: "发给管家", exact: true }).click();
  await page.getByText("补充意见：请保留现有验收记录，不要扩大范围。", { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).goals[0].next, nextBeforeFeedback);
  state = await page.evaluate(() =>
      window.crewvane.command({ type: "snapshot" }),
    );
  const dispatchBeforeDirect = state.goals[0].dispatch?.id;
  await run("pnpm", [
    "--dir", "cli", "exec", "tsx", "src/main.ts", "direct",
    "外部 Herdr 终端追加下一步", "--goal", goalId, "--root", workspace, "--json",
  ], { cwd: resolve("."), timeout: 30_000 });
  await page.getByText("外部 Herdr 终端追加下一步", { exact: true }).waitFor();
  state = await page.evaluate(() => window.crewvane.command({ type: "snapshot" }));
  assert.equal(state.goals[0].dispatch?.id, dispatchBeforeDirect,
    "external terminal feedback must not create a duplicate handoff");
  assert.match(state.goals[0].activities.at(-1).text, /外部 Herdr 终端追加下一步/);
  await page.getByRole("button", { name: "我来处理", exact: true }).click();
  assert.equal((await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).goals[0].mode, "manual");
  await page.screenshot({ path: join(home, "intake-dark.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await service.execute({
    type: "goal.wait",
    goalId,
    reason: "等 YR 审批",
    owner: "YR",
    remindAt: "2030-01-01T00:00:00Z",
  });
  await page.waitForFunction(() =>
    document.body.innerText.includes("等 YR 审批"),
  );
  await page.screenshot({ path: join(home, "waiting-dark.png") });
  await service.execute({
    type: "goal.review",
    goalId,
    actor: "owner",
    delivery: {
      summary: "真实试用交付已完成",
      location: "试用工作区",
      checks: [
        {
          name: "真实读取",
          command: "crewvane goal show",
          result: "passed",
          note: "命令退出码 0",
        },
      ],
    },
  });
  await page.getByText("查看并验收").click();
  await page.getByText("交付与证据").waitFor();
  await page.screenshot({ path: join(home, "review-dark.png") });
  await page.getByLabel("退回原因").fill("请补充桌面端的实际验收说明");
  await page.getByRole("button", { name: "退回修改" }).click();
  await service.execute({
    type: "goal.review",
    goalId,
    actor: "owner",
    delivery: {
      summary: "已补充桌面端验收说明",
      checks: [
        { name: "桌面交互", command: "Playwright 点击验收", result: "passed" },
      ],
    },
  });
  await page.getByLabel("退回原因").fill("桌面交互与证据已确认");
  await page.getByRole("button", { name: "验收通过" }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByText("现在，可以安心了。").waitFor();
  await page.getByRole("button", { name: "工序", exact: true }).click();
  await page.getByLabel("第 1 步工序名称").fill("理解与对齐");
  await page.getByRole("button", { name: "保存工序" }).click();
  await page.getByText("工序已保存，新目标将使用这份说明。").waitFor();
  await page.screenshot({ path: join(home, "workflow-dark.png") });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "只设置必要的。" }).waitFor();
  const personalPolicy = page.locator(".policy-row").filter({ hasText: "个人事项" });
  await personalPolicy.getByRole("button", { name: "配置", exact: true }).click();
  await personalPolicy.getByLabel("上线策略").selectOption("auto");
  await personalPolicy.getByLabel("外部审批人（可选）").fill("YR、平台组");
  await personalPolicy.getByRole("button", { name: "保存策略", exact: true }).click();
  await page.getByText("项目上线策略已更新。", { exact: true }).waitFor();
  const personalProject = (await service.read()).projects.find(project => project.id === "personal");
  assert.equal(personalProject.policy.shipPolicy, "auto");
  assert.deepEqual(personalProject.policy.approvers, ["YR", "平台组"]);
  await page.getByLabel("管家启动命令").fill("codex --model my-model");
  await page.getByLabel("负责人启动命令").fill("omp --model another-model");
  await page.getByLabel("工人启动命令").fill("");
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await page.getByText("Agent 偏好已保存，将用于新启动的会话。", { exact: true }).waitFor();
  assert.deepEqual((await service.read()).agents, { concierge: "codex --model my-model", owner: "omp --model another-model" });
  await page.screenshot({ path: join(home, "settings-dark.png") });
  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (main) main.scrollTop = 0;
  });
  const mainBox = await page.locator("main").boundingBox();
  assert.ok(mainBox && mainBox.height > 500);
  assert.equal(
    await page
      .locator(".main")
      .evaluate((element) => getComputedStyle(element).overflowY),
    "auto",
  );
  await page.locator("main").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.getByText(/Crewvane 0\.4 · 一位管家/).waitFor();
  await page.getByRole("button", { name: "浅色模式" }).click();
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  const riskGoal = await page.evaluate(() => window.crewvane.command({
    type: "goal.create",
    input: { title: "权限变更试用", projectId: "personal", mode: "manual" },
  }));
  await page.evaluate((goalId) => window.crewvane.command({
    type: "goal.risk", goalId, category: "change-permissions",
    summary: "给生产环境增加一名管理员", actor: "管家",
  }), riskGoal.id);
  await page.getByText("权限变更试用", { exact: true }).click();
  await page.getByLabel("你的决定").fill("只允许只读权限，不增加管理员。");
  await page.getByRole("button", { name: "批准这个决定", exact: true }).click();
  await page.getByText("已记入批准账本，下一步已更新", { exact: true }).waitFor();
  const ledger = await readFile(join(workspace, ".crewvane", "decisions.md"), "utf8");
  assert.match(ledger, /只允许只读权限/);
  assert.match(ledger, /change-permissions/);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({ path: join(home, "home-light.png") });
  // A personal item must be manageable without asking an Agent or using CLI.
  await page.locator(".top-actions").getByRole("button", { name: "新目标" }).click();
  await page.getByLabel("要交给管家的事情").fill("个人事项界面闭环");
  await page.getByLabel("要交给管家的事情").press("Meta+Enter");
  await page.getByRole("dialog", { name: "个人事项界面闭环", exact: true }).waitFor();
  await page.getByRole("button", { name: "我来处理", exact: true }).click();
  await page.getByText("手动处理", { exact: true }).click();
  await page.getByLabel("补充进展", { exact: true }).fill("审批已经通过，继续处理");
  const previousNext = (await service.read()).goals.find(item => item.title === "个人事项界面闭环").next;
  await page.getByRole("button", { name: "补充进展", exact: true }).click();
  assert.equal((await service.read()).goals.find(item => item.title === "个人事项界面闭环").next, previousNext, "progress notes must not silently change the next step");
  await page.getByRole("button", { name: "编辑目标", exact: true }).click();
  await page.getByLabel("当前安排").selectOption("waiting");
  await page.getByLabel("下一步", { exact: true }).fill("等待下一次核对");
  await page.getByLabel("跟进提醒", { exact: true }).fill("2030-01-01T09:30");
  await page.getByRole("button", { name: "保存更新", exact: true }).click();
  let manual = (await service.read()).goals.find(item => item.title === "个人事项界面闭环");
  assert.equal(manual.status, "waiting");
  assert.equal(manual.remindAt, new Date("2030-01-01T09:30").toISOString());
  await page.getByText("手动处理", { exact: true }).click();
  await page.getByRole("button", { name: "编辑目标", exact: true }).click();
  assert.equal(await page.getByLabel("跟进提醒", { exact: true }).inputValue(), "2030-01-01T09:30");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByText("手动处理", { exact: true }).click();
  await page.getByRole("button", { name: "提交成果", exact: true }).click();
  await page.getByLabel("成果摘要").fill("已用桌面界面完成个人事项闭环");
  await page.getByLabel("检查名称").fill("提醒时间核对");
  await page.getByLabel("实际检查操作").fill("编辑后再次打开跟进提醒字段");
  await page.getByLabel("通过依据").fill("界面值与保存前一致，未发生时区偏移");
  await page.getByRole("button", { name: "提交验收", exact: true }).click();
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "编辑目标", exact: true }).count(), 0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "工序", exact: true }).click();
  await page.getByRole("button", { name: "新建工序", exact: true }).click();
  await page.getByLabel("工序模板名称").fill("内容发布");
  await page.getByLabel("第 1 步工序名称").fill("核对与发布");
  await page.getByRole("button", { name: "添加一步", exact: true }).click();
  await page.getByRole("button", { name: "删除第 2 步", exact: true }).click();
  await page.getByRole("button", { name: "保存工序", exact: true }).click();
  await page.getByRole("button", { name: /内容发布.*1 步/ }).waitFor();
  state = await service.read();
  assert.equal(state.goals[0].status, "completed");
  assert.equal(state.goals.find(item => item.id === manual.id).status, "completed");
  assert.equal(state.workflows.find(item => item.name === "内容发布").steps.length, 1);
  assert.equal(state.workflows[0].steps[0].name, "理解与对齐");
  await page.locator(".top-actions").getByRole("button", { name: "新目标" }).click();
  await page.getByLabel("要交给管家的事情").fill("等待审批操作");
  await page.getByRole("button", { name: "交给管家", exact: true }).click();
  await page.getByRole("dialog", { name: "等待审批操作", exact: true }).waitFor();
  const waiting = (await service.read()).goals.find(item => item.title === "等待审批操作");
  await service.execute({ type: "goal.wait", goalId: waiting.id, reason: "等 YR 审批", owner: "YR", remindAt: "2030-01-01T00:00:00Z" });
  await page.getByRole("heading", { name: "这件事，接下来怎么走？" }).waitFor();
  assert.equal(await page.getByLabel("当前安排").count(), 0);
  await page.getByRole("button", { name: "稍后提醒我", exact: true }).click();
  await page.getByRole("button", { name: "1 小时后", exact: true }).click();
  let waitingState = (await service.read()).goals.find(item => item.id === waiting.id);
  assert.ok(Date.parse(waitingState.remindAt) > Date.now());
  assert.equal(waitingState.status, "waiting");
  await page.getByRole("button", { name: "有结果了，继续推进", exact: true }).click();
  await page.getByLabel("最新结果与下一步").fill("审批通过了，我亲自处理。");
  await page.getByRole("button", { name: "我来处理", exact: true }).click();
  await page.waitForFunction(async goalId => {
    const state = await window.crewvane.command({ type: "snapshot" });
    return state.goals.find(item => item.id === goalId)?.status === "active";
  }, waiting.id);
  waitingState = (await service.read()).goals.find(item => item.id === waiting.id);
  assert.equal(waitingState.status, "active");
  assert.equal(waitingState.mode, "manual");
  assert.equal(waitingState.owner, "你");
  assert.equal(waitingState.dispatch, undefined);
  await page.screenshot({ path: join(home, "waiting-resumed-dark.png"), animations: "disabled" });
  await page.getByText("手动处理", { exact: true }).click();
  await page.getByRole("button", { name: "提交成果", exact: true }).click();
  await page.getByLabel("成果摘要").fill("删除闭环已完成");
  await page.getByLabel("检查名称").fill("目标状态核对");
  await page.getByLabel("实际检查操作").fill("确认目标已进入待验收");
  await page.getByLabel("通过依据").fill("目标状态为 review");
  await page.getByRole("button", { name: "提交验收", exact: true }).click();
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  page.once("dialog", dialog => void dialog.accept());
  await page.getByRole("button", { name: "永久删除目标", exact: true }).click();
  await page.getByText("目标与关联图片已永久删除。", { exact: true }).waitFor();
  assert.equal((await service.read()).goals.some(item => item.id === waiting.id), false);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  console.log(
    JSON.stringify({
      ok: true,
      home,
      checks: [
        "theme",
        "collapsible sidebar",
        "workspace overview navigation and project creation without a directory",
        "manual goal",
        "waiting",
        "review evidence",
        "rework",
        "accept",
        "workflow save",
        "settings",
        "per-project ship policy from the desktop UI",
        "high-risk decision from the desktop UI and persisted ledger",
        "save Agent role preferences",
        "shared state",
        "renderer isolation",
        "manual progress/wait/review/accept through UI",
        "local reminder round trip",
        "custom workflow add/remove/save",
        "single natural-language goal intake",
        "image paste, drag, file selection, preview, removal, and metadata-only persistence",
        "keyboard submission for goal intake",
        "visible goal feedback preserves the next step",
        "external terminal feedback refreshes the app without replaying a handoff",
        "waiting snooze and resume directly without the manual editor",
        "permanent deletion for completed goals",
      ],
      errors,
    }),
  );
} catch (error) {
  const page = await app.firstWindow();
  await page.screenshot({ path: join(home, "failure.png") });
  console.error(JSON.stringify({ home, error: String(error), errors }));
  throw error;
} finally {
  await app.close();
  if (process.env.CREWVANE_KEEP_TEST_ARTIFACTS !== "1") await rm(home, { recursive: true, force: true });
}
