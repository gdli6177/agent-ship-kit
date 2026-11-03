import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { codexArguments } from "./agent-command.js";
import type {
  HerdrReference,
  LivePresence,
  AgentPreferences,
} from "../../../packages/core/src/types.js";
const exec = promisify(execFile);
export interface HerdrRunner {
  run(args: string[], timeout?: number): Promise<string>;
}
export const herdrRunner = (
  executable: string,
  session = "crewvane",
): HerdrRunner => ({
  async run(args, timeout = 30_000) {
    try {
      const result = await exec(executable, args, {
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, HERDR_SESSION: session },
      });
      return result.stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      let detail = stderr.trim();
      try {
        const data = JSON.parse(stderr);
        detail = JSON.stringify(data.error ?? data);
      } catch {
        /* keep stderr */
      }
      throw new Error(
        `Herdr ${args.slice(0, 2).join(" ")}：${detail || (error as Error).message}`,
      );
    }
  },
});
function payload(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Herdr 返回了无法读取的结果：${raw.slice(0, 300)}`);
  }
}
function named(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}
export const quoteShell = (value: string) =>
  `'${value.replaceAll("'", "'\\''")}'`;
function agents(raw: string): any[] {
  const data = payload(raw),
    list = data.result?.agents ?? data.agents ?? data;
  if (!Array.isArray(list)) throw new Error("Herdr 没有返回 Agent 列表");
  return list;
}
export function conciergeInstructions(root: string, preferences: AgentPreferences = { concierge: "codex" }, session = "crewvane"): string {
  return `你是 Crewvane 的全局管家，统筹这个工作区的所有项目和个人事项。用户只与你沟通，不需要分别寻找目标负责人。

工作区：${root}
必须先运行 crewvane goal list --json 了解目标，运行 crewvane workflow list --json 了解工序。后续每个目标用 crewvane goal show <ID> --json 获取完整说明。
用户只需用自然语言交代事情。用户提出新事项时，用 crewvane goal create --title "<目标>" --project <实际项目ID> --description "<背景与完成标准>" 记录后推进；你和负责人负责写回下一步、等待对象和提醒，不得要求人去桌面填写这些表单。
Agent 默认启动命令：管家 ${preferences.concierge}，负责人 ${preferences.owner || preferences.concierge}，工人 ${preferences.worker || preferences.owner || preferences.concierge}。分工前运行 crewvane status --json 读取最新 agents 偏好；未设置的角色继承上一级。用户在本目标明确指定的启动命令优先，其次工作区的角色偏好。把启动命令拆成 CLI 可执行文件与原生参数，CLI 对应 Herdr agent start --kind，原生参数完整放在 -- 后，保留模型等选项；绝对路径须将该目录放在 Pane 的 PATH 首位。没有指定模型时沿用该 CLI 自身配置。不得私自换成其他 CLI；指定项不可用时先核查并提出明确的问题。
创建负责人时要传递 CREWVANE_WORKSPACE、可用的 crewvane PATH、当前 Herdr Session 和真实 Pane 上下文。Codex 负责人使用 workspace-write；需要 Herdr 本地 socket 时允许 sandbox_workspace_write.network_access=true，并通过 --add-dir 指定 CLI 目录和目标项目目录，不使用全盘权限。

你的职责：
1. 把目标整理成清晰的下一步。简单事项你可以自己完成；需要分工时，在当前 Herdr Session 的对应目标 Tab 中按需创建负责人，并用 herdr agent prompt <名称> "<任务>" --wait 发消息。
2. 一个目标对应一个 Herdr Tab；创建后运行 crewvane session set <目标ID> --session ${quoteShell(session)} --workspace <真实ID> --tab <真实ID> --pane <真实ID> --agent <真实名称>，不得猜测 ID。
3. 读取目标项目规则与工序快照。负责人遇到问题先自己解决；解决不了先由你处理，只有你也无法决定才通过 crewvane goal decide <ID> --question "<具体问题>" 请求人决定。常规实现选择不要反复向人确认。
4. 每次实质进展用 crewvane goal progress <ID> --summary "<实际结果>" --next "<下一步>" [--stage <步骤ID>]。等待他人用 crewvane goal wait <ID> --reason "<等待事项>" --owner "<对象>" [--remind-at <ISO时间>]。
5. 交付必须有真实成果和运行过的检查，使用 crewvane goal review <ID> --summary "<成果>" [--location <位置>] [--url <https链接>] --check "名称::实际命令或操作::passed::真实结果"。Herdr 的 done/idle 不表示目标完成。
6. 不自动合并、发布、部署或向外部联系人发消息。不要伪造 CLI 执行结果或检查。
7. 创建负责人后先立即运行 crewvane session set 保存真实现场，再发送任务。给负责人发消息不要长时间阻塞等待整项工程完成；确认消息已被接收后继续统筹其他目标，通过 crewvane 状态和 Herdr agent get 检查进展。负责人遇到问题或交付时也及时用 crewvane 写回。

先简短回复你已开始统筹，然后直接推进，不需要用户再确认常规执行。`;
}
export class HerdrClient {
  constructor(
    readonly runner: HerdrRunner,
    readonly session = "crewvane",
    readonly startSession?: () => Promise<void>,
  ) {}
  async findConcierge(): Promise<HerdrReference | undefined> {
    await this.ensureSession();
    const concierge = agents(await this.runner.run(["agent", "list"])).find(agent => agent.name === "concierge");
    if (!concierge) return;
    const reference = {
      session: this.session,
      workspaceId: named(concierge.workspace_id), tabId: named(concierge.tab_id),
      paneId: named(concierge.pane_id), agent: "concierge",
    };
    if (!reference.workspaceId || !reference.tabId || !reference.paneId)
      throw new Error("Herdr 中已有管家，但缺少可恢复的现场 ID。请打开 Herdr 检查。");
    return reference;
  }
  async ensureSession(): Promise<void> {
    try {
      agents(await this.runner.run(["agent", "list"]));
      return;
    } catch (error) {
      if (!String(error).includes("server_not_running") || !this.startSession)
        throw error;
    }
    await this.startSession();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        agents(await this.runner.run(["agent", "list"], 2000));
        return;
      } catch (error) {
        if (!String(error).includes("server_not_running")) throw error;
      }
      await delay(250);
    }
    throw new Error(
      "Herdr 会话未能启动。请在应用内重新连接现场，再点「准备管家」重试。",
    );
  }
  async prepareConcierge(
    root: string,
    existing?: HerdrReference,
    kind = "codex",
    cliDirectory = "",
    localBin = "/usr/local/bin",
    agentBin = "/usr/local/bin",
    projectDirectories: string[] = [],
    onReference?: (reference: HerdrReference) => Promise<void>,
    preferences?: AgentPreferences,
    nativeArgs: string[] = [],
  ): Promise<HerdrReference> {
    const concierge = await this.findConcierge();
    if (concierge) return concierge;
    let workspaceId: string | undefined,
      tabId: string | undefined,
      paneId: string | undefined;
    if (existing?.session === this.session && existing.paneId) {
      try {
        const current = payload(
          await this.runner.run(["pane", "get", existing.paneId]),
        );
        const pane = current.result?.pane ?? current.pane;
        if (pane?.pane_id === existing.paneId) {
          workspaceId = existing.workspaceId;
          tabId = existing.tabId;
          paneId = existing.paneId;
        }
      } catch (error) {
        if (!/not_found|invalid_pane|unknown_pane/.test(String(error)))
          throw error;
      }
    }
    if (!workspaceId || !tabId || !paneId) {
      const created = payload(
        await this.runner.run(
          [
            "workspace",
            "create",
            "--cwd",
            root,
            "--label",
            "Crewvane · 全局工作台",
            "--no-focus",
          ],
          60_000,
        ),
      );
      const result = created.result ?? created;
      workspaceId =
        named(result.workspace?.workspace_id) ?? named(result.workspace?.id);
      tabId = named(result.tab?.tab_id) ?? named(result.tab?.id);
      paneId = named(result.root_pane?.pane_id) ?? named(result.root_pane?.id);
    }
    if (!workspaceId || !tabId || !paneId)
      throw new Error("Herdr 没有返回管家所需的真实会话 ID");
    const reference = {
      session: this.session,
      workspaceId,
      tabId,
      paneId,
      agent: "concierge",
    };
    await onReference?.(reference);
    await this.runner.run(["tab", "focus", tabId]);
    const cliRoot = cliDirectory || `${root}/.crewvane/bin`;
    const cliPath = `${agentBin}:${cliRoot}:${localBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
    const environment = `export CREWVANE_WORKSPACE=${quoteShell(root)} HERDR_SESSION=${quoteShell(this.session)} HERDR_ENV=1 HERDR_WORKSPACE_ID=${quoteShell(workspaceId)} HERDR_TAB_ID=${quoteShell(tabId)} HERDR_PANE_ID=${quoteShell(paneId)} PATH=${quoteShell(cliPath)}; printf '\\n__CREWVANE_ENV_READY__\\n'`;
    await this.runner.run(["pane", "run", paneId, environment]);
    await this.runner.run(
      [
        "pane",
        "wait-output",
        paneId,
        "--match",
        "__CREWVANE_ENV_READY__",
        "--timeout",
        "10000",
      ],
      15_000,
    );
    await this.runner.run(
      [
        "agent",
        "start",
        "concierge",
        "--kind",
        kind,
        "--pane",
        paneId,
        ...(kind === "codex" || nativeArgs.length ? ["--",
          ...(kind === "codex" ? codexArguments(nativeArgs, cliRoot, projectDirectories, cliPath) : nativeArgs),
        ] : []),
      ],
      60_000,
    );
    await this.runner.run([
      "agent",
      "prompt",
      "concierge",
      conciergeInstructions(root, preferences, this.session),
    ]);
    return reference;
  }
  async notifyGoal(
    reference: HerdrReference | undefined,
    goalId: string,
    title: string,
  ) {
    if (!reference?.agent)
      throw new Error("管家尚未准备好，请先在设置中准备管家");
    await this.runner.run([
      "agent",
      "prompt",
      reference.agent,
      `目标有更新 ${goalId}：${title}。请用 crewvane goal show ${goalId} --json 读取最新状态，并用 crewvane status --json 查看当前 Agent 默认偏好后直接统筹。若人已经验收或放弃，请停止该目标的工作。`,
    ]);
  }
  async open(reference: HerdrReference) {
    if (reference.tabId)
      await this.runner.run(["tab", "focus", reference.tabId]);
    else if (reference.agent)
      await this.runner.run(["agent", "focus", reference.agent]);
  }
  async notifyWatchdog(reference: HerdrReference, issues: { goalId: string; reason: string }[]) {
    if (!reference.agent) throw new Error("管家尚未准备好，请先连接管家");
    const reasons: Record<string, string> = { blocked: "负责人正在等待输入或批准", missing: "负责人会话暂时不可达", stale: "目标 30 分钟没有写回实质进展" };
    await this.runner.run(["agent", "prompt", reference.agent,
      `这是 Crewvane 后台巡检，不是用户新增任务：${issues.map(issue => `${issue.goalId}（${reasons[issue.reason] ?? issue.reason}）`).join("；")}。请先用 crewvane goal show 读取实际记录，检查真实负责人现场并主动联系负责人。能处理的由你处理并写回进展，不把终端安静或 idle 当作失败或完成。确实必须由人决定时才用 goal decide 提出具体问题；不要让人填写进度表。已等待他人、已交付或已结束的目标不要重新启动。`]);
  }
  async presences(
    goals: { id: string; herdr?: HerdrReference }[],
  ): Promise<Record<string, LivePresence>> {
    const entries = agents(await this.runner.run(["agent", "list"]));
    const result: Record<string, LivePresence> = {};
    for (const goal of goals) {
      if (!goal.herdr?.agent) continue;
      const agent = entries.find(
        (entry) =>
          entry.name === goal.herdr?.agent ||
          entry.agent === goal.herdr?.agent ||
          entry.pane_id === goal.herdr?.paneId,
      );
      if (!agent) {
        result[goal.id] = { state: "unknown", checkedAt: new Date().toISOString(), reachable: false };
        continue;
      }
      const state =
        agent.agent_status ?? agent.state ?? agent.status ?? agent.lifecycle;
      if (["working", "idle", "done", "blocked", "unknown"].includes(state))
        result[goal.id] = { state, checkedAt: new Date().toISOString(), reachable: true };
    }
    return result;
  }
}
