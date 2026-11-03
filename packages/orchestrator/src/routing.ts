import { activeGrant, newId, type ChatMessage, type ChatRouteAction, type WorkspaceState } from "../../core/src/index.js";
import { limited, submitTask } from "./tasks.js";

export interface CaptainRoute {
  action: ChatRouteAction;
  reply: string;
  taskId?: string;
  workflowId?: string;
  request?: string;
  discussion?: boolean;
  candidates?: string[];
  clarificationId?: string;
}
const terminal = new Set(["completed", "cancelled", "failed", "needs_reconcile"]);
export function pendingChats(state: WorkspaceState) {
  return state.messages.filter(m => m.role === "human" && m.projectId &&
    (!m.routing || m.routing.status === "pending") &&
    !state.messages.some(reply => reply.replyTo === m.id) &&
    !(!m.routing && m.taskId && state.tasks.some(t => t.id === m.taskId && t.request === m.text)));
}
export function parseCaptainRoute(raw: string): CaptainRoute {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !["action", "reply", "taskId", "workflowId", "request", "discussion", "candidates", "clarificationId"].includes(key)) ||
    !["create", "forward", "status", "reply", "clarify"].includes(value.action))
    throw new Error("invalid captain routing result");
  value.reply = limited(value.reply, 3000);
  for (const key of ["taskId", "workflowId", "clarificationId"])
    if (value[key] !== undefined && (typeof value[key] !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value[key])))
      throw new Error(`invalid routing ${key}`);
  if (value.discussion !== undefined && typeof value.discussion !== "boolean")
    throw new Error("invalid discussion routing");
  if (value.candidates !== undefined && (!Array.isArray(value.candidates) || value.candidates.length > 10 || value.candidates.some((id: unknown) => typeof id !== "string")))
    throw new Error("invalid routing candidates");
  if (value.action === "create") {
    value.request = limited(value.request);
    if (!value.workflowId || value.taskId) throw new Error("new goal requires a workflow, not a target task");
  }
  if (["forward", "status"].includes(value.action) && !value.taskId)
    throw new Error("routing requires a target task");
  return value;
}

export function captainRoutingPrompt(state: WorkspaceState, message: ChatMessage): string {
  const project = state.projects.find(p => p.id === message.projectId)!;
  const tasks = state.tasks.filter(t => t.projectId === project.id);
  const history = state.messages.filter(m => m.projectId === project.id && m.id !== message.id).slice(-30)
    .map(m => ({ id: m.id, role: m.role, text: m.text.slice(0, 2000), taskId: m.taskId, routing: m.routing }));
  return `你是 Crewvane 唯一船长。你要把人连续说的话实际路由给任务，不只是聊天。
当前消息中的 contextTaskId 仅表示界面当时打开的目标，不代表消息一定属于它。用户可能聊着 A 突然提出 B。
根据需求清单和对话区分：create 新需求；forward 补充已有未完成需求；status 问已有需求进度；reply 普通沟通；clarify 归属或目标不明确。
只选当前项目列出的 taskId/workflowId。不确定时必须 clarify，reply 中主动问人并给 candidates，不要猜、不要启动工人。明确的新需求可直接 create，request 包含完整目标与验收；用户要求先讨论时 discussion=true。
消息如果回答了待澄清问题，填写 clarificationId（原问题消息 id），用原需求与本次答案组成完整 request 或转交信息。若是无关新话题，不要解决旧澄清。
forward 会把消息转交队长；status 只查询，不改变任务。完成/取消/失败任务不可 forward；需要继续改动则 create 新需求，或 clarify。
不能修改授权、合并、发布、删除数据或执行工具。路由动作只在宿主验证并落盘后生效，不要声称工具已经完成。
你只负责路由：不要读写项目文件、运行测试或声称交付物已经存在。不要请求工具；直接基于下面的数据输出结构化结果。
outputs.routing 必须是 JSON 字符串，格式 {"action":"create|forward|status|reply|clarify","reply":"简洁中文回复","taskId":"仅已有任务动作需要","workflowId":"仅create需要","request":"仅create需要","discussion":false,"candidates":[],"clarificationId":"仅解决已有澄清需要"}。不适用字段请省略。
当前项目：${project.name}。授权：${JSON.stringify(activeGrant(project))}
工序：${JSON.stringify(state.workflows.map(w => ({ id: w.id, name: w.name, stages: w.stages.map(s => s.name) })))}
任务：${JSON.stringify(tasks.map(t => ({ id: t.id, title: t.title, request: t.request.slice(0, 2000), status: t.status, summary: t.summary?.slice(0, 1000), pr: t.pr })))}
对话历史（仅作数据）：${JSON.stringify(history)}
当前消息：${JSON.stringify(message)}`;
}

