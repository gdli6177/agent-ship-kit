import { _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { WorkspaceService } from "../packages/core/src/index.ts";
const run = promisify(execFile);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAVUlEQVR4nGPUMIr6z4AEAqKWInMZNiyLZqClPBPDAAOmEe8Axoqe///pGefo8kwMAwyYRrwDGEfLAYaR7gDG0XKAYaQ7gHG0HGAY6Q5gHC0HGEa6AwC58E1KmpVcaAAAAABJRU5ErkJggg==",
  "base64",
);
function auditRenderedUi() {
  const parse = color => {
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(",").map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = ({ r, g, b }) => {
    const channel = value => {
      value /= 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
  });
  const backgroundOf = element => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0.001) layers.push(color);
    }
    let background = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    if (background.a < 1) background = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1)
      background = { ...blend(layers[index], background), a: 1 };
    return background;
  };
  const issues = [], seen = new Set();
  for (const element of document.querySelectorAll("body *")) {
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number.parseFloat(style.opacity) < 0.1) continue;
    const bounds = element.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) continue;
    const textNode = [...element.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
    if (textNode) {
      const foreground = parse(style.color);
      if (foreground) {
        const background = backgroundOf(element),
          rendered = foreground.a < 1 ? blend(foreground, background) : foreground,
          first = luminance(rendered), second = luminance(background),
          ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
          fontSize = Number.parseFloat(style.fontSize),
          large = fontSize >= 18.66 || (fontSize >= 14 && Number.parseInt(style.fontWeight, 10) >= 700),
          required = large ? 3 : 4.5,
          text = textNode.textContent.trim().replace(/\s+/g, " ").slice(0, 42),
          key = `contrast|${text}|${Math.round(ratio * 100)}|${fontSize}`;
        if (ratio < required && !seen.has(key)) {
          seen.add(key);
          issues.push({ kind: "contrast", text, fontSize, ratio: Math.round(ratio * 100) / 100, required });
        }
        if (fontSize < 11 && !seen.has(`tiny|${text}|${fontSize}`)) {
          seen.add(`tiny|${text}|${fontSize}`);
          issues.push({ kind: "tiny-text", text, fontSize });
        }
      }
    }
    if (style.overflow === "hidden" && element.scrollWidth > element.clientWidth + 2 && element.clientWidth > 0 && element.scrollHeight <= element.clientHeight + 2)
      issues.push({ kind: "clipped-x", text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 42) });
  }
  for (const button of document.querySelectorAll("button")) {
    const name = (button.getAttribute("aria-label") || button.textContent || "").trim(),
      bounds = button.getBoundingClientRect();
    if (bounds.width < 1) continue;
    if (!name) issues.push({ kind: "unnamed-button" });
    if (bounds.width < 24 || bounds.height < 24)
      issues.push({ kind: "small-target", text: name.slice(0, 30), size: `${Math.round(bounds.width)}x${Math.round(bounds.height)}` });
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)
    issues.push({ kind: "horizontal-scroll", over: document.documentElement.scrollWidth - document.documentElement.clientWidth });
  return issues;
}
const home = await mkdtemp(join(tmpdir(), "crewvane-desktop-v04-")),
  workspace = join(home, "workspace");
