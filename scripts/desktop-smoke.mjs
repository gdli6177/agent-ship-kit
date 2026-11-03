import { _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { WorkspaceService } from "../packages/core/src/index.ts";
const home = await mkdtemp(join(tmpdir(), "crewvane-desktop-v04-")),
  workspace = join(home, "workspace");
await mkdir(workspace);
await mkdir(join(home, "userData"), { recursive: true });
const app = await electron.launch({
  executablePath: resolve(process.env.CREWVANE_APP_PATH ||
    "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
  args: [],
  env: {
    ...process.env,
    CREWVANE_TEST_USER_DATA: join(home, "userData"),
    CREWVANE_TEST_HOME: home,
    CREWVANE_TEST_WORKSPACE: workspace,
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
  await page
    .locator(".top-actions")
    .getByRole("button", { name: "新目标" })
    .click();
  await page.getByLabel("要处理什么？").fill("桌面试用交付");
  await page
    .getByLabel("背景与完成标准")
    .fill("验证目标创建、提交验收、退回与完成。");
  await page.getByLabel("交给谁？").selectOption("manual");
  await page.getByRole("button", { name: "记录目标" }).click();
  await page.getByText("桌面试用交付", { exact: true }).first().waitFor();
  let state = await page.evaluate(() =>
      window.crewvane.command({ type: "snapshot" }),
    ),
    goalId = state.goals[0].id;
  const service = new WorkspaceService(workspace);
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
  await page.screenshot({ path: join(home, "home-light.png") });
  // A personal item must be manageable without asking an Agent or using CLI.
  await page.locator(".top-actions").getByRole("button", { name: "新目标" }).click();
  await page.getByLabel("要处理什么？").fill("个人事项界面闭环");
  await page.getByLabel("交给谁？").selectOption("manual");
  await page.getByRole("button", { name: "记录目标", exact: true }).click();
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await page.getByText("个人事项界面闭环", { exact: true }).click();
  await page.getByText("手动处理", { exact: true }).click();
  await page.getByLabel("手动处理说明", { exact: true }).fill("审批已经通过，继续处理");
  await page.getByRole("button", { name: "记录进展", exact: true }).click();
  await page.getByRole("button", { name: "更新下一步", exact: true }).click();
  await page.getByLabel("当前安排").selectOption("waiting");
  await page.getByLabel("下一步", { exact: true }).fill("等待下一次核对");
  await page.getByLabel("跟进提醒", { exact: true }).fill("2030-01-01T09:30");
  await page.getByRole("button", { name: "保存更新", exact: true }).click();
  let manual = (await service.read()).goals.find(item => item.title === "个人事项界面闭环");
  assert.equal(manual.status, "waiting");
  assert.equal(manual.remindAt, new Date("2030-01-01T09:30").toISOString());
  await page.getByText("手动处理", { exact: true }).click();
  await page.getByRole("button", { name: "更新下一步", exact: true }).click();
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
  assert.equal(await page.getByRole("button", { name: "更新下一步", exact: true }).count(), 0);
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
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  console.log(
    JSON.stringify({
      ok: true,
      home,
      checks: [
        "theme",
        "collapsible sidebar",
        "manual goal",
        "waiting",
        "review evidence",
        "rework",
        "accept",
        "workflow save",
        "settings",
        "save Agent role preferences",
        "shared state",
        "renderer isolation",
        "manual progress/wait/review/accept through UI",
        "local reminder round trip",
        "custom workflow add/remove/save",
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
