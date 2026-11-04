import { WorkspaceService, attentionGoals, type CrewvaneCommand, type HighRiskCategory } from "../../packages/core/src/index.js";
import { readFile, rename, writeFile } from "node:fs/promises";
import { runBoard } from "./board.js";
const usage = `Crewvane — 把所有事整理成清晰的下一步

用法：
  crewvane status [--json]
  crewvane attention [--json]
  crewvane board [--new] [--once]
  crewvane ask TEXT [--project ID]
  crewvane direct TEXT [--new] [--goal ID] [--next TEXT] [--project ID]
  crewvane event herdr [--json]
  crewvane goal list [--all] [--json]
  crewvane goal show ID [--json]
  crewvane goal comment ID --text TEXT
  crewvane goal create --title TEXT [--project ID] [--description TEXT]
    [--workflow ID] [--mode concierge|manual]
  crewvane goal update ID [--title TEXT] [--description TEXT] [--next TEXT]
    [--owner TEXT] [--stage ID] [--status active|waiting] [--remind-at ISO]
  crewvane goal progress ID --summary TEXT [--next TEXT] [--stage ID] [--owner NAME]
  crewvane goal wait ID --reason TEXT [--owner TEXT] [--remind-at ISO]
  crewvane goal decide ID --question TEXT [--next TEXT] [--key KEY]
  crewvane goal risk ID --category CATEGORY --summary TEXT [--key KEY]
  crewvane goal ship ID --operation merge|deploy --checks passed|failed
  crewvane goal review ID --summary TEXT [--location TEXT] [--url URL]
    --check "名称::命令或操作::passed::说明"（可重复）
  crewvane goal accept ID [--note TEXT]
  crewvane goal rework ID --note TEXT
  crewvane goal resolve ID --note TEXT [--outcome approved|rejected]
  crewvane goal drop ID --reason TEXT
  crewvane goal remind ID --at ISO [--note TEXT]
  crewvane session set [ID] [--workspace ID] [--tab ID] [--pane ID] [--agent NAME]
    [--transport pane --process-id PID]（自定义 CLI）
  crewvane workflow list [--json]

使用 --root DIR 或 CREWVANE_WORKSPACE 指定工作区。所有读写与桌面共用状态。
高风险动作类别：delete-data、stop-service、spend-money、external-message、
product-direction、create-secret、rotate-secret、change-permissions、change-ship-policy。
goal ship 只按项目策略给出放行或审批判断；外部动作仍由负责人执行并核实。
`;
function parse(argv: string[]) {
  const positional: string[] = [], values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    if (!name) throw new Error("无效参数");
    if (["json", "all", "help", "new", "once", "current"].includes(name)) { values.set(name, ["true"]); continue; }
    const value = inline ?? argv[++index];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new Error(`--${name} 需要一个值`);
    if (values.has(name) && name !== "check") throw new Error(`--${name} 不能重复`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { positional, one: (name: string) => values.get(name)?.[0], all: (name: string) => values.get(name) ?? [], has: (name: string) => values.has(name) };
}
function checks(values: string[]) {
  if (!values.length) throw new Error("至少提供一个 --check，记录实际运行的检查");
  return values.map((value) => {
    const [name, command, result, ...note] = value.split("::");
    if (!name || !command || !["passed", "failed"].includes(result ?? "")) throw new Error("--check 格式：名称::命令或操作::passed|failed::说明");
    return { name, command, result: result as "passed" | "failed", ...(note.length ? { note: note.join("::") } : {}) };
  });
}
function textArg(value: string | undefined, label: string) {
  if (!value?.trim()) throw new Error(`${label} 不能为空`);
  return value.trim();
}
async function coordinatorCaseId(allowMissing = false) {
  if (process.env.CREWVANE_COORDINATOR !== "1") return;
  const file = process.env.CREWVANE_COORDINATOR_SCOPE_FILE;
  if (!file) throw new Error("管家缺少当前案卷范围，请重新准备管家");
  const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === "ENOENT") return;
    if (error.code === "ENOENT")
      throw new Error("管家当前没有案卷范围；只有 crewvane direct --new 可以直接建立新目标");
    throw error;
  });
  if (!raw) return;
  const value = JSON.parse(raw) as { goalId?: unknown };
  if (typeof value.goalId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.goalId))
    throw new Error("管家当前案卷范围无效，请重新准备管家");
  return value.goalId;
}
async function advanceCoordinatorCase(goal: { id: string; dispatch?: { id?: string } }) {
  const file = process.env.CREWVANE_COORDINATOR_SCOPE_FILE;
  if (!file) throw new Error("管家缺少案卷范围文件，无法继续直接新建的目标");
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    goalId: goal.id,
    requestId: goal.dispatch?.id,
    setAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
function assertCoordinatorCase(caseId: string, target: string | undefined) {
  if (!target) throw new Error("管家操作必须指定当前案卷目标 ID");
  if (target !== caseId) throw new Error(`管家当前只处理目标 ${caseId}，不能读取或修改其他目标`);
}
function herdrLiveEvent() {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!raw) throw new Error("缺少 Herdr 插件事件");
  let value: any;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Herdr 插件事件不是有效 JSON"); }
  const data = value?.data;
  if (!data || typeof data !== "object") throw new Error("Herdr 插件事件缺少 data");
  const rawKind = String(value.event ?? value.type ?? "").trim();
  const legacyKinds: Record<string, string> = {
    pane_agent_status_changed: "pane.agent_status_changed",
    pane_exited: "pane.exited",
    pane_closed: "pane.closed",
    pane_moved: "pane.moved",
    tab_closed: "tab.closed",
    workspace_closed: "workspace.closed",
  };
  const kind = legacyKinds[rawKind] ?? rawKind;
  const targetId = (name: "pane" | "tab" | "workspace") => {
    const id = data[`${name}_id`];
    if (typeof id !== "string" || !id)
      throw new Error(`Herdr 插件事件缺少有效 ${name === "pane" ? "Pane" : name === "tab" ? "Tab" : "Workspace"} ID`);
    return id;
  };
  const paneId = typeof data.pane_id === "string" ? data.pane_id : "";
  const workspaceId = typeof data.workspace_id === "string" ? data.workspace_id : undefined;
  const checkedAt = new Date().toISOString();
  if (kind === "pane.agent_status_changed") {
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(paneId))
      throw new Error("Herdr 插件事件缺少有效 Pane ID");
    const state = typeof data.agent_status === "string" ? data.agent_status.toLowerCase() : "";
    if (!["working", "idle", "done", "blocked", "unknown"].includes(state))
      throw new Error("Herdr 插件事件包含无效 Agent 状态");
    return {
      target: { paneId, ...(workspaceId ? { workspaceId } : {}) },
      presence: { state: state as "working" | "idle" | "done" | "blocked" | "unknown", checkedAt, reachable: true },
    };
  }
  if (kind === "pane.exited" || kind === "pane.closed") {
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(paneId))
      throw new Error("Herdr 插件事件缺少有效 Pane ID");
    return {
      target: { paneId, ...(workspaceId ? { workspaceId } : {}) },
      presence: { state: "unknown" as const, checkedAt, reachable: false },
    };
  }
  if (kind === "pane.moved") {
    const previousPaneId = typeof data.previous_pane_id === "string" ? data.previous_pane_id : "";
    const previousWorkspaceId = typeof data.previous_workspace_id === "string" ? data.previous_workspace_id : undefined;
    const pane = data.pane;
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(previousPaneId) ||
      !pane || typeof pane !== "object")
      throw new Error("Herdr 插件事件缺少有效的 Pane 移动信息");
    const newPaneId = typeof pane.pane_id === "string" ? pane.pane_id : "";
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(newPaneId))
      throw new Error("Herdr 插件事件缺少有效的新 Pane ID");
    const status = typeof pane.agent_status === "string" ? pane.agent_status.toLowerCase() : "unknown";
    if (!["working", "idle", "done", "blocked", "unknown"].includes(status))
      throw new Error("Herdr 插件事件包含无效 Agent 状态");
    return {
      target: { paneId: previousPaneId, ...(previousWorkspaceId ? { workspaceId: previousWorkspaceId } : {}) },
      reference: {
        paneId: newPaneId,
        ...(typeof pane.workspace_id === "string" ? { workspaceId: pane.workspace_id } : {}),
        ...(typeof pane.tab_id === "string" ? { tabId: pane.tab_id } : {}),
        ...(typeof pane.agent === "string" ? { agent: pane.agent } : {}),
      },
      presence: {
        state: status as "working" | "idle" | "done" | "blocked" | "unknown",
        checkedAt, reachable: true,
      },
    };
  }
  if (kind === "tab.closed")
    return {
      target: { tabId: targetId("tab"), ...(workspaceId ? { workspaceId } : {}) },
      presence: { state: "unknown" as const, checkedAt, reachable: false },
    };
  if (kind === "workspace.closed")
    return {
      target: { workspaceId: targetId("workspace") },
      presence: { state: "unknown" as const, checkedAt, reachable: false },
    };
  throw new Error(`不支持的 Herdr 插件事件：${kind}`);
}
export async function run(argv: string[], io = { out: console.log, error: console.error }): Promise<number> {
  try {
    const args = parse(argv), [group, action, target] = args.positional;
    if (args.has("help") || !group) { io.out(usage); return 0; }
    const service = new WorkspaceService(args.one("root") ?? (process.env.CREWVANE_WORKSPACE?.trim() || process.cwd())),
      coordinatorMode = process.env.CREWVANE_COORDINATOR === "1",
      coordinatorCase = await coordinatorCaseId(group === "direct" && args.has("new"));
    if (group === "board" && !coordinatorCase) {
      await runBoard(service, io, { once: args.has("once"), startWithNewGoal: args.has("new") });
      return 0;
    }
    let command: CrewvaneCommand | undefined, result: unknown, coordinatorRead = false;
    if (coordinatorMode && !coordinatorCase) {
      if (group !== "direct" || !args.has("new"))
        throw new Error("管家当前没有案卷范围；只有 crewvane direct --new 可以直接建立新目标");
    } else if (coordinatorCase) {
      if (group === "status") {
        const state = await service.read(), goal = state.goals.find(item => item.id === coordinatorCase);
        if (!goal) throw new Error("当前案卷不存在或已结束");
        result = { name: state.name, agents: state.agents ?? { concierge: "codex" },
          project: state.projects.find(project => project.id === goal.projectId) };
        coordinatorRead = true;
      } else if (group === "workflow" && action === "list") {
        result = (await service.read()).workflows;
        coordinatorRead = true;
      }
      else if (group === "goal" && action === "show") {
        const goalId = target ?? args.one("id");
        assertCoordinatorCase(coordinatorCase, goalId);
        result = (await service.read()).goals.find(goal => goal.id === goalId);
        if (!result) throw new Error("找不到当前案卷");
        coordinatorRead = true;
      } else if (group === "goal" && ["update", "progress", "wait", "decide", "risk", "ship"].includes(action ?? "")) {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "session" && action === "set") {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "direct") {
        if (args.has("new") && args.one("goal"))
          throw new Error("--new 不能与 --goal 同时使用");
        if (args.has("current") && (args.has("new") || args.one("goal")))
          throw new Error("--current 不能与 --new 或 --goal 同时使用");
        if (!args.has("new"))
          assertCoordinatorCase(coordinatorCase, args.one("goal") ?? coordinatorCase);
      } else throw new Error("管家当前只能查看或更新自己的案卷，不能执行该命令");
    }
    if (!coordinatorRead) {
      if (group === "status") result = await service.read();
      else if (group === "attention") result = attentionGoals((await service.read()).goals);
      else if (group === "workflow" && action === "list") result = (await service.read()).workflows;
      else if (group === "ask") command = { type: "goal.intake", text: args.positional.slice(1).join(" "), projectId: args.one("project") };
      else if (group === "direct") {
        const directText = args.positional.slice(1).join(" ").trim();
        if (!directText) throw new Error("需要一个要同步给管家的终端消息");
        if (args.has("new") && args.one("goal"))
          throw new Error("--new 不能与 --goal 同时使用");
        if (args.has("current") && (args.has("new") || args.one("goal")))
          throw new Error("--current 不能与 --new 或 --goal 同时使用");
        if (args.has("current") && !coordinatorCase)
          throw new Error("--current 只能由当前受管管家使用");
        command = {
          type: "goal.direct",
          text: directText,
          goalId: args.has("new") ? undefined
            : args.has("current") ? coordinatorCase : args.one("goal") ?? coordinatorCase,
          next: args.one("next"),
          projectId: args.one("project"),
        };
      }
      else if (group === "event" && action === "herdr") {
        const event = herdrLiveEvent();
        result = await service.execute({ type: "live.event", ...event });
      }
      else if (group === "goal" && action === "list") { const state = await service.read(); result = args.has("all") ? state.goals : state.goals.filter((goal) => !["completed", "dropped"].includes(goal.status)); }
      else if (group === "goal" && action === "show") { const goalId = target ?? args.one("id"); if (!goalId) throw new Error("需要目标 ID"); result = (await service.read()).goals.find((goal) => goal.id === goalId); if (!result) throw new Error("找不到目标"); }
      else if (group === "goal" && action === "create") command = { type: "goal.create", input: { title: args.one("title")!, projectId: args.one("project") ?? "personal", description: args.one("description"), workflowId: args.one("workflow"), mode: (args.one("mode") ?? "concierge") as "concierge" | "manual", next: args.one("next"), waitingFor: args.one("owner"), remindAt: args.one("remind-at") } };
      else if (group === "goal" && action === "update") command = { type: "goal.update", goalId: target!, patch: {
        title: args.one("title"), description: args.one("description"), next: args.one("next"),
        owner: args.one("owner"), stageId: args.one("stage"),
        status: args.one("status") as "active" | "waiting" | undefined,
        remindAt: args.one("remind-at"),
      } };
      else if (group === "goal" && action === "progress") command = { type: "goal.progress", goalId: target!, summary: args.one("summary")!, next: args.one("next"), stageId: args.one("stage"), actor: args.one("actor") ?? args.one("owner") };
      else if (group === "goal" && action === "comment") {
        const comment = textArg(args.one("text") ?? args.one("summary"), "--text");
        command = { type: "goal.progress", goalId: target!, summary: `补充意见：${comment}`, actor: "你" };
      }
      else if (group === "goal" && action === "wait") command = { type: "goal.wait", goalId: target!, reason: args.one("reason")!, owner: args.one("owner"), remindAt: args.one("remind-at"), actor: args.one("actor") };
      else if (group === "goal" && action === "decide") command = { type: "goal.decide", goalId: target!, question: args.one("question")!, next: args.one("next"), actor: args.one("actor"), key: args.one("key") };
      else if (group === "goal" && action === "risk") command = {
        type: "goal.risk", goalId: target!, category: args.one("category") as HighRiskCategory,
        summary: args.one("summary")!, actionKey: args.one("key"), actor: args.one("actor"),
      };
      else if (group === "goal" && action === "ship") {
        const checksPassed = args.one("checks");
        if (checksPassed !== "passed" && checksPassed !== "failed")
          throw new Error("--checks 必须是 passed 或 failed");
        command = {
          type: "goal.ship", goalId: target!, operation: args.one("operation") as "merge" | "deploy",
          checksPassed: checksPassed === "passed", actor: args.one("actor"),
        };
      }
      else if (group === "goal" && action === "review") command = { type: "goal.review", goalId: target!, delivery: { summary: args.one("summary")!, location: args.one("location"), url: args.one("url"), checks: checks(args.all("check")) }, actor: args.one("actor") };
      else if (group === "goal" && ["accept", "rework", "drop"].includes(action ?? "")) command = { type: `goal.${action}` as "goal.accept", goalId: target!, note: args.one("note") ?? args.one("reason") ?? "", actor: args.one("actor") };
      else if (group === "goal" && action === "resolve") command = {
        type: "goal.resolve", goalId: target!, note: args.one("note") ?? args.one("reason"), actor: args.one("actor"),
        outcome: (args.one("outcome") ?? "approved") as "approved" | "rejected",
        source: "cli",
      };
      else if (group === "goal" && action === "remind") command = { type: "goal.remind", goalId: target!, at: args.one("at")!, note: args.one("note") };
      else if (group === "session" && action === "set") command = { type: "session.set", goalId: target, reference: { session: args.one("session") ?? process.env.HERDR_SESSION ?? "crewvane", workspaceId: args.one("workspace"), tabId: args.one("tab"), paneId: args.one("pane"), agent: args.one("agent"),
        ...(args.has("transport") ? { transport: args.one("transport") as "pane", processId: Number(args.one("process-id")) } : {}) } };
      else throw new Error(`不支持的命令：${args.positional.join(" ")}\n\n${usage}`);
    }
    if (command) result = await service.execute(command);
    if (coordinatorMode && group === "direct" && args.has("new") && command?.type === "goal.direct")
      await advanceCoordinatorCase(result as import("../../packages/core/src/index.js").Goal);
    if (args.has("json")) io.out(JSON.stringify(result, null, 2));
    else if (group === "status" && coordinatorRead) {
      const current = result as { name: string; project?: { name?: string } };
      io.out(`${current.name} · ${current.project?.name ?? "个人事项"} · 当前案卷`);
    }
    else if (group === "event" && action === "herdr") {
      const current = result as { matched: number };
      io.out(current.matched ? `已同步 ${current.matched} 个目标的现场状态。` : "没有需要同步的 Crewvane 目标。");
    }
    else if (group === "goal" && action === "show") { const goal = result as import("../../packages/core/src/index.js").Goal; io.out(`${goal.title}\n${goal.status} · ${goal.next}\n\n${goal.description}`); }
    else if (Array.isArray(result)) io.out(result.length ? result.map((item) => `${item.id}  ${item.title ?? item.name}  ${item.next ?? ""}`).join("\n") : "暂无记录");
    else if (group === "status") { const state = result as import("../../packages/core/src/index.js").WorkspaceState; io.out(`${state.name} · ${state.goals.filter((goal) => !["completed", "dropped"].includes(goal.status)).length} 个进行中目标 · ${attentionGoals(state.goals).length} 项需要处理`); }
    else { const goal = result as import("../../packages/core/src/index.js").Goal; io.out(goal?.id ? `${goal.id} · ${goal.status}\n${goal.next}` : JSON.stringify(result)); }
    return 0;
  } catch (error) { io.error(`crewvane: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
