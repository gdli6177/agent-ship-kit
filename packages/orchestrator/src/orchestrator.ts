import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  WorkspaceStore,
  MUST_ESCALATE,
  activeGrant,
  executionProfile,
  newId,
  pidAlive,
  redact,
  withLock,
  type AgentInstance,
  type DecisionRequest,
  type ExecutionProfile,
  type Project,
  type Role,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
  type StageResult,
  type Task,
} from "../../core/src/index.js";
import { ProtocolAdapter } from "./adapters.js";
import {
  addWorktree,
  assertScope,
  changedPaths,
  command,
  commitChanges,
  git,
  publishPR,
} from "./git.js";
import { parseAssignments, type WorkerAssignment } from "./allocation.js";
import { permissionAllowed } from "./permissions.js";
export class WaitingForHuman extends Error {}
export function parseResult(text: string): StageResult {
  let value: any;
  try {
    value = JSON.parse(text.trim());
  } catch {
    // Runtimes can wrap the result in Markdown and include code fences inside
    // string-valued outputs. Walk balanced JSON objects instead of matching fences.
    for (let start = 0; start < text.length; start++) {
      if (text[start] !== "{") continue;
      let depth = 0,
        quoted = false,
        escaped = false,
        end = -1;
      for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      if (end !== -1) {
        try {
          const candidate = JSON.parse(text.slice(start, end + 1));
          if (candidate?.status) {
            value = candidate;
            break;
          }
        } catch {
          /* next object boundary */
        }
      }
    }
    if (!value) throw new Error("agent returned no final StageResult JSON");
  }
  if (
    !value ||
    !["done", "blocked", "rework"].includes(value.status) ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.evidence) ||
    value.evidence.some((v: unknown) => typeof v !== "string") ||
    !value.outputs ||
    typeof value.outputs !== "object" ||
    Array.isArray(value.outputs)
  )
    throw new Error("agent returned an invalid StageResult");
  value.outputs = Object.fromEntries(
    Object.entries(value.outputs).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
  if (value.action && !MUST_ESCALATE.includes(value.action))
    throw new Error("unknown escalation action");
  if (value.status === "blocked" && typeof value.question !== "string")
    throw new Error("blocked result requires a question");
  return JSON.parse(redact(JSON.stringify(value)));
}
const resultFormat = (keys: string[]) =>
  `Return ONLY a JSON object: {"status":"done|blocked|rework","summary":"concise verified facts","evidence":["commands and results or artifact paths"],"outputs":${JSON.stringify(Object.fromEntries(keys.map((key) => [key, "artifact or explanation"])))},"question":"only when blocked","recommendation":"suggested answer","returnTo":"only when rework","action":"only for delete_data|stop_service|spend_money|send_message|product_direction|rotate_secret|change_permissions|change_ship_policy"}. Do not invent success, evidence, sessions or approvals.`;
