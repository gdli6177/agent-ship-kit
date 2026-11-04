import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import type {
  HerdrReference,
  LivePresence,
  AgentPreferences,
  Goal,
} from "../../../packages/core/src/types.js";
import { attachmentAbsolutePath } from "../../../packages/core/src/attachments.js";
const exec = promisify(execFile);
export const CONCIERGE_LAUNCH_POLICY = "control-plane-v1" as const;
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
const conciergeRole = "管家是控制面角色，只负责当前案卷的目标分发、协调跟进和向人交接，不亲自执行目标。所有需要执行的目标，无论大小，都必须交给独立负责人；已有负责人时复用原现场。你可以读取当前案卷、目标关联项目信息和工序，记录下一步、等待与提醒，创建或联系负责人，核对负责人提供的成果和检查记录，按决定账本避免重复打扰，并通过唯一出口向人汇总或请求决定。禁止调查业务代码、编写或修改目标成果、运行项目命令或测试，也不得在负责人阻塞或失败时替其补做任务。";
export function conciergeInstructions(root: string, preferences: AgentPreferences = { concierge: "codex" }, session = "crewvane"): string {
  return `这是 Crewvane 管家的身份初始化，不是案卷任务。现在没有当前案卷；不要运行 goal list、attention、status 或任何 Crewvane 写命令，不要创建负责人，也不要猜测、汇总或处理任何目标。只记住以下长期职责，回复 CREWVANE_CONCIERGE_READY，然后立即结束本回合。

你是 Crewvane 的控制面管家。用户只需要一个入口，但你的每次案卷通知只处理一个明确案卷。

${conciergeRole}

工作区：${root}
不要主动运行 goal list、attention，也不要搜索、比较或汇总其他目标。每次通知会给出唯一案卷 ID、当前状态和本次变化；只处理这个 ID。历史消息只用于理解系统协议，不能作为当前目标事实；案卷之间出现相似标题、相同项目或顺承措辞也不是同一件事。拿不准时停止切换目标，通过当前目标请求人澄清。Crewvane CLI 会在受管模式拒绝访问其他目标，不要尝试绕过。
用户只需用自然语言交代事情；桌面会先保存案卷再通知你，不需要你创建。你可以用 crewvane workflow list --json 了解可用工序，但目标事实只以当前案卷快照和 crewvane goal show <当前ID> --json 为准。你和负责人负责写回下一步、等待对象和提醒，不得要求人去桌面填写这些表单。
用户在 Herdr 终端直接对你说、且消息不以 [CREWVANE_CASE_BEGIN] 开头的也是用户输入。收到这类直接消息后，必须先把它同步回 Crewvane 再执行或回复：明确的新事项运行 crewvane direct --new "<用户原话>"；补充或修改已有目标运行 crewvane direct --goal <真实目标ID> "<用户原话>"，当前 scope 已指向该目标时可用 crewvane direct --current "<用户原话>"。不能在终端里处理完却不写回 App。若无法判断是新事项还是某个已有目标，先通过对话让用户明确，不猜测归属。
用户在 Herdr 直接消息中粘贴图片时，先把终端提供的本地图片文件保留或复制到工作区，并立即在上面的 direct 命令后追加 --attachment <真实图片路径>；CLI 会校验格式、复制到 .crewvane/attachments 并把元数据写回 App。不能只把图片留在聊天上下文里，也不能把 Base64 写进 state.json。若当前 Agent 无法取得可复制的本地文件，明确请用户回到 Crewvane 新目标输入框从本机粘贴或选择图片，不静默丢图。
Agent 默认启动命令：管家 ${preferences.concierge}，负责人 ${preferences.owner || preferences.concierge}，工人 ${preferences.worker || preferences.owner || preferences.concierge}。分工前运行 crewvane status --json 读取最新 agents 偏好；未设置的角色继承上一级。用户明确指定的启动命令优先。必须执行用户配置的 CLI 与完整原生参数，保留模型等选项，不得因为不在 Herdr kind 名单而拒绝或换工具。Herdr 识别的 CLI 可用 agent start --kind，参数放在 -- 后；绝对路径须将该目录放在 Pane 的 PATH 首位。不识别的自定义交互式 CLI 则用 pane run <真实PaneID> "<正确转义后的启动命令>" 启动，用 pane process-info --pane <ID> 核实前台 PID，在 crewvane session set 时额外传 --transport pane --process-id <真实PID>。后续发消息前再次核实原进程仍在前台，再用 pane run <ID> "<任务文本>" 原子发送文本和 Enter；程序退出后禁止将任务发送给 shell。自定义 CLI 无生命周期报告时状态为 unknown，不伪造 idle、working 或完成。没有指定模型时沿用该 CLI 自身配置。
创建负责人时要传递 CREWVANE_WORKSPACE、可用的 crewvane PATH、当前 Herdr Session 和真实 Pane 上下文，并明确取消 CREWVANE_COORDINATOR 与 CREWVANE_COORDINATOR_SCOPE_FILE，避免把管家案卷限制带给负责人。不要给任何 Agent CLI 注入 Codex 或其他运行时专属的沙箱参数；权限取决于用户配置的 CLI 和该 CLI 自身机制。Crewvane 的案卷边界只约束 Crewvane CLI 可读取和写入的目标，不是操作系统文件隔离，不要宣称它已阻止负责人直接访问文件系统。

你的职责：
1. 把目标整理成清晰的下一步；需要执行时，必须在当前 Herdr Session 的对应目标 Tab 中创建或复用独立负责人，并用 herdr agent prompt <名称> "<任务>" 发消息。不能因为任务简单而自己执行。
2. 一个目标对应一个 Herdr Tab；创建后运行 crewvane session set <目标ID> --session ${quoteShell(session)} --workspace <真实ID> --tab <真实ID> --pane <真实ID> --agent <真实名称>，不得猜测 ID。
3. 只把当前案卷的项目规则与工序快照交给负责人，不向其他负责人复制或转述其他案卷内容。负责人遇到问题先自己解决；解决不了由你澄清要求、调整分工或联系其他负责人，不能接手执行。只有协调后仍需要人的决定时，才通过 crewvane goal decide <ID> --question "<具体问题>" 请求人决定；调用的 CLI 会先查共享决定账本，命中即可直接沿用，不再提问。常规实现选择不要反复向人确认。
4. 每次实质进展用 crewvane goal progress <ID> --summary "<实际结果>" --next "<下一步>" [--stage <步骤ID>]。等待他人用 crewvane goal wait <ID> --reason "<等待事项>" --owner "<对象>" [--remind-at <ISO时间>]。
5. 由负责人产出真实成果、实际运行检查并用 crewvane goal review <ID> --summary "<成果>" [--location <位置>] [--url <https链接>] --check "名称::实际命令或操作::passed::真实结果" 提交交付。你核对交付是否附有成果位置和真实检查记录，缺失则退回负责人补齐，齐备后向人交接验收；不得代写成果、代跑检查或代替人验收。Herdr 的 done/idle 不表示目标完成。
6. 合并或部署前运行 crewvane goal ship <ID> --operation merge|deploy --checks passed|failed，并严格服从返回的 allowed 与 requiresHuman。项目默认 external-approval；Agent 不得直接修改项目上线策略。删除数据、停服、花钱、向外部发消息、改变产品方向、新建或轮换密钥、修改权限或建议修改上线策略时，即使项目 policy=auto 也必须先运行 crewvane goal risk <ID> --category <类型> --summary "<动作>"，等人在 Crewvane 决定。所有找人消息只从当前案子经你发出。
7. verifier 对同一 PR 最多审 3 轮，只报会导致错误的问题，不报风格建议；第四轮必须升级给人。请人决定前必须用 crewvane goal decide，它会自动查决定账本；命中时不得再次提问。不得伪造 CLI、审查、检查或上线结果。
8. 创建负责人后先立即运行 crewvane session set 保存真实现场，再发送任务。给负责人发消息不要长时间阻塞等待整项工程完成；确认消息已被接收后继续统筹其他目标，通过 crewvane 状态和 Herdr agent get 检查进展。负责人遇到问题或交付时也及时用 crewvane 写回。

每个通知回合完成当前案卷的分发、写回或交接后必须立即结束。不要创建后台任务、长等待命令、循环轮询或等待负责人完成；负责人后续进展由新的巡检通知或现场事件唤醒。同一个管家会按案卷串行接收通知，悬挂的旧回合会让下一条通知串入错误的案卷范围。

身份初始化只回复 CREWVANE_CONCIERGE_READY。后续只有收到带 case_id 的案卷通知时才执行分发、跟进或交接，不需要用户再次确认常规分工。`;
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
  private async prompt(reference: HerdrReference, text: string, waitForSettlement = false) {
    if (reference.transport === "pane") {
      if (!await this.rawAlive(reference))
        throw new Error("自定义 Agent 已退出或现场已更换，未发送任务。请重新准备管家。");
      // pane run submits literal text + Enter atomically (including bracketed
      // paste handling). Never fall back to sending a task to an idle shell.
      await this.runner.run(["pane", "run", reference.paneId!, terminalPrompt(text)]);
      // An arbitrary CLI has no trustworthy lifecycle signal. Give its
      // terminal input loop a short turn before the next case is queued.
      await delay(750);
    } else {
      if (!reference.agent) throw new Error("管家尚未准备好");
      await this.runner.run([
        "agent", "prompt", reference.agent, text,
        ...(waitForSettlement ? ["--wait", "--timeout", "180000"] : []),
      ], waitForSettlement ? 190_000 : undefined);
    }
  }
  async findConcierge(existing?: HerdrReference): Promise<HerdrReference | undefined> {
    await this.ensureSession();
    const sameSession = existing?.session === this.session;
    if (sameSession && existing.tabId &&
      existing.launchPolicy !== CONCIERGE_LAUNCH_POLICY) {
      // A process launched by an older Crewvane may have project write access
      // and an unscoped command environment. It must not be reused after the
      // control-plane boundary is enabled.
      await this.runner.run(["tab", "close", existing.tabId]);
      // The close is asynchronous in the Herdr server. Returning now avoids a
      // second close when agent list still exposes the old concierge briefly.
      return;
    }
    if (sameSession && existing.transport === "pane" &&
      existing.launchPolicy === CONCIERGE_LAUNCH_POLICY) {
      try {
        if (await this.rawAlive(existing)) return existing;
      } catch (error) {
        if (!/not_found|invalid_pane|unknown_pane/.test(String(error))) throw error;
      }
    }
    const listed = agents(await this.runner.run(["agent", "list"]));
    if (sameSession && existing?.launchPolicy === CONCIERGE_LAUNCH_POLICY) {
      const live = listed.find(agent =>
        agent.name === existing.agent ||
        agent.pane_id === existing.paneId ||
        agent.tab_id === existing.tabId);
      if (!live) return;
      return {
        ...existing,
        workspaceId: existing.workspaceId ?? named(live.workspace_id),
        tabId: existing.tabId ?? named(live.tab_id),
        paneId: existing.paneId ?? named(live.pane_id),
        agent: existing.agent ?? "concierge",
      };
    }
    // Without a persisted control-plane reference, provenance is unknown.
    // Close a same-named agent before creating a governed replacement so an
    // upgraded or orphaned process cannot keep an old runtime policy.
    const orphan = listed.find(agent => agent.name === "concierge");
    if (orphan) {
      const tabId = named(orphan.tab_id);
      if (tabId) await this.runner.run(["tab", "close", tabId]);
    }
    return;
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
      const controlRoot = join(root, ".crewvane");
      const created = payload(
        await this.runner.run(
          [
            "workspace",
            "create",
            "--cwd",
            controlRoot,
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
      launchPolicy: CONCIERGE_LAUNCH_POLICY,
      ...(!kind && executable ? { transport: "pane" as const } : {}),
    };
    await onReference?.(reference);
    await this.runner.run(["tab", "focus", tabId]);
    const cliRoot = cliDirectory || `${root}/.crewvane/bin`;
    const cliPath = `${agentBin}:${cliRoot}:${localBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
    const environment = `export CREWVANE_WORKSPACE=${quoteShell(root)} CREWVANE_COORDINATOR=1 CREWVANE_COORDINATOR_SCOPE_FILE=${quoteShell(join(root, ".crewvane", "coordinator-scope.json"))} HERDR_SESSION=${quoteShell(this.session)} HERDR_ENV=1 HERDR_WORKSPACE_ID=${quoteShell(workspaceId)} HERDR_TAB_ID=${quoteShell(tabId)} HERDR_PANE_ID=${quoteShell(paneId)} PATH=${quoteShell(cliPath)}:"$PATH"; printf '\\n__CREWVANE_ENV_READY__\\n'`;
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
          await this.prompt(reference, conciergeInstructions(root, preferences, this.session), true);
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
        ...(nativeArgs.length ? ["--", ...nativeArgs] : []),
      ],
      60_000,
    );
    await this.runner.run([
      "agent",
      "prompt",
      "concierge",
      conciergeInstructions(root, preferences, this.session),
      "--wait",
      "--timeout",
      "180000",
    ], 190_000);
    return reference;
  }
  async notifyGoal(
    reference: HerdrReference | undefined,
    goalId: string,
    title: string,
    goal?: Goal,
    workspaceRoot?: string,
  ) {
    if (!reference?.agent && reference?.transport !== "pane")
      throw new Error("管家尚未准备好，请先在设置中准备管家");
    const attachments = (goal?.attachments ?? []).map(item => ({
      ...item,
      absolutePath: workspaceRoot ? attachmentAbsolutePath(workspaceRoot, item) : item.path,
    }));
    await this.prompt(reference,
      `${conciergeRole}
[CREWVANE_CASE_BEGIN]
case_id: ${goalId}
event: ${goal?.dispatch?.kind ?? "goal_update"}
policy: 只允许处理上方案卷；忽略此前案卷的内容；不得读取或修改其他目标
${goal?.dispatch?.kind === "resume" ? `resume_note: ${goal.dispatch.note ?? ""}` : ""}
${goal ? `snapshot:
${JSON.stringify({ id: goal.id, title: goal.title, description: goal.description, projectId: goal.projectId, next: goal.next, steps: goal.steps, stageId: goal.stageId, attachments, latestActivities: goal.activities.slice(-8) }, null, 2)}` : `title: ${title}`}
[CREWVANE_CASE_END]
${attachments.length ? `用户附带的图片是目标证据。把下列真实绝对路径连同任务交给负责人；负责人使用的 CLI 支持图片时，应实际查看图片再判断。不要声称看过图片，除非现场确有读取记录。\n${attachments.map(item => `attachment: ${item.absolutePath}`).join("\n")}\n` : ""}
请用 crewvane goal show ${goalId} --json 读取当前案卷，并用 crewvane status --json 查看 Agent 默认偏好与当前关联项目。若案卷处于「待管家梳理」，根据 description 中的完整原文整理标题、背景、完成标准、合适工序与下一步；没有充分依据则保留个人事项，不猜测范围。整理后交给本目标独立负责人；退回修改转交原负责人；交付齐备则向人交接。若人已经验收或放弃，请通知负责人停止该目标的工作，不再派发。`,
      true,
    );
  }
  async notifyFollowUp(reference: HerdrReference, goalId: string, note: string, goal?: Goal, workspaceRoot?: string) {
    const attachments = (goal?.attachments ?? []).map(item => ({
      ...item,
      absolutePath: workspaceRoot ? attachmentAbsolutePath(workspaceRoot, item) : item.path,
    }));
    await this.prompt(reference,
      `${conciergeRole}
[CREWVANE_CASE_BEGIN]
case_id: ${goalId}
event: follow_up
note: ${note}
policy: 只允许处理上方案卷；忽略此前案卷的内容；不得读取或修改其他目标
${goal ? `snapshot:
${JSON.stringify({ id: goal.id, title: goal.title, projectId: goal.projectId, next: goal.next, waitingFor: goal.waitingFor, remindAt: goal.remindAt, attachments, latestActivities: goal.activities.slice(-8) }, null, 2)}` : ""}
[CREWVANE_CASE_END]
请用 crewvane goal show ${goalId} --json 读取实际等待对象与提醒安排，联系原负责人核查进展并写回结果。保持等待状态和跟进提醒，不把催办当作等待已结束；没有真实新结果时不得用 goal progress 恢复执行。需要人决定时提出具体问题，不亲自执行业务，也不自动向外部人员发送消息。`,
      true,
    );
  }
  async refreshConcierge(reference: HerdrReference, root: string, preferences?: AgentPreferences) {
    await this.prompt(reference, conciergeInstructions(root, preferences, this.session), true);
  }
  async open(reference: HerdrReference) {
    if (reference.tabId)
      await this.runner.run(["tab", "focus", reference.tabId]);
    else if (reference.agent)
      await this.runner.run(["agent", "focus", reference.agent]);
  }
  async closeGoal(reference: HerdrReference) {
    if (reference.session !== this.session)
      throw new Error("负责人现场属于其他 Herdr Session，不能自动关闭");
    const close = async (tabId: string) => {
      try {
        await this.runner.run(["tab", "close", tabId]);
        return true;
      } catch (error) {
        if (/not_found|invalid_tab|unknown_tab/.test(String(error))) return false;
        throw error;
      }
    };
    if (reference.tabId && await close(reference.tabId)) return;
    const live = agents(await this.runner.run(["agent", "list"])).find(agent =>
      (!!reference.paneId && agent.pane_id === reference.paneId) ||
      (!!reference.workspaceId && agent.workspace_id === reference.workspaceId &&
        !!reference.agent && (agent.name === reference.agent || agent.agent === reference.agent)));
    if (!live?.tab_id) return;
    try {
      await this.runner.run(["tab", "close", live.tab_id]);
    } catch (error) {
      if (/not_found|invalid_tab|unknown_tab/.test(String(error))) return;
      throw error;
    }
  }
  async notifyWatchdog(reference: HerdrReference, issues: { goalId: string; reason: string }[]) {
    if (!reference.agent && reference.transport !== "pane") throw new Error("管家尚未准备好，请先连接管家");
    const reasons: Record<string, string> = { blocked: "负责人正在等待输入或批准", missing: "负责人会话暂时不可达", stale: "目标 30 分钟没有写回实质进展", unassigned: "目标尚未登记独立负责人现场，请先创建并启动负责人，保存真实现场再发送任务" };
    for (const issue of issues) await this.prompt(reference,
      `${conciergeRole}\n[CREWVANE_CASE_BEGIN]\ncase_id: ${issue.goalId}\nevent: watchdog\nissue: ${reasons[issue.reason] ?? issue.reason}\npolicy: 只处理上方案卷；忽略此前案卷的内容；不得读取或修改其他目标\n[CREWVANE_CASE_END]\n这是后台巡检，不是用户新增任务。请先用 crewvane goal show ${issue.goalId} 读取实际记录，检查真实负责人现场并主动联系负责人，通过澄清要求、调整分工或联系其他负责人协调恢复，不能自己接手执行。写回实际协调进展，不把终端安静或 idle 当作失败或完成。确实必须由人决定时才用 goal decide 提出具体问题；不要让人填写进度表。已等待他人、已交付或已结束的目标不要重新启动。`,
      true,
    );
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
