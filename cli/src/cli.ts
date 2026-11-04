import { WorkspaceService, attentionGoals, type CrewvaneCommand } from "../../packages/core/src/index.js";
const usage = `Crewvane — 把所有事整理成清晰的下一步

用法：
  crewvane status [--json]
  crewvane attention [--json]
  crewvane goal list [--all] [--json]
  crewvane goal show ID [--json]
  crewvane goal create --title TEXT --project ID [--description TEXT]
    [--workflow ID] [--mode concierge|manual]
  crewvane goal update ID [--title TEXT] [--description TEXT] [--next TEXT]
    [--owner TEXT] [--stage ID] [--status active|waiting] [--remind-at ISO]
  crewvane goal progress ID --summary TEXT [--next TEXT] [--stage ID] [--owner NAME]
  crewvane goal wait ID --reason TEXT [--owner TEXT] [--remind-at ISO]
  crewvane goal decide ID --question TEXT [--next TEXT]
  crewvane goal review ID --summary TEXT [--location TEXT] [--url URL]
    --check "名称::命令或操作::passed::说明"（可重复）
  crewvane goal accept ID [--note TEXT]
  crewvane goal rework ID --note TEXT
  crewvane goal resolve ID --note TEXT
  crewvane goal drop ID --reason TEXT
  crewvane goal remind ID --at ISO [--note TEXT]
  crewvane session set [ID] [--workspace ID] [--tab ID] [--pane ID] [--agent NAME]
    [--transport pane --process-id PID]（自定义 CLI）
  crewvane workflow list [--json]

使用 --root DIR 或 CREWVANE_WORKSPACE 指定工作区。所有读写与桌面共用状态。
goal accept 仅结束 Crewvane 目标，不合并代码、不部署。
`;
function parse(argv: string[]) {
  const positional: string[] = [], values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    if (!name) throw new Error("无效参数");
    if (name === "json" || name === "all" || name === "help") { values.set(name, ["true"]); continue; }
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
export async function run(argv: string[], io = { out: console.log, error: console.error }): Promise<number> {
  try {
    const args = parse(argv), [group, action, target] = args.positional;
    if (args.has("help") || !group) { io.out(usage); return 0; }
    const service = new WorkspaceService(args.one("root") ?? process.env.CREWVANE_WORKSPACE ?? process.cwd());
    let command: CrewvaneCommand | undefined, result: unknown;
    if (group === "status") result = await service.read();
    else if (group === "attention") result = attentionGoals((await service.read()).goals);
    else if (group === "workflow" && action === "list") result = (await service.read()).workflows;
    else if (group === "goal" && action === "list") { const state = await service.read(); result = args.has("all") ? state.goals : state.goals.filter((goal) => !["completed", "dropped"].includes(goal.status)); }
    else if (group === "goal" && action === "show") { const goalId = target ?? args.one("id"); if (!goalId) throw new Error("需要目标 ID"); result = (await service.read()).goals.find((goal) => goal.id === goalId); if (!result) throw new Error("找不到目标"); }
    else if (group === "goal" && action === "create") command = { type: "goal.create", input: { title: args.one("title")!, projectId: args.one("project")!, description: args.one("description"), workflowId: args.one("workflow"), mode: (args.one("mode") ?? "concierge") as "concierge" | "manual", next: args.one("next"), waitingFor: args.one("owner"), remindAt: args.one("remind-at") } };
    else if (group === "goal" && action === "update") command = { type: "goal.update", goalId: target!, patch: {
      title: args.one("title"), description: args.one("description"), next: args.one("next"),
      owner: args.one("owner"), stageId: args.one("stage"),
      status: args.one("status") as "active" | "waiting" | undefined,
      remindAt: args.one("remind-at"),
    } };
    else if (group === "goal" && action === "progress") command = { type: "goal.progress", goalId: target!, summary: args.one("summary")!, next: args.one("next"), stageId: args.one("stage"), actor: args.one("actor") ?? args.one("owner") };
    else if (group === "goal" && action === "wait") command = { type: "goal.wait", goalId: target!, reason: args.one("reason")!, owner: args.one("owner"), remindAt: args.one("remind-at"), actor: args.one("actor") };
    else if (group === "goal" && action === "decide") command = { type: "goal.decide", goalId: target!, question: args.one("question")!, next: args.one("next"), actor: args.one("actor") };
    else if (group === "goal" && action === "review") command = { type: "goal.review", goalId: target!, delivery: { summary: args.one("summary")!, location: args.one("location"), url: args.one("url"), checks: checks(args.all("check")) }, actor: args.one("actor") };
    else if (group === "goal" && ["accept", "resolve", "rework", "drop"].includes(action ?? "")) command = { type: `goal.${action}` as "goal.accept", goalId: target!, note: args.one("note") ?? args.one("reason") ?? "", actor: args.one("actor") };
    else if (group === "goal" && action === "remind") command = { type: "goal.remind", goalId: target!, at: args.one("at")!, note: args.one("note") };
    else if (group === "session" && action === "set") command = { type: "session.set", goalId: target, reference: { session: args.one("session") ?? process.env.HERDR_SESSION ?? "crewvane", workspaceId: args.one("workspace"), tabId: args.one("tab"), paneId: args.one("pane"), agent: args.one("agent"),
      ...(args.has("transport") ? { transport: args.one("transport") as "pane", processId: Number(args.one("process-id")) } : {}) } };
    else throw new Error(`不支持的命令：${args.positional.join(" ")}\n\n${usage}`);
    if (command) result = await service.execute(command);
    if (args.has("json")) io.out(JSON.stringify(result, null, 2));
    else if (group === "goal" && action === "show") { const goal = result as import("../../packages/core/src/index.js").Goal; io.out(`${goal.title}\n${goal.status} · ${goal.next}\n\n${goal.description}`); }
    else if (Array.isArray(result)) io.out(result.length ? result.map((item) => `${item.id}  ${item.title ?? item.name}  ${item.next ?? ""}`).join("\n") : "暂无记录");
    else if (group === "status") { const state = result as import("../../packages/core/src/index.js").WorkspaceState; io.out(`${state.name} · ${state.goals.filter((goal) => !["completed", "dropped"].includes(goal.status)).length} 个进行中目标 · ${attentionGoals(state.goals).length} 项需要处理`); }
    else { const goal = result as import("../../packages/core/src/index.js").Goal; io.out(goal?.id ? `${goal.id} · ${goal.status}\n${goal.next}` : JSON.stringify(result)); }
    return 0;
  } catch (error) { io.error(`crewvane: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
