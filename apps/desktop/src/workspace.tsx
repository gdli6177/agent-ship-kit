import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Blocks,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Code2,
  ExternalLink,
  FolderCog,
  Inbox,
  LayoutGrid,
  LoaderCircle,
  MessageCircle,
  Moon,
  Navigation,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  Sun,
  Users,
  Workflow,
  X,
} from "lucide-react";
import type {
  Project,
  Task,
  WorkspaceState,
} from "../../../packages/core/src/types.js";
import type { ServiceCommand } from "../../../packages/orchestrator/src/service.js";
import { api } from "./api.js";
import { relativeTime, shortTime, statusText } from "./view.js";

export const pageDefinitions = [
  { id: "inbox", label: "待办", title: "待我决定", icon: Inbox },
  { id: "tasks", label: "目标", title: "全部目标", icon: LayoutGrid },
  { id: "runtimes", label: "运行时", title: "运行时", icon: Blocks },
  { id: "workflows", label: "工序", title: "工序模板", icon: Workflow },
  { id: "projects", label: "项目", title: "项目设置", icon: FolderCog },
] as const;

function statusIcon(status: Task["status"]) {
  if (status === "completed") return <CheckCircle2 size={18} />;
  if (status === "running" || status === "planning")
    return <LoaderCircle className="spin" size={18} />;
  if (status === "waiting_human" || status === "failed")
    return <ShieldAlert size={18} />;
  if (status === "needs_reconcile") return <Clock3 size={18} />;
  return <Circle size={18} />;
}