await mkdir(workspace);
await mkdir(join(home, "userData"), { recursive: true });
await mkdir(join(home, ".local/bin"), { recursive: true });
const webhookEvents = [];
const webhookServer = createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    webhookEvents.push({
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(204).end();
  });
});
await new Promise((resolve, reject) => {
  webhookServer.once("error", reject);
  webhookServer.listen(0, "127.0.0.1", resolve);
});
const webhookAddress = webhookServer.address();
assert.ok(webhookAddress && typeof webhookAddress !== "string");
const webhookUrl = `http://127.0.0.1:${webhookAddress.port}/attention`;
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
  assert.equal(await page.locator(".section-heading h2 span").count(), 0);
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  assert.ok(await page.locator(".app.collapsed").count());
  assert.equal(await page.getByRole("button", { name: "找管家" }).locator("svg").first().isVisible(), true);
  await page.screenshot({ path: join(home, "collapsed-dark.png"), animations: "disabled" });
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
  await page.getByRole("dialog", { name: /桌面试用交付/ }).waitFor();
  await page.locator(".goal-attachments").getByText("selected.png", { exact: true }).waitFor();
  await page.locator(".goal-attachments").getByText("pasted.png", { exact: true }).waitFor();
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
  await page.getByRole("dialog", { name: /桌面试用交付/ }).waitFor();
  await assert.rejects(stat(join(workspace, removedAttachment.path)), /ENOENT/);
  state = await page.evaluate(() => window.crewvane.command({ type: "snapshot" }));
  assert.equal(state.goals[0].attachments.length, 1);
  assert.ok(!state.goals[0].attachments.some(item => item.id === removedAttachment.id));
  await page.getByRole("button", { name: "给管家留言", exact: true }).click();
  await page.getByLabel("发给管家的消息", { exact: true }).fill("请保留现有验收记录，不要扩大范围。");
  await page.getByLabel("选择回复图片", { exact: true }).setInputFiles({
    name: "reply.png",
    mimeType: "image/png",
    buffer: png,
  });
  await page.getByText("reply.png", { exact: true }).waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(home, "goal-reply-dark.png"), animations: "disabled" });
  const nextBeforeFeedback = (await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).goals[0].next;
  await page.getByRole("button", { name: "交给管家", exact: true }).click();
  await page.getByText("请保留现有验收记录，不要扩大范围。", { exact: true }).waitFor();
  let feedbackSnapshot;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    feedbackSnapshot = (await service.read()).goals.find(goal => goal.id === goalId);
    if (feedbackSnapshot?.activities.some(activity =>
      activity.kind === "message" &&
      activity.text === "请保留现有验收记录，不要扩大范围。" &&
      activity.attachmentIds?.length === 1)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(feedbackSnapshot.next, nextBeforeFeedback);
  assert.ok(feedbackSnapshot.activities.some(activity =>
    activity.kind === "message" &&
    activity.text === "请保留现有验收记录，不要扩大范围。" &&
    activity.attachmentIds?.length === 1));
  for (let index = 1; index <= 5; index += 1) {
    await page.evaluate(({ id, index }) => window.crewvane.command({
      type: "goal.progress",
      goalId: id,
      summary: index === 5
        ? "负责人具体答复：旧接口仍可只读调用，但新界面应改用 /v2/items，并保留两轮兼容期。"
        : `负责人过程记录 ${index}`,
      actor: "负责人 alpha-owner",
    }), { id: goalId, index });
  }
  await page.locator(".goal-history").evaluate(element => { element.open = true; });
  await page.locator(".goal-raw-message").getByText(
    "负责人具体答复：旧接口仍可只读调用，但新界面应改用 /v2/items，并保留两轮兼容期。",
    { exact: true },
  ).waitFor();
  assert.equal(
    await page.locator(".conversation-feed").getByText("请保留现有验收记录，不要扩大范围。", { exact: true }).count(),
    1,
    "older conversation history must remain visible after more than four activity records",
  );
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
  assert.ok(state.goals[0].activities.some(activity =>
    activity.kind === "message" && /外部 Herdr 终端追加下一步/.test(activity.text)));
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "我来处理", exact: true }).click();
  await page.waitForFunction(async id => {
    const snapshot = await window.crewvane.command({ type: "snapshot" });
    return snapshot.goals.find(goal => goal.id === id)?.mode === "manual";
  }, goalId);
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
  await page.getByRole("button", { name: "退回修改", exact: true }).click();
  await page.getByLabel("退回说明", { exact: true }).fill("请补充桌面端的实际验收说明");
  await page.getByRole("button", { name: "退回并交给管家", exact: true }).click();
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
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByText("现在，可以安心了。").waitFor();
  assert.equal(await page.getByRole("button", { name: "工序", exact: true }).count(), 0);
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
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await service.read()).agents?.owner === "omp --model another-model") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual((await service.read()).agents, { concierge: "codex --model my-model", owner: "omp --model another-model" });
  await page.getByRole("button", { name: "配置 Webhook", exact: true }).click();
  await page.getByRole("dialog", { name: "Webhook 通知" }).waitFor();
  await page.getByLabel(/在需要你处理时发送/).check();
  await page.getByLabel("Webhook 地址").fill(webhookUrl);
  await page.getByLabel(/Bearer 令牌/).fill("desktop-smoke-token");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("Webhook 通知已启用。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "管理 Webhook", exact: true }).click();
  await page.screenshot({ path: join(home, "webhook-dark.png"), animations: "disabled" });
  await page.getByRole("button", { name: "测试当前配置", exact: true }).click();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (webhookEvents.some(event =>
      event.body.event === "notification.test" &&
      event.headers.authorization === "Bearer desktop-smoke-token")) break;
    await page.waitForTimeout(100);
  }
  assert.ok(
    webhookEvents.some(event =>
      event.body.event === "notification.test" &&
      event.headers.authorization === "Bearer desktop-smoke-token"),
    `the Webhook test button must send a real request; dialog text: ${await page.locator('[role="dialog"]').innerText()}`,
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
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
  await page.getByText(/Crewvane 0\.5\.0 · 一位管家/).waitFor();
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
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (webhookEvents.some(event =>
      event.body.event === "attention.required" &&
      event.body.goal?.id === riskGoal.id)) break;
    await page.waitForTimeout(100);
  }
  const attentionEvent = webhookEvents.find(event =>
    event.body.event === "attention.required" &&
    event.body.goal?.id === riskGoal.id);
  assert.ok(attentionEvent, "an attention transition must reach the configured webhook");
  assert.equal(attentionEvent.body.goal.title, "权限变更试用");
  assert.equal(attentionEvent.body.goal.kind, "decision");
  assert.equal(attentionEvent.headers.authorization, "Bearer desktop-smoke-token");
  await page.getByText("权限变更试用", { exact: true }).click();
  await page.getByLabel("你的决定").fill("只允许只读权限，不增加管理员。");
  await page.getByRole("button", { name: "批准并继续", exact: true }).click();
  await page.getByText("已记入批准账本，正在通知管家", { exact: true }).waitFor();
  const ledger = await readFile(join(workspace, ".crewvane", "decisions.md"), "utf8");
  assert.match(ledger, /只允许只读权限/);
  assert.match(ledger, /change-permissions/);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({ path: join(home, "home-light.png") });
  // A personal item must be manageable without asking an Agent or using CLI.
  await page.locator(".top-actions").getByRole("button", { name: "新目标" }).click();
  await page.getByLabel("要交给管家的事情").fill("个人事项界面闭环");
  await page.getByLabel("要交给管家的事情").press("Meta+Enter");
  await page.getByRole("dialog", { name: /个人事项界面闭环/ }).waitFor();
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "我来处理", exact: true }).click();
  await page.getByRole("button", { name: "补充说明", exact: true }).click();
  await page.getByLabel("发给管家的消息", { exact: true }).fill("审批已经通过，继续处理");
  const previousNext = (await service.read()).goals.find(item => item.title === "个人事项界面闭环").next;
  await page.getByRole("button", { name: "记录留言", exact: true }).click();
  let personal = (await service.read()).goals.find(item => item.title === "个人事项界面闭环");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    personal = (await service.read()).goals.find(item => item.title === "个人事项界面闭环");
    if (personal?.activities.some(activity =>
      activity.kind === "message" && activity.text === "审批已经通过，继续处理")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(personal.activities.some(activity =>
    activity.kind === "message" && activity.text === "审批已经通过，继续处理"));
  assert.equal(personal.next, previousNext, "messages must not silently change the next step");
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "编辑目标", exact: true }).click();
  await page.getByLabel("当前安排").selectOption("waiting");
  await page.getByLabel("下一步", { exact: true }).fill("等待下一次核对");
  await page.getByLabel("跟进提醒", { exact: true }).fill("2030-01-01T09:30");
  await page.getByRole("button", { name: "保存更新", exact: true }).click();
  let manual = (await service.read()).goals.find(item => item.title === "个人事项界面闭环");
  assert.equal(manual.status, "waiting");
  assert.equal(manual.remindAt, new Date("2030-01-01T09:30").toISOString());
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "编辑目标", exact: true }).click();
  assert.equal(await page.getByLabel("跟进提醒", { exact: true }).inputValue(), "2030-01-01T09:30");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "提交成果", exact: true }).click();
  await page.getByLabel("成果摘要").fill("已用桌面界面完成个人事项闭环");
  await page.getByLabel("检查名称").fill("提醒时间核对");
  await page.getByLabel("实际检查操作").fill("编辑后再次打开跟进提醒字段");
  await page.getByLabel("通过依据").fill("界面值与保存前一致，未发生时区偏移");
  await page.getByRole("button", { name: "提交验收", exact: true }).click();
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  state = await service.read();
  assert.equal(state.goals[0].status, "completed");
  assert.equal(state.goals.find(item => item.id === manual.id).status, "completed");
  assert.deepEqual(state.workflows, []);
  await page.locator(".top-actions").getByRole("button", { name: "新目标" }).click();
  await page.getByLabel("要交给管家的事情").fill("等待审批操作");
  await page.getByRole("button", { name: "交给管家", exact: true }).click();
  await page.getByRole("dialog", { name: /等待审批操作/ }).waitFor();
  const waiting = (await service.read()).goals.find(item => item.title === "等待审批操作");
  await service.execute({ type: "goal.wait", goalId: waiting.id, reason: "等 YR 审批", owner: "YR", remindAt: "2030-01-01T00:00:00Z" });
  await page.getByText("现在不用处理", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("当前安排").count(), 0);
  await page.getByRole("button", { name: "1 小时后提醒", exact: true }).click();
  let waitingState = (await service.read()).goals.find(item => item.id === waiting.id);
  assert.ok(Date.parse(waitingState.remindAt) > Date.now());
  assert.equal(waitingState.status, "waiting");
  await page.getByRole("button", { name: "有结果了，继续推进", exact: true }).click();
  await page.getByLabel("最新结果与下一步", { exact: true }).fill("审批通过了，我亲自处理。");
  await page.getByRole("button", { name: "交给管家继续", exact: true }).click();
  await page.waitForFunction(async goalId => {
    const state = await window.crewvane.command({ type: "snapshot" });
    return state.goals.find(item => item.id === goalId)?.status === "active";
  }, waiting.id);
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "我来处理", exact: true }).click();
  await page.waitForFunction(async goalId => {
    const state = await window.crewvane.command({ type: "snapshot" });
    return state.goals.find(item => item.id === goalId)?.mode === "manual";
  }, waiting.id);
  waitingState = (await service.read()).goals.find(item => item.id === waiting.id);
  assert.equal(waitingState.status, "active");
  assert.equal(waitingState.mode, "manual");
  assert.equal(waitingState.owner, "你");
  assert.equal(waitingState.dispatch, undefined);
  await page.screenshot({ path: join(home, "goal-detail-light.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1050, height: 760 });
  const detailOverflow = await page.locator(".goal-detail-modal").evaluate(element =>
    element.scrollWidth > element.clientWidth + 1);
  assert.equal(detailOverflow, false, "goal detail must not overflow a narrow desktop viewport");
  await page.screenshot({ path: join(home, "goal-detail-narrow-light.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "提交成果", exact: true }).click();
  await page.getByLabel("成果摘要").fill("删除闭环已完成");
  await page.getByLabel("检查名称").fill("目标状态核对");
  await page.getByLabel("实际检查操作").fill("确认目标已进入待验收");
  await page.getByLabel("通过依据").fill("目标状态为 review");
  await page.getByRole("button", { name: "提交验收", exact: true }).click();
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  page.once("dialog", dialog => void dialog.accept());
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "永久删除目标", exact: true }).click();
  await page.waitForFunction(async goalId => {
    const state = await window.crewvane.command({ type: "snapshot" });
    return !state.goals.some(item => item.id === goalId);
  }, waiting.id);
  assert.equal((await service.read()).goals.some(item => item.id === waiting.id), false);
  const offline = await page.evaluate(() => window.crewvane.command({
    type: "goal.create",
    input: { title: "联系管家失败界面", projectId: "personal", mode: "concierge" },
  }));
  const offlineState = (await service.read()).goals.find(goal => goal.id === offline.id);
  await service.execute({
    type: "goal.dispatch",
    goalId: offline.id,
    status: "failed",
    requestId: offlineState.dispatch.id,
    detail: "测试环境无法连接管家",
  });
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await page.getByText("联系管家失败界面", { exact: true }).click();
  await page.getByText("联系管家失败", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重试联系管家", exact: true }).waitFor();
  assert.equal(await page.getByText("负责人现场需要你处理", { exact: true }).count(), 0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(home, "dispatch-failure-light.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const auditDirectory = join(home, "ui-audit");
  await mkdir(auditDirectory);
  const auditReport = [];
  for (const size of [[1408, 880], [1280, 800], [1024, 700]]) {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await page.waitForTimeout(180);
    for (const theme of ["dark", "light"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme)
        await page.getByRole("button", { name: theme === "light" ? "浅色模式" : "深色模式" }).click();
      await page.waitForTimeout(120);
      for (const screen of ["home", "goals", "settings"]) {
        await page.getByRole("button", {
          name: screen === "home" ? "注意力" : screen === "goals" ? "全部目标" : "设置",
          exact: true,
        }).click();
        await page.waitForTimeout(120);
        const issues = await page.evaluate(auditRenderedUi);
        auditReport.push({ size: size.join("x"), theme, screen, issues });
        await page.screenshot({
          path: join(auditDirectory, `${size[0]}x${size[1]}-${theme}-${screen}.png`),
          animations: "disabled",
        });
      }
      await page.getByRole("button", { name: "全部目标", exact: true }).click();
      await page.getByText("联系管家失败界面", { exact: true }).click();
      await page.getByRole("dialog").waitFor();
      const detailIssues = await page.evaluate(auditRenderedUi);
      auditReport.push({ size: size.join("x"), theme, screen: "goal-detail", issues: detailIssues });
      await page.screenshot({
        path: join(auditDirectory, `${size[0]}x${size[1]}-${theme}-goal-detail.png`),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await page.locator(".top-actions").getByRole("button", { name: "新目标" }).click();
      await page.getByRole("dialog").waitFor();
      const intakeIssues = await page.evaluate(auditRenderedUi);
      auditReport.push({ size: size.join("x"), theme, screen: "intake", issues: intakeIssues });
      await page.screenshot({
        path: join(auditDirectory, `${size[0]}x${size[1]}-${theme}-intake.png`),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.waitForTimeout(120);
    }
  }
  const uiIssues = auditReport.flatMap(result =>
    result.issues.map(issue => ({ ...issue, size: result.size, theme: result.theme, screen: result.screen })));
  assert.deepEqual(uiIssues, [],
    `UI audit found contrast, clipping, accessibility, or target-size issues: ${JSON.stringify(uiIssues.slice(0, 20))}`);
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
        "settings",
        "private Webhook settings and real attention delivery",
        "per-project ship policy from the desktop UI",
        "high-risk decision from the desktop UI and persisted ledger",
        "save Agent role preferences",
        "shared state",
        "renderer isolation",
        "manual message/wait/review/accept through UI",
        "local reminder round trip",
        "single natural-language goal intake",
        "image paste, drag, file selection, preview, removal, and metadata-only persistence",
        "keyboard submission for goal intake",
        "goal.message preserves the next step and status",
        "reply images are imported into the message activity",
        "complete goal conversation and substantive owner answer remain visible",
        "external terminal feedback refreshes the app without replaying a handoff",
        "waiting snooze and resume directly without the manual editor",
        "light and narrow goal detail layouts have no horizontal overflow",
        "6 theme/size UI audit combinations across 5 core screens",
        "dispatch failure is presented as a retryable concierge connection failure",
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
  await new Promise((resolve, reject) =>
    webhookServer.close(error => error ? reject(error) : resolve()));
  if (process.env.CREWVANE_KEEP_TEST_ARTIFACTS !== "1") await rm(home, { recursive: true, force: true });
}
