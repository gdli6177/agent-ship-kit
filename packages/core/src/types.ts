/**
 * Runtime ids are extensible so a local ACP or Codex App Server CLI can be
 * registered without adding another brand-specific branch to the scheduler.
 */
export type RuntimeId = string;
export type RuntimeProtocol = "acp" | "codex-app-server" | "none";
export type Role = "captain" | "lead" | "worker" | "verifier";
export type Action = "read" | "write" | "verify" | "publish_pr";
export type TaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_human"
  | "needs_reconcile"
  | "failed"
  | "cancelled"
  | "completed";
export interface ExecutionProfile {
  id: string;
  name: string;
  runtime: RuntimeId;
  model: string;
  effort?: string;
  fallback?: string[];
}
export interface RuntimeModel {
  id: string;
  name: string;
  efforts?: string[];
}
export interface RuntimeCapabilities {
  dispatch: boolean;
  stream: boolean;
  cancel: boolean;
  resume: boolean;
  modelDiscovery: boolean;
  interactiveTerminal: boolean;
}
export interface RuntimeInfo {
  id: RuntimeId;
  name: string;
  executable?: string;
  application?: string;
  version?: string;
  protocol?: RuntimeProtocol;
  launchArgs?: string[];
  interactiveArgs?: string[];
  capabilities?: RuntimeCapabilities;
  status: "missing" | "detected" | "ready" | "unavailable" | "discovery_only";
  models: RuntimeModel[];
  reason?: string;
  checkedAt?: string;
}
export interface WorkflowStage {
  id: string;
  name: string;
  goal: string;
  role: "worker" | "verifier";
  profile?: string;
  inputs: string[];
  outputs: string[];
  completion: string;
  parallel: number;
  returnTo?: string;
  retries: number;
}
export interface WorkflowTemplate {
  id: string;
  name: string;
  version: number;
  stages: WorkflowStage[];
}
export interface DelegationGrant {
  id: string;
  projectId: string;
  approvedBy: string;
  approvedAt: string;
  revokedAt?: string;
  actions: Action[];
  profiles: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  maxParallel: number;
  maxTaskMinutes: number;
  credentials?: string[];
}
export interface CredentialReference {
  id: string;
  projectId: string;
  label: string;
  env: string;
  checkIndex: number;
  createdAt: string;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  baseBranch: string;
  checks: string[][];
  roles: Partial<Record<Role, string>>;
  defaultProfile?: string;
  grant?: DelegationGrant;
  shipPolicy: "external-approval";
  credentials?: CredentialReference[];
}
export type RiskAction =
  | "delete_data"
  | "stop_service"
  | "spend_money"
  | "send_message"
  | "product_direction"
  | "rotate_secret"
  | "change_permissions"
  | "change_ship_policy";
export interface StageResult {
  knowledgeQuery?: string;
  verifyCheck?: number;
  action?: RiskAction;
  status: "done" | "blocked" | "rework";
  summary: string;
  evidence: string[];
  outputs: Record<string, string>;
  question?: string;
  recommendation?: string;
  returnTo?: string;
}
export interface WorkflowRun {
  template: WorkflowTemplate;
  stage: number;
  round: number;
  results: {
    stageId: string;
    round: number;
    workers: StageResult[];
    commit: string;
    valid: boolean;
  }[];
}
export interface Task {
  id: string;
  projectId: string;
  grantId: string;
  title: string;
  request: string;
  createdAt: string;
  status: TaskStatus;
  workflow: WorkflowRun;
  profile?: string;
  branch: string;
  baseCommit?: string;
  checkout?: string;
  summary?: string;
  error?: string;
  discussion?: boolean;
  pr?: string;
  publishIntent?: string;
  cancelledAt?: string;
  reviewRounds: number;
  decisions: string[];
  integrationHead?: string;
  contextRevision?: number;
  executedRevision?: number;
  learning?: { outcome: "pending" | "none" | "candidate" | "failed"; reason: string; lessonIds: string[] };
}
export interface AgentInstance {
  id: string;
  taskId: string;
  parent?: string;
  role: Role;
  profileId: string;
  runtime: RuntimeId;
  model: string;
  sessionId?: string;
  cwd: string;
  pid?: number;
  status:
    | "reserved"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "needs_reconcile";
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  contextSources?: { path: string; digest: string; bodyIncluded: boolean }[];
  lessonIds?: string[];
  hostChecks?: { head: string; checks: { index: number; output: string }[] };
}
export interface DecisionRequest {
  id: string;
  taskId: string;
  projectId: string;
  question: string;
  rootCause: string;
  evidence: string[];
  tried: string[];
  recommendation: string;
  level: "lead" | "captain" | "human";
  status: "open" | "resolved";
  answer?: string;
  answeredBy?: string;
  createdAt: string;
}
export interface DecisionRecord {
  id: string;
  projectId: string;
  rootCause: string;
  question: string;
  answer: string;
  rejected: boolean;
  source: string;
  by: string;
  at: string;
  expiresAt?: string;
}
export type ChatRouteAction = "create" | "forward" | "status" | "reply" | "clarify";
export interface ChatRouting {
  status: "pending" | "clarifying" | "applied" | "failed";
  action?: ChatRouteAction;
  taskId?: string;
  candidates?: string[];
  resolvedBy?: string;
  error?: string;
}
export interface ChatMessage {
  id: string;
  role: "human" | "captain";
  text: string;
  at: string;
  taskId?: string;
  projectId?: string;
  replyTo?: string;
  contextTaskId?: string;
  clarifies?: string;
  routing?: ChatRouting;
}
export interface WorkspaceState {
  version: 1;
  profiles: ExecutionProfile[];
  runtimes: RuntimeInfo[];
  projects: Project[];
  workflows: WorkflowTemplate[];
  tasks: Task[];
  agents: AgentInstance[];
  decisions: DecisionRequest[];
  ledger: DecisionRecord[];
  messages: ChatMessage[];
  defaultProfile?: string;
  maxParallel: number;
  knowledgeRevision?: number;
  credentialAccess?: { taskId: string; credentialIds: string[]; checkIndex: number; at: string }[];
}
export interface RuntimeEvent {
  type: "text" | "tool" | "permission" | "status";
  sessionId?: string;
  text: string;
}
export interface PermissionRequest {
  method: string;
  params: Record<string, unknown>;
}
export interface SessionOptions {
  cwd: string;
  model: string;
  effort?: string;
  role: Role;
  resume?: string;
  onEvent: (event: RuntimeEvent) => void;
  permission: (request: PermissionRequest) => Promise<boolean>;
}
export interface RuntimeSession {
  id: string;
  pid: number;
  models: RuntimeModel[];
  prompt(text: string): Promise<string>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
export interface RuntimeAdapter {
  id: RuntimeId;
  probe(cwd: string): Promise<RuntimeInfo>;
  open(options: SessionOptions): Promise<RuntimeSession>;
}
