import { WorkspaceStore, newId } from "./store.js";
import type { CrewvaneCommand, Goal, WorkflowStep } from "./types.js";
import { inspectWatchdog, reportWatchdog } from "./watchdog.js";
export const nowIso = () => new Date().toISOString();
function text(value: unknown, label: string, limit = 20_000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > limit ||
    value.includes("\0")
  )
    throw new Error(`请提供有效的${label}`);
  return value.trim();
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error("无效的记录 ID");
  return value;
}
function iso(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("请提供有效的 ISO 时间");
  return new Date(value).toISOString();
}
function steps(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30)
    throw new Error("工序至少需要一步");
  if (new Set(value.map((step) => step.id)).size !== value.length)
    throw new Error("工序步骤 ID 不能重复");
  return value.map((step) => ({
    id: id(step.id),
    name: text(step.name, "工序名称", 100),
    prompt: text(step.prompt, "提示词", 12_000),
  }));
}
function ongoing(item: Goal, allowReview = false) {
  if (["completed", "dropped"].includes(item.status))
    throw new Error("已结束的目标不能继续修改");
  if (item.status === "review" && !allowReview)
    throw new Error("目标正在等待验收，请先验收或退回修改");
}
export { attentionGoals, attentionKind } from "./model.js";
export class WorkspaceService {
  readonly store: WorkspaceStore;
  constructor(readonly root: string) {
    this.store = new WorkspaceStore(root);
  }
  async read() {
    return this.store.read();
  }
  async execute(command: CrewvaneCommand): Promise<unknown> {
    if (
      !command ||
      typeof command !== "object" ||
      typeof command.type !== "string"
    )
      throw new Error("无效的命令");
    if (command.type === "snapshot") return this.store.read();
    return this.store.update(command.type, async (state) => {
      const goal = (goalId: string) => {
        const found = state.goals.find((item) => item.id === id(goalId));
        if (!found) throw new Error("找不到目标");
        return found;
      };
      const stamp = (item: Goal) => {
        item.updatedAt = nowIso();
      };
      const activity = (
        item: Goal,
        kind: Goal["activities"][number]["kind"],
        body: string,
        actor = "你",
      ) => {
        item.activities.push({
          id: newId("act"),
          at: nowIso(),
          actor,
          kind,
          text: text(body, "记录", 12_000),
        });
        stamp(item);
      };
      switch (command.type) {
        case "workspace.rename":
          state.name = text(command.name, "工作区名称", 80);
          return state.name;
        case "agents.configure": {
          const startup = (value: unknown) => {
            if (typeof value !== "string" || !value.trim() || value.length > 2000 || /[\x00-\x1f\x7f;&|<>`$]/.test(value)) throw new Error("无效的 Agent 启动命令：请使用单行 CLI 命令与参数，不支持 shell 表达式");
            return value.trim();
          };
          state.agents = {
            concierge: startup(command.preferences.concierge),
            ...(command.preferences.owner?.trim() ? { owner: startup(command.preferences.owner) } : {}),
            ...(command.preferences.worker?.trim() ? { worker: startup(command.preferences.worker) } : {}),
          };
          return state.agents;
        }
        case "project.add": {
          const name = text(command.name, "项目名称", 100);
          if (state.projects.some((p) => p.name === name))
            throw new Error("已有同名项目");
          const project = {
            id: newId("project"),
            name,
            ...(command.path
              ? { path: text(command.path, "项目路径", 1000) }
              : {}),
            createdAt: nowIso(),
          };
          state.projects.push(project);
          return project;
        }
        case "project.remove": {
          if (command.projectId === "personal")
            throw new Error("个人事项不能删除");
          if (state.goals.some((g) => g.projectId === command.projectId))
            throw new Error("项目仍有目标，请先完成或放弃这些目标");
          state.projects = state.projects.filter(
            (p) => p.id !== id(command.projectId),
          );
          return true;
        }
        case "workflow.save": {
          const workflow = {
            id: id(command.workflow.id),
            name: text(command.workflow.name, "工序名称", 100),
            steps: steps(command.workflow.steps),
          };
          const index = state.workflows.findIndex((w) => w.id === workflow.id);
          if (index < 0) state.workflows.push(workflow);
          else state.workflows[index] = workflow;
          return workflow;
        }
        case "goal.create": {
          const input = command.input;
          if (!input || !["concierge", "manual"].includes(input.mode))
            throw new Error("无效的目标");
          const project = state.projects.find(
            (p) => p.id === id(input.projectId),
          );
          if (!project) throw new Error("请选择有效项目");
          const workflow =
            state.workflows.find((w) => w.id === input.workflowId) ??
            state.workflows[0];
          if (
            input.workflowId &&
            !state.workflows.some((w) => w.id === input.workflowId)
          )
            throw new Error("找不到所选工序");
          if (!workflow) throw new Error("请先创建工序");
          const at = nowIso();
          const item: Goal = {
            id: newId("goal"),
            projectId: project.id,
            title: text(input.title, "目标", 160),
            description: text(
              input.description || "由管家进一步梳理目标与完成标准。",
              "目标说明",
            ),
            mode: input.mode,
            status: input.mode === "manual" ? "waiting" : "active",
            steps: steps(workflow.steps),
            stageId: workflow.steps[0]?.id,
            next:
              input.next?.trim() ||
              (input.mode === "concierge"
                ? "管家正在理解目标并安排下一步。"
                : "补充下一步和跟进时间，或交给管家继续处理。"),
            owner:
              input.mode === "concierge"
                ? "待分配负责人"
                : text(input.waitingFor || "你", "等待对象", 120),
            ...(input.waitingFor
              ? { waitingFor: text(input.waitingFor, "等待对象", 120) }
              : {}),
            ...(input.remindAt ? { remindAt: iso(input.remindAt) } : {}),
            attention: null,
            activities: [
              {
                id: newId("act"),
                at,
                actor: "你",
                kind: "created",
                text:
                  input.mode === "concierge"
                    ? "已交给管家统筹。"
                    : "已记录，由你安排下一步。",
              },
            ],
            createdAt: at,
            updatedAt: at,
          };
          state.goals.push(item);
          return item;
        }
        case "goal.update": {
          const item = goal(command.goalId);
          ongoing(item, true);
          for (const field of [
            "title",
            "description",
            "next",
            "owner",
          ] as const)
            if (command.patch[field] !== undefined)
              item[field] = text(
                command.patch[field],
                field,
                field === "description" ? 20_000 : 500,
              );
          if (command.patch.stageId !== undefined) {
            if (!item.steps.some((s) => s.id === command.patch.stageId))
              throw new Error("该工序不在目标中");
            item.stageId = command.patch.stageId;
          }
          if (command.patch.waitingFor !== undefined)
            item.waitingFor = text(command.patch.waitingFor, "等待对象", 120);
          if (command.patch.remindAt !== undefined)
            item.remindAt =
              command.patch.remindAt === null
                ? undefined
                : iso(command.patch.remindAt);
          if (command.patch.status !== undefined) {
            ongoing(item);
            if (!["active", "waiting"].includes(command.patch.status))
              throw new Error("无效的目标状态");
            item.status = command.patch.status;
            if (item.status === "active") {
              item.waitingFor = undefined;
              item.remindAt = undefined;
            }
          }
          activity(item, "progress", "已更新目标说明与下一步。");
          return item;
        }
        case "goal.dispatch": {
          const item = goal(command.goalId);
          if (command.requestId && item.dispatch?.id !== command.requestId) return item;
          ongoing(item, true);
          if (!["pending", "sent", "failed"].includes(command.status)) throw new Error("无效的派送状态");
          const at = nowIso(), detail = command.detail ? text(command.detail, "派送说明", 2000) : undefined;
          item.mode = "concierge";
          item.dispatch = { ...item.dispatch,
            id: command.status === "pending" && !command.requestId ? newId("handoff") : item.dispatch?.id,
            status: command.status, at, detail };
          if (command.status === "failed" && !item.attention) item.attention = {
            kind: "intervention", source: "dispatch", summary: detail || "目标尚未送达管家，请重试。", since: at,
          };
          if (command.status === "sent" && item.attention?.source === "dispatch") item.attention = null;
          activity(item, "session", command.status === "sent" ? "目标已送达管家。" : command.status === "failed" ? `联系管家失败：${detail}` : "正在联系管家。", "系统");
          return item;
        }
        case "goal.resume": {
          const item = goal(command.goalId); ongoing(item);
          if (item.status !== "waiting") throw new Error("只有等待中的目标可以恢复推进");
          if (!["concierge", "manual"].includes(command.mode)) throw new Error("请选择由谁继续推进");
          const note = text(command.note, "最新结果与下一步", 2000);
          item.status = "active";
          item.mode = command.mode;
          item.next = note;
          item.owner = command.mode === "manual" ? "你" : item.herdr?.agent || "待分配负责人";
          item.waitingFor = undefined;
          item.remindAt = undefined;
          item.attention = null;
          delete item.watchdog;
          delete item.live;
          if (command.mode === "concierge") item.dispatch = {
            id: newId("handoff"), kind: "resume", note, status: "pending", at: nowIso(),
          };
          else delete item.dispatch;
          activity(item, "resolved", `等待已结束。${note}`, "你");
          return item;
        }
        case "goal.followup": {
          const item = goal(command.goalId); ongoing(item);
          if (item.status !== "waiting") throw new Error("只有等待中的目标可以请求跟进");
          const note = command.note?.trim() ? text(command.note, "跟进说明", 2000) : "请核查等待事项的最新进展，并写回跟进结果。";
          item.mode = "concierge";
          item.dispatch = { id: newId("handoff"), kind: "follow_up", note, status: "pending", at: nowIso() };
          activity(item, "session", `已请求管家跟进：${note}`, "你");
          return item;
        }
        case "goal.progress": {
          const item = goal(command.goalId);
          ongoing(item);
          item.status = "active";
          item.remindAt = undefined;
          item.waitingFor = undefined;
          if (item.attention?.kind === "follow_up") item.attention = null;
          if (command.next) item.next = text(command.next, "下一步", 2000);
          if (command.stageId) {
            if (!item.steps.some((s) => s.id === command.stageId))
              throw new Error("该工序不在目标中");
            item.stageId = command.stageId;
          }
          activity(item, "progress", command.summary, command.actor || "管家");
          return item;
        }
        case "goal.wait": {
          const item = goal(command.goalId);
          ongoing(item);
          item.status = "waiting";
          if (item.attention?.kind === "follow_up") item.attention = null;
          item.next = text(command.reason, "等待原因", 2000);
          item.owner = text(command.owner || "你", "等待对象", 120);
          item.waitingFor = item.owner;
          item.remindAt = command.remindAt ? iso(command.remindAt) : undefined;
          activity(item, "waiting", command.reason, command.actor || "管家");
          return item;
        }
        case "goal.decide": {
          const item = goal(command.goalId);
          ongoing(item);
          item.attention = {
            kind: "decision",
            summary: text(command.question, "问题", 2000),
            since: nowIso(),
          };
          if (command.next) item.next = text(command.next, "下一步", 2000);
          activity(item, "decision", command.question, command.actor || "管家");
          return item;
        }
        case "goal.review": {
          const item = goal(command.goalId),
            delivery = command.delivery;
          ongoing(item, true);
          if (
            !delivery ||
            !Array.isArray(delivery.checks) ||
            delivery.checks.length < 1
          )
            throw new Error("提交验收至少需要一项真实检查记录");
          const checks = delivery.checks.map((check) => ({
            name: text(check.name, "检查名称", 200),
            command: text(check.command, "检查命令或操作", 1000),
            result:
              check.result === "passed"
                ? ("passed" as const)
                : check.result === "failed"
                  ? ("failed" as const)
                  : (() => {
                      throw new Error("无效的检查结果");
                    })(),
            ...(check.note ? { note: text(check.note, "检查说明", 2000) } : {}),
          }));
          if (checks.some((check) => check.result !== "passed"))
            throw new Error("仍有检查未通过，请修复后再提交验收");
          const at = nowIso();
          item.delivery = {
            summary: text(delivery.summary, "成果摘要", 12_000),
            ...(delivery.location
              ? { location: text(delivery.location, "交付位置", 2000) }
              : {}),
            ...(delivery.url ? { url: text(delivery.url, "链接", 2000) } : {}),
            checks,
            submittedAt: at,
            submittedBy: command.actor || "管家",
          };
          item.status = "review";
          item.attention = {
            kind: "review",
            summary: "成果已提交，等待你的验收。",
            since: at,
          };
          item.next = "查看实际成果和检查结果，选择验收通过或退回修改。";
          activity(
            item,
            "delivery",
            item.delivery.summary,
            command.actor || "管家",
          );
          return item;
        }
        case "goal.accept": {
          const item = goal(command.goalId);
          if (item.status !== "review" || !item.delivery)
            throw new Error("只有提交验收的目标才能通过验收");
          item.status = "completed";
          item.attention = null;
          item.remindAt = undefined;
          item.waitingFor = undefined;
          item.next = "这件事已完成，不需要继续关注。";
          activity(
            item,
            "accepted",
            command.note || "成果验收通过。",
            command.actor || "你",
          );
          return item;
        }
        case "goal.rework": {
          const item = goal(command.goalId);
          if (item.status !== "review")
            throw new Error("只有待验收目标可以退回");
          item.status = "active";
          item.attention = null;
          item.next = text(command.note, "修改意见", 4000);
          activity(item, "rework", command.note, command.actor || "你");
          return item;
        }
        case "goal.drop": {
          const item = goal(command.goalId);
          ongoing(item, true);
          item.status = "dropped";
          item.attention = null;
          item.remindAt = undefined;
          item.next = text(command.note || "这件事已放弃。", "原因", 4000);
          activity(item, "dropped", item.next, command.actor || "你");
          return item;
        }
        case "goal.resolve": {
          const item = goal(command.goalId);
          ongoing(item, true);
          if (item.attention?.kind === "review")
            throw new Error("成果请使用验收通过或退回修改");
          if (!item.attention && !(item.status === "waiting" && item.remindAt))
            throw new Error("当前没有需要解决的注意力事项");
          item.attention = null;
          item.remindAt = undefined;
          if (command.note) {
            item.next = text(command.note, "下一步", 2000);
            activity(item, "resolved", command.note, command.actor || "你");
          } else stamp(item);
          return item;
        }
        case "goal.remind": {
          const item = goal(command.goalId);
          ongoing(item);
          item.status = "waiting";
          item.remindAt = iso(command.at);
          if (item.attention?.kind === "follow_up") item.attention = null;
          if (command.note) item.next = text(command.note, "提醒说明", 2000);
          activity(
            item,
            "reminder",
            command.note || `将在 ${item.remindAt} 提醒。`,
          );
          return item;
        }
        case "session.set": {
          const reference = command.reference;
          if (
            typeof reference?.session !== "string" ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(reference.session)
          )
            throw new Error("无效的 Herdr Session");
          if (reference.transport !== undefined && reference.transport !== "pane")
            throw new Error("无效的现场通信方式");
          if (reference.transport === "pane" &&
            (!reference.paneId || !Number.isSafeInteger(reference.processId) || reference.processId! <= 0))
            throw new Error("自定义 CLI 现场需要真实 Pane 与前台进程 ID");
          if (command.goalId) {
            const item = goal(command.goalId);
            const sameSite = (other: typeof reference) => other.session === reference.session &&
              (!!reference.paneId && reference.paneId === other.paneId ||
               !!reference.tabId && reference.tabId === other.tabId ||
               !!reference.agent && reference.agent === other.agent);
            if (reference.agent === "concierge" || sameSite(state.concierge))
              throw new Error("目标需要独立负责人，不能把全局管家登记为执行现场");
            if (state.goals.some(other => other.id !== item.id &&
              !["completed","dropped"].includes(other.status) && other.herdr && sameSite(other.herdr)))
              throw new Error("该现场属于其他目标，请为当前目标创建独立负责人 Tab");
            item.herdr = structuredClone(reference);
            delete item.live;
            if (item.mode === "concierge" && item.status === "active")
              item.owner = reference.agent || "独立负责人";
            activity(item, "session", "已关联 Herdr 现场。", "系统");
            return item;
          }
          state.concierge = {
            ...state.concierge,
            ...structuredClone(reference),
          };
          return state.concierge;
        }
        case "concierge.status": {
          if (!["ready", "error", "not_ready"].includes(command.status))
            throw new Error("无效的管家状态");
          state.concierge = {
            session: "crewvane",
            ...command.reference,
            status: command.status,
            ...(command.detail
              ? { detail: text(command.detail, "状态说明", 1000) }
              : {}),
          };
          return state.concierge;
        }
        case "live.sync": {
          for (const [goalId, presence] of Object.entries(command.presences)) {
            const item = goal(goalId);
            if (
              !["working", "idle", "done", "blocked", "unknown"].includes(
                presence.state,
              )
            )
              throw new Error("无效的 Herdr 状态");
            item.live = {
              state: presence.state,
              checkedAt: iso(presence.checkedAt),
              ...(presence.reachable === undefined ? {} : { reachable: Boolean(presence.reachable) }),
            };
            if (
              presence.state !== "blocked" &&
              item.attention?.source === "live"
            )
              item.attention = null;
          }
          return true;
        }
        case "watchdog.inspect":
          return inspectWatchdog(state.goals, iso(command.at));
        case "watchdog.report": {
          if (!["contacted", "failed"].includes(command.outcome)) throw new Error("无效的巡检结果");
          reportWatchdog(goal(command.goalId), iso(command.at), iso(command.basis), command.outcome,
            command.detail ? text(command.detail, "巡检说明", 1000) : undefined);
          return true;
        }
        case "notification.sent": {
          const item = goal(command.goalId),
            kind = command.kind;
          if (item.attention?.kind === kind)
            item.attention.notifiedAt = iso(command.at);
          else if (kind === "follow_up")
            item.attention = {
              kind,
              summary: item.next,
              since: iso(command.at),
              notifiedAt: iso(command.at),
            };
          return true;
        }
        default:
          throw new Error("不支持的命令");
      }
    });
  }
}
