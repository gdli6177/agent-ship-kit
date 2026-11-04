import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Folder,
  Inbox,
  LayoutList,
  ListChecks,
  Moon,
  Plus,
  Settings2,
  Sparkles,
  SquareTerminal,
  Sun,
  X,
  Zap,
} from "lucide-react";
import {
  attentionGoals,
  attentionKind,
  initialState,
  newId,
} from "../../../packages/core/src/model.js";
import type {
  CrewvaneCommand,
  AgentPreferences,
  Goal,
  Project,
  ShipPolicy,
  Workflow,
  WorkspaceState,
} from "../../../packages/core/src/types.js";
import { api } from "./api.js";
import pixelMark from "../assets/brand/crewvane-mage.png";
import "./style.css";
const HerdrTerminal = lazy(() => import("./terminal.js").then((module) => ({ default: module.HerdrTerminal })));
const pages = {
  home: "注意力",
  goals: "全部目标",
  workflows: "工序",
  settings: "设置",
} as const;
const statusLabel = {
  active: "进行中",
  waiting: "等待中",
  review: "待验收",
  completed: "已完成",
  dropped: "已放弃",
};
const attentionLabel = {
  decision: "需要你决定",
  review: "等待你验收",
  follow_up: "到点该跟进",
  intervention: "会话需要介入",
};
const time = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "";
function IconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
  error,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  error?: string;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className={`modal ${wide ? "wide" : ""}`}>
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description && (
                <Dialog.Description>{description}</Dialog.Description>
              )}
            </div>
            <Dialog.Close className="icon-button" aria-label="关闭">
              <X size={18} />
            </Dialog.Close>
          </div>
          {error && (
            <p className="modal-error" role="alert">
              {error}
            </p>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function App() {
  const [state, setState] = useState<WorkspaceState>(initialState),
    [workspace, setWorkspace] = useState<string>(),
    [page, setPage] = useState<keyof typeof pages>("home");
  const [theme, setTheme] = useState<string>(
      localStorage.getItem("crewvane.theme") === "light" ? "light" : "dark",
    ),
    [collapsed, setCollapsed] = useState(() => localStorage.getItem("crewvane.sidebar-collapsed") === "true");
  const [projectId, setProjectId] = useState(""),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all");
  const [modal, setModal] = useState<
      "new" | "project" | "goal" | "edit" | "delivery" | "workspace" | ""
    >(""),
    [goalId, setGoalId] = useState(""),
    [selectedWorkflowId, setSelectedWorkflowId] = useState("feature"),
    [draft, setDraft] = useState<Workflow>();
  const [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false),
    [pickingWorkspace, setPickingWorkspace] = useState(false),
    [herdr, setHerdr] = useState<any>(),
    [cli, setCli] = useState<any>();
  const [agentOptions, setAgentOptions] = useState<{ kind: string; installed: boolean }[]>([]);
  const [terminal, setTerminal] = useState<{ session: string; title: string; visible: boolean }>();
  const goal = state.goals.find((item) => item.id === goalId),
    project = state.projects.find((item) => item.id === projectId);
  const attention = attentionGoals(state.goals),
    waiting = state.goals.filter(
      (item) => item.status === "waiting" && !attention.includes(item),
    );
  const active = state.goals.filter((item) => item.status === "active"),
    selectedGoals = state.goals.filter(
      (item) =>
        (!projectId || item.projectId === projectId) &&
        (filter === "all" ||
          (filter === "attention"
            ? attention.includes(item)
            : item.status === filter)) &&
        `${item.title} ${item.next}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("crewvane.theme", theme);
  }, [theme]);
  useEffect(() => { localStorage.setItem("crewvane.sidebar-collapsed", String(collapsed)); }, [collapsed]);
  useEffect(() => {
    api
      .environment()
      .then((env) => {
        setWorkspace(env.workspace);
        if (env.workspace)
          return api.command({ type: "snapshot" }).then(setState);
      })
      .catch(showError);
    const unsubscribe = api.subscribe((event) => {
      if (event.state) setState(event.state);
      if (event.workspace) setWorkspace(event.workspace);
      if (event.type === "refresh") {
        setTerminal(undefined);
        void api.command({ type: "snapshot" }).then(setState).catch(showError);
      }
      if (event.type === "diagnostic") setError(event.message);
      if (event.type === "herdr-status") setHerdr(event.status);
      if (event.type === "cli-status") setCli(event.status);
      if (event.type === "open-goal") openGoal(event.goalId);
      if (event.type === "terminal-available") {
        setTerminal(current => current?.session === event.session ? current : { session: event.session, title: event.title, visible: false });
      }
      if (event.type === "terminal-open") {
        setTerminal({ session: event.session, title: event.title, visible: true });
      }
    });
    void api.herdrStatus().then(setHerdr).catch(showError);
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (page === "settings") {
      void api.herdrStatus().then(setHerdr).catch(showError);
      void api.cliStatus().then(setCli).catch(showError);
      void api.agentChoices().then(setAgentOptions).catch(showError);
    }
  }, [page]);
  useEffect(() => {
    if (!error || modal) return;
    const timer = window.setTimeout(() => setError(""), 8_000);
    return () => window.clearTimeout(timer);
  }, [error, modal]);
  function showError(reason: unknown) {
    setError(String(reason).replace(/^Error: /, "")
      .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
  }
  async function openScene(id?: string, terminalOnly = false) {
    if (busy) return;
    setModal("");
    setBusy(true); setError("");
    try { if (terminalOnly) await api.openTerminal(); else await api.openHerdr(id); }
    catch (reason) { showError(reason); }
    finally { setBusy(false); }
  }
  function notify(text: string) {
    setToast(text);
    setTimeout(() => setToast(""), 3500);
  }
  async function execute(command: CrewvaneCommand) {
    setBusy(true);
    setError("");
    try {
      const result = await api.command(command);
      setState(await api.command({ type: "snapshot" }));
      return result;
    } catch (reason) {
      showError(reason);
      throw reason;
    } finally {
      setBusy(false);
    }
  }
  async function pickWorkspace() {
    if (pickingWorkspace) return;
    setPickingWorkspace(true);
    setError("");
    try {
      const selected = await api.selectWorkspace();
      if (selected) {
        setProjectId("");
        setDraft(undefined);
        setGoalId("");
        setModal("");
        setPage("home");
        setWorkspace(selected);
        setState(await api.command({ type: "snapshot" }));
        notify(selected === workspace ? "你已在这个工作区。" : `已打开工作区：${selected.split("/").filter(Boolean).at(-1)}`);
      }
    } catch (reason) {
      showError(reason);
    } finally {
      setPickingWorkspace(false);
    }
  }
  function openGoal(id: string) {
    setGoalId(id);
    setModal("goal");
  }
  function editWorkflow(workflow: Workflow) {
    setSelectedWorkflowId(workflow.id);
    setDraft(structuredClone(workflow));
  }
  async function saveGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const created = await execute({
      type: "goal.intake", text: String(data.get("request")),
      projectId: projectId || undefined,
    }) as Goal;
    setGoalId(created.id);
    setModal("goal");
    notify("目标已保存，正在联系管家。");
    return created;
  }
  return (
    <div className={`app ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <img src={pixelMark} alt="Crewvane" />
          <div>
            <strong>Crewvane</strong>
            <span>协 航</span>
          </div>
        </div>
        <button
          className="workspace-switch"
          aria-label="我的工作台"
          title="查看所有项目和个人事项"
          onClick={() => {
            setPage("home");
            setProjectId("");
            setModal("");
          }}
        >
          <span className="pixel-dot" />
          <span>
            <strong>{state.name}</strong>
            <small>所有项目与个人事项</small>
          </span>
          <ChevronRight size={14} />
        </button>
        <nav aria-label="主导航">
          <button
            aria-label="注意力"
            className={page === "home" ? "active" : ""}
            onClick={() => {
              setPage("home");
              setProjectId("");
            }}
          >
            <Inbox />
            <span>注意力</span>
            {attention.length > 0 && <b>{attention.length}</b>}
          </button>
          <button
            className={page === "goals" && !projectId ? "active" : ""}
            aria-label="全部目标"
            onClick={() => {
              setPage("goals");
              setProjectId("");
            }}
          >
            <LayoutList />
            <span>全部目标</span>
          </button>
          <button
            className={page === "workflows" ? "active" : ""}
            aria-label="工序"
            onClick={() => setPage("workflows")}
          >
            <ListChecks />
            <span>工序</span>
          </button>
          <button
            className={page === "settings" ? "active" : ""}
            aria-label="设置"
            onClick={() => setPage("settings")}
          >
            <Settings2 />
            <span>设置</span>
          </button>
        </nav>
        <div className="projects">
          <small>我的空间</small>
          {state.projects.map((item) => (
            <button
              key={item.id}
              className={projectId === item.id ? "active" : ""}
              onClick={() => {
                setProjectId(item.id);
                setPage("goals");
              }}
            >
              <Folder />
              <span>{item.name}</span>
              <small>
                {
                  state.goals.filter(
                    (goal) =>
                      goal.projectId === item.id &&
                      !["completed", "dropped"].includes(goal.status),
                  ).length
                }
              </small>
            </button>
          ))}
          <button className="add-project" onClick={() => setModal("project")}>
            <Plus />
            <span>添加项目</span>
          </button>
        </div>
        <div className="concierge">
          <div className="concierge-orb">
            <img src={pixelMark} alt="" />
            <i />
          </div>
          <strong>所有事，找管家。</strong>
          <p>你负责方向，管家负责条理。</p>
          <button disabled={!workspace || busy} aria-label="找管家" onClick={() => void openScene()}>
            <SquareTerminal size={15} />
            <span>{busy ? "正在处理…" : state.concierge.status === "ready" ? "回到现场" : "找管家"}</span>
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-footer">
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun /> : <Moon />}
            <span>{theme === "dark" ? "浅色模式" : "深色模式"}</span>
          </button>
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            <ChevronRight className="collapse-icon" />
            <span>收起</span>
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div>
            <span className="tiny-star">✦</span>
            <span>{project?.name ?? state.name}</span>
            <span className="slash">/</span>
            <strong>{pages[page]}</strong>
          </div>
          <div className="top-actions">
            <span className={`live-status ${state.concierge.status}`}>
              <i />
              {state.concierge.status === "ready" ? "管家在线" : "管家待准备"}
            </span>
            <button
              className="primary"
              onClick={() => setModal("new")}
              disabled={!workspace}
            >
              <Plus size={16} />
              新目标
            </button>
          </div>
        </header>
        {error && (
          <div className="error" role="alert">
            <CircleAlert size={16} />
            <span>{error}</span>
            <IconButton label="关闭提示" onClick={() => setError("")}>
              <X size={15} />
            </IconButton>
          </div>
        )}
        {herdr && (herdr.phase === "checking" || herdr.phase === "downloading" || herdr.phase === "error") && (
          <div className={`setup-status ${herdr.phase}`} role="status" aria-live="polite">
            <SquareTerminal size={16} />
            <span>{herdr.detail || "正在检查 Herdr…"}</span>
            {herdr.phase === "error" && <button className="secondary" onClick={() => {
              void api.installHerdr().catch(showError);
            }}>重试准备 Herdr</button>}
          </div>
        )}
        <main>
          {!workspace ? (
            <section className="welcome">
              <img src={pixelMark} alt="Crewvane" />
              <span className="eyebrow">YOUR MIND, CLEARER</span>
              <h1>
                把事情放下，
                <br />
                把方向留住。
              </h1>
              <p>
                一位管家，整理所有项目与个人事项。
                <br />
                只有真正需要你的时刻，才打扰你。
              </p>
              <button
                className="primary large"
                disabled={pickingWorkspace}
                onClick={() => void pickWorkspace()}
              >
                {pickingWorkspace ? "正在准备工作区…" : "选择存储位置并开始"}
                <ArrowRight size={17} />
              </button>
            </section>
          ) : page === "home" ? (
            <div className="content home">
              <section className="intro">
                <div>
                  <span className="eyebrow">
                    {new Intl.DateTimeFormat("zh-CN", {
                      month: "long",
                      day: "numeric",
                      weekday: "long",
                    }).format(new Date())}
                  </span>
                  <h1>
                    {attention.length ? (
                      <>
                        把注意力，<em>留给真正重要的事。</em>
                      </>
                    ) : (
                      <>
                        现在，<em>可以安心了。</em>
                      </>
                    )}
                  </h1>
                  <p>
                    {attention.length
                      ? `有 ${attention.length} 件事需要你。其余的事，管家会继续推进。`
                      : "该你处理的事已经清零。去专注于你想做的事吧。"}
                  </p>
                </div>
                <div className="pixel-scene" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <img src={pixelMark} alt="" />
                </div>
              </section>
              <section className="attention-section">
                <div className="section-heading">
                  <h2>
                    需要你处理 <span>{attention.length || ""}</span>
                  </h2>
                  <small>
                    {attention.length
                      ? "不必盯着其他会话"
                      : "内部进展不会打扰你"}
                  </small>
                </div>
                {attention.length ? (
                  <div className="attention-list">
                    {attention.map((item) => {
                      const kind = attentionKind(item)!;
                      return (
                        <button
                          className={`attention-card ${kind}`}
                          key={item.id}
                          onClick={() => openGoal(item.id)}
                        >
                          <span className="attention-symbol">
                            {kind === "review" ? (
                              <Check />
                            ) : kind === "follow_up" ? (
                              <Clock3 />
                            ) : (
                              <Zap />
                            )}
                          </span>
                          <div>
                            <span className="card-label">
                              {
                                state.projects.find(
                                  (p) => p.id === item.projectId,
                                )?.name
                              }{" "}
                              · {attentionLabel[kind]}
                            </span>
                            <h3>{item.title}</h3>
                            <p>{item.attention?.summary ?? item.next}</p>
                          </div>
                          <span className="card-link">
                            {kind === "review" ? "查看并验收" : "查看下一步"}
                            <ArrowRight size={15} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="clear">
                    <span>✦</span>
                    <div>
                      <h3>此刻，没有等你处理的事。</h3>
                      <p>等待和进行中的事都还在，到了该出现的时候再告诉你。</p>
                    </div>
                  </div>
                )}
              </section>
              <section className="waiting-section">
                <div className="section-heading">
                  <h2>在等待</h2>
                  <small>不用一直记着</small>
                </div>
                {waiting.length ? (
                  waiting.map((item) => (
                    <button
                      className="waiting-row"
                      key={item.id}
                      onClick={() => openGoal(item.id)}
                    >
                      <Clock3 />
                      <div>
                        <strong>{item.title}</strong>
                        <span>
                          {item.owner} · {item.next}
                        </span>
                      </div>
                      <small>
                        {item.remindAt
                          ? `${time(item.remindAt)} 跟进`
                          : "未设提醒"}
                      </small>
                      <ChevronRight />
                    </button>
                  ))
                ) : (
                  <p className="quiet-copy">没有等待中的事项。</p>
                )}
              </section>
              <div className="running">
                <span className="pulse" />
                <span>
                  <strong>{active.length} 个目标</strong>正在推进
                </span>
                <span>·</span>
                <span>工作时不会打扰你</span>
                <button
                  onClick={() => {
                    setFilter("active");
                    setPage("goals");
                  }}
                >
                  查看进展
                  <ArrowUpRight size={13} />
                </button>
              </div>
            </div>
          ) : page === "goals" ? (
            <div className="content">
              <section className="intro">
                <div>
                  <span className="eyebrow">
                    {project ? "项目视角" : "全局视角"}
                  </span>
                  <h1>{project?.name ?? "每件事，都有下一步。"}</h1>
                  <p>
                    {project
                      ? "同一个管家，继续统筹这里的一切。"
                      : "不用记住哪个会话在做什么，这里保留下一步。"}
                  </p>
                </div>
                <button className="primary" onClick={() => setModal("new")}>
                  <Plus size={16} />
                  记录新目标
                </button>
              </section>
              <div className="filter-bar">
                {(
                  [
                    ["all", "全部"],
                    ["attention", "需要处理"],
                    ["waiting", "等待中"],
                    ["active", "进行中"],
                    ["completed", "已完成"],
                  ] as [string, string][]
                ).map(([value, label]) => (
                  <button
                    className={filter === value ? "active" : ""}
                    key={value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
                <input
                  aria-label="搜索目标"
                  placeholder="搜索目标…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="goal-list">
                {selectedGoals.length ? (
                  selectedGoals.map((item) => (
                    <button
                      className="goal-row"
                      key={item.id}
                      onClick={() => openGoal(item.id)}
                    >
                      <span className={`goal-dot ${item.status}`} />
                      <div>
                        <strong>{item.title}</strong>
                        <p>{item.next}</p>
                      </div>
                      <span className={`status-pill ${item.status}`}>
                        {attention.includes(item)
                          ? attentionLabel[attentionKind(item)!]
                          : statusLabel[item.status]}
                      </span>
                      <ChevronRight />
                    </button>
                  ))
                ) : (
                  <div className="empty">
                    <Sparkles />
                    <h3>这里还没有目标</h3>
                    <p>记录一件事，或把它交给管家。</p>
                  </div>
                )}
              </div>
            </div>
          ) : page === "workflows" ? (
            <div className="content">
              <section className="intro">
                <div>
                  <span className="eyebrow">REUSABLE INSTRUCTIONS</span>
                  <h1>工序，只是一份说明书。</h1>
                  <p>
                    每一步一个名称、一段提示词。没有运行时，也没有复杂配置。
                  </p>
                </div>
              </section>
              <div className="workflow-layout">
                <div className="workflow-list">
                  {state.workflows.map((item) => (
                    <button
                      className={selectedWorkflowId === item.id ? "active" : ""}
                      key={item.id}
                      onClick={() => editWorkflow(item)}
                    >
                      <ListChecks />
                      <span>{item.name}</span>
                      <small>{item.steps.length} 步</small>
                    </button>
                  ))}
                  <button
                    className="add-workflow"
                    onClick={() => {
                      const workflow: Workflow = {
                        id: newId("workflow"),
                        name: "我的工序",
                        steps: [
                          {
                            id: newId("step"),
                            name: "第一步",
                            prompt: "说明要做什么，以及怎样算完成。",
                          },
                        ],
                      };
                      editWorkflow(workflow);
                    }}
                  >
                    <Plus size={14} />
                    <span>新建工序</span>
                  </button>
                </div>
                {(draft ??
                  state.workflows.find(
                    (item) => item.id === selectedWorkflowId,
                  )) && (
                  <section className="workflow-editor">
                    <label className="workflow-name">
                      说明书名称
                      <input
                        aria-label="工序模板名称"
                        value={
                          (draft ??
                            state.workflows.find(
                              (item) => item.id === selectedWorkflowId,
                            ))!.name
                        }
                        onChange={(event) => {
                          const current = structuredClone(
                            draft ??
                              state.workflows.find(
                                (item) => item.id === selectedWorkflowId,
                              )!,
                          );
                          current.name = event.target.value;
                          setDraft(current);
                        }}
                      />
                    </label>
                    {(draft ??
                      state.workflows.find(
                        (item) => item.id === selectedWorkflowId,
                      ))!.steps.map((step, index) => (
                      <div className="stage-row" key={step.id}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <button
                          className="icon-button remove-step"
                          aria-label={`删除第 ${index + 1} 步`}
                          disabled={
                            (draft ??
                              state.workflows.find(
                                (item) => item.id === selectedWorkflowId,
                              ))!.steps.length <= 1
                          }
                          onClick={() => {
                            const current = structuredClone(
                              draft ??
                                state.workflows.find(
                                  (item) => item.id === selectedWorkflowId,
                                )!,
                            );
                            current.steps.splice(index, 1);
                            setDraft(current);
                          }}
                        >
                          <X size={14} />
                        </button>
                        <label>
                          工序名称
                          <input
                            aria-label={`第 ${index + 1} 步工序名称`}
                            value={step.name}
                            onChange={(event) => {
                              const current = structuredClone(
                                draft ??
                                  state.workflows.find(
                                    (item) => item.id === selectedWorkflowId,
                                  )!,
                              );
                              current.steps[index]!.name = event.target.value;
                              setDraft(current);
                            }}
                          />
                        </label>
                        <label>
                          提示词说明书
                          <textarea
                            aria-label={`${step.name}的提示词`}
                            value={step.prompt}
                            onChange={(event) => {
                              const current = structuredClone(
                                draft ??
                                  state.workflows.find(
                                    (item) => item.id === selectedWorkflowId,
                                  )!,
                              );
                              current.steps[index]!.prompt = event.target.value;
                              setDraft(current);
                            }}
                          />
                        </label>
                      </div>
                    ))}
                    <div className="workflow-actions">
                      <button
                        className="secondary"
                        onClick={() => {
                          const current = structuredClone(
                            draft ??
                              state.workflows.find(
                                (item) => item.id === selectedWorkflowId,
                              )!,
                          );
                          current.steps.push({
                            id: newId("step"),
                            name: "新工序",
                            prompt: "说明这一步要做什么，以及怎样算完成。",
                          });
                          setDraft(current);
                        }}
                      >
                        <Plus size={14} />
                        添加一步
                      </button>
                      <button
                        className="primary"
                        disabled={!draft || busy}
                        onClick={async () => {
                          if (draft) {
                            try {
                              await execute({
                                type: "workflow.save",
                                workflow: draft,
                              });
                              setDraft(undefined);
                              notify("工序已保存，新目标将使用这份说明。");
                            } catch {
                              /* Keep the draft and show the error. */
                            }
                          }
                        }}
                      >
                        <Check size={14} />
                        保存工序
                      </button>
                    </div>
                  </section>
                )}
              </div>
            </div>
          ) : (
            <Settings
              busy={busy}
              state={state}
              herdr={herdr}
              cli={cli}
              agentOptions={agentOptions}
              saveAgents={async (preferences: AgentPreferences) => {
                await execute({ type: "agents.configure", preferences });
                notify("Agent 偏好已保存，将用于新启动的会话。");
              }}
              savePolicy={async (projectId: string, policy: { shipPolicy: ShipPolicy; approvers: string[] }) => {
                await execute({ type: "project.policy.set", projectId, policy, actor: "你" });
                notify("项目上线策略已更新。");
              }}
              theme={theme}
              setTheme={(value: string) => setTheme(value)}
              onAction={async (action: string) => {
                setBusy(true);
                setError("");
                try {
                  if (action === "herdr") await api.installHerdr();
                  if (action === "cli") {
                    const result = await api.installCli();
                    notify(result.output);
                  }
                  if (action === "concierge") await api.prepareConcierge();
                  setHerdr(await api.herdrStatus());
                  setAgentOptions(await api.agentChoices());
                  setCli(await api.cliStatus());
                  setState(await api.command({ type: "snapshot" }));
                  const ready = await api.herdrStatus();
                  notify(action === "herdr" && ready.phase === "error"
                    ? "本机版本可用，更新检查未完成，可稍后重试。"
                    : action === "herdr" ? `Herdr ${ready.version ?? ""} 已就绪` : "已准备就绪");
                } catch (reason) {
                  showError(reason);
                } finally {
                  setBusy(false);
                }
              }}
              workspace={workspace ?? ""}
              pickWorkspace={() => setModal("workspace")}
              openHerdr={() => void openScene(undefined, true)}
            />
          )}
        </main>
      </div>
      {terminal && <Suspense fallback={null}><HerdrTerminal session={terminal.session} title={terminal.title} theme={theme} visible={terminal.visible && !modal} onClose={() => setTerminal(current => current ? { ...current, visible: false } : current)} /></Suspense>}
      {modal === "workspace" && <Modal title="工作区存储位置" description="这里只设置所有目标、提醒和管家的保存位置，不是选择项目。" error={error} onClose={() => setModal("")}>
        <div className="workspace-location">
          <Folder size={22} />
          <div><strong>{workspace ? "当前工作区" : "先选择一个工作区文件夹"}</strong><p>{workspace || "建议创建一个专门的文件夹，例如 Documents/Crewvane。"}</p></div>
        </div>
        <p className="workspace-help">要处理某个代码项目，请在左侧「项目」旁点 + 添加。切换工作区后，将显示所选目录自己的目标和管家。</p>
        <div className="form-actions">
          <button className="secondary" onClick={() => setModal("")}>返回设置</button>
          <button className="primary" disabled={pickingWorkspace} onClick={() => void pickWorkspace()}>
            {pickingWorkspace ? "正在打开工作区…" : workspace ? "选择其他工作区文件夹" : "选择工作区文件夹"}
          </button>
        </div>
      </Modal>}
      {modal === "new" && (
        <Modal
          error={error}
          title="把事情放下。"
          description="记录一个目标，剩下的交给管家。"
          onClose={() => setModal("")}
        >
          <form
            className="form"
            onSubmit={(event) => void saveGoal(event).catch(() => {})}
          >
            <textarea className="goal-intake" name="request" required autoFocus maxLength={20000} rows={5}
              aria-label="要交给管家的事情"
              placeholder="直接说：要做什么、知道哪些背景、怎样算完成……"
              onKeyDown={event => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                  event.preventDefault(); event.currentTarget.form?.requestSubmit();
                }
              }} />
            <p className="intake-hint">管家会整理目标、项目、工序和下一步。⌘ / Ctrl + Enter 提交。</p>
            {busy && (
              <p className="form-progress" role="status">
                正在记录并联系管家，首次准备可能需要几十秒…
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setModal("")}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                <Sparkles size={15} />
                {busy ? "正在交给管家…" : "交给管家"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "project" && (
        <Modal
          error={error}
          title="添加项目"
          description="在这里创建项目并关联本机目录；目录可留空，仍由同一位管家统筹。"
          onClose={() => setModal("")}
        >
          <form
            className="form"
            onSubmit={async (event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              try {
                await execute({
                  type: "project.add",
                  name: String(data.get("name")),
                  path: String(data.get("path")) || undefined,
                });
                setModal("");
                notify("项目已添加");
              } catch {
                /* execute reports the error in the modal. */
              }
            }}
          >
            <label>
              项目名称
              <input
                name="name"
                required
                autoFocus
                placeholder="例如：数据平台"
              />
            </label>
            <label>
              项目目录（可选）
              <div className="file-input">
                <input name="path" readOnly placeholder="选择本机目录" />
                <button
                  className="secondary"
                  type="button"
                  onClick={async () => {
                    const selected = await api.selectProject();
                    const input =
                      document.querySelector<HTMLInputElement>(
                        'input[name="path"]',
                      );
                    if (input && selected) input.value = selected;
                  }}
                >
                  选择目录
                </button>
              </div>
            </label>
            <div className="modal-actions">
              <button className="primary" disabled={busy}>
                添加项目
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "goal" && goal && (
        <GoalModal
          goal={goal}
          error={error}
          state={state}
          onClose={() => setModal("")}
          execute={execute}
          busy={busy}
          openHerdr={() => void openScene(goal.id)}
          openUrl={(url) => void api.openUrl(url).catch(showError)}
          edit={() => setModal("edit")}
          submit={() => setModal("delivery")}
          retry={async () => {
            setBusy(true); setError("");
            try { await api.dispatchGoal(goal.id); setState(await api.command({ type: "snapshot" })); }
            catch (reason) { showError(reason); }
            finally { setBusy(false); }
          }}
          notify={notify}
        />
      )}
      {modal === "edit" && goal && (
        <GoalEditor
          goal={goal}
          error={error}
          busy={busy}
          execute={execute}
          onClose={() => setModal("goal")}
          onSaved={() => {
            setModal("goal");
            notify("下一步已更新");
          }}
        />
      )}
      {modal === "delivery" && goal && (
        <DeliveryEditor
          goal={goal}
          error={error}
          busy={busy}
          execute={execute}
          onClose={() => setModal("goal")}
          onSaved={() => {
            setModal("goal");
            notify("成果已记录，请核对后验收");
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
type GoalFormProps = {
  goal: Goal;
  error: string;
  busy: boolean;
  execute: (command: CrewvaneCommand) => Promise<unknown>;
  onClose: () => void;
  onSaved: () => void;
};
function GoalEditor({
  goal,
  error,
  busy,
  execute,
  onClose,
  onSaved,
}: GoalFormProps) {
  const localReminder = goal.remindAt
    ? (() => {
        const date = new Date(goal.remindAt);
        return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, 16);
      })()
    : "";
  return (
    <Modal
      title="编辑目标"
      description="修改目标说明或接下来的安排。它不会提交成果，也不会表示等待已经结束。"
      error={error}
      onClose={onClose}
    >
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            await execute({
              type: "goal.update",
              goalId: goal.id,
              patch: {
                title: String(data.get("title")),
                description: String(data.get("description")),
                next: String(data.get("next")),
                owner: String(data.get("owner")),
                waitingFor: String(data.get("owner")),
                status:
                  goal.status === "review"
                    ? undefined
                    : (data.get("status") as "active" | "waiting"),
                remindAt: data.get("remindAt")
                  ? new Date(String(data.get("remindAt"))).toISOString()
                  : null,
              },
            });
            onSaved();
          } catch {
            /* execute reports the error. */
          }
        }}
      >
        <label>
          目标名称
          <input
            name="title"
            defaultValue={goal.title}
            maxLength={160}
            required
          />
        </label>
        <label>
          背景与完成标准
          <textarea
            name="description"
            aria-label="背景与完成标准"
            defaultValue={goal.description}
            required
          />
        </label>
        {goal.status !== "review" && (
          <label>
            当前安排
            <select name="status" defaultValue={goal.status}>
              <option value="active">继续推进</option>
              <option value="waiting">等待他人 / 到时跟进</option>
            </select>
          </label>
        )}
        <label>
          下一步
          <textarea aria-label="下一步" name="next" defaultValue={goal.next} required />
        </label>
        <label>
          等待对象 / 负责人
          <input name="owner" defaultValue={goal.owner} required />
        </label>
        <label>
          跟进提醒
          <input
            name="remindAt"
            type="datetime-local"
            defaultValue={localReminder}
          />
        </label>
        <p className="quiet-copy">
          选择“等待他人 / 到时跟进”后，到提醒时间会进入注意力面板。
        </p>
        <div className="modal-actions">
          <button className="primary" disabled={busy}>
            保存更新
          </button>
        </div>
      </form>
    </Modal>
  );
}
function DeliveryEditor({
  goal,
  error,
  busy,
  execute,
  onClose,
  onSaved,
}: GoalFormProps) {
  return (
    <Modal
      title="提交成果"
      description="写下实际成果与已完成的检查，供最终验收。"
      error={error}
      onClose={onClose}
    >
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            await execute({
              type: "goal.review",
              goalId: goal.id,
              actor: "你",
              delivery: {
                summary: String(data.get("summary")),
                location: String(data.get("location")) || undefined,
                checks: [
                  {
                    name: String(data.get("checkName")),
                    command: String(data.get("checkCommand")),
                    result: "passed",
                    note: String(data.get("checkNote")),
                  },
                ],
              },
            });
            onSaved();
          } catch {
            /* execute reports the error. */
          }
        }}
      >
        <label>
          成果摘要
          <textarea name="summary" placeholder="实际完成了什么？" required />
        </label>
        <label>
          成果位置（可选）
          <input
            name="location"
            placeholder="文件位置、文档或其他可核对的位置"
          />
        </label>
        <label>
          检查名称
          <input
            name="checkName"
            placeholder="例如：人工核对审批结果"
            required
          />
        </label>
        <label>
          实际检查操作
          <input
            name="checkCommand"
            placeholder="实际执行的命令或人工检查步骤"
            required
          />
        </label>
        <label>
          通过依据
          <textarea
            name="checkNote"
            placeholder="写下实际观察到的结果；未检查通过时请继续处理。"
            required
          />
        </label>
        <div className="modal-actions">
          <button className="primary" disabled={busy}>
            提交验收
          </button>
        </div>
      </form>
    </Modal>
  );
}
function WaitingActions({ goal, busy, act }: {
  goal: Goal;
  busy: boolean;
  act: (command: CrewvaneCommand, message: string) => Promise<boolean>;
}) {
  const [action, setAction] = useState<"resume" | "remind" | "">(""),
    [update, setUpdate] = useState(""),
    [reminder, setReminder] = useState(""),
    [validation, setValidation] = useState(""),
    decision = goal.attention?.kind === "decision";
  async function remind(at: string) {
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
      setValidation("请选择未来的提醒时间。"); return;
    }
    if (await act({ type: "goal.remind", goalId: goal.id, at: new Date(timestamp).toISOString() }, "提醒已更新，到时再通知你")) {
      setAction(""); setValidation("");
    }
  }
  return <section className="waiting-actions" aria-label="推进等待事项">
    <div className="section-heading">
      <h3>这件事，接下来怎么走？</h3>
      <span>正在等 {goal.waitingFor || goal.owner}</span>
    </div>
    {decision && <p>{goal.attention?.summary}</p>}
    <div className="waiting-choices">
      <button className="primary" disabled={busy} aria-expanded={action === "resume"}
        onClick={() => { setAction("resume"); setValidation(""); }}>有结果了，继续推进<ArrowRight size={14} /></button>
      <button className="secondary" disabled={busy || goal.dispatch?.status === "pending"}
        onClick={() => void act({ type: "goal.followup", goalId: goal.id }, "跟进请求已保存，正在联系管家")}>请管家跟进</button>
      <button className="secondary" disabled={busy} aria-expanded={action === "remind"}
        onClick={() => { setAction("remind"); setValidation(""); }}>稍后提醒我</button>
    </div>
    {action === "resume" && <form className="form waiting-form" onSubmit={async event => {
      event.preventDefault();
      const saved = decision
        ? await act({ type: "goal.resolve", goalId: goal.id, note: update, actor: "你", outcome: "approved", source: "desktop" },
          "决定已记入批准账本，正在通知管家继续推进")
        : await act({ type: "goal.resume", goalId: goal.id, note: update, mode: "concierge" },
          "等待已结束，正在通知管家继续推进");
      if (saved) setUpdate("");
    }}>
      <label>{decision ? "你的决定原话" : "最新结果与下一步"}
        <textarea autoFocus required maxLength={2000} value={update} onChange={event => setUpdate(event.target.value)}
          placeholder="例如：YR 已批准，按原方案继续开发。" />
      </label>
      <p className="quiet-copy">决定会写入共享账本；管家把更新交给原负责人，没有可用现场时再安排独立负责人。</p>
      <div className="modal-actions">
        <button className="secondary" type="button" disabled={busy} onClick={() => setAction("")}>取消</button>
        {decision ? <button className="secondary danger-action" type="button" disabled={busy || !update.trim()} onClick={() => void act({
          type: "goal.resolve", goalId: goal.id, note: update, actor: "你", outcome: "rejected", source: "desktop",
        }, "决定已记入拒绝账本，管家会按你的决定继续")}>拒绝</button> :
          <button className="secondary" type="button" disabled={busy || !update.trim()} onClick={() => void act({
            type: "goal.resume", goalId: goal.id, note: update, mode: "manual",
          }, "已恢复推进，由你处理")}>我来处理</button>}
        <button className="primary" disabled={busy || !update.trim()}>{decision ? "批准并继续" : "交给管家继续"}</button>
      </div>
    </form>}
    {action === "remind" && <form className="form waiting-form" onSubmit={event => { event.preventDefault(); void remind(reminder); }}>
      <div className="waiting-choices">
        <button type="button" className="secondary" disabled={busy} onClick={() => void remind(new Date(Date.now() + 3_600_000).toISOString())}>1 小时后</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void remind(new Date(Date.now() + 86_400_000).toISOString())}>24 小时后</button>
      </div>
      <label>自定义提醒时间<input type="datetime-local" required value={reminder} onChange={event => setReminder(event.target.value)} /></label>
      {validation && <p role="alert" className="modal-error">{validation}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary" disabled={busy} onClick={() => setAction("")}>取消</button>
        <button className="primary" disabled={busy}>保存提醒</button>
      </div>
    </form>}
  </section>;
}
function GoalModal({
  goal,
  state,
  onClose,
  execute,
  busy,
  openHerdr,
  openUrl,
  edit,
  notify,
  error,
  submit,
  retry,
}: {
  goal: Goal;
  state: WorkspaceState;
  onClose: () => void;
  execute: (command: CrewvaneCommand) => Promise<any>;
  busy: boolean;
  openHerdr: () => void;
  openUrl: (url: string) => void;
  edit: () => void;
  notify: (text: string) => void;
  error: string;
  submit: () => void;
  retry: () => Promise<void>;
}) {
  const current = goal.steps.findIndex((step) => step.id === goal.stageId),
    [note, setNote] = useState(""), [feedback, setFeedback] = useState("");
  const ended = goal.status === "completed" || goal.status === "dropped";
  const kind = attentionKind(goal);
  const needsDecision = goal.status !== "waiting" && (kind === "decision" || kind === "follow_up");
  async function act(command: CrewvaneCommand, message: string) {
    try {
      await execute(command);
      setNote("");
      notify(message);
      return true;
    } catch {
      /* execute reports errors inside this modal. */
      return false;
    }
  }
  return (
    <Modal
      error={error}
      title={goal.title}
      description={`${state.projects.find((item) => item.id === goal.projectId)?.name} · ${statusLabel[goal.status]}`}
      onClose={onClose}
      wide
    >
      <div className="next-step">
        <small>NEXT STEP</small>
        <p>{goal.next}</p>
        <span>
          {goal.owner}
          {goal.remindAt ? ` · ${time(goal.remindAt)} 跟进` : ""}
          {goal.reviewRounds ? ` · 审查 ${goal.reviewRounds}/${goal.reviewLimit ?? 3}` : ""}
        </span>
      </div>
      {goal.status === "waiting" && <WaitingActions key={goal.id} goal={goal} busy={busy} act={act} />}
      <p className="goal-description">{goal.description}</p>
      {!ended && goal.status === "active" && <form className="goal-feedback" onSubmit={async event => {
        event.preventDefault();
        if (await act({ type: "goal.progress", goalId: goal.id, summary: `补充意见：${feedback}`, actor: "你" },
          goal.mode === "concierge" ? "补充意见已保存，正在通知管家；原来的下一步保留" : "补充意见已记录，原来的下一步保留")) setFeedback("");
      }}>
        <label htmlFor={`feedback-${goal.id}`}>补充意见</label>
        <textarea id={`feedback-${goal.id}`} aria-label="补充意见" required maxLength={2000} value={feedback}
          onChange={event => setFeedback(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault(); event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="有新的要求、约束或想法，直接补充…" />
        <div><span>追加到目标动态，不覆盖原来的下一步。</span>
          <button className="secondary" disabled={busy || !feedback.trim()}>{goal.mode === "concierge" ? "发给管家" : "记录意见"}<ArrowRight size={14} /></button>
        </div>
      </form>}
      {goal.dispatch && <p className={`dispatch-note ${goal.dispatch.status}`} role="status">
        {goal.dispatch.status === "pending" ? (goal.dispatch.kind === "follow_up" ? "正在通知管家跟进，目标仍保持等待。" : "正在准备管家并发送更新，你可以先处理其他事情。") :
          goal.dispatch.status === "failed" ? goal.dispatch.detail :
            goal.dispatch.kind === "follow_up" ? `跟进请求已送达管家 · ${time(goal.dispatch.at)}，仍在等待实际结果。` :
            goal.dispatch.kind === "resume" ? `继续推进的更新已送达管家 · ${time(goal.dispatch.at)}。` :
            goal.dispatch.at ? `已通知管家 · ${time(goal.dispatch.at)}` :
            goal.status === "active" && !goal.herdr ? "已通知管家，等待分配独立负责人；尚未确认执行现场。" :
            goal.status === "active" && goal.live?.reachable === false ? "负责人现场暂时不可达，管家将先核查。" :
            goal.status === "active" && goal.herdr ? (goal.live?.reachable === true ? "负责人现场已连接。" : "已登记负责人现场，正在核实连接。") :
            `已通知管家 · ${time(goal.dispatch.at)}`}
      </p>}
      {goal.watchdog && !goal.attention && <p className="dispatch-note">
        {goal.watchdog.contactedAt ? "巡检已请管家核查现场，常规问题会先由管家处理。" : "巡检正在核查这个目标的下一步。"}
      </p>}
      <div className="stage-track">
        {goal.steps.map((step, index) => (
          <span
            className={
              index < current ? "done" : index === current ? "current" : ""
            }
            key={step.id}
          >
            {step.name}
          </span>
        ))}
      </div>
      {goal.delivery && (
        <section className="delivery">
          <div className="section-heading">
            <h3>交付与证据</h3>
            <small>{time(goal.delivery.submittedAt)}</small>
          </div>
          <p>{goal.delivery.summary}</p>
          {goal.delivery.location && <code>{goal.delivery.location}</code>}
          {goal.delivery.url && (
            <button
              className="text-link"
              onClick={() => openUrl(goal.delivery!.url!)}
            >
              {goal.delivery.url}
              <ArrowUpRight size={13} />
            </button>
          )}
          <div className="checks">
            {goal.delivery.checks.map((check, index) => (
              <div key={index}>
                <Check size={14} />
                <strong>{check.name}</strong>
                <code>{check.command}</code>
                <span>{check.note}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="activity">
        <h3>最近动态</h3>
        {goal.activities
          .slice(-4)
          .reverse()
          .map((item) => (
            <div key={item.id}>
              <span>
                {item.actor} · {time(item.at)}
              </span>
              <p>{item.text}</p>
            </div>
          ))}
      </div>
      {!ended && (needsDecision || goal.status === "review") && (
        <label className="decision-input">
          {kind === "decision" && <p className="decision-question">{goal.attention?.summary}</p>}
          {goal.status === "review"
            ? "退回原因（通过验收可不填）"
            : "你的决定 / 下一步"}
          <textarea
            aria-label={goal.status === "review" ? "退回原因" : "你的决定"}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={
              goal.status === "review"
                ? "需要补充或修改什么…"
                : "写下决定，让管家继续推进…"
            }
          />
        </label>
      )}
      <div className="modal-actions goal-actions">
        {!ended && goal.mode === "concierge" && goal.status !== "waiting" && goal.status !== "review" &&
          <button className="secondary" disabled={busy} onClick={() => void act({
            type: "goal.takeover", goalId: goal.id,
          }, "已由你接管，不会再向管家发送后续更新")}>我来处理</button>}
        {!ended && goal.mode === "manual" && goal.status !== "waiting" &&
          <button className="secondary" disabled={busy} onClick={() => void act({
            type: "goal.delegate", goalId: goal.id,
          }, "已重新交给管家，正在联系")}>交给管家</button>}
        {!ended && goal.dispatch?.status === "failed" &&
          <button className="secondary" disabled={busy} onClick={() => void retry()}>
            重试联系管家
          </button>}
        {(goal.herdr || goal.mode === "concierge") && (
          <button className="secondary" disabled={busy} onClick={openHerdr}>
            <SquareTerminal size={14} />
            {goal.herdr ? "回到现场" : "找管家"}
          </button>
        )}
        {goal.status === "review" ? (
          <>
            <button
              className="secondary"
              disabled={busy || !note.trim()}
              onClick={() =>
                void act(
                  { type: "goal.rework", goalId: goal.id, note },
                  "已退回给管家继续处理",
                )
              }
            >
              退回修改
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(
                  {
                    type: "goal.accept",
                    goalId: goal.id,
                    note: note || "已查看成果与检查记录，验收通过。",
                  },
                  "验收完成，这件事可以放下了",
                )
              }
            >
              <Check size={15} />
              验收通过
            </button>
          </>
        ) : (
          !ended && needsDecision && (
            <>
              {kind === "decision" && <button
                className="secondary danger-action"
                disabled={busy || !note.trim()}
                onClick={() => void act({
                  type: "goal.resolve", goalId: goal.id, note, actor: "你",
                  outcome: "rejected", source: "desktop",
                }, "已记入拒绝账本，管家会按你的决定继续")}
              >
                拒绝这个决定
              </button>}
              <button
                className="primary"
                disabled={busy || !note.trim()}
                onClick={() => void act({
                  type: "goal.resolve", goalId: goal.id, note, actor: "你",
                  ...(kind === "decision" ? { outcome: "approved" as const, source: "desktop" as const } : {}),
                }, kind === "decision" ? "已记入批准账本，下一步已更新" : "已记录，下一步已更新")}
              >
                {kind === "decision" ? "批准这个决定" : "记录决定"}
                <ArrowRight size={14} />
              </button>
            </>
          )
        )}
      </div>
      {!ended && <details className="manual-tools">
        <summary>手动处理</summary>
        <p>仅在你自己接管或纠正目标时使用；让管家继续工作请用上方操作。</p>
        <p><strong>补充进展</strong>记录已经发生的事，目标仍会继续；<strong>编辑目标</strong>修改安排；<strong>提交成果</strong>附实际检查并进入待验收。</p>
        {!needsDecision && goal.status !== "review" && (goal.status !== "waiting" || kind !== "follow_up") && <label className="decision-input">
          实际发生了什么？<textarea aria-label="补充进展" value={note} onChange={event => setNote(event.target.value)}
            placeholder="例如：已完成第一轮开发，接下来准备自测。" />
        </label>}
        <div className="modal-actions">
          <button className="secondary" onClick={edit}>编辑目标</button>
          {goal.status !== "review" && <>
            <button className="secondary" disabled={busy} onClick={submit}>提交成果</button>
            {!needsDecision && (goal.status !== "waiting" || kind !== "follow_up") && <button className="secondary" disabled={busy || !note.trim()}
              onClick={() => void act({ type: "goal.progress", goalId: goal.id, summary: note, actor: "你" }, "进展已补充，原来的下一步不变")}>补充进展</button>}
          </>}
          <button className="secondary danger-action" disabled={busy || !note.trim()}
            onClick={() => void act({ type: "goal.drop", goalId: goal.id, note }, "已放弃，记录仍可查看")}>放弃目标</button>
        </div>
      </details>}
    </Modal>
  );
}
function Settings({
  busy,
  state,
  herdr,
  cli,
  theme,
  setTheme,
  onAction,
  workspace,
  pickWorkspace,
  openHerdr,
  agentOptions,
  saveAgents,
  savePolicy,
}: any) {
  return (
    <div className="content settings">
      <section className="intro">
        <div>
          <span className="eyebrow">MAKE IT YOURS</span>
          <h1>只设置必要的。</h1>
          <p>没有运行时管理。你已有的工具，在 Herdr 里自然相遇。</p>
        </div>
      </section>
      <AgentPreferencesEditor key={workspace} preferences={state.agents ?? { concierge: "codex" }} options={agentOptions}
        busy={busy} onSave={saveAgents} />
      <GovernanceEditor projects={state.projects} decisions={state.decisions ?? []} busy={busy} onSave={savePolicy} />
      <section className="setting">
        <div>
          <SquareTerminal />
          <span>
            <h3>Herdr 与全局管家</h3>
            <p>会话由 Herdr 托管，关闭 Crewvane 窗口也不会终止。</p>
            <p>启动时自动检查最新版，并安装 Crewvane 注意力面板插件，无需 Homebrew。</p>
            {herdr?.executable && <code className="tool-location">{herdr.executable}</code>}
          </span>
        </div>
        <div>
          {herdr?.installed ? (
            <span className="ready">
              <i />
              已安装 {herdr.version}
              {herdr.plugin?.phase === "ready" ? " · 注意力面板已接入" : ""}
            </span>
          ) : <span className="setting-progress">{herdr?.detail || "正在检测…"}</span>}
          {herdr?.plugin?.phase === "error" && <span className="setting-progress">{herdr.plugin.detail}</span>}
          <button className="secondary" disabled={busy || herdr?.phase === "checking" || herdr?.phase === "downloading"}
            onClick={() => void onAction("herdr")}>
            {herdr?.phase === "downloading" ? "正在自动安装…" : herdr?.phase === "checking" ? "正在检查…" : herdr?.installed ? "检查更新" : "重试准备"}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void onAction("concierge")}
          >
            {busy ? "正在准备…" : "准备管家"}
          </button>
          <button className="secondary" disabled={busy} onClick={openHerdr}>
            打开 Herdr
          </button>
        </div>
      </section>
      <section className="setting">
        <div>
          <Zap />
          <span>
            <h3>Crewvane 命令行</h3>
            <p>管家通过它读写当前案卷，不能列出或修改其他目标。应用内置，无需另外安装 Node。</p>
            <code>{cli?.path}</code>
          </span>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void onAction("cli")}
        >
          {cli?.installed ? "重新安装" : "安装到 ~/.local/bin"}
        </button>
      </section>
      <section className="setting">
        <div>
          <Folder />
          <span>
            <h3>工作区存储位置</h3>
            <p>
              {workspace}
              <br />
              目标保存在此目录的 .crewvane 中。
            </p>
          </span>
        </div>
        <button className="secondary" onClick={() => void pickWorkspace()}>
          更换工作区
        </button>
      </section>
      <section className="setting">
        <div>
          <Bell />
          <span>
            <h3>只提醒该看的</h3>
            <p>决定、验收和到期跟进会提醒你。会话卡点先交给管家，无法恢复时再请你介入。</p>
          </span>
        </div>
        <span className="ready">
          <i />
          按规则提醒
        </span>
      </section>
      <section className="setting">
        <div>
          {theme === "dark" ? <Moon /> : <Sun />}
          <span>
            <h3>外观</h3>
            <p>深夜像素或清爽日光，任务始终清晰。</p>
          </span>
        </div>
        <button
          className="secondary"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? "切换到浅色" : "切换到深色"}
        </button>
      </section>
      <p className="setting-foot">
        Crewvane 0.4 · 一位管家 · {state.projects.length} 个空间 ·{" "}
        {state.goals.length} 个目标
      </p>
    </div>
  );
}
const shipPolicyLabels: Record<ShipPolicy, string> = {
  "external-approval": "外部审批（默认）",
  auto: "检查通过后自动合并与上线",
  "auto-merge-manual-deploy": "自动合并，上线前审批",
};
function GovernanceEditor({
  projects,
  decisions,
  busy,
  onSave,
}: {
  projects: Project[];
  decisions: WorkspaceState["decisions"];
  busy: boolean;
  onSave: (projectId: string, policy: { shipPolicy: ShipPolicy; approvers: string[] }) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string>();
  return <section className="governance-editor" aria-label="上线策略与决定账本">
    <div className="section-heading">
      <h2>上线策略与决定账本</h2>
      <small>{decisions.length} 条已记住的决定</small>
    </div>
    <p>默认要求外部审批。自动策略只跳过审批，不跳过检查；删数据、停服、花钱、外部发消息、改产品方向、新建或轮换密钥、改权限始终会进入注意力。</p>
    <div className="policy-list">
      {projects.map(project => {
        const open = editing === project.id;
        return <div className="policy-row" key={project.id}>
          <div>
            <strong>{project.name}</strong>
            <span>{shipPolicyLabels[project.policy.shipPolicy]}</span>
            {project.policy.approvers.length > 0 && <small>审批人：{project.policy.approvers.join("、")}</small>}
          </div>
          {!open ? <button className="secondary" disabled={busy} onClick={() => setEditing(project.id)}>配置</button> :
            <form key={`${project.id}-${project.policy.revision}`} onSubmit={async event => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              try {
                await onSave(project.id, {
                  shipPolicy: String(data.get("shipPolicy")) as ShipPolicy,
                  approvers: String(data.get("approvers"))
                    .split(/[\n,，、]/).map(value => value.trim()).filter(Boolean),
                });
                setEditing(undefined);
              } catch {
                /* The parent shows the server error. */
              }
            }}>
              <label>
                上线策略
                <select name="shipPolicy" defaultValue={project.policy.shipPolicy} disabled={busy}>
                  {Object.entries(shipPolicyLabels).map(([value, label]) =>
                    <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              <label>
                外部审批人（可选）
                <input name="approvers" defaultValue={project.policy.approvers.join("、")}
                  placeholder="例如：YR、平台组" disabled={busy} />
              </label>
              <div className="policy-actions">
                <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(undefined)}>取消</button>
                <button className="primary" disabled={busy}>保存策略</button>
              </div>
            </form>}
        </div>;
      })}
    </div>
  </section>;
}
function AgentPreferencesEditor({ preferences, options, busy, onSave }: {
  preferences: AgentPreferences;
  options: { kind: string; installed: boolean }[];
  busy: boolean;
  onSave: (preferences: AgentPreferences) => Promise<void>;
}) {
  const [commands, setCommands] = useState(preferences);
  useEffect(() => { setCommands(preferences); }, [preferences.concierge, preferences.owner, preferences.worker]);
  const installed = options.filter(option => option.installed);
  return <section className="agent-preferences" aria-label="Agent 偏好">
    <div className="section-heading"><h2>Agent 启动命令</h2><small>CLI + 原生参数</small></div>
    <p>填写每个角色的启动命令，可附带模型等原生参数。Crewvane 不替换 CLI，也不借用 Codex 等运行时专属的沙箱参数；已有会话继续工作，新会话使用保存后的命令。</p>
    <form onSubmit={async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      try { await onSave({ concierge: String(data.get("concierge")),
        owner: String(data.get("owner")) || undefined, worker: String(data.get("worker")) || undefined }); }
      catch { /* Parent keeps the existing preferences and displays the error. */ }
    }}>
      <div className="agent-role-grid">
        {(["concierge", "owner", "worker"] as const).map((role, index) => <label key={role}>
          <span>{["管家", "负责人", "工人"][index]}启动命令</span>
          <input name={role} aria-label={`${["管家", "负责人", "工人"][index]}启动命令`} list="installed-agent-commands"
            value={commands[role] ?? ""} onChange={event => setCommands(current => ({ ...current, [role]: event.target.value }))}
            placeholder={role === "concierge" ? "codex" : role === "owner" ? "留空跟随管家" : "留空跟随负责人"}
            required={role === "concierge"} maxLength={2000} disabled={busy} spellCheck={false} />
        </label>)}
      </div>
      <datalist id="installed-agent-commands">{installed.map(option => <option key={option.kind} value={option.kind} />)}</datalist>
      <div className="agent-preference-footer"><small>填写本机任意交互式 CLI 和参数，例如 codex --model gpt-5、npx --yes my-agent。支持绝对路径与 ~/ 路径；自定义 CLI 直接在终端启动，无需 Herdr 类型适配。管家案卷边界由 Crewvane CLI 约束，不是操作系统文件沙箱。环境变量和 shell 表达式请放入自己的启动脚本。</small><button className="secondary" disabled={busy}>保存偏好</button></div>
    </form>
  </section>;
}
createRoot(document.getElementById("root")!).render(<App />);
