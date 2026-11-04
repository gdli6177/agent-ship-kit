import { attentionKind } from "../../../../../packages/core/src/model.js";
import type {
  Activity,
  Goal,
  GoalAttachment,
  WorkspaceState,
} from "../../../../../packages/core/src/types.js";

export type GoalTone = "running" | "waiting" | "review" | "reply" | "blocked" | "done";

export const statusLabel = {
  active: "进行中",
  waiting: "等待中",
  review: "待验收",
  completed: "已完成",
  dropped: "已放弃",
} as const;

export const activityKindLabel: Record<Activity["kind"], string> = {
  created: "目标",
  message: "消息",
  progress: "答复",
  waiting: "等待",
  decision: "决定",
  delivery: "交付",
  accepted: "验收",
  rework: "返工",
  dropped: "放弃",
  resolved: "处理",
  reminder: "提醒",
  session: "会话",
  watchdog: "巡检",
  ship: "上线",
};

const contentKinds = new Set<Activity["kind"]>([
  "created",
  "message",
  "progress",
  "waiting",
  "decision",
  "delivery",
  "accepted",
  "rework",
  "dropped",
  "resolved",
]);

export interface GoalPresentation {
  tone: GoalTone;
  label: string;
  detail: string;
  projectName: string;
  latest?: Activity;
  latestAttachments: GoalAttachment[];
  ended: boolean;
  needsDecision: boolean;
  needsIntervention: boolean;
  dispatchFailed: boolean;
  dueFollowUp: boolean;
}

export function presentGoal(goal: Goal, state: WorkspaceState): GoalPresentation {
  const ended = goal.status === "completed" || goal.status === "dropped";
  const kind = attentionKind(goal);
  const needsDecision = !ended && kind === "decision";
  const dispatchFailed = !ended && goal.attention?.source === "dispatch";
  const needsIntervention = !ended && kind === "intervention" && !dispatchFailed;
  const dueFollowUp = !ended && goal.status === "waiting" && kind === "follow_up";
  const latest = [...goal.activities]
    .reverse()
    .find((activity) => contentKinds.has(activity.kind));
  const latestAttachments = (latest?.attachmentIds ?? [])
    .map((id) => goal.attachments?.find((attachment) => attachment.id === id))
    .filter((attachment): attachment is GoalAttachment => Boolean(attachment));

  let tone: GoalTone = "running";
  let label = "管家处理中";
  let detail = "有真正需要你的变化时会再出现。";
  if (ended) {
    tone = goal.status === "dropped" ? "blocked" : "done";
    label = statusLabel[goal.status];
    detail = goal.status === "completed" ? "已经验收完成。" : "已经放弃，只保留记录。";
  } else if (goal.status === "review") {
    tone = "review";
    label = "等你验收";
    detail = "成果和检查记录已经就绪。";
  } else if (dispatchFailed) {
    tone = "blocked";
    label = "联系管家失败";
    detail = "目标已保存在本机；恢复连接后重试即可继续。";
  } else if (needsDecision) {
    tone = "reply";
    label = "等你决定";
    detail = "这里需要你的明确授权或选择。";
  } else if (needsIntervention) {
    tone = "blocked";
    label = "需要你排障";
    detail = "负责人现场需要你完成一次操作。";
  } else if (dueFollowUp) {
    tone = "waiting";
    label = "到点跟进";
    detail = "到了你设定的跟进时间。";
  } else if (goal.status === "waiting") {
    tone = "waiting";
    label = "等待外部";
    detail = "现在不需要你处理。";
  } else if (goal.mode === "manual") {
    label = "由你处理";
    detail = "补充进展或提交成果；需要协作时可以交回管家。";
  }

  return {
    tone,
    label,
    detail,
    projectName:
      state.projects.find((project) => project.id === goal.projectId)?.name ??
      "个人事项",
    latest,
    latestAttachments,
    ended,
    needsDecision,
    needsIntervention,
    dispatchFailed,
    dueFollowUp,
  };
}

export const time = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "";

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