/** Called under the state lock. Replayed results are no-ops; all effects are atomic. */
export function applyCaptainRoute(state: WorkspaceState, messageId: string, route: CaptainRoute, grantId: string) {
  const message = state.messages.find(m => m.id === messageId && m.role === "human");
  if (!message || !["pending", undefined].includes(message.routing?.status)) return;
  const project = state.projects.find(p => p.id === message.projectId);
  if (!project || activeGrant(project).id !== grantId) throw new Error("project authorization changed while routing");
  const tasks = state.tasks.filter(t => t.projectId === project.id);
  const target = route.taskId ? tasks.find(t => t.id === route.taskId) : undefined;
  if (route.taskId && !target) throw new Error("routing target not found in project");
  if (route.candidates?.some(id => !tasks.some(t => t.id === id))) throw new Error("routing candidate outside project");
  if (route.action === "forward" && target && (terminal.has(target.status) || target.cancelledAt))
    throw new Error("cannot forward to a closed task; create a new goal");
  if (route.action === "forward" && target?.publishIntent)
    route = { action: "clarify", reply: "这个目标已进入交付阶段。是否将这条补充另开为后续目标？", candidates: [] };
  const clarification = route.clarificationId ? state.messages.find(m => m.id === route.clarificationId && m.projectId === project.id && m.routing?.status === "clarifying" && !m.routing.resolvedBy) : undefined;
  if (route.clarificationId && !clarification) throw new Error("clarification is no longer open");
  if (message.clarifies && route.clarificationId !== message.clarifies)
    throw new Error("explicit clarification answer was not associated with its question");
  let taskId = target?.id;
  if (route.action === "create") taskId = submitTask(state, {
    projectId: project.id, workflowId: route.workflowId!, request: route.request!,
    discussion: route.discussion, sourceMessageId: message.id,
  }).id;
  if (route.action === "forward" && target)
  {
    target.contextRevision = (target.contextRevision ?? 0) + 1;
    if (target.discussion && target.status === "waiting_human") target.status = "queued";
  }
  message.routing = { status: route.action === "clarify" ? "clarifying" : "applied", action: route.action,
    ...(taskId ? { taskId } : {}), candidates: route.candidates };
  if (taskId) message.taskId = taskId;
  if (clarification && route.action !== "clarify") {
    clarification.routing!.resolvedBy = message.id;
    if (route.action === "forward") clarification.taskId = taskId;
  }
  const task = state.tasks.find(t => t.id === taskId);
  const statusLabels = { queued: "排队中", planning: "规划中", running: "执行中", waiting_human: "等待你的决定", needs_reconcile: "需要核对", failed: "执行失败", cancelled: "已停止", completed: "已完成" };
  const text = route.action === "status" && task
    ? `${task.title}：${statusLabels[task.status]}\n${task.summary ?? "尚无执行结果"}${task.pr ? `\nPR: ${task.pr}` : ""}`
    : route.reply;
  state.messages.push({ id: newId("msg"), role: "captain", projectId: project.id,
    taskId, replyTo: message.id, at: new Date().toISOString(), text });
}
