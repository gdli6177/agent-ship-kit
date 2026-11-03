import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  DelegationGrant,
  ExecutionProfile,
  Project,
  RuntimeProtocol,
  Task,
  WorkflowStage,
  WorkflowTemplate,
  WorkspaceState,
} from "../../../packages/core/src/types.js";
import { initialState } from "../../../packages/core/src/workflows.js";
import type { ServiceCommand } from "../../../packages/orchestrator/src/service.js";
import { api } from "./api.js";
import { Button, Input, Modal, DesignSystem } from "./ui.js";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  MessageCircle,
  Navigation,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  AppRail,
  CaptainDrawer,
  GoalView,
  TaskQueue,
  pageDefinitions,
} from "./workspace.js";
import { TerminalDrawer } from "./terminal.js";
import { SettingsPage } from "./settings.js";
import { shortTime, statusText } from "./view.js";
import "./style.css";
function App() {
  const [state, setState] = useState<WorkspaceState>(initialState),
    [workspace, setWorkspace] = useState<string>(),
    [page, setPageState] = useState("tasks"),
    [taskId, setTaskId] = useState<string>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [newTask, setNewTask] = useState(false),
    [chatOpen, setChatOpen] = useState(false),
    [terminalOpen, setTerminalOpen] = useState(false),
    [logs, setLogs] = useState<{ taskId: string; text: string }[]>([]),
    [theme, setTheme] = useState<"light" | "dark">(
      () =>
        (localStorage.getItem("crewvane.theme") as "light" | "dark") ??
        "dark",
    );
  const [title, setTitle] = useState(""),
    [workflowId, setWorkflowId] = useState("feature"),
    [taskProfile, setTaskProfile] = useState(""),
    [discussion, setDiscussion] = useState(false),
    [selectedProjectId, setSelectedProjectId] = useState("");
  const selectedProject = state.projects.find(
    (project) => project.id === selectedProjectId,
  );
  const projectInitialized = useRef(false),
    taskInitialized = useRef(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem("crewvane.theme", theme);
  }, [theme]);
  useEffect(() => {
    void api.environment().then((env) => {
      setWorkspace(env.workspace);
      if (env.workspace)
        void api
          .command({ type: "snapshot" })
          .then(setState)
          .catch(() => {});
    });
    return api.subscribe((event) => {
      if (event.type === "snapshot") {
        setState(event.state);
        if (event.workspace) setWorkspace(event.workspace);
      }
      if (event.type === "runtime")
        setLogs((previous) =>
          [
            ...previous,
            { taskId: event.event.taskId, text: event.event.text },
          ].slice(-300),
        );
      if (event.type === "diagnostic") setError(event.message);
    });
  }, []);
  useEffect(() => {
    if (!projectInitialized.current && state.projects[0]) {
      setSelectedProjectId(state.projects[0].id);
      projectInitialized.current = true;
    }
  }, [state.projects]);
  useEffect(() => {
    if (!taskInitialized.current && state.tasks.length) {
      const preferred =
        state.tasks.find((task) =>
          ["running", "waiting_human", "needs_reconcile"].includes(task.status),
        ) ?? state.tasks.at(-1);
      if (preferred) setTaskId(preferred.id);
      taskInitialized.current = true;
    }
  }, [state.tasks]);
  const execute = async (command: ServiceCommand) => {
    setBusy(true);
    setError("");
    try {
      const result = await api.command(command);
      setState(await api.command({ type: "snapshot" }));
      return result;
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
      throw reason;
    } finally {
      setBusy(false);
    }
  };
  const run = (command: ServiceCommand) => {
    void execute(command).catch(() => {});
  };
  const pickWorkspace = async () => {
    try {
      const path = await api.selectWorkspace();
      if (path) {
        setWorkspace(path);
        setState(await api.command({ type: "snapshot" }));
      }
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    }
  };
  const selectProject = (id: string) => {
    setSelectedProjectId(id);
    setTaskId(undefined);
    taskInitialized.current = true;
  };
  const setPage = (next: string) => {
    setPageState(next);
    if (next !== "tasks") setTaskId(undefined);
  };
  const selectedTask = state.tasks.find((task) => task.id === taskId),
    tasks = state.tasks.filter(
      (task) => !selectedProjectId || task.projectId === selectedProjectId,
    ),
    questions = state.decisions.filter(
      (decision) =>
        decision.level === "human" &&
        decision.status === "open" &&
        (!selectedProjectId || decision.projectId === selectedProjectId),
    ),
    active = tasks.filter((task) =>
      ["running", "planning", "queued"].includes(task.status),
    ),
    delivered = tasks.filter((task) => task.status === "completed"),
    workers = state.agents.filter(
      (agent) =>
        ["worker", "verifier"].includes(agent.role) &&
        ["running", "reserved"].includes(agent.status),
    );
  return (
    <DesignSystem appearance={theme}>
      <div className="app-shell" data-theme={theme}>
      <AppRail
        page={page}
        questions={questions.length}
        workspace={workspace}
        theme={theme}
        setTheme={setTheme}
        setPage={setPage}
        openTerminal={() => setTerminalOpen(true)}
      />
      <TaskQueue
        state={state}
        selectedProject={selectedProjectId}
        selectedTaskId={taskId}
        setSelectedProject={selectProject}
        setTaskId={(id) => {
          setTaskId(id);
          setPageState("tasks");
        }}
        newTask={() => setNewTask(true)}
        pickWorkspace={() => void pickWorkspace()}
      />
      <section className="app-main">
        <header className="context-bar">
          <div className="context-path">
            <span>{selectedProject?.name ?? "个人工作区"}</span>
            <i>/</i>
            <strong>
              {selectedTask && page === "tasks"
                ? "目标"
                : page === "settings"
                  ? "设置与集成"
                : pageDefinitions.find((item) => item.id === page)?.title ??
                  "工作台"}
            </strong>
          </div>
          <div className="context-actions">
            <span className="capacity-chip">
              <i className={workers.length ? "working" : ""} />
              {workers.length} / {state.maxParallel} Agent
            </span>
            <button
              type="button"
              className="top-action"
              onClick={() => setTerminalOpen(true)}
            >
              <SquareTerminal size={16} />
              终端
            </button>
            <button
              type="button"
              className="top-action"
              onClick={() => setChatOpen(true)}
            >
              <MessageCircle size={16} />
              船长
            </button>
            <button
              type="button"
              className="top-primary"
              disabled={!state.projects.length}
              onClick={() => setNewTask(true)}
            >
              <Plus size={16} />
              新建目标
            </button>
          </div>
        </header>
        {error && (
          <div role="alert" className="error-banner">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="关闭错误"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <main className="workspace-content">
          {!workspace ? (
            <div className="welcome">
              <div className="sail">
                <Navigation size={38} strokeWidth={1.5} />
              </div>
              <span className="welcome-kicker">CREWVANE · 协航</span>
              <h1>交代目标，团队交付。</h1>
              <p>
                扫描本机已有的 Agent，按工序安排队长和工人。
                <br />
                团队先逐级解决问题，你只处理船长无法决定的事。
              </p>
              <Button className="primary large" onClick={() => void pickWorkspace()}>
                打开工作区
              </Button>
              <small>共享状态保存在本地，项目代码和凭据仍归各自工具所有。</small>
            </div>
          ) : selectedTask && page === "tasks" ? (
            <GoalView
              task={selectedTask}
              state={state}
              logs={logs.filter((entry) => entry.taskId === selectedTask.id).slice(-40)}
              run={run}
              openChat={() => setChatOpen(true)}
              openTerminal={() => setTerminalOpen(true)}
            />
          ) : page === "inbox" ? (
            <div className="overview-page">
              <div className="page-heading">
                <span className="eyebrow">针对你的注意力做减法</span>
                <h1>把精力留给真正的决定。</h1>
                <p>直属上级先处理问题，只有船长无法解决时，才会到这里。</p>
              </div>
              <div className="metrics">
                <div>
                  <small>待你决定</small>
                  <strong>
                    {questions.length}
                    <span>项</span>
                  </strong>
                </div>
                <div>
                  <small>正在推进</small>
                  <strong>
                    {active.length}
                    <span>个目标</span>
                  </strong>
                </div>
                <div>
                  <small>已交付</small>
                  <strong>
                    {delivered.length}
                    <span>个目标</span>
                  </strong>
                </div>
              </div>
              {questions.length ? (
                <div className="decision-list">
                  {questions.map((question) => (
                    <DecisionCard
                      key={question.id}
                      question={question}
                      run={run}
                      open={() => {
                        setTaskId(question.taskId);
                        setPageState("tasks");
                      }}
                    />
                  ))}
                </div>
              ) : (
                <section className="clear-state panel">
                  <span>
                    <Check size={21} />
                  </span>
                  <div>
                    <h2>目前没有需要你决定的事</h2>
                    <p>
                      队长和工人会在授权范围内继续推进，内部问题不会挤进你的收件箱。
                    </p>
                  </div>
                  <Button className="text-btn" onClick={() => setPage("tasks")}>
                    查看团队进展 <ArrowRight size={14} />
                  </Button>
                </section>
              )}
            </div>
          ) : page === "runtimes" ? (
            <div className="settings-page">
              <Runtimes state={state} execute={execute} busy={busy} />
            </div>
          ) : page === "workflows" ? (
            <div className="settings-page">
              <Workflows state={state} execute={execute} />
            </div>
          ) : page === "projects" ? (
            <div className="settings-page">
              <Projects
                state={state}
                execute={execute}
                selectedId={selectedProjectId}
                onSelect={selectProject}
              />
            </div>
          ) : page === "settings" ? (
            <SettingsPage />
          ) : (
            <div className="overview-page">
              <PageTitle
                title="全部目标"
                description="每个目标由独立队长负责，工人共享工作区容量。"
              />
              <div className="metrics compact">
                <div>
                  <small>执行中</small>
                  <strong>{active.length}</strong>
                </div>
                <div>
                  <small>待决定</small>
                  <strong>{questions.length}</strong>
                </div>
                <div>
                  <small>已交付</small>
                  <strong>{delivered.length}</strong>
                </div>
              </div>
              <TaskList
                tasks={tasks}
                state={state}
                open={(id) => {
                  setTaskId(id);
                  setPageState("tasks");
                }}
              />
            </div>
          )}
        </main>
      </section>
      <CaptainDrawer
        open={chatOpen}
        close={() => setChatOpen(false)}
        state={state}
        selectedProject={selectedProjectId}
        taskId={taskId}
        run={run}
      />
      <TerminalDrawer
        open={terminalOpen}
        close={() => setTerminalOpen(false)}
        workspace={workspace}
        cwd={selectedTask?.checkout ?? selectedProject?.path ?? workspace}
        theme={theme}
      />
      {newTask && (
        <Modal title="交代一个新目标" close={() => setNewTask(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void execute({
                type: "task.submit",
                projectId: selectedProjectId,
                request: title,
                workflowId,
                profile: taskProfile || undefined,
                discussion,
              })
                .then((task: Task) => {
                  setNewTask(false);
                  setTitle("");
                  setTaskId(task.id);
                  setPageState("tasks");
                })
                .catch(() => {});
            }}
          >
            <label>
              项目
              <select
                required
                value={selectedProjectId}
                onChange={(event) => {
                  selectProject(event.target.value);
                  setTaskProfile("");
                }}
              >
                <option value="">选择项目</option>
                {state.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                    {!project.grant || project.grant.revokedAt
                      ? "（需要授权）"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              目标与验收
              <textarea
                required
                rows={7}
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="你希望解决什么？做到什么程度算完成？"
              />
            </label>
            <div className="form-row">
              <label>
                工序模板
                <select
                  value={workflowId}
                  onChange={(event) => setWorkflowId(event.target.value)}
                >
                  {state.workflows.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name} · v{workflow.version}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                本次执行配置
                <select
                  value={taskProfile}
                  onChange={(event) => setTaskProfile(event.target.value)}
                >
                  <option value="">按工序 / 项目默认</option>
                  {state.profiles
                    .filter((profile) =>
                      selectedProject?.grant?.profiles.includes(profile.id),
                    )
                    .map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label className="check">
              <Input
                type="checkbox"
                checked={discussion}
                onChange={(event) => setDiscussion(event.target.checked)}
              />
              先沟通方案，由我确认后开工
            </label>
            <p className="help">
              授权内的普通工作由团队自主推进；合并、部署和高风险动作保留人工审批。
            </p>
            <Button
              className="primary"
              disabled={
                busy ||
                !selectedProject?.grant ||
                !!selectedProject.grant.revokedAt
              }
            >
              {busy ? "正在提交…" : discussion ? "创建讨论" : "交给船长"}
            </Button>
          </form>
        </Modal>
      )}
      </div>
    </DesignSystem>
  );
}

function PageTitle({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="page-heading compact">
      <div className="eyebrow">CREWVANE WORKSPACE</div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
function TaskList({
  tasks,
  state,
  open,
}: {
  tasks: Task[];
  state: WorkspaceState;
  open: (id: string) => void;
}) {
  return (
    <div className="task-list panel">
      {!tasks.length ? (
        <div className="empty">还没有需求。交代一个目标，让团队开始推进。</div>
      ) : (
        [...tasks].reverse().map((task) => (
          <Button
            className="task-row"
            onClick={() => open(task.id)}
            key={task.id}
          >
            <span className={`status-dot ${task.status}`} />
            <div>
              <strong>{task.title}</strong>
              <small>
                {state.projects.find((p) => p.id === task.projectId)?.name} ·{" "}
                {task.workflow.template.name} · {shortTime(task.createdAt)}
              </small>
            </div>
            <span className={`pill ${task.status}`}>
              {statusText[task.status]}
            </span>
            <ArrowUpRight className="row-arrow" size={15}/>
          </Button>
        ))
      )}
    </div>
  );
}
function DecisionCard({
  question: q,
  run,
  open,
}: {
  question: WorkspaceState["decisions"][number];
  run: (command: ServiceCommand) => void;
  open: () => void;
}) {
  const [answer, setAnswer] = useState(""),
    [remember, setRemember] = useState(true),
    [rejected, setRejected] = useState(false);
  return (
    <section className="panel decision-card">
      <span className="tag amber">船长需要你的决定</span>
      <h2>{q.question}</h2>
      {q.recommendation && <p>建议：{q.recommendation}</p>}
      <details>
        <summary>团队已经尝试了什么</summary>
        <ul>
          {q.tried.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
        <p className="prewrap">{q.evidence.join("\n")}</p>
      </details>
      <label>
        你的决定
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="给出决定，团队据此继续…"
          rows={3}
        />
      </label>
      <div className="form-row">
        <label className="check">
          <Input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          记入这个项目的决定账本
        </label>
        <label className="check">
          <Input
            type="checkbox"
            checked={rejected}
            onChange={(e) => setRejected(e.target.checked)}
          />
          拒绝并停止需求
        </label>
      </div>
      <div className="toolbar">
        <Button
          className="primary"
          disabled={!answer.trim()}
          onClick={() =>
            run({
              type: "decision.answer",
              decisionId: q.id,
              answer,
              by: "desktop-human",
              remember,
              rejected,
            })
          }
        >
          提交决定
        </Button>
        <Button onClick={open}>查看需求</Button>
      </div>
    </section>
  );
}
function Runtimes({
  state,
  execute,
  busy,
}: {
  state: WorkspaceState;
  execute: (command: ServiceCommand) => Promise<any>;
  busy: boolean;
}) {
  const [runtime, setRuntime] = useState(""),
    [model, setModel] = useState(""),
    [effort, setEffort] = useState(""),
    [name, setName] = useState(""),
    [fallback, setFallback] = useState("");
  const info = state.runtimes.find((r) => r.id === runtime),
    selectedModel = info?.models.find((m) => m.id === model);
  const protocolLabel = (protocol?: RuntimeProtocol) =>
    protocol === "codex-app-server"
      ? "Codex App Server"
      : protocol === "acp"
        ? "ACP"
        : "仅发现";
  const capabilityRows = [
    ["dispatch", "派工"],
    ["stream", "流式"],
    ["cancel", "取消"],
    ["resume", "恢复"],
    ["modelDiscovery", "模型发现"],
    ["interactiveTerminal", "交互终端"],
  ] as const;
  return (
    <>
      <PageTitle
        title="连接你已有的 Agent"
        description="使用运行时自己的登录与模型配置。连接测试通过后，才会用于派工。"
      />
      <div className="toolbar">
        <Button
          className="primary"
          disabled={busy}
          onClick={() => void execute({ type: "scan" }).catch(() => {})}
        >
          {busy ? "扫描中…" : "扫描本机运行时"}
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void execute({ type: "scan", probe: "all" }).catch(() => {})
          }
        >
          测试全部连接
        </Button>
      </div>
      <div className="runtime-grid">
        {state.runtimes.map((r) => (
          <section key={r.id} className="panel runtime-card">
            <div className="section-title">
              <div className="runtime-icon">
                {r.id.slice(0, 1).toUpperCase()}
              </div>
              <span className={`pill ${r.status}`}>{statusText[r.status]}</span>
            </div>
            <h2>{r.name}</h2>
            <p className="muted">
              {r.version ??
                (r.application ? "发现桌面应用" : "本地命令行运行时")}
            </p>
            <small className="path">
              {r.executable ?? r.application ?? "未找到安装位置"}
            </small>
            {r.reason && <p className="runtime-reason">{r.reason}</p>}
            <div className="runtime-protocol">
              <span>
                <small>协议</small>
                <code>{protocolLabel(r.protocol)}</code>
              </span>
              <span>
                <small>启动参数</small>
                <code>
                  {r.launchArgs?.length
                    ? r.launchArgs.join(" ")
                    : "无可调度协议"}
                </code>
              </span>
            </div>
            <div className="runtime-capabilities" aria-label="运行时能力">
              {capabilityRows.map(([key, label]) => (
                <span
                  key={key}
                  className={r.capabilities?.[key] ? "available" : "unavailable"}
                >
                  {r.capabilities?.[key] ? <Check size={12} /> : <X size={12} />}
                  {label}
                </span>
              ))}
            </div>
            <div className="section-title">
              <small>
                {r.models.length ? `${r.models.length} 个模型` : ""}
              </small>
              <Button
                disabled={
                  busy || ["missing", "discovery_only"].includes(r.status)
                }
                onClick={() =>
                  void execute({ type: "scan", probe: r.id }).catch(() => {})
                }
              >
                连接测试
              </Button>
            </div>
          </section>
        ))}
      </div>
      <section className="panel detail-section">
        <h2>执行配置</h2>
        <p className="muted">
          将角色与工具分开：一个执行配置包含运行时、模型和推理强度。
        </p>
        {state.profiles.map((p) => (
          <div className="profile-row" key={p.id}>
            <strong>{p.name}</strong>
            <span>
              {p.runtime} · {p.model}
              {p.effort ? ` · ${p.effort}` : ""}
            </span>
            {p.fallback?.length ? (
              <small>
                回退：
                {p.fallback
                  .map((id) => state.profiles.find((p) => p.id === id)?.name)
                  .join("、")}
              </small>
            ) : null}
          </div>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const id = `profile_${Date.now().toString(36)}`;
            void execute({
              type: "profile.save",
              profile: {
                id,
                name,
                runtime: runtime as ExecutionProfile["runtime"],
                model,
                ...(effort ? { effort } : {}),
                ...(fallback ? { fallback: [fallback] } : {}),
              },
            })
              .then(() => setName(""))
              .catch(() => {});
          }}
        >
          <div className="form-row">
            <label>
              配置名称
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：主力开发"
              />
            </label>
            <label>
              运行时
              <select
                required
                aria-label="运行时"
                value={runtime}
                onChange={(e) => {
                  setRuntime(e.target.value);
                  setModel("");
                  setEffort("");
                }}
              >
                <option value="">选择已连接的运行时</option>
                {state.runtimes
                  .filter((r) => r.status === "ready")
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              模型
              <select
                required
                aria-label="模型"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setEffort("");
                }}
              >
                <option value="">选择实际可用的模型</option>
                {info?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              推理强度
              <select
                aria-label="推理强度"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
              >
                <option value="">运行时默认</option>
                {selectedModel?.efforts?.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
            </label>
            <label>
              允许的回退配置
              <select
                value={fallback}
                onChange={(e) => setFallback(e.target.value)}
              >
                <option value="">不回退</option>
                {state.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button className="primary" disabled={busy || !runtime || !model}>
            保存执行配置
          </Button>
        </form>
      </section>
    </>
  );
}
function Workflows({
  state,
  execute,
}: {
  state: WorkspaceState;
  execute: (command: ServiceCommand) => Promise<any>;
}) {
  const [id, setId] = useState("feature"),
    [draft, setDraft] = useState<WorkflowTemplate>(() =>
      structuredClone(state.workflows[0]!),
    ),
    [saved, setSaved] = useState("");
  const select = (value: string) => {
    setId(value);
    setDraft(structuredClone(state.workflows.find((w) => w.id === value)!));
    setSaved("");
  };
  const change = (index: number, patch: Partial<WorkflowStage>) =>
    setDraft((d) => ({
      ...d,
      stages: d.stages.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  return (
    <>
      <PageTitle
        title="工序可以随任务而变"
        description="定义做事的顺序、交接物和完成标准。每次执行固定模板版本，返工会使后续验证失效。"
      />
      <div className="toolbar">
        <select value={id} onChange={(e) => select(e.target.value)}>
          {state.workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} · v{w.version}
            </option>
          ))}
        </select>
        <Button
          onClick={() => {
            const next = `workflow_${Date.now().toString(36)}`;
            setId(next);
            setDraft({
              ...structuredClone(draft),
              id: next,
              name: "自定义工序",
              version: 0,
            });
          }}
        >
          复制为自定义模板
        </Button>
      </div>
      <label>
        模板名称
        <Input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <div className="workflow-list">
        {draft.stages.map((stage, i) => (
          <section className="panel workflow-editor" key={i}>
            <div className="section-title">
              <span className="stage-number">{i + 1}</span>
              <strong>{stage.name}</strong>
              <div className="toolbar">
                <Button
                  disabled={i === 0}
                  aria-label="上移工序"
                  onClick={() => {
                    const stages = [...draft.stages];
                    [stages[i - 1], stages[i]] = [stages[i]!, stages[i - 1]!];
                    setDraft({ ...draft, stages });
                  }}
                >
                  <ArrowUp size={16}/>
                </Button>
                <Button
                  disabled={i === draft.stages.length - 1}
                  aria-label="下移工序"
                  onClick={() => {
                    const stages = [...draft.stages];
                    [stages[i + 1], stages[i]] = [stages[i]!, stages[i + 1]!];
                    setDraft({ ...draft, stages });
                  }}
                >
                  <ArrowDown size={16}/>
                </Button>
                <Button
                  aria-label="删除工序"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      stages: draft.stages.filter((_, n) => n !== i),
                    })
                  }
                >
                  <X size={16}/>
                </Button>
              </div>
            </div>
            <div className="form-row">
              <label>
                标识
                <Input
                  value={stage.id}
                  onChange={(e) => change(i, { id: e.target.value })}
                />
              </label>
              <label>
                名称
                <Input
                  value={stage.name}
                  onChange={(e) => change(i, { name: e.target.value })}
                />
              </label>
              <label>
                角色
                <select
                  value={stage.role}
                  onChange={(e) =>
                    change(i, { role: e.target.value as WorkflowStage["role"] })
                  }
                >
                  <option value="worker">工人</option>
                  <option value="verifier">独立验证员</option>
                </select>
              </label>
            </div>
            <label>
              目标
              <textarea
                value={stage.goal}
                onChange={(e) => change(i, { goal: e.target.value })}
              />
            </label>
            <div className="form-row">
              <label>
                输入（逗号分隔）
                <Input
                  value={stage.inputs.join(",")}
                  onChange={(e) =>
                    change(i, {
                      inputs: e.target.value
                        .split(",")
                        .map((v) => v.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <label>
                输出（逗号分隔）
                <Input
                  value={stage.outputs.join(",")}
                  onChange={(e) =>
                    change(i, {
                      outputs: e.target.value
                        .split(",")
                        .map((v) => v.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
            </div>
            <label>
              完成标准
              <Input
                value={stage.completion}
                onChange={(e) => change(i, { completion: e.target.value })}
              />
            </label>
            <div className="form-row">
              <label>
                执行配置
                <select
                  value={stage.profile ?? ""}
                  onChange={(e) =>
                    change(i, { profile: e.target.value || undefined })
                  }
                >
                  <option value="">按项目角色默认</option>
                  {state.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                并行工人数
                <Input
                  type="number"
                  min={1}
                  max={8}
                  value={stage.parallel}
                  onChange={(e) =>
                    change(i, { parallel: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                重试上限
                <Input
                  type="number"
                  min={0}
                  max={3}
                  value={stage.retries}
                  onChange={(e) =>
                    change(i, { retries: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                失败返回工序
                <select
                  value={stage.returnTo ?? ""}
                  onChange={(e) =>
                    change(i, { returnTo: e.target.value || undefined })
                  }
                >
                  <option value="">无</option>
                  {draft.stages.slice(0, i).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        ))}
      </div>
      <div className="toolbar">
        <Button
          onClick={() =>
            setDraft({
              ...draft,
              stages: [
                ...draft.stages.slice(0, -1),
                {
                  id: `stage_${draft.stages.length}`,
                  name: "新工序",
                  goal: "定义工序目标",
                  role: "worker",
                  inputs: ["request"],
                  outputs: [`artifact_${draft.stages.length}`],
                  completion: "定义验收标准",
                  parallel: 1,
                  retries: 1,
                },
                ...draft.stages.slice(-1),
              ],
            })
          }
        >
          <Plus size={16}/> 添加工序
        </Button>
        <Button
          className="primary"
          onClick={() => {
            const old = state.workflows.find((w) => w.id === draft.id);
            void execute({
              type: "workflow.save",
              workflow: { ...draft, version: (old?.version ?? 0) + 1 },
            })
              .then((saved: WorkflowTemplate) => {
                setDraft(saved);
                setSaved(`已保存 v${saved.version}，现有需求保持原版本。`);
              })
              .catch(() => {});
          }}
        >
          保存新版本
        </Button>
        {saved && <span className="success">{saved}</span>}
      </div>
    </>
  );
}
function Projects({
  state,
  execute,
  selectedId,
  onSelect,
}: {
  state: WorkspaceState;
  execute: (command: ServiceCommand) => Promise<any>;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const selected = state.projects.find((p) => p.id === selectedId),
    [draft, setDraft] = useState<Omit<Project, "grant" | "shipPolicy">>({
      id: "",
      name: "",
      path: "",
      baseBranch: "main",
      checks: [["pnpm", "test"]],
      roles: {},
    }),
    [checksText, setChecksText] = useState('[["pnpm","test"]]'),
    [grantOpen, setGrantOpen] = useState(false),
    [allowed, setAllowed] = useState(
      "src/**,test/**,tests/**,docs/**,README.md,package.json,pnpm-lock.yaml",
    ),
    [forbidden, setForbidden] = useState("AGENTS.md,.agents/**,.github/**"),
    [publish, setPublish] = useState(false),
    [approvedProfiles, setApprovedProfiles] = useState<string[]>([]),
    [maxParallel, setMaxParallel] = useState(3),
    [minutes, setMinutes] = useState(30);
  useEffect(() => {
    if (selected) {
      const { grant: _, shipPolicy: __, ...p } = selected;
      setDraft(p);
      setChecksText(JSON.stringify(p.checks));
    }
  }, [selectedId, selected?.grant?.revokedAt]);
  const [picking, setPicking] = useState(false);
  const active = selected?.grant && !selected.grant.revokedAt;
  return (
    <>
      <PageTitle
        title="项目与自主执行范围"
        description="由你确定团队的执行边界。授权内的普通工作自主推进，合并和部署保留人工流程。"
      />
      <div className="toolbar">
        <select value={selectedId} onChange={(e) => onSelect(e.target.value)}>
          <option value="">新建项目</option>
          {state.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button
          onClick={() => {
            onSelect("");
            setDraft({
              id: `project_${Date.now().toString(36)}`,
              name: "",
              path: "",
              baseBranch: "main",
              checks: [["pnpm", "test"]],
              roles: {},
            });
          }}
        >
          <Plus size={16}/> 新项目
        </Button>
        {active && (
          <Button
            className="danger"
            onClick={() =>
              void execute({
                type: "grant.revoke",
                projectId: selected!.id,
              }).catch(() => {})
            }
          >
            撤销授权并停止相关任务
          </Button>
        )}
      </div>
      <section className="panel detail-section">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            let checks;
            try {
              checks = JSON.parse(checksText);
            } catch {
              return;
            }
            void execute({
              type: "project.save",
              project: {
                ...draft,
                id: draft.id || `project_${Date.now().toString(36)}`,
                checks,
              },
            })
              .then((p: Project) => onSelect(p.id))
              .catch(() => {});
          }}
        >
          <fieldset disabled={!!active || picking}>
            <div className="form-row">
              <label>
                项目名称
                <Input
                  required
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                基准分支
                <Input
                  required
                  value={draft.baseBranch}
                  onChange={(e) =>
                    setDraft({ ...draft, baseBranch: e.target.value })
                  }
                />
              </label>
            </div>
            <label>
              Git 仓库目录
              <div className="path-picker">
                <Input
                  required
                  readOnly
                  value={draft.path}
                  placeholder="通过文件选择器选择项目"
                />
                <Button
                  type="button"
                  onClick={async () => {
                    setPicking(true);
                    try {
                      const path = await api.selectProject();
                      if (path)
                        setDraft((current) => ({
                          ...current,
                          path,
                          name: current.name || path.split("/").pop()!,
                        }));
                    } finally {
                      setPicking(false);
                    }
                  }}
                >
                  选择目录
                </Button>
              </div>
            </label>
            <label>
              完整分支验证命令（JSON argv 数组）
              <textarea
                required
                value={checksText}
                onChange={(e) => setChecksText(e.target.value)}
                rows={3}
              />
            </label>
            <p className="help">
              示例：[["pnpm","test"],["pnpm","typecheck"]]。只有这些命令可以自动通过运行时执行审批。
            </p>
            <label>
              项目默认执行配置
              <select
                required
                value={draft.defaultProfile ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, defaultProfile: e.target.value })
                }
              >
                <option value="">选择配置</option>
                {state.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-row">
              {(["captain", "lead", "worker", "verifier"] as const).map(
                (role, i) => (
                  <label key={role}>
                    {["船长", "队长", "工人", "验证员"][i]}
                    <select
                      value={draft.roles[role] ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          roles: {
                            ...draft.roles,
                            [role]: e.target.value || undefined,
                          },
                        })
                      }
                    >
                      <option value="">项目默认</option>
                      {state.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ),
              )}
            </div>
            <Button className="primary">保存项目设置</Button>
          </fieldset>
          {active && <p className="help">修改设置前请先撤销当前授权。</p>}
        </form>
      </section>
      {selected && (
        <section className="panel detail-section">
          <div className="section-title">
            <h2>自主执行授权</h2>
            <span className={`pill ${active ? "ready" : "waiting_human"}`}>
              {active ? "已授权" : "尚未授权"}
            </span>
          </div>
          {active ? (
            <>
              <p>允许路径：{selected.grant!.allowedPaths.join("、")}</p>
              <p>禁止路径：{selected.grant!.forbiddenPaths.join("、")}</p>
              <p>
                交付范围：开发、独立验证
                {selected.grant!.actions.includes("publish_pr")
                  ? "、发布分支和创建 PR"
                  : "，结果仅保存在本地分支"}
              </p>
              <p className="muted">
                {selected.grant!.approvedBy} ·{" "}
                {shortTime(selected.grant!.approvedAt)}
              </p>
            </>
          ) : (
            <>
              <p>
                明确可修改的路径、执行配置与预算。此后无需为授权内的普通步骤反复确认。
              </p>
              <Button
                className="primary"
                onClick={() => {
                  setApprovedProfiles(state.profiles.map((p) => p.id));
                  setGrantOpen(true);
                }}
              >
                配置并授权
              </Button>
            </>
          )}
          <p className="help">
            上线策略：external-approval。删数据、停服、花钱、对外发消息、改产品方向、密钥和权限变更，必须升级给你。
          </p>
        </section>
      )}
      <section className="panel detail-section">
        <h2>决定账本</h2>
        {state.ledger
          .filter((d) => !selectedId || d.projectId === selectedId)
          .map((d) => (
            <div className="decision-history" key={d.id}>
              <small>
                {d.rejected ? "已拒绝" : "已决定"} · {d.by} · {shortTime(d.at)}
              </small>
              <strong>{d.question}</strong>
              <p>{d.answer}</p>
            </div>
          ))}
        {!state.ledger.some(
          (d) => !selectedId || d.projectId === selectedId,
        ) && (
          <p className="muted">
            还没有保存的决定。处理升级问题时可以选择记住。
          </p>
        )}
      </section>
      {grantOpen && selected && (
        <Modal
          title={`授权 ${selected.name}`}
          close={() => setGrantOpen(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void execute({
                type: "grant.save",
                projectId: selected.id,
                grant: {
                  approvedBy: "desktop-human",
                  actions: [
                    "read",
                    "write",
                    "verify",
                    ...(publish ? ["publish_pr" as const] : []),
                  ],
                  profiles: approvedProfiles,
                  allowedPaths: allowed
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                  forbiddenPaths: forbidden
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                  maxParallel,
                  maxTaskMinutes: minutes,
                },
              })
                .then(() => setGrantOpen(false))
                .catch(() => {});
            }}
          >
            <label>
              允许修改路径（逗号分隔）
              <textarea
                value={allowed}
                onChange={(e) => setAllowed(e.target.value)}
                rows={3}
              />
            </label>
            <label>
              禁止修改路径
              <textarea
                value={forbidden}
                onChange={(e) => setForbidden(e.target.value)}
              />
            </label>
            <label>允许的执行配置</label>
            {state.profiles.map((p) => (
              <label className="check" key={p.id}>
                <Input
                  type="checkbox"
                  checked={approvedProfiles.includes(p.id)}
                  onChange={(e) =>
                    setApprovedProfiles(
                      e.target.checked
                        ? [...approvedProfiles, p.id]
                        : approvedProfiles.filter((id) => id !== p.id),
                    )
                  }
                />
                {p.name} · {p.runtime} / {p.model}
              </label>
            ))}
            <div className="form-row">
              <label>
                项目工人并发
                <Input
                  type="number"
                  min={1}
                  max={8}
                  value={maxParallel}
                  onChange={(e) => setMaxParallel(Number(e.target.value))}
                />
              </label>
              <label>
                单会话时限（分钟）
                <Input
                  type="number"
                  min={1}
                  max={240}
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </label>
            </div>
            <label className="check">
              <Input
                type="checkbox"
                checked={publish}
                onChange={(e) => setPublish(e.target.checked)}
              />
              允许推送本需求分支并创建 PR
            </label>
            <p className="help">
              不会自动合并或部署。授权只适用于当前项目和选择的执行配置，可以随时撤销。
            </p>
            <Button className="primary" disabled={!approvedProfiles.length}>
              确认授权
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
