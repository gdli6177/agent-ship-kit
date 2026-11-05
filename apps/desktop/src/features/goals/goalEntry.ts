import { attentionKind } from "../../../../../packages/core/src/model.js";
import type { Goal } from "../../../../../packages/core/src/types.js";

export type GoalEntryDestination = "scene" | "attention" | "details";

export function hasGoalScene(goal: Goal) {
  return Boolean(goal.herdr?.tabId || goal.herdr?.paneId || goal.herdr?.agent);
}

export function goalEntryDestination(goal: Goal): GoalEntryDestination {
  if (goal.status === "completed" || goal.status === "dropped") return "details";
  if (goal.attention?.source === "dispatch") return "attention";
  const kind = attentionKind(goal);
  if (kind === "decision" || kind === "review" || kind === "follow_up") return "attention";
  if (kind === "intervention") return "scene";
  if (goal.status === "active" && hasGoalScene(goal)) return "scene";
  return "details";
}
