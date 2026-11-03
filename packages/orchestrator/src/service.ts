import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  WorkspaceStore,
  activeGrant,
  assertHumanHost,
  assertId,
  executionProfile,
  newId,
  redact,
  validateGrant,
  validateWorkflow,
  type DelegationGrant,
  type ExecutionProfile,
  type Project,
  type Task,
  type WorkflowTemplate,
} from "../../core/src/index.js";
import { discoverRuntimes } from "./discovery.js";
import { ProtocolAdapter } from "./adapters.js";
import { canonicalRepo, git } from "./git.js";
export type ServiceCommand =
  | { type: "snapshot" }
  | { type: "scan"; probe?: string }
  | { type: "profile.save"; profile: ExecutionProfile }
  | { type: "project.save"; project: Omit<Project, "grant" | "shipPolicy"> }
  | {
      type: "grant.save";
      projectId: string;
      grant: Omit<DelegationGrant, "id" | "approvedAt" | "projectId">;
    }
  | { type: "grant.revoke"; projectId: string }
  | { type: "workflow.save"; workflow: WorkflowTemplate }
  | {
      type: "task.submit";
      projectId: string;
      request: string;
      workflowId: string;
      profile?: string;
      discussion?: boolean;
    }
  | { type: "task.cancel" | "task.retry"; taskId: string; profile?: string }
  | {
      type: "decision.answer";
      decisionId: string;
      answer: string;
      by: string;
      rejected?: boolean;
      remember?: boolean;
      expiresAt?: string;
    }
  | { type: "chat.send"; projectId: string; text: string; taskId?: string };
