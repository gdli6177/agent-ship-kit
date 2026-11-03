import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceService } from "../packages/orchestrator/src/service.js";
import { git } from "../packages/orchestrator/src/git.js";
import type { ChatMessage, RuntimeInfo, WorkspaceState } from "../packages/core/src/types.js";

const root = await mkdtemp(join(tmpdir(), "crewvane-product-trial-"));
const workspace = join(root, "workspace"), project = join(root, "project"), screenshots = join(root, "screenshots");
for (const dir of [workspace, project, screenshots, join(project, "src"), join(project, "test")]) await mkdir(dir, { recursive: true });
await git(project, "init", "-b", "main");
await git(project, "config", "user.name", "Product Trial");
await git(project, "config", "user.email", "trial@localhost");
await writeFile(join(project, ".gitignore"), ".crewvane/\n");
await writeFile(join(project, "AGENTS.md"), "# Isolated product trial\nWrite only the exact files named in each goal. No subagents, dependencies, commits or external effects. Read TEAM.md. Only run node --test for verification. Test credentials are provided by the host; never request or read their values. A verifier can ask the host to execute a check via verifyCheck.\n");
await writeFile(join(project, "TEAM.md"), "# Team handbook\nFor CommonJS Node tests, build paths from __dirname. Read the real output file and assert exact content. Include zero and negative boundary cases. Keep tests independent and do not add packages.\n");
await writeFile(join(project, "test/host.test.cjs"), "const {test}=require('node:test');const assert=require('node:assert/strict');test('host credential verification',{skip:!process.env.E2E_PASSWORD},()=>{assert.ok(process.env.E2E_PASSWORD.startsWith('synthetic-trial-'));console.log(process.env.E2E_PASSWORD);});\n");
await git(project, "add", ".gitignore", "AGENTS.md", "TEAM.md", "test/host.test.cjs");
await git(project, "commit", "-m", "isolated product trial");
const service = new WorkspaceService(workspace);
const runtimes = await service.execute({ type: "scan", probe: "codex" }) as RuntimeInfo[];
const omp = runtimes.find(runtime => runtime.id === "codex" && runtime.status === "ready");
const model = ["group/group", "gpt-6.1-sol"].map(id => omp?.models.find(model => model.id === id)).find(Boolean);
assert.ok(model, "real Codex model must be available");
await service.execute({ type: "profile.save", profile: { id: "trial", name: "真实试用", runtime: "codex", model: model.id } });
await service.execute({ type: "project.save", project: { id: "trial", name: "产品闭环试用", path: project, baseBranch: "main", checks: [["node", "--test"]], defaultProfile: "trial", roles: {} } });
console.log(JSON.stringify({ root, model: model.id, startedAt: new Date().toISOString() }));
const app = await electron.launch({ args: [resolve("apps/desktop")], executablePath: resolve("node_modules/.pnpm/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
  env: { ...process.env, CREWVANE_TEST_USER_DATA: join(root, "userData"), CREWVANE_TEST_WORKSPACE: workspace }, timeout: 60_000 });
const page = await app.firstWindow();
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
const snapshot = async () => page.evaluate(async () => window.crewvane.command({ type: "snapshot" })) as Promise<WorkspaceState>;
async function waitForState(predicate: (state: WorkspaceState) => boolean, label: string, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  let nextLog = 0;
  while (Date.now() < deadline) {
    const state = await snapshot();
    if (predicate(state)) return state;
    const failure = state.tasks.find(task => ["failed", "waiting_human"].includes(task.status) && !task.discussion);
    if (failure) throw new Error(`${label}: ${failure.status}: ${failure.error ?? failure.summary}`);
    if (Date.now() > nextLog) {
      console.log(JSON.stringify({ waiting: label, tasks: state.tasks.map(task => ({ title: task.title.slice(0, 25), status: task.status, stage: task.workflow.stage, learning: task.learning?.outcome })) }));
      nextLog = Date.now() + 15_000;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`${label} timed out`);
}
async function message(text: string) {
  await page.getByLabel("给船长发消息").fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const state = await waitForState(state => state.messages.some(m => m.text === text && !!m.routing && m.routing.status !== "pending"), "captain routing");
  const sent = state.messages.find(m => m.role === "human" && m.text === text)!;
  assert.notEqual(sent.routing?.status, "failed", sent.routing?.error);
  return sent;
}
try {
  await page.setViewportSize({ width: 1485, height: 1058 });
  await page.getByRole("heading", { name: "全部目标" }).waitFor();
  await page.locator("nav").getByRole("button", { name: "知识", exact: true }).click();
  await page.getByLabel("团队手册路径").fill("TEAM.md");
  await page.getByRole("button", { name: "保存知识来源", exact: true }).click();
  await page.getByRole("status").getByText(/知识来源已保存/).waitFor();
  await page.screenshot({ path: join(screenshots, "01-knowledge-connected-dark.png") });
  await page.locator("nav").getByRole("button", { name: "密码本", exact: true }).click();
  await page.getByText("系统钥匙串加密 · 凭据值不会写入工作区记录", { exact: true }).waitFor({ timeout: 60_000 });
  const secret = `synthetic-trial-${randomUUID()}`;
  await page.getByLabel("凭据名称").fill("临时试用密码");
  await page.getByLabel("凭据值", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "保存凭据", exact: true }).click();
  const credentialState = await waitForState(state => !!state.projects[0]?.credentials?.length, "secure reference registration");
  const reference = credentialState.projects[0]!.credentials![0]!;
  assert.equal(await page.getByLabel("凭据值", { exact: true }).inputValue(), "");
  assert.ok(!(await readFile(join(root, "userData/credential-vault", `${reference.id}.json`), "utf8")).includes(secret));
  await page.screenshot({ path: join(screenshots, "02-credentials-dark.png") });
  await page.getByText("临时试用密码", { exact: true }).waitFor();
  await page.locator("nav").getByRole("button", { name: "项目", exact: true }).click();
  await page.getByRole("button", { name: "配置并授权", exact: true }).click();
  await page.locator(".modal label").filter({ hasText: "允许修改路径（逗号分隔）" }).locator("textarea").fill("src/a.cjs,test/a.test.cjs,src/b.cjs,test/b.test.cjs");
  await page.getByRole("checkbox", { name: /临时试用密码/ }).check();
  await page.getByRole("button", { name: "确认授权", exact: true }).click();
  await waitForState(state => !!state.projects[0]?.grant?.credentials?.includes(reference.id), "project authorization");
  await page.locator(".context-actions").getByRole("button", { name: "船长", exact: true }).click();
  const a = await message("新目标 A：仅新增 src/a.cjs 导出 add(a,b) 返回数值相加，新增 test/a.test.cjs 用 Node 内置 test/assert 测试正数、零和负数。遵守团队手册，不改其他文件，不加依赖。直接按现有授权完成本地交付，不发布。");
  assert.equal(a.routing?.action, "create");
  const b = await message("这是另一个独立的新目标 B：仅新增 src/b.cjs 导出 double(n) 返回数值乘二，新增 test/b.test.cjs 用 Node 内置 test/assert 覆盖正数、零和负数。遵守团队手册，不改其他文件，不加依赖。直接按现有授权完成本地交付，不发布。");
  assert.equal(b.routing?.action, "create");
  assert.notEqual(a.taskId, b.taskId);
  const unclear = await message("我不确定下面这条补充应归到 A 还是 B，请先向我确认归属再转交：再覆盖一个负数边界用例。");
  assert.equal(unclear.routing?.action, "clarify");
  const aTask = (await snapshot()).tasks.find(task => task.id === a.taskId)!;
  await page.screenshot({ path: join(screenshots, "03-captain-clarification-dark.png") });
  const choice = page.locator(".clarification-choices").getByRole("button", { name: aTask.title, exact: true });
  if (await choice.count()) await choice.click();
  else await message("上条待澄清的补充属于目标 A，请转交 A 的小队长。");
  await waitForState(state => !!state.messages.find(m => m.id === unclear.id)?.routing?.resolvedBy, "persistent clarification resolution");
  await page.screenshot({ path: join(screenshots, "04-captain-routing-dark.png") });
  await page.getByRole("button", { name: "关闭船长对话", exact: true }).click();
  const final = await waitForState(state => state.tasks.length === 2 && state.tasks.every(task => task.status === "completed" && task.learning && task.learning.outcome !== "pending"), "real delivery and learning", 12 * 60_000);
  assert.ok(final.tasks.every(task => task.learning?.outcome !== "failed"), JSON.stringify(final.tasks.map(task => task.learning)));
  assert.ok(final.credentialAccess?.length);
  const log = await readFile(join(workspace, ".crewvane/events.jsonl"), "utf8");
  assert.ok(!log.includes(secret));
  for (const task of final.tasks) {
    const report = await readFile(join(workspace, ".crewvane/evidence", task.id, "report.md"), "utf8");
    assert.ok(!report.includes(secret)); assert.ok(report.includes("[redacted]"));
    assert.ok(final.agents.some(agent => agent.taskId === task.id && agent.contextSources?.some(source => source.bodyIncluded && source.path.endsWith("TEAM.md"))));
  }
  await page.locator("nav").getByRole("button", { name: "知识", exact: true }).click();
  await page.waitForTimeout(1000);
  if (await page.getByRole("button", { name: "审核并纳入", exact: true }).count()) {
    await page.getByRole("button", { name: "审核并纳入", exact: true }).first().click();
    await page.getByLabel("审核说明", { exact: true }).fill("已核对真实交付与独立验证证据，适用于同类 Node 边界测试。");
    await page.getByRole("button", { name: "确认纳入", exact: true }).click();
    await page.getByText("可复用", { exact: true }).first().waitFor();
  }
  await page.screenshot({ path: join(screenshots, "05-knowledge-reviewed-dark.png") });
  await page.locator(".rail-bottom").getByRole("button", { name: "切换到浅色主题" }).click();
  await page.screenshot({ path: join(screenshots, "06-knowledge-light.png") });
  await page.locator("nav").getByRole("button", { name: "密码本", exact: true }).click();
  await page.screenshot({ path: join(screenshots, "07-credentials-light.png") });
  await page.setViewportSize({ width: 1050, height: 760 });
  await page.screenshot({ path: join(screenshots, "08-credentials-narrow.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const report = { completedAt: new Date().toISOString(), model: model.id, tasks: final.tasks.map(task => ({ id: task.id, status: task.status, learning: task.learning, revision: task.contextRevision })),
    checks: ["real captain creates A/B", "persistent clarification", "real worker/verifier delivery", "team handbook injected", "learning extracted", "OS-encrypted dummy credential", "host credential injection", "output redaction", "metadata-only audit", "light/dark/narrow UI"], errors };
  await writeFile(join(root, "product-trial-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, root, report }));
} finally { await app.close(); }