export function AppRail({
  page,
  questions,
  workspace,
  theme,
  setTheme,
  setPage,
  openTerminal,
}: {
  page: string;
  questions: number;
  workspace?: string;
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  setPage: (page: string) => void;
  openTerminal: () => void;
}) {
  return (
    <aside className="app-rail" aria-label="主导航">
      <button
        type="button"
        className="rail-brand"
        title="Crewvane 协航"
        onClick={() => setPage("tasks")}
      >
        <Navigation size={27} strokeWidth={1.8} />
        <span>Crewvane</span>
        <small>协航</small>
      </button>
      <nav className="rail-nav">
        {pageDefinitions.map((item) => (
          <button
            type="button"
            key={item.id}
            className={page === item.id ? "active" : ""}
            onClick={() => setPage(item.id)}
          >
            <span className="rail-icon">
              <item.icon size={21} />
              {item.id === "inbox" && questions > 0 && (
                <b aria-label={`${questions} 项待决定`}>{questions}</b>
              )}
            </span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className="rail-bottom">
        <button type="button" onClick={openTerminal}>
          <SquareTerminal size={20} />
          终端
        </button>
        <button
          type="button"
          aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          title={theme === "dark" ? "浅色主题" : "深色主题"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
          主题
        </button>
        <button type="button" onClick={() => setPage("settings")}>
          <Settings2 size={20} />
          设置
        </button>
        <span
          className={`rail-connection ${workspace ? "connected" : ""}`}
          title={workspace ?? "尚未打开工作区"}
        />
      </div>
    </aside>
  );
}

export function TaskQueue({
  state,
  selectedProject,
  selectedTaskId,
  setSelectedProject,
  setTaskId,
  newTask,
  pickWorkspace,
}: {
  state: WorkspaceState;
  selectedProject: string;
  selectedTaskId?: string;
  setSelectedProject: (id: string) => void;
  setTaskId: (id?: string) => void;
  newTask: () => void;
  pickWorkspace: () => void;
}) {
  const [query, setQuery] = useState("");
  const project = state.projects.find((item) => item.id === selectedProject);
  const tasks = state.tasks
    .filter(
      (task) =>
        (!selectedProject || task.projectId === selectedProject) &&
        (!query.trim() ||
          `${task.title} ${task.request}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())),
    )
    .reverse();
  const groups = [
    {
      id: "attention",
      label: "需要你决定",
      tasks: tasks.filter((task) =>
        ["waiting_human", "needs_reconcile", "failed"].includes(task.status),
      ),
    },
    {
      id: "active",
      label: "执行中",
      tasks: tasks.filter((task) =>
        ["queued", "planning", "running"].includes(task.status),
      ),
    },
    {
      id: "delivered",
      label: "最近交付",
      tasks: tasks.filter((task) =>
        ["completed", "cancelled"].includes(task.status),
      ),
    },
  ];
  return (
    <aside className="task-queue">
      <header>
        <button type="button" className="project-switcher">
          <span>
            <strong>{project?.name ?? "个人工作区"}</strong>
            <small>{project ? project.baseBranch : "目标与交付队列"}</small>
          </span>
          <ChevronDown size={16} />
        </button>
        <button
          type="button"
          className="new-goal"
          onClick={newTask}
          disabled={!state.projects.length}
        >
          <Plus size={18} />
          新建目标
        </button>
        <label className="queue-search">
          <Search size={16} />
          <input
            aria-label="搜索目标"
            placeholder="搜索目标…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="project-chips" aria-label="项目筛选">
          <button
            type="button"
            className={!selectedProject ? "selected" : ""}
            onClick={() => setSelectedProject("")}
          >
            全部
          </button>
          {state.projects.map((item) => (
            <button
              type="button"
              key={item.id}
              className={item.id === selectedProject ? "selected" : ""}
              onClick={() => setSelectedProject(item.id)}
            >
              {item.name}
            </button>
          ))}
        </div>
      </header>
      <div className="queue-scroll">
        {!state.tasks.length && (
          <div className="queue-empty">
            <Navigation size={24} />
            <strong>还没有目标</strong>
            <span>创建项目和授权后，交代第一个目标。</span>
            <button
              type="button"
              onClick={state.projects.length ? newTask : pickWorkspace}
            >
              {state.projects.length ? "新建目标" : "打开工作区"}
              <ArrowRight size={14} />
            </button>
          </div>
        )}
        {groups.map(
          (group) =>
            group.tasks.length > 0 && (
              <section className="queue-group" key={group.id}>
                <div className="queue-group-title">
                  <span>{group.label}</span>
                  <b>{group.tasks.length}</b>
                </div>
                {group.tasks.map((task) => (
                  <button
                    type="button"
                    key={task.id}
                    className={`queue-item ${task.id === selectedTaskId ? "active" : ""}`}
                    onClick={() => setTaskId(task.id)}
                  >
                    <span className={`queue-status ${task.status}`}>
                      {statusIcon(task.status)}
                    </span>
                    <span className="queue-copy">
                      <strong>{task.title}</strong>
                      <small>
                        <span>{statusText[task.status]}</span>
                        <i>·</i>
                        {task.status === "completed"
                          ? shortTime(task.createdAt)
                          : relativeTime(task.createdAt)}
                      </small>
                      <em>
                        {
                          state.projects.find(
                            (project) => project.id === task.projectId,
                          )?.name
                        }
                      </em>
                    </span>
                  </button>
                ))}
              </section>
            ),
        )}
      </div>
      <footer>
        <span className="connection-dot" />
        <span>
          <strong>
            {state.agents.filter((agent) => agent.status === "running").length}{" "}
            / {state.maxParallel}
          </strong>
          个 Agent 正在工作
        </span>
      </footer>
    </aside>
  );
}

function stageState(task: Task, index: number) {
  const stage = task.workflow.template.stages[index];
  if (
    stage &&
    task.workflow.results.some(
      (result) => result.stageId === stage.id && result.valid,
    )
  )
    return "done";
  if (index === task.workflow.stage && task.status === "failed") return "failed";
  if (index === task.workflow.stage && task.status === "cancelled")
    return "inactive";
  if (task.status === "completed") return "done";
  if (index === task.workflow.stage) return "current";
  return "pending";
}

function evidenceIcon(state: "passed" | "active" | "blocked" | "pending") {
  if (state === "passed") return <CheckCircle2 size={18} />;
  if (state === "active")
    return <LoaderCircle className="spin" size={18} />;
  if (state === "blocked") return <ShieldAlert size={18} />;
  return <Circle size={18} />;
}

export function GoalView({
  task,
  state,
  logs,
  run,
  openChat,
  openTerminal,
}: {
  task: Task;
  state: WorkspaceState;
  logs: { text: string }[];
  run: (command: ServiceCommand) => void;
  openChat: () => void;
  openTerminal: () => void;
}) {
  const project = state.projects.find((item) => item.id === task.projectId),
    decision = state.decisions.find(
      (item) =>
        item.taskId === task.id &&
        item.level === "human" &&
        item.status === "open",
    ),
    agents = state.agents.filter((agent) => agent.taskId === task.id),
    lastResult = [...task.workflow.results]
      .reverse()
      .find((result) => result.valid),
    evidence =
      lastResult?.workers.flatMap((result) => result.evidence).filter(Boolean) ??
      [];
  const complete = task.status === "completed",
    waiting = task.status === "waiting_human" || !!decision,
    failed = task.status === "failed" || task.status === "needs_reconcile",
    active =
      task.status === "running" ||
      task.status === "planning" ||
      task.status === "queued",
    verificationState = complete
      ? "passed"
      : failed || waiting
        ? "blocked"
        : active
          ? "active"
          : "pending",
    verificationRows: {
      label: string;
      detail: string;
      state: "passed" | "active" | "blocked" | "pending";
      icon: ReactNode;
    }[] = [
      {
        icon: <CheckCircle2 size={17} />,
        label: "完整分支检查",
        detail:
          project?.checks.map((check) => check.join(" ")).join(" · ") ??
          "项目验证命令",
        state: verificationState,
      },
      {
        icon: <Code2 size={17} />,
        label: "独立审查",
        detail: `第 ${task.reviewRounds} / 3 轮，只报告会导致错误的问题`,
        state: complete
          ? "passed"
          : task.reviewRounds
            ? active
              ? "active"
              : "blocked"
            : "pending",
      },
      {
        icon: <ShieldCheck size={17} />,
        label: "范围与证据",
        detail: `${task.workflow.results.filter((result) => result.valid).length} 个有效工序结果 · 本地提交可追溯`,
        state: complete
          ? "passed"
          : task.workflow.results.some((result) => result.valid)
            ? "active"
            : "pending",
      },
    ];
  return (
    <div className="goal-view">
      <div className="goal-context">
        <span>{project?.name ?? "项目"}</span>
        <i>/</i>
        <strong>{task.workflow.template.name}</strong>
      </div>
      <header className="goal-heading">
        <div>
          <h1>{task.title}</h1>
          <p>{task.request.split("\n").slice(1).join(" ") || task.request}</p>
        </div>
        <div className="goal-actions">
          <button type="button" onClick={openChat}>
            <MessageCircle size={16} />
            与船长沟通
          </button>
          {task.pr && (
            <button
              type="button"
              className="primary"
              onClick={() => void api.openPR(task.id)}
            >
              查看 PR
              <ExternalLink size={15} />
            </button>
          )}
        </div>
      </header>
      <ol className="stage-progress" aria-label="目标进度">
        {task.workflow.template.stages.map((stage, index) => {
          const current = stageState(task, index);
          return (
            <li key={stage.id} className={current}>
              <span className="stage-line" />
              <span className="stage-marker">
                {current === "done" ? <Check size={17} /> : index + 1}
              </span>
              <strong>{stage.name}</strong>
              <small>
                {current === "done"
                  ? "已完成"
                  : current === "failed"
                    ? "未能完成"
                    : current === "current"
                      ? "当前阶段"
                      : stage.role === "verifier"
                        ? "独立验证"
                        : "等待开始"}
              </small>
            </li>
          );
        })}
      </ol>
      <section
        className={`delivery-card ${complete ? "complete" : waiting ? "waiting" : failed ? "failed" : "active"}`}
      >
        <div className="delivery-heading">
          <span className="delivery-state-icon">
            {complete ? (
              <Check size={24} />
            ) : waiting ? (
              <ShieldAlert size={23} />
            ) : failed ? (
              <X size={23} />
            ) : (
              <LoaderCircle className="spin" size={23} />
            )}
          </span>
          <div>
            <h2>
              {complete
                ? "结果已验证，可以审查。"
                : waiting
                  ? "团队需要你的一个决定。"
                  : failed
                    ? "当前步骤没有通过。"
                    : "团队正在把目标变成可审查的结果。"}
            </h2>
            <p>
              {task.summary ??
                (complete
                  ? "实现已经完成并通过独立验证。上游问题在团队内部处理，没有打断你。"
                  : decision?.question ??
                    "直属上级会先处理执行中的问题，只有船长无法解决时才会通知你。")}
            </p>
          </div>
        </div>
        <div className="delivery-separator" />
        <ul className="acceptance-list">
          {(evidence.length
            ? evidence.slice(0, 4)
            : task.workflow.template.stages
                .slice(0, 3)
                .map((stage) => stage.completion)
          ).map((item, index) => (
            <li key={`${index}-${item}`}>
              <span
                className={`evidence-mark ${
                  complete && evidence.length
                    ? "passed"
                    : active
                      ? "active"
                      : "pending"
                }`}
              >
                {complete && evidence.length ? (
                  <CheckCircle2 size={18} />
                ) : active ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <Circle size={18} />
                )}
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        {decision && (
          <div className="inline-decision">
            <div>
              <small>船长升级给你</small>
              <strong>{decision.question}</strong>
              {decision.recommendation && (
                <span>建议：{decision.recommendation}</span>
              )}
            </div>
            <button
              type="button"
              className="primary"
              onClick={() => document.getElementById("human-decision")?.scrollIntoView({ behavior: "smooth" })}
            >
              处理决定
            </button>
          </div>
        )}
        <section className="verification-panel">
          <div className="verification-title">
            <div>
              <h3>独立验证</h3>
              <span
                className={`verified-badge ${complete ? "passed" : waiting || failed ? "blocked" : active ? "active" : "pending"}`}
              >
                {complete ? "验证通过" : waiting ? "等待决定" : "正在验证"}
              </span>
            </div>
            {task.status === "completed" && (
              <button
                type="button"
                className="quiet-link"
                onClick={() => void api.openEvidence(task.id)}
              >
                打开完整报告
                <ExternalLink size={13} />
              </button>
            )}
          </div>
          <div className="verification-rows">
            {verificationRows.map((row) => (
              <div className={row.state} key={row.label}>
                <span>{row.icon}</span>
                <strong>{row.label}</strong>
                <small>{row.detail}</small>
                {evidenceIcon(row.state)}
              </div>
            ))}
          </div>
          <div className="verification-foot">
            <span>
              验证提交{" "}
              <code>{task.integrationHead?.slice(0, 7) ?? task.baseCommit?.slice(0, 7) ?? "等待提交"}</code>
            </span>
            <span>{shortTime(task.createdAt)}</span>
          </div>
        </section>
      </section>
      {decision && (
        <a className="decision-anchor" id="human-decision" />
      )}
      <section className="team-process">
        <span className="team-icon">
          <Users size={22} />
        </span>
        <div>
          <strong>团队与工序</strong>
          <small>队长统筹 · 工人执行 · 独立验证员复核</small>
        </div>
        <div className="team-runtime">
          <code>
            {agents.find((agent) => agent.role === "worker")?.runtime ??
              state.profiles.find(
                (profile) => profile.id === project?.defaultProfile,
              )?.runtime ??
              "runtime"}
          </code>
          <span>
            {agents.find((agent) => agent.role === "worker")?.model ??
              state.profiles.find(
                (profile) => profile.id === project?.defaultProfile,
              )?.model ??
              "模型由工序配置"}
          </span>
        </div>
        <span className="internal-resolution">
          <i />
          {state.decisions.some(
            (item) =>
              item.taskId === task.id &&
              ["captain", "lead"].includes(item.level) &&
              item.status === "resolved",
          )
            ? "内部问题已由上级解决"
            : "内部问题优先由直属上级处理"}
        </span>
      </section>
      <section className="goal-lower-grid">
        <div>
          <div className="section-kicker">决策记录</div>
          {state.decisions.filter((item) => item.taskId === task.id).length ? (
            state.decisions
              .filter((item) => item.taskId === task.id)
              .map((item) => (
                <article className="decision-row" key={item.id}>
                  <span>
                    {item.level === "human"
                      ? "你的决定"
                      : item.level === "captain"
                        ? "船长决定"
                        : "队长决定"}
                  </span>
                  <strong>{item.question}</strong>
                  <small>
                    {item.status === "resolved"
                      ? item.answer
                      : "等待上级处理"}
                  </small>
                </article>
              ))
          ) : (
            <p className="muted">目前没有需要升级的问题。</p>
          )}
        </div>
        <div>
          <div className="section-kicker">目标控制</div>
          <div className="control-actions">
            {["failed", "needs_reconcile", "waiting_human"].includes(
              task.status,
            ) && (
              <button
                type="button"
                className="primary"
                onClick={() => run({ type: "task.retry", taskId: task.id })}
              >
                {task.discussion ? "确认方案并开工" : "核对后恢复"}
              </button>
            )}
            {!["completed", "cancelled"].includes(task.status) && (
              <button
                type="button"
                className="danger"
                onClick={() => run({ type: "task.cancel", taskId: task.id })}
              >
                停止目标
              </button>
            )}
            <button type="button" onClick={openTerminal}>
              <SquareTerminal size={15} />
              打开终端
            </button>
          </div>
        </div>
      </section>
      {logs.length > 0 && (
        <details className="runtime-details">
          <summary>实时执行日志</summary>
          <pre>{logs.map((entry) => entry.text).join("")}</pre>
        </details>
      )}
    </div>
  );
}

export function CaptainDrawer({
  open,
  close,
  state,
  selectedProject,
  taskId,
  run,
}: {
  open: boolean;
  close: () => void;
  state: WorkspaceState;
  selectedProject: string;
  taskId?: string;
  run: (command: ServiceCommand) => void;
}) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const project = state.projects.find((item) => item.id === selectedProject),
    messages = state.messages.filter(
      (message) =>
        (!selectedProject || message.projectId === selectedProject) &&
        (!taskId || !message.taskId || message.taskId === taskId),
    );
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, open]);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-backdrop" />
        <Dialog.Content className="captain-drawer" aria-describedby={undefined}>
          <header>
            <span className="captain-avatar">
              <Navigation size={20} />
            </span>
            <div>
              <Dialog.Title>船长</Dialog.Title>
              <small>团队内部问题会先逐级解决</small>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭船长对话">
                <X size={18} />
              </button>
            </Dialog.Close>
          </header>
          <div className="captain-messages">
            <article className="captain-intro">
              <span>协航船长</span>
              <p>
                把目标与完成标准交给我。我会安排队长、工人和独立验证员，只有团队无法决定的事才升级给你。
              </p>
            </article>
            {messages.slice(-60).map((message) => (
              <article
                key={message.id}
                className={`captain-message ${message.role}`}
              >
                <small>
                  {message.role === "human" ? "你" : "船长"} ·{" "}
                  {shortTime(message.at)}
                </small>
                <p>{message.text}</p>
              </article>
            ))}
            <div ref={end} />
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!text.trim() || !selectedProject) return;
              run({
                type: "chat.send",
                projectId: selectedProject,
                text,
                taskId,
              });
              setText("");
            }}
          >
            <textarea
              aria-label="给船长发消息"
              placeholder={
                project ? "问进度、补信息，或讨论下一步…" : "先选择一个项目"
              }
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={!project}
            />
            <span>{project?.name ?? "未选择项目"}</span>
            <button
              type="submit"
              className="primary"
              aria-label="发送消息"
              disabled={!project || !text.trim()}
            >
              <Send size={15} />
              发送
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