const limited = (v: unknown, size = 12000) => {
  if (typeof v !== "string" || !v.trim() || v.length > size || v.includes("\0"))
    throw new Error("invalid text");
  return redact(v.trim());
};
export class WorkspaceService {
  readonly store: WorkspaceStore;
  constructor(readonly root: string) {
    this.store = new WorkspaceStore(root);
  }
  async execute(command: ServiceCommand): Promise<unknown> {
    if (!command || typeof command !== "object")
      throw new Error("invalid command");
    if (command.type === "snapshot") return this.store.read();
    assertHumanHost();
    switch (command.type) {
      case "scan": {
        const found = await discoverRuntimes(this.root);
        const previous = await this.store.read();
        const infos = await Promise.all(
          found.map(async (info) =>
            command.probe === info.id || command.probe === "all"
              ? new ProtocolAdapter(info).probe(this.root)
              : (previous.runtimes.find(
                  (p) =>
                    p.id === info.id &&
                    p.executable === info.executable &&
                    p.checkedAt,
                ) ?? info),
          ),
        );
        await this.store.update("runtime.scan", (state) => {
          state.runtimes = infos;
        });
        return infos;
      }
      case "profile.save": {
        const p = structuredClone(command.profile);
        assertId(p.id);
        p.name = limited(p.name, 100);
        p.model = limited(p.model, 200);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(p.runtime))
          throw new Error("invalid runtime id");
        return this.store.update("profile.save", (state) => {
          const info = state.runtimes.find((r) => r.id === p.runtime);
          if (
            info?.status !== "ready" ||
            info.capabilities?.dispatch === false ||
            !info.models.some(
              (m) =>
                m.id === p.model &&
                (!p.effort || m.efforts?.includes(p.effort)),
            )
          )
            throw new Error(
              "select a tested runtime and an advertised model/effort",
            );
          if (
            p.fallback?.some(
              (id) => id === p.id || !state.profiles.some((p) => p.id === id),
            )
          )
            throw new Error("invalid fallback profile");
          // Changing an authorized profile would silently expand/rebind an existing grant.
          const old = state.profiles.find((v) => v.id === p.id);
          if (
            old &&
            JSON.stringify(old) !== JSON.stringify(p) &&
            state.projects.some(
              (project) =>
                project.grant &&
                !project.grant.revokedAt &&
                project.grant.profiles.includes(p.id),
            )
          )
            throw new Error(
              "revoke affected project grants before changing an execution profile",
            );
          state.profiles = [...state.profiles.filter((v) => v.id !== p.id), p];
          state.defaultProfile ??= p.id;
          return p;
        });
      }
      case "project.save": {
        const p = structuredClone(command.project);
        assertId(p.id);
        p.name = limited(p.name, 100);
        p.path = await canonicalRepo(p.path);
        await git(p.path, "rev-parse", "--verify", `${p.baseBranch}^{commit}`);
        if (
          !Array.isArray(p.checks) ||
          !p.checks.length ||
          p.checks.length > 10 ||
          p.checks.some(
            (c) =>
              !Array.isArray(c) ||
              !c.length ||
              c.some((a) => typeof a !== "string" || !a || /[\0\n\r]/.test(a)),
          )
        )
          throw new Error("verification commands must be nonempty argv arrays");
        return this.store.update("project.save", (state) => {
          for (const id of [p.defaultProfile, ...Object.values(p.roles)])
            if (id && !state.profiles.some((v) => v.id === id))
              throw new Error("unknown role profile");
          const old = state.projects.find((v) => v.id === p.id);
          if (old?.grant && !old.grant.revokedAt)
            throw new Error(
              "revoke the project grant before changing project execution settings",
            );
          const project: Project = { ...p, shipPolicy: "external-approval" };
          state.projects = [
            ...state.projects.filter((v) => v.id !== p.id),
            project,
          ];
          return project;
        });
      }
      case "grant.save":
        return this.store.update("grant.save", (state) => {
          const project = state.projects.find(
            (p) => p.id === command.projectId,
          );
          if (!project) throw new Error("project not found");
          if (project.grant && !project.grant.revokedAt)
            throw new Error("revoke the existing grant before replacing it");
          const grant: DelegationGrant = {
            ...command.grant,
            approvedBy: limited(command.grant.approvedBy, 100),
            id: newId("grant"),
            projectId: project.id,
            approvedAt: new Date().toISOString(),
          };
          validateGrant(grant, project, state.profiles);
          project.grant = grant;
          return grant;
        });
      case "grant.revoke":
        return this.store.update("grant.revoke", (state) => {
          const project = state.projects.find(
            (p) => p.id === command.projectId,
          );
          if (!project?.grant) throw new Error("grant not found");
          project.grant.revokedAt = new Date().toISOString();
          for (const task of state.tasks.filter(
            (t) =>
              t.projectId === project.id &&
              !["completed", "cancelled", "failed"].includes(t.status),
          ))
            task.cancelledAt = new Date().toISOString();
          return project.grant;
        });
      case "workflow.save":
        return this.store.update("workflow.save", (state) => {
          const template = structuredClone(command.workflow);
          validateWorkflow(template, state.profiles);
          const old = state.workflows.find((w) => w.id === template.id);
          if (old && template.version !== old.version + 1)
            throw new Error("increment workflow version by one");
          state.workflows = [
            ...state.workflows.filter((w) => w.id !== template.id),
            template,
          ];
          return template;
        });
      case "task.submit":
        return this.store.update("task.submit", (state) => {
          const project = state.projects.find(
            (p) => p.id === command.projectId,
          );
          if (!project) throw new Error("project not found");
          activeGrant(project);
          const template = state.workflows.find(
            (w) => w.id === command.workflowId,
          );
          if (!template) throw new Error("workflow not found");
          validateWorkflow(template, state.profiles);
          for (const role of ["captain", "lead", "worker", "verifier"] as const)
            executionProfile(state, project, role, command.profile);
          for (const stage of template.stages)
            executionProfile(
              state,
              project,
              stage.role,
              command.profile,
              stage.profile,
            );
          const request = limited(command.request),
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
            profile: command.profile,
            branch: `crewvane/${id}`,
            decisions: [],
            reviewRounds: 0,
          };
          if (command.discussion) {
            task.discussion = true;
            task.summary = "讨论模式：先沟通方案，尚未授权此任务开工。";
          }
          state.tasks.push(task);
          state.messages.push({
            id: newId("msg"),
            role: "human",
            text: request,
            taskId: id,
            projectId: project.id,
            at: task.createdAt,
          });
          return task;
        });
      case "task.cancel":
        return this.store.update("task.cancel_requested", (state) => {
          const task = state.tasks.find((t) => t.id === command.taskId);
          if (!task) throw new Error("task not found");
          if (["completed", "cancelled"].includes(task.status)) return task;
          task.cancelledAt = new Date().toISOString();
          return task;
        });
      case "task.retry":
        return this.store.update("task.retry", (state) => {
          const task = state.tasks.find((t) => t.id === command.taskId);
          if (
            !task ||
            !["failed", "needs_reconcile", "waiting_human"].includes(
              task.status,
            )
          )
            throw new Error("task is not resumable");
          if (
            state.agents.some(
              (a) =>
                a.taskId === task.id &&
                ["running", "reserved"].includes(a.status),
            )
          )
            throw new Error("live session must stop before retry");
          if (
            state.decisions.some(
              (d) =>
                d.taskId === task.id &&
                d.level === "human" &&
                d.status === "open",
            )
          )
            throw new Error("answer pending decisions first");
          if (command.profile) {
            const project = state.projects.find(
              (p) => p.id === task.projectId,
            )!;
            for (const role of [
              "captain",
              "lead",
              "worker",
              "verifier",
            ] as const)
              executionProfile(state, project, role, command.profile);
            task.profile = command.profile;
          }
          task.grantId = activeGrant(
            state.projects.find((p) => p.id === task.projectId)!,
          ).id;
          task.status = "queued";
          delete task.discussion;
          delete task.cancelledAt;
          delete task.error;
          return task;
        });
      case "decision.answer":
        return this.store.update("decision.answer", (state) => {
          const item = state.decisions.find(
            (d) =>
              d.id === command.decisionId &&
              d.level === "human" &&
              d.status === "open",
          );
          if (!item) throw new Error("human decision not found");
          item.answer = limited(command.answer);
          item.answeredBy = limited(command.by, 100);
          item.status = "resolved";
          if (
            command.expiresAt &&
            (!Number.isFinite(Date.parse(command.expiresAt)) ||
              Date.parse(command.expiresAt) <= Date.now())
          )
            throw new Error("decision expiry must be in the future");
          if (command.remember)
            state.ledger.push({
              id: newId("decision"),
              projectId: item.projectId,
              rootCause: item.rootCause,
              question: item.question,
              answer: item.answer,
              rejected: !!command.rejected,
              source: item.id,
              by: item.answeredBy,
              at: new Date().toISOString(),
              expiresAt: command.expiresAt,
            });
          const task = state.tasks.find((t) => t.id === item.taskId);
          if (
            task &&
            !state.decisions.some(
              (d) =>
                d.taskId === task.id &&
                d.level === "human" &&
                d.status === "open",
            )
          ) {
            task.status = command.rejected ? "cancelled" : "queued";
            if (command.rejected) task.cancelledAt = new Date().toISOString();
          }
          return item;
        });
      case "chat.send":
        return this.store.update("chat.message", (state) => {
          const project = state.projects.find(
            (p) => p.id === command.projectId,
          );
          if (!project) throw new Error("project not found");
          if (
            command.taskId &&
            !state.tasks.some(
              (t) => t.id === command.taskId && t.projectId === project.id,
            )
          )
            throw new Error("task not found in selected project");
          const message = {
            id: newId("msg"),
            role: "human" as const,
            text: limited(command.text),
            taskId: command.taskId,
            projectId: project.id,
            at: new Date().toISOString(),
          };
          state.messages.push(message);
          return message;
        });
      default:
        throw new Error("unknown workspace command");
    }
  }
}
