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
// Unknown CLIs can use canonical TTY input (macOS MAX_CANON is 1024 bytes).
// Keep each line below the limit without breaking a Unicode code point.
export function terminalPrompt(text: string) {
  return text.split("\n").map(line => {
    const lines: string[] = [];
    let current = "", bytes = 0;
    for (const character of line) {
      const length = Buffer.byteLength(character);
      if (bytes + length > 768) { lines.push(current); current = ""; bytes = 0; }
      current += character; bytes += length;
    }
    return [...lines, current].join("\n");
  }).join("\n");
}
function agents(raw: string): any[] {
  const data = payload(raw),
    list = data.result?.agents ?? data.agents ?? data;
  if (!Array.isArray(list)) throw new Error("Herdr 没有返回 Agent 列表");
  return list;
}
const conciergeRole = "管家只负责目标分发、协调跟进和向人交接，不亲自执行目标。所有需要执行的目标，无论大小，都必须交给独立负责人；已有负责人时复用原现场。你可以读取目标、项目规则和工序，记录下一步、等待与提醒，创建或联系负责人，核对负责人提供的成果和检查记录，并向人汇总或请求决定。禁止亲自调查业务代码、编写或修改目标成果、运行目标命令或测试，也不得在负责人阻塞或失败时替其补做任务。";
export function conciergeInstructions(root: string, preferences: AgentPreferences = { concierge: "codex" }, session = "crewvane"): string {
  return `你是 Crewvane 的全局管家，统筹这个工作区的所有项目和个人事项。用户只与你沟通，不需要分别寻找目标负责人。

${conciergeRole}

工作区：${root}
必须先运行 crewvane goal list --json 了解目标，运行 crewvane workflow list --json 了解工序。后续每个目标用 crewvane goal show <ID> --json 获取完整说明。
用户只需用自然语言交代事情。用户提出新事项时，用 crewvane goal create --title "<目标>" --project <实际项目ID> --description "<背景与完成标准>" 记录后推进；你和负责人负责写回下一步、等待对象和提醒，不得要求人去桌面填写这些表单。
Agent 默认启动命令：管家 ${preferences.concierge}，负责人 ${preferences.owner || preferences.concierge}，工人 ${preferences.worker || preferences.owner || preferences.concierge}。分工前运行 crewvane status --json 读取最新 agents 偏好；未设置的角色继承上一级。用户明确指定的启动命令优先。必须执行用户配置的 CLI 与完整原生参数，保留模型等选项，不得因为不在 Herdr kind 名单而拒绝或换工具。Herdr 识别的 CLI 可用 agent start --kind，参数放在 -- 后；绝对路径须将该目录放在 Pane 的 PATH 首位。不识别的自定义交互式 CLI 则用 pane run <真实PaneID> "<正确转义后的启动命令>" 启动，用 pane process-info --pane <ID> 核实前台 PID，在 crewvane session set 时额外传 --transport pane --process-id <真实PID>。后续发消息前再次核实原进程仍在前台，再用 pane run <ID> "<任务文本>" 原子发送文本和 Enter；程序退出后禁止将任务发送给 shell。自定义 CLI 无生命周期报告时状态为 unknown，不伪造 idle、working 或完成。没有指定模型时沿用该 CLI 自身配置。
创建负责人时要传递 CREWVANE_WORKSPACE、可用的 crewvane PATH、当前 Herdr Session 和真实 Pane 上下文。Codex 负责人使用 workspace-write；需要 Herdr 本地 socket 时允许 sandbox_workspace_write.network_access=true，并通过 --add-dir 指定 CLI 目录和目标项目目录，不使用全盘权限。

你的职责：
1. 把目标整理成清晰的下一步；需要执行时，必须在当前 Herdr Session 的对应目标 Tab 中创建或复用独立负责人，并用 herdr agent prompt <名称> "<任务>" 发消息。不能因为任务简单而自己执行。
2. 一个目标对应一个 Herdr Tab；创建后运行 crewvane session set <目标ID> --session ${quoteShell(session)} --workspace <真实ID> --tab <真实ID> --pane <真实ID> --agent <真实名称>，不得猜测 ID。
3. 读取目标项目规则与工序快照。负责人遇到问题先自己解决；解决不了由你澄清要求、调整分工或联系其他负责人，不能接手执行。只有协调后仍需要人的决定时，才通过 crewvane goal decide <ID> --question "<具体问题>" 请求人决定。常规实现选择不要反复向人确认。
4. 每次实质进展用 crewvane goal progress <ID> --summary "<实际结果>" --next "<下一步>" [--stage <步骤ID>]。等待他人用 crewvane goal wait <ID> --reason "<等待事项>" --owner "<对象>" [--remind-at <ISO时间>]。
5. 由负责人产出真实成果、实际运行检查并用 crewvane goal review <ID> --summary "<成果>" [--location <位置>] [--url <https链接>] --check "名称::实际命令或操作::passed::真实结果" 提交交付。你核对交付是否附有成果位置和真实检查记录，缺失则退回负责人补齐，齐备后向人交接验收；不得代写成果、代跑检查或代替人验收。Herdr 的 done/idle 不表示目标完成。
6. 不自动合并、发布、部署或向外部联系人发消息。不要伪造 CLI 执行结果或检查。
7. 创建负责人后先立即运行 crewvane session set 保存真实现场，再发送任务。给负责人发消息不要长时间阻塞等待整项工程完成；确认消息已被接收后继续统筹其他目标，通过 crewvane 状态和 Herdr agent get 检查进展。负责人遇到问题或交付时也及时用 crewvane 写回。

先简短回复你已开始统筹，然后直接分发和跟进，不需要用户再确认常规分工。`;
}
export class HerdrClient {
  constructor(
    readonly runner: HerdrRunner,
    readonly session = "crewvane",
    readonly startSession?: () => Promise<void>,
  ) {}
  private async foreground(paneId: string) {
    const data = payload(await this.runner.run(["pane", "process-info", "--pane", paneId]));
    const info = data.result?.process_info ?? data.process_info;
    if (!info || !Array.isArray(info.foreground_processes)) throw new Error("无法核实自定义 CLI 的前台进程");
    return info.foreground_processes.filter((process: any) => process.pid !== info.shell_pid) as { pid: number }[];
  }
  private async rawAlive(reference: HerdrReference) {
    return !!reference.paneId && !!reference.processId &&
      (await this.foreground(reference.paneId)).some(process => process.pid === reference.processId);
  }
  private async prompt(reference: HerdrReference, text: string) {
    if (reference.transport === "pane") {
      if (!await this.rawAlive(reference))
        throw new Error("自定义 Agent 已退出或现场已更换，未发送任务。请重新准备管家。");
      // pane run submits literal text + Enter atomically (including bracketed
      // paste handling). Never fall back to sending a task to an idle shell.
      await this.runner.run(["pane", "run", reference.paneId!, terminalPrompt(text)]);
    } else {
      if (!reference.agent) throw new Error("管家尚未准备好");
      await this.runner.run(["agent", "prompt", reference.agent, text]);
    }
  }
  async findConcierge(existing?: HerdrReference): Promise<HerdrReference | undefined> {
    await this.ensureSession();
    if (existing?.session === this.session && existing.transport === "pane") {
      try {
        if (await this.rawAlive(existing)) return existing;
      } catch (error) {
        if (!/not_found|invalid_pane|unknown_pane/.test(String(error))) throw error;
      }
    }
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
    executable?: string,
  ): Promise<HerdrReference> {
    const concierge = await this.findConcierge(existing);
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
          if (existing.transport === "pane" && (await this.foreground(existing.paneId)).length)
            throw new Error("自定义 Agent 的现场仍有其他程序运行。请打开 Herdr 检查，避免重复启动或向错误程序发送任务。");
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
    const reference: HerdrReference = {
      session: this.session,
      workspaceId,
      tabId,
      paneId,
      agent: "concierge",
      ...(!kind && executable ? { transport: "pane" as const } : {}),
    };
    await onReference?.(reference);
    await this.runner.run(["tab", "focus", tabId]);
    const cliRoot = cliDirectory || `${root}/.crewvane/bin`;
    const cliPath = `${agentBin}:${cliRoot}:${localBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
    const environment = `export CREWVANE_WORKSPACE=${quoteShell(root)} HERDR_SESSION=${quoteShell(this.session)} HERDR_ENV=1 HERDR_WORKSPACE_ID=${quoteShell(workspaceId)} HERDR_TAB_ID=${quoteShell(tabId)} HERDR_PANE_ID=${quoteShell(paneId)} PATH=${quoteShell(cliPath)}:"$PATH"; printf '\\n__CREWVANE_ENV_READY__\\n'`;
    await this.runner.run(["pane", "run", paneId, environment]);
    await this.runner.run(["pane", "wait-output", paneId, "--match", "__CREWVANE_ENV_READY__", "--timeout", "10000"], 15_000);
    if (!kind && executable) {
      await this.runner.run(["pane", "run", paneId, [executable, ...nativeArgs].map(quoteShell).join(" ")]);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const running = await this.foreground(paneId);
        if (running.length) {
          reference.transport = "pane";
          reference.processId = running[0]!.pid;
          await onReference?.(reference);
          await this.prompt(reference, conciergeInstructions(root, preferences, this.session));
          return reference;
        }
        await delay(200);
      }
      throw new Error("自定义 Agent 未保持运行。请打开现场检查启动命令、登录或配置。");
    }
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
    resumeNote?: string,
  ) {
    if (!reference?.agent && reference?.transport !== "pane")
      throw new Error("管家尚未准备好，请先在设置中准备管家");
    await this.prompt(reference,
      `${conciergeRole}\n目标有更新 ${goalId}：${title}。${resumeNote ? `用户已结束等待，要求继续推进：${resumeNote}。优先联系原负责人恢复执行；确无可用原现场时才创建独立负责人。` : ""}请用 crewvane goal show ${goalId} --json 读取最新状态，并用 crewvane status --json 查看当前 Agent 默认偏好。待执行的目标交给独立负责人；退回修改转交原负责人；交付齐备则向人交接。若人已经验收或放弃，请通知负责人停止该目标的工作，不再派发。`,
    );
  }
  async notifyFollowUp(reference: HerdrReference, goalId: string, note: string) {
    await this.prompt(reference,
      `${conciergeRole}\n用户请求跟进等待事项 ${goalId}：${note}。请用 crewvane goal show ${goalId} --json 读取实际等待对象与提醒安排，联系原负责人核查进展并写回结果。保持等待状态和跟进提醒，不把催办当作等待已结束；没有真实新结果时不得用 goal progress 恢复执行。需要人决定时提出具体问题，不亲自执行业务，也不自动向外部人员发送消息。`);
  }
  async refreshConcierge(reference: HerdrReference, root: string, preferences?: AgentPreferences) {
    await this.prompt(reference, conciergeInstructions(root, preferences, this.session));
  }
  async open(reference: HerdrReference) {
    if (reference.tabId)
      await this.runner.run(["tab", "focus", reference.tabId]);
    else if (reference.agent)
      await this.runner.run(["agent", "focus", reference.agent]);
  }
  async notifyWatchdog(reference: HerdrReference, issues: { goalId: string; reason: string }[]) {
    if (!reference.agent && reference.transport !== "pane") throw new Error("管家尚未准备好，请先连接管家");
    const reasons: Record<string, string> = { blocked: "负责人正在等待输入或批准", missing: "负责人会话暂时不可达", stale: "目标 30 分钟没有写回实质进展", unassigned: "目标尚未登记独立负责人现场，请先创建并启动负责人，保存真实现场再发送任务" };
    await this.prompt(reference,
      `${conciergeRole}\n这是 Crewvane 后台巡检，不是用户新增任务：${issues.map(issue => `${issue.goalId}（${reasons[issue.reason] ?? issue.reason}）`).join("；")}。请先用 crewvane goal show 读取实际记录，检查真实负责人现场并主动联系负责人，通过澄清要求、调整分工或联系其他负责人协调恢复，不能自己接手执行。写回实际协调进展，不把终端安静或 idle 当作失败或完成。确实必须由人决定时才用 goal decide 提出具体问题；不要让人填写进度表。已等待他人、已交付或已结束的目标不要重新启动。`);
  }
  async presences(
    goals: { id: string; herdr?: HerdrReference }[],
  ): Promise<Record<string, LivePresence>> {
    const entries = agents(await this.runner.run(["agent", "list"]));
    const result: Record<string, LivePresence> = {};
    for (const goal of goals) {
      if (goal.herdr?.transport === "pane") {
        const reachable = await this.rawAlive(goal.herdr).catch(() => false);
        result[goal.id] = { state: "unknown", checkedAt: new Date().toISOString(), reachable };
        continue;
      }
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
