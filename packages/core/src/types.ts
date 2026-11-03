export type GoalStatus = "active" | "waiting" | "review" | "completed" | "dropped";
export type AttentionKind = "decision" | "review" | "follow_up" | "intervention";
export type LiveState = "working" | "idle" | "done" | "blocked" | "unknown";
export interface Project { id: string; name: string; path?: string; createdAt: string }
export interface WorkflowStep { id: string; name: string; prompt: string }
export interface Workflow { id: string; name: string; steps: WorkflowStep[] }
export interface AgentPreferences { concierge: string; owner?: string; worker?: string }
export interface Attention { kind: AttentionKind; summary: string; since: string; notifiedAt?: string; source?: "live" | "dispatch" | "watchdog" }
export interface HerdrReference { session: string; workspaceId?: string; tabId?: string; paneId?: string; agent?: string }
export interface LivePresence { state: LiveState; checkedAt: string; reachable?: boolean }
export type WatchdogReason = "blocked" | "missing" | "stale";
export interface WatchdogState {
  reason: WatchdogReason; basis: string; detectedAt: string;
  attemptedAt?: string; contactedAt?: string; escalatedAt?: string; lastError?: string;
}
export interface DeliveryCheck { name: string; command: string; result: "passed" | "failed"; note?: string }
export interface Delivery { summary: string; location?: string; url?: string; checks: DeliveryCheck[]; submittedAt: string; submittedBy: string }
export interface Activity { id: string; at: string; actor: string; kind: "created" | "progress" | "waiting" | "decision" | "delivery" | "accepted" | "rework" | "dropped" | "resolved" | "reminder" | "session" | "watchdog"; text: string }
export interface Goal {
  id: string; projectId: string; title: string; description: string;
  mode: "concierge" | "manual"; status: GoalStatus;
  steps: WorkflowStep[]; stageId?: string; next: string; owner: string;
  waitingFor?: string; remindAt?: string; attention: Attention | null;
  delivery?: Delivery; herdr?: HerdrReference; live?: LivePresence;
  dispatch?: { status: "pending" | "sent" | "failed"; at: string; detail?: string };
  watchdog?: WatchdogState;
  activities: Activity[]; createdAt: string; updatedAt: string;
}
export interface WorkspaceState {
  version: 2; name: string; projects: Project[]; workflows: Workflow[]; goals: Goal[];
  agents?: AgentPreferences;
  concierge: HerdrReference & { status: "not_ready" | "ready" | "error"; detail?: string };
}
export type CrewvaneCommand =
  | { type: "snapshot" }
  | { type: "workspace.rename"; name: string }
  | { type: "agents.configure"; preferences: AgentPreferences }
  | { type: "project.add"; name: string; path?: string }
  | { type: "project.remove"; projectId: string }
  | { type: "workflow.save"; workflow: Workflow }
  | { type: "goal.create"; input: { title: string; description?: string; projectId: string; workflowId?: string; mode: "concierge" | "manual"; next?: string; waitingFor?: string; remindAt?: string } }
  | { type: "goal.update"; goalId: string; patch: { title?: string; description?: string; next?: string; owner?: string; stageId?: string; waitingFor?: string; remindAt?: string | null; status?: "active" | "waiting" } }
  | { type: "goal.progress"; goalId: string; summary: string; next?: string; stageId?: string; actor?: string }
  | { type: "goal.dispatch"; goalId: string; status: "pending" | "sent" | "failed"; detail?: string }
  | { type: "goal.wait"; goalId: string; reason: string; owner?: string; remindAt?: string; actor?: string }
  | { type: "goal.decide"; goalId: string; question: string; next?: string; actor?: string }
  | { type: "goal.review"; goalId: string; delivery: Omit<Delivery, "submittedAt" | "submittedBy">; actor?: string }
  | { type: "goal.accept" | "goal.drop" | "goal.resolve"; goalId: string; note?: string; actor?: string }
  | { type: "goal.rework"; goalId: string; note: string; actor?: string }
  | { type: "goal.remind"; goalId: string; at: string; note?: string }
  | { type: "session.set"; goalId?: string; reference: HerdrReference }
  | { type: "concierge.status"; status: "not_ready" | "ready" | "error"; detail?: string; reference?: HerdrReference }
  | { type: "live.sync"; presences: Record<string, LivePresence> }
  | { type: "watchdog.inspect"; at: string }
  | { type: "watchdog.report"; goalId: string; at: string; basis: string; outcome: "contacted" | "failed"; detail?: string }
  | { type: "notification.sent"; goalId: string; kind: AttentionKind; at: string };
