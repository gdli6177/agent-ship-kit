import type { AttentionKind, Goal, ProjectPolicy, WorkspaceState } from "./types.js";
import { defaultWorkflows } from "./workflows.js";
export const newId = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
export const defaultProjectPolicy = (): ProjectPolicy => ({
  shipPolicy: "external-approval",
  approvers: [],
  revision: 1,
  updatedAt: new Date().toISOString(),
});
export const initialState = (): WorkspaceState => ({
  version: 2,
  name: "我的工作台",
  projects: [{ id: "personal", name: "个人事项", policy: defaultProjectPolicy(), createdAt: new Date().toISOString() }],
  workflows: defaultWorkflows(),
  goals: [],
  decisions: [],
  concierge: { session: "crewvane", status: "not_ready" },
});
export function attentionGoals(goals: Goal[], now = Date.now()): Goal[] {
  return goals.filter((goal) => !["completed", "dropped"].includes(goal.status) && (goal.attention || (goal.status === "waiting" && goal.remindAt && Date.parse(goal.remindAt) <= now))).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
export function attentionKind(goal: Goal, now = Date.now()): AttentionKind | undefined {
  if (goal.attention) return goal.attention.kind;
  return goal.status === "waiting" && goal.remindAt && Date.parse(goal.remindAt) <= now ? "follow_up" : undefined;
}