export class Orchestrator extends EventEmitter {
  readonly store: WorkspaceStore;
  private token = newId("scheduler");
  private active = new Map<string, Promise<void>>();
  private sessions = new Map<
    string,
    { taskId: string; session: RuntimeSession }
  >();
  private aborts = new Map<string, AbortController>();
  private stopping = false;
  private acquired = false;
  private captainTail: Promise<unknown> = Promise.resolve();
  private handledChats = new Set<string>();
  constructor(
    readonly root: string,
    readonly adapter?: (profile: ExecutionProfile) => RuntimeAdapter,
  ) {
    super();
    this.store = new WorkspaceStore(root);
  }
  private leaseFile() {
    return join(this.root, ".crewvane", "scheduler.json");
  }
  async start() {
    await this.store.read();
    await withLock(join(this.root, ".crewvane"), async () => {
      const old = JSON.parse(
        await readFile(this.leaseFile(), "utf8").catch((e) => {
          if (e.code === "ENOENT") return "null";
          throw e;
        }),
      );
      if (old && (old.hostname !== hostname() || pidAlive(old.pid)))
        throw new Error("another scheduler owns this workspace");
      await writeFile(
        this.leaseFile(),
        JSON.stringify({
          token: this.token,
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      this.acquired = true;
    });
    await this.store.update("scheduler.reconcile", (state) => {
      for (const agent of state.agents.filter((a) =>
        ["running", "reserved"].includes(a.status),
      ))
        agent.status = "needs_reconcile";
      for (const task of state.tasks.filter((t) =>
        ["running", "planning"].includes(t.status),
      )) {
        task.status = "needs_reconcile";
        task.summary = "上次运行中断，核对现有会话与分支后恢复。";
      }
    });
  }
  private async snapshotTask(id: string) {
    const state = await this.store.read(),
      task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error("task not found");
    const project = state.projects.find((p) => p.id === task.projectId);
    if (!project) throw new Error("project not found");
    return { state, task, project };
  }
  private async assertRunning(taskId: string) {
    const { task, project } = await this.snapshotTask(taskId);
    if (
      this.stopping ||
      task.cancelledAt ||
      this.aborts.get(taskId)?.signal.aborted
    )
      throw new Error("task cancelled");
    if (activeGrant(project).id !== task.grantId)
      throw new Error("task grant changed; explicit human retry required");
    return { task, project };
  }
  async tick() {
    if (!this.acquired || this.stopping) return;
    const state = await this.store.read();
    for (const task of state.tasks) {
      const project = state.projects.find((p) => p.id === task.projectId);
      if (
        (task.cancelledAt || project?.grant?.revokedAt) &&
        !["cancelled", "completed"].includes(task.status)
      ) {
        this.aborts.get(task.id)?.abort();
        for (const { taskId, session } of this.sessions.values())
          if (taskId === task.id) {
            await session.cancel().catch(() => {});
            await session.close();
          }
        if (!this.active.has(task.id))
          await this.store.update("task.cancelled", (s) => {
            const t = s.tasks.find((t) => t.id === task.id)!;
            t.status = "cancelled";
          });
      }
      if (
        task.status === "queued" &&
        !task.cancelledAt &&
        !this.active.has(task.id)
      ) {
        const promise = this.runTask(task.id)
          .catch((error) => {
            this.emit("diagnostic", redact(String(error)));
          })
          .finally(() => {
            this.active.delete(task.id);
            this.aborts.delete(task.id);
          });
        this.active.set(task.id, promise);
      }
    }
    // Conversation is a registered read-only captain session; each human message is answered once.
    for (const message of state.messages.filter(
      (m) => m.role === "human" && !(m as any).replyTo,
    )) {
      if (
        this.handledChats.has(message.id) ||
        state.messages.some((m) => (m as any).replyTo === message.id)
      )
        continue;
      // Intake messages already get a captain acknowledgement through the task loop.
      if (
        message.taskId &&
        state.tasks.some(
          (t) => t.id === message.taskId && t.request === message.text,
        )
      ) {
        this.handledChats.add(message.id);
        continue;
      }
      const projectId =
        (message as any).projectId ??
        state.tasks.find((t) => t.id === message.taskId)?.projectId;
      const project = state.projects.find((p) => p.id === projectId);
      if (!project?.grant || project.grant.revokedAt) continue;
      this.handledChats.add(message.id);
      const chatKey = `chat_${message.id}`;
      const promise = this.runAgent(
        chatKey,
        project,
        "captain",
        project.path,
        `你是 Crewvane 船长。回应用户的问题，必要时解释当前进度。不能改变授权或声称执行了工具。\n问题：${message.text}\n当前项目需求：${JSON.stringify(state.tasks.filter((t) => t.projectId === project.id).map((t) => ({ id: t.id, title: t.title, status: t.status, summary: t.summary, pr: t.pr })))}`,
        undefined,
        undefined,
        undefined,
        false,
      )
        .then((text) =>
          this.store.update("captain.reply", (s) => {
            s.messages.push({
              id: newId("msg"),
              role: "captain",
              text: redact(text).slice(0, 12000),
              at: new Date().toISOString(),
              taskId: message.taskId,
              projectId,
              replyTo: message.id,
            } as any);
          }),
        )
        .catch((error) => {
          this.emit("diagnostic", String(error));
          this.handledChats.delete(message.id);
        })
        .finally(() => this.active.delete(chatKey));
      this.active.set(
        chatKey,
        promise.then(() => {}),
      );
    }
  }
  async runUntilIdle(timeoutMs = 30 * 60_000) {
    if (!this.acquired) await this.start();
    const deadline = Date.now() + timeoutMs;
    do {
      await this.tick();
      if (
        !this.active.size &&
        !(await this.store.read()).tasks.some((t) => t.status === "queued")
      )
        return;
      if (Date.now() > deadline) throw new Error("orchestration timeout");
      await delay(250);
    } while (!this.stopping);
  }
  async stop() {
    this.stopping = true;
    for (const abort of this.aborts.values()) abort.abort();
    for (const { session } of this.sessions.values()) {
      await session.cancel().catch(() => {});
      await session.close();
    }
    await Promise.allSettled(this.active.values());
    if (this.acquired)
      await withLock(join(this.root, ".crewvane"), async () => {
        const owner = JSON.parse(
          await readFile(this.leaseFile(), "utf8").catch(() => "null"),
        );
        if (owner?.token === this.token) await rm(this.leaseFile());
      });
    this.acquired = false;
  }
  private async runAgent(
    taskId: string,
    project: Project,
    role: Role,
    cwd: string,
    prompt: string,
    override?: string,
    stageProfile?: string,
    parent?: string,
    structured = true,
    outputKeys: string[] = ["plan"],
  ): Promise<string> {
    if (role !== "captain")
      return this.runAgentSession(
        taskId,
        project,
        role,
        cwd,
        prompt,
        override,
        stageProfile,
        parent,
        structured,
        outputKeys,
      );
    const queued = this.captainTail
      .catch(() => {})
      .then(() =>
        this.runAgentSession(
          taskId,
          project,
          role,
          cwd,
          prompt,
          override,
          stageProfile,
          parent,
          structured,
          outputKeys,
        ),
      );
    this.captainTail = queued;
    return queued;
  }
  private async runAgentSession(
    taskId: string,
    project: Project,
    role: Role,
    cwd: string,
    prompt: string,
    override?: string,
    stageProfile?: string,
    parent?: string,
    structured = true,
    outputKeys: string[] = ["plan"],
  ): Promise<string> {
    let state = await this.store.read();
    const selected = executionProfile(
      state,
      project,
      role,
      override,
      stageProfile,
    );
    const grant = activeGrant(project),
      candidates = [selected.id, ...(selected.fallback ?? [])].filter((id) =>
        grant.profiles.includes(id),
      );
    let lastError: unknown;
    for (const profileId of candidates) {
      state = await this.store.read();
      const profile = state.profiles.find((p) => p.id === profileId);
      if (!profile) continue;
      const instance: AgentInstance = {
        id: newId(role),
        taskId,
        parent,
        role,
        profileId,
        runtime: profile.runtime,
        model: profile.model,
        cwd,
        status: "reserved",
        startedAt: new Date().toISOString(),
      };
      const isWorker = ["worker", "verifier"].includes(role);
      for (;;) {
        if (this.stopping || this.aborts.get(taskId)?.signal.aborted)
          throw new Error("task cancelled");
        const reserved = await this.store.update("agent.reserve", (s) => {
          const p = s.projects.find((p) => p.id === project.id)!;
          activeGrant(p);
          const active = s.agents.filter(
            (a) =>
              ["reserved", "running"].includes(a.status) &&
              ["worker", "verifier"].includes(a.role),
          );
          const projectTasks = new Set(
            s.tasks.filter((t) => t.projectId === project.id).map((t) => t.id),
          );
          if (
            isWorker &&
            (active.length >= s.maxParallel ||
              active.filter((a) => projectTasks.has(a.taskId)).length >=
                grant.maxParallel)
          )
            return false;
          s.agents.push(instance);
          return true;
        });
        if (reserved) break;
        await delay(200);
      }
      let session: RuntimeSession | undefined,
        started = false;
      try {
        const info = state.runtimes.find((r) => r.id === profile.runtime);
        const adapter =
          this.adapter?.(profile) ??
          (info?.status === "ready" ? new ProtocolAdapter(info) : undefined);
        if (!adapter) throw new Error(`runtime not ready: ${profile.runtime}`);
        session = await adapter.open({
          cwd,
          role,
          model: profile.model,
          effort: profile.effort,
          onEvent: (event: RuntimeEvent) =>
            this.emit("runtime", { taskId, agentId: instance.id, ...event }),
          permission: async (request) => {
            const latest = (await this.store.read()).projects.find(
              (p) => p.id === project.id,
            )!;
            const allow =
              !this.stopping &&
              !this.aborts.get(taskId)?.signal.aborted &&
              permissionAllowed(
                {
                  ...latest,
                  grant: latest.grant
                    ? {
                        ...latest.grant,
                        allowedPaths:
                          project.grant?.allowedPaths ??
                          latest.grant.allowedPaths,
                      }
                    : undefined,
                },
                role,
                cwd,
                request,
              );
            this.emit("permission", {
              taskId,
              agentId: instance.id,
              allow,
              method: request.method,
            });
            return allow;
          },
        });
        this.sessions.set(instance.id, { taskId, session });
        await this.store.update("agent.started", (s) => {
          Object.assign(
            s.agents.find((a) => a.id === instance.id)!,
            { status: "running", sessionId: session!.id, pid: session!.pid },
          );
        });
        started = true;
        const timer = setTimeout(() => {
          void session?.cancel().finally(() => session?.close());
        }, grant.maxTaskMinutes * 60_000);
        try {
          const text = await session.prompt(
            `${prompt}\n\n${structured ? resultFormat(outputKeys) : "简洁使用中文回复。"}`,
          );
          await session.close();
          await this.store.update("agent.completed", (s) => {
            Object.assign(
              s.agents.find((a) => a.id === instance.id)!,
              {
                status: "completed",
                finishedAt: new Date().toISOString(),
                summary: redact(text).slice(0, 2000),
              },
            );
          });
          return text;
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        lastError = error;
        await session?.close();
        await this.store.update("agent.failed", (s) => {
          Object.assign(
            s.agents.find((a) => a.id === instance.id)!,
            {
              status:
                this.aborts.get(taskId)?.signal.aborted || this.stopping
                  ? "cancelled"
                  : "failed",
              finishedAt: new Date().toISOString(),
              summary: redact(String(error)).slice(0, 2000),
            },
          );
        });
        if (started) throw error; // A started session may already have edited artifacts; don't silently replay it.
      } finally {
        await session?.close();
        this.sessions.delete(instance.id);
      }
    }
    throw lastError ?? new Error("no authorized runtime available");
  }
  private async askParents(
    task: Task,
    project: Project,
    question: string,
    evidence: string[],
    recommendation: string,
    forceHuman = false,
  ): Promise<string> {
    const rootCause = createHash("sha256")
      .update(question.trim().toLowerCase().replace(/\s+/g, " "))
      .digest("hex");
    const state = await this.store.read();
    const known = [...state.ledger]
      .reverse()
      .find(
        (d) =>
          d.projectId === project.id &&
          d.rootCause === rootCause &&
          (!d.expiresAt || Date.parse(d.expiresAt) > Date.now()),
      );
    if (known && !forceHuman)
      return `${known.rejected ? "Previously rejected: " : ""}${known.answer} (source ${known.source})`;
    const answered = state.decisions.find(
      (d) =>
        d.taskId === task.id &&
        d.rootCause === rootCause &&
        d.status === "resolved" &&
        d.answer,
    );
    if (answered && !forceHuman) return answered.answer!;
    const tried: string[] = [];
    for (const level of forceHuman ? [] : (["lead", "captain"] as const)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = parseResult(
          await this.runAgent(
            task.id,
            project,
            level,
            task.checkout ?? project.path,
            `你是 ${level}，先独立判断能否解决直属下级的问题。只在现有授权内决定，不得扩大产品范围或权限。不能解决时返回 blocked。\n需求：${task.request}\n问题：${question}\n证据：${JSON.stringify(evidence)}\n建议：${recommendation}\n已尝试：${JSON.stringify(tried)}\n现有授权：${JSON.stringify(activeGrant(project))}`,
            task.profile,
          ),
        );
        tried.push(`${level}: ${result.summary}`);
        const decision: DecisionRequest = {
          id: newId("question"),
          taskId: task.id,
          projectId: project.id,
          question,
          rootCause,
          evidence,
          tried: [...tried],
          recommendation,
          level,
          status: result.status === "done" ? "resolved" : "open",
          ...(result.status === "done"
            ? { answer: result.summary, answeredBy: level }
            : {}),
          createdAt: new Date().toISOString(),
        };
        await this.store.update("decision.internal", (s) => {
          s.decisions.push(decision);
          s.tasks.find((t) => t.id === task.id)!.decisions.push(decision.id);
        });
        if (result.action) {
          forceHuman = true;
          break;
        }
        if (result.status === "done") return result.summary;
      }
      if (forceHuman) break;
    }
    await this.store.update("decision.escalated", (s) => {
      const existing = s.decisions.find(
        (d) =>
          d.taskId === task.id &&
          d.rootCause === rootCause &&
          d.level === "human" &&
          d.status === "open",
      );
      if (!existing) {
        const id = newId("question");
        s.decisions.push({
          id,
          taskId: task.id,
          projectId: project.id,
          question,
          rootCause,
          evidence,
          tried,
          recommendation,
          level: "human",
          status: "open",
          createdAt: new Date().toISOString(),
        });
        s.tasks.find((t) => t.id === task.id)!.decisions.push(id);
      }
      s.tasks.find((t) => t.id === task.id)!.status = "waiting_human";
    });
    this.emit("attention", { taskId: task.id, question });
    throw new WaitingForHuman(question);
  }
  private async runTask(id: string) {
    const abort = new AbortController();
    this.aborts.set(id, abort);
    try {
      let { task, project, state } = await this.snapshotTask(id);
      const grant = activeGrant(project);
      if (!grant.actions.includes("write") || !grant.actions.includes("verify"))
        throw new Error("development requires write and verify authorization");
      if (
        state.agents.some(
          (a) =>
            a.taskId === id &&
            a.status === "needs_reconcile" &&
            a.pid &&
            pidAlive(a.pid),
        )
      )
        throw new Error(
          "previous runtime process still exists; reconcile it before retry",
        );
      await this.store.update("task.planning", (s) => {
        s.tasks.find((t) => t.id === id)!.status = "planning";
      });
      if (!task.checkout) {
        const base = await git(
            project.path,
            "rev-parse",
            `${project.baseBranch}^{commit}`,
          ),
          path = join(this.root, ".crewvane", "worktrees", id, "integration");
        const checkout = await addWorktree(project, path, task.branch, base);
        await this.store.update("task.checkout", (s) => {
          Object.assign(
            s.tasks.find((t) => t.id === id)!,
            { checkout, baseCommit: base, integrationHead: base },
          );
        });
      }
      ({ task, project } = await this.snapshotTask(id));
      if (
        (await git(task.checkout!, "rev-parse", "HEAD")) !==
          task.integrationHead ||
        (await changedPaths(task.checkout!)).length
      )
        throw new Error(
          "integration checkout differs from recorded checkpoint; inspect before resuming",
        );
      const captainPlan = parseResult(
        await this.runAgent(
          id,
          project,
          "captain",
          task.checkout!,
          `你是唯一船长，本轮只判断派工是否就绪。宿主会在你回复后实际创建独立队长、工人和验证员，你无需调用工具或创建原生子代理。done 仅表示可以派工，不表示需求已经实现。不能因为你本轮不执行工具而阻塞已获授权的工人。检查目标是否明确、是否在现有授权内；明确则返回 done，outputs.routing 说明安排，evidence 引用给定授权。只有真实范围或权限缺口才 blocked。需求：${task.request}。工序：${task.workflow.template.name}。授权：${JSON.stringify(grant)}`,
          task.profile,
        ),
      );
      if (captainPlan.status !== "done")
        await this.askParents(
          task,
          project,
          captainPlan.question ?? captainPlan.summary,
          captainPlan.evidence,
          captainPlan.recommendation ?? "",
          true,
        );
      const captainId = (await this.store.read()).agents
        .filter((a) => a.taskId === id && a.role === "captain")
        .at(-1)?.id;
      const leadPlan = parseResult(
        await this.runAgent(
          id,
          project,
          "lead",
          task.checkout!,
          `你是临时需求队长，本轮只输出工序执行方案。宿主会在你回复后实际启动登记工人和独立验证员。无需你调用工具、创建原生子代理或实施需求；你的只读角色不妨碍工人执行。done 仅表示计划就绪，不表示实现或测试完成。按给定工序安排，检查需求与授权匹配；不直接找人。范围明确则 status=done，outputs.plan 简述方案，evidence 引用给定授权；仅真实未决问题才 blocked。\n需求：${task.request}\n工序：${JSON.stringify(task.workflow.template)}\n授权：${JSON.stringify(grant)}`,
          task.profile,
          undefined,
          captainId,
        ),
      );
      if (leadPlan.status !== "done")
        await this.askParents(
          task,
          project,
          leadPlan.question ?? leadPlan.summary,
          leadPlan.evidence,
          leadPlan.recommendation ?? "",
        );
      if (task.discussion) {
        await this.store.update("task.proposal_ready", (s) => {
          const t = s.tasks.find((t) => t.id === id)!;
          t.status = "waiting_human";
          t.summary = `${leadPlan.summary}\n${Object.values(leadPlan.outputs).join("\n")}`;
          s.messages.push({
            id: newId("msg"),
            role: "captain",
            taskId: id,
            text: `方案已准备好，确认开工后才启动工人。\n${t.summary}`,
            at: new Date().toISOString(),
          });
        });
        return;
      }
      await this.store.update("task.running", (s) => {
        s.tasks.find((t) => t.id === id)!.status = "running";
        s.messages.push({
          id: newId("msg"),
          role: "captain",
          taskId: id,
          text: `已交给队长：${leadPlan.summary}`,
          at: new Date().toISOString(),
        });
      });
      for (;;) {
        ({ task, project } = await this.snapshotTask(id));
        await this.assertRunning(id);
        const stage = task.workflow.template.stages[task.workflow.stage];
        if (!stage) break;
        if (stage.role === "verifier") {
          if (task.reviewRounds >= 3) {
            await this.askParents(
              task,
              project,
              "独立审查已达到三轮上限，需要人工决定是否另开任务。",
              [],
              "检查实际缺陷和验收范围。",
              true,
            );
            return;
          }
          await this.store.update("verification.round", (s) => {
            s.tasks.find((t) => t.id === id)!.reviewRounds++;
          });
        }
        const inputs: Record<string, string> = {};
        for (const result of task.workflow.results.filter((r) => r.valid))
          for (const worker of result.workers)
            for (const [key, value] of Object.entries(worker.outputs))
              inputs[key] = inputs[key] ? `${inputs[key]}\n${value}` : value;
        let assignments: WorkerAssignment[] | undefined;
        if (stage.parallel > 1) {
          const allocation = parseResult(
            await this.runAgent(
              id,
              project,
              "lead",
              task.checkout!,
              `本轮只拆分当前工序，不实施。为 ${stage.parallel} 个并行工人分配不重叠的具体文件与目标。outputs.assignments 必须是 JSON 数组字符串，每项 {goal:文字,paths:[具体文件路径]}，不能使用通配符；所有路径必须在授权内。需求：${task.request}。工序：${JSON.stringify(stage)}。已有工件：${JSON.stringify(inputs)}。授权路径：${JSON.stringify(grant.allowedPaths)}。禁止路径：${JSON.stringify(grant.forbiddenPaths)}。如不能安全拆分，返回 blocked，不能扩大范围。`,
              task.profile,
              undefined,
              undefined,
              true,
              ["assignments"],
            ),
          );
          if (allocation.status !== "done") {
            await this.askParents(
              task,
              project,
              allocation.question ?? allocation.summary,
              allocation.evidence,
              allocation.recommendation ?? "调整工序并行配置",
            );
            throw new Error("parallel stage needs revised allocation");
          }
          assignments = parseAssignments(
            allocation.outputs.assignments!,
            stage.parallel,
            grant,
          );
        }
        const answers = (await this.store.read()).decisions
          .filter((d) => d.taskId === id && d.status === "resolved")
          .map((d) => ({ question: d.question, answer: d.answer }));
        const stageBase = await git(task.checkout!, "rev-parse", "HEAD");
        const settledWorkers = await Promise.allSettled(
          Array.from({ length: stage.parallel }, async (_, index) => {
            let cwd = task.checkout!,
              branch: string | undefined;
            if (stage.role !== "verifier") {
              const suffix = newId("w");
              branch = `${task.branch}-${stage.id}-${suffix}`;
              cwd = await addWorktree(
                project,
                join(this.root, ".crewvane", "worktrees", id, suffix),
                branch,
                stageBase,
              );
            }
            const assignment = assignments?.[index];
            const workerProject: Project = assignment
              ? {
                  ...project,
                  grant: { ...grant, allowedPaths: assignment.paths },
                }
              : project;
            let result: StageResult | undefined;
            for (let attempt = 0; attempt <= stage.retries; attempt++) {
              await this.assertRunning(id);
              const latestState = await this.store.read(),
                lead = latestState.agents
                  .filter((a) => a.taskId === id && a.role === "lead")
                  .at(-1)?.id;
              const followups = latestState.messages
                .filter(
                  (m) =>
                    m.taskId === id &&
                    m.role === "human" &&
                    m.text !== task.request,
                )
                .slice(-12)
                .map((m) => m.text);
              const prompt = `你是 ${stage.role}，直属上级是需求队长。独立执行工序 ${stage.name}。禁止原生子代理、对外操作、读取秘密、修改权限；不要 git commit，宿主收集并提交。Verifier 严格只读，仅报告真实错误。\n需求：${task.request}\n用户补充：${JSON.stringify(followups)}\n工序目标：${stage.goal}\n完成标准：${stage.completion}\n必须输出字段：${JSON.stringify(stage.outputs)}\n并行工人：${index + 1}/${stage.parallel}，只承担第 ${index + 1} 份不重叠工作，避免与其他工人重复修改。\n本工人分工：${JSON.stringify(assignment ?? { goal: stage.goal, paths: grant.allowedPaths })}\n已有工件：${JSON.stringify(inputs)}\n直属上级的已解决问题：${JSON.stringify(answers)}\n允许路径：${JSON.stringify(grant.allowedPaths)}\n禁止路径：${JSON.stringify(grant.forbiddenPaths)}\n项目验证命令：${JSON.stringify(project.checks)}\n当前返工意见：${JSON.stringify(
                task.workflow.results
                  .filter((r) => !r.valid)
                  .slice(-2)
                  .map((r) => r.workers),
              )}\n${result ? `上次结果：${JSON.stringify(result)}` : ""}`;
              try {
                result = parseResult(
                  await this.runAgent(
                    id,
                    workerProject,
                    stage.role,
                    cwd,
                    prompt,
                    task.profile,
                    stage.profile,
                    lead,
                    true,
                    stage.outputs,
                  ),
                );
                if (
                  stage.outputs.some(
                    (key) =>
                      typeof result!.outputs[key] !== "string" ||
                      !result!.outputs[key]!.trim(),
                  ) ||
                  !result.evidence.length
                )
                  throw new Error(
                    `missing stage artifacts/evidence: ${stage.id}`,
                  );
              } catch (e) {
                if (attempt === stage.retries) throw e;
                result = {
                  status: "blocked",
                  summary: String(e),
                  evidence: [],
                  outputs: {},
                  question: "请按 StageResult JSON 格式返回真实执行结果。",
                };
                continue;
              }
              if (result.status !== "blocked") break;
              const answer = await this.askParents(
                task,
                project,
                result.question!,
                result.evidence,
                result.recommendation ?? "",
                !!result.action,
              );
              answers.push({ question: result.question!, answer });
            }
            if (!result || result.status === "blocked")
              throw new Error("stage exhausted its retry budget");
            if (
              stage.outputs.some(
                (key) =>
                  typeof result!.outputs[key] !== "string" ||
                  !result!.outputs[key]!.trim(),
              ) ||
              !result.evidence.length
            )
              throw new Error(`missing stage artifacts/evidence: ${stage.id}`);
            if (stage.role === "verifier") {
              if (
                (await git(cwd, "rev-parse", "HEAD")) !== stageBase ||
                (await changedPaths(cwd)).length
              )
                throw new Error("verifier modified the integration checkout");
              return { result, commit: stageBase };
            }
            await this.assertRunning(id);
            return {
              result,
              commit: await commitChanges(
                workerProject,
                cwd,
                stageBase,
                `${task.title}: ${stage.name} ${index + 1}`,
              ),
            };
          }),
        );
        const failure = settledWorkers.find((w) => w.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const workers = settledWorkers.map(
          (w) =>
            (
              w as PromiseFulfilledResult<{
                result: StageResult;
                commit: string;
              }>
            ).value,
        );
        for (const worker of workers)
          if (worker.commit !== stageBase && stage.role !== "verifier") {
            await this.assertRunning(id);
            const commits = (
              await git(
                project.path,
                "rev-list",
                "--reverse",
                `${stageBase}..${worker.commit}`,
              )
            )
              .split("\n")
              .filter(Boolean);
            for (const commit of commits)
              await git(task.checkout!, "cherry-pick", commit);
          }
        await assertScope(project, task.checkout!, task.baseCommit!);
        const head = await git(task.checkout!, "rev-parse", "HEAD"),
          rework = workers.find((w) => w.result.status === "rework");
        if (
          rework &&
          (task.workflow.round >= stage.retries ||
            (stage.role === "verifier" &&
              (await this.snapshotTask(id)).task.reviewRounds >= 3))
        ) {
          await this.store.update("verification.exhausted", (s) => {
            const t = s.tasks.find((t) => t.id === id)!;
            t.workflow.results.push({
              stageId: stage.id,
              round: t.workflow.round,
              workers: workers.map((w) => w.result),
              commit: head,
              valid: false,
            });
          });
          await this.askParents(
            task,
            project,
            "独立审查或返工已达到本次预算上限，需要决定后续范围。",
            workers.flatMap((w) => w.result.evidence),
            "检查仍未满足的验收条件，必要时另开需求。",
            true,
          );
          return;
        }
        await this.store.update("stage.completed", (s) => {
          const t = s.tasks.find((t) => t.id === id)!;
          t.workflow.results.push({
            stageId: stage.id,
            round: t.workflow.round,
            workers: workers.map((w) => w.result),
            commit: head,
            valid: !rework,
          });
          t.integrationHead = head;
          if (rework) {
            const target = t.workflow.template.stages.findIndex(
              (st) => st.id === stage.returnTo,
            );
            if (target < 0 || t.workflow.round >= stage.retries)
              throw new Error("rework budget exceeded or no return target");
            const invalid = new Set(
              t.workflow.template.stages.slice(target).map((st) => st.id),
            );
            for (const result of t.workflow.results)
              if (invalid.has(result.stageId)) result.valid = false;
            t.workflow.stage = target;
            t.workflow.round++;
          } else t.workflow.stage++;
          t.summary = workers
            .map((w) => w.result.summary)
            .join("\n")
            .slice(0, 3000);
        });
      }
      ({ task, project } = await this.snapshotTask(id));
      await this.assertRunning(id);
      const checks: string[] = [];
      for (const argv of project.checks) {
        await this.assertRunning(id);
        checks.push(
          `${JSON.stringify(argv)}\n${await command(argv, task.checkout!, { timeout: 5 * 60_000, signal: abort.signal, env: { CREWVANE_AGENT: "1" } })}`,
        );
      }
      if (
        (await changedPaths(task.checkout!)).length ||
        (await git(task.checkout!, "rev-parse", "HEAD")) !==
          task.integrationHead
      )
        throw new Error(
          "verification changed source; independent verification must run again",
        );
      const evidenceDir = join(this.root, ".crewvane", "evidence", id);
      await mkdir(evidenceDir, { recursive: true });
      const report = `# ${task.title}\n\n${task.summary}\n\n## 独立验证\n${task.workflow.results
        .filter((r) => r.valid)
        .map(
          (r) =>
            `- ${r.stageId}: ${r.workers.map((w) => w.summary).join("; ")}`,
        )
        .join(
          "\n",
        )}\n\n## 完整分支检查\n\n${checks.join("\n\n")}\n\nVerified head: ${task.integrationHead}\n`;
      await writeFile(join(evidenceDir, "report.md"), redact(report), {
        mode: 0o600,
      });
      if (grant.actions.includes("publish_pr")) {
        await this.assertRunning(id);
        await this.store.update("task.publish_intent", (s) => {
          s.tasks.find((t) => t.id === id)!.publishIntent =
            task.integrationHead;
        });
        const pr = await publishPR(project, task, report, abort.signal);
        await this.store.update("task.published", (s) => {
          s.tasks.find((t) => t.id === id)!.pr = pr;
        });
      }
      await this.store.update("task.completed", (s) => {
        const t = s.tasks.find((t) => t.id === id)!;
        t.status = "completed";
        t.summary = `${t.summary}\n验证报告：${join(evidenceDir, "report.md")}`;
        s.messages.push({
          id: newId("msg"),
          role: "captain",
          taskId: id,
          text: `${t.title} 已完成。${t.pr ? `PR: ${t.pr}` : "结果保存在独立分支，未授权发布 PR。"}`,
          at: new Date().toISOString(),
        });
      });
    } catch (error) {
      if (error instanceof WaitingForHuman) return;
      await this.store.update("task.interrupted", (s) => {
        const t = s.tasks.find((t) => t.id === id)!;
        t.status = t.cancelledAt
          ? "cancelled"
          : this.stopping
            ? "needs_reconcile"
            : "failed";
        t.error = redact(String(error)).slice(0, 5000);
      });
    }
  }
}
