import { activeGrant, executionProfile, newId, redact, validateWorkflow, type Task, type WorkspaceState } from "../../core/src/index.js";
export interface TaskInput {
  projectId: string;
  request: string;
  workflowId: string;
  profile?: string;
  discussion?: boolean;
  sourceMessageId?: string;
}
export function limited(value: unknown, size = 12000): string {
  if (typeof value !== "string" || !value.trim() || value.length > size || value.includes("\0"))
    throw new Error("invalid text");
  return redact(value.trim());
}
/** Called under the workspace lock by both explicit intake and captain routing. */
export function submitTask(state: WorkspaceState, input: TaskInput): Task {
  const project = state.projects.find(
    (p) => p.id === input.projectId,
  );
  if (!project) throw new Error("project not found");
  activeGrant(project);
  const template = state.workflows.find(
    (w) => w.id === input.workflowId,
  );
  if (!template) throw new Error("workflow not found");
  validateWorkflow(template, state.profiles);
  for (const role of ["captain", "lead", "worker", "verifier"] as const)
    executionProfile(state, project, role, input.profile);
  for (const stage of template.stages)
    executionProfile(
      state,
      project,
      stage.role,
      input.profile,
      stage.profile,
    );
  const request = limited(input.request),
    id = newId("task");
  const task: Task = {
    id,
    projectId: project.id,
    grantId: activeGrant(project).id,
    title: request.split("\n")[0]!.slice(0, 90),
    request,
    status: "queued",
    createdAt: new Date().toISOString(),
    workflow: {
      template: structuredClone(template),
      stage: 0,
      round: 0,
      results: [],
    },
    profile: input.profile,
    branch: `crewvane/${id}`,
    decisions: [],
    reviewRounds: 0,
  };
  if (input.discussion) {
    task.discussion = true;
    task.summary = "讨论模式：先沟通方案，尚未授权此任务开工。";
  }
  state.tasks.push(task);
  if (!input.sourceMessageId) state.messages.push({
    id: newId("msg"),
    role: "human",
    text: request,
    taskId: id,
    projectId: project.id,
    at: task.createdAt,
  });
  return task;
}
