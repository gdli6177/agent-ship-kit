import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  Inbox,
  LayoutList,
  MessageCircle,
  Moon,
  Paperclip,
  Search,
  Send,
  Settings2,
  Sparkles,
  Sun,
  Target,
  X,
} from "lucide-react";

const STATUS = {
  reply: { label: "等你回复", tone: "reply", attention: true },
  waiting: { label: "等待外部", tone: "waiting", attention: true },
  review: { label: "等你验收", tone: "review", attention: true },
  blocked: { label: "需要你排障", tone: "blocked", attention: true },
  running: { label: "管家处理中", tone: "running", attention: false },
  handedOff: { label: "已交管家", tone: "running", attention: false },
  approved: { label: "已验收", tone: "done", attention: false },
  done: { label: "已完成", tone: "done", attention: false },
};

const initialGoals = [
  {
    id: "login",
    title: "发布登录改版",
    context: "登录体验升级",
    statusKey: "reply",
    updatedAt: "17:43",
    message: `我把发布前的情况整理了一下。24 项回归已经全部通过，报告附在下面。

目前唯一没底的是企业 SSO，还没有用真实账号走过。我建议先给普通账号放 10%，观察 24 小时。你要是更想今天就收尾，也可以全量，但一旦出问题，影响面会大很多，回滚也更重。

你怎么想？直接告诉我就好。`,
    attachments: [
      { name: "回归报告.md", detail: "24 / 24 项，含失败用例追踪" },
      { name: "回滚预案.md", detail: "功能开关、旧入口与观察指标" },
    ],
    history: [
      { author: "你", time: "16:44", text: "企业 SSO 会不会被这次灰度覆盖？" },
      { author: "管家", time: "16:46", text: "不会，企业入口仍然走旧流程。不过企业账号的新登录流程还没有用过真实账号验证。" },
      { author: "你", time: "16:51", text: "回滚开关验证过吗？" },
      { author: "管家", time: "16:57", text: "验证过了，两分钟内可以切回旧入口。" },
    ],
  },
  {
    id: "payment",
    title: "开通支付测试环境",
    context: "沙箱密钥",
    statusKey: "waiting",
    updatedAt: "16:20",
    message: `我在 16:20 又问了 YR 一次，对方说今天 18:00 前把沙箱密钥发过来。

负责人那边的联调脚本已经准备好了，拿到密钥就能继续。现在不需要你做什么；如果对方提前联系你，把结果告诉我就行。`,
    attachments: [],
    history: [
      { author: "管家", time: "15:12", text: "已向 YR 发出第一次跟进。" },
      { author: "负责人", time: "15:46", text: "联调脚本已完成，当前停在等待密钥。" },
    ],
  },
  {
    id: "research",
    title: "整理本周访谈结论",
    context: "8 次用户访谈",
    statusKey: "review",
    updatedAt: "17:32",
    message: `访谈都整理完了，我也先看了一遍。

8 位受访者都提到首次设置步骤太多。大家主要卡在邀请同事、补公司资料和选择模板这三处。负责人建议先把必填项从 5 项减到 2 项，其余内容等首次成功后再补。

完整文档和 8 份原始记录索引都在下面。请看一下这一版是否可以作为最终结论。`,
    attachments: [
      { name: "访谈结论.md", detail: "完整结论、主题归纳与下一步建议" },
      { name: "原始记录索引.csv", detail: "8 位受访者、日期和原话位置" },
    ],
    history: [
      { author: "负责人", time: "16:51", text: "已补齐企业客户与个人用户的差异说明。" },
      { author: "管家", time: "17:24", text: "已校对摘要与原文索引，没有发现断链。" },
    ],
  },
  {
    id: "herdr",
    title: "恢复测试环境连接",
    context: "Herdr 工作现场",
    statusKey: "blocked",
    updatedAt: "17:06",
    message: `测试环境连接连续失败了三次。助手已经重试并切换到备用端口，但登录凭据仍在系统钥匙串里，我无法继续读取。

这件事需要你在工作现场完成一次系统授权。完成后不用回来改状态，直接告诉我就行。`,
    attachments: [],
    history: [
      { author: "负责人", time: "16:42", text: "已确认不是 Herdr 服务本身掉线。" },
      { author: "管家", time: "16:58", text: "备用端口仍被系统权限拦截。" },
    ],
  },
  {
    id: "cleanup",
    title: "清理图片附件",
    context: "工作区维护",
    statusKey: "running",
    updatedAt: "15:18",
    message: `管家正在清理已经结束目标中的过期图片。

清理前会保留引用位置和文件摘要，当前无需你处理。`,
    attachments: [],
    history: [],
  },
  {
    id: "report",
    title: "整理九月产品复盘",
    context: "产品复盘",
    statusKey: "done",
    updatedAt: "昨天",
    message: "复盘已经完成并通过验收。结论文档保存在项目目录中。",
    attachments: [{ name: "九月产品复盘.md", detail: "已验收成果" }],
    history: [],
  },
];

const navItems = [
  { id: "attention", label: "注意力", icon: Inbox },
  { id: "all", label: "全部目标", icon: LayoutList },
];

function resolveGoal(goal) {
  return { ...goal, status: STATUS[goal.statusKey] };
}

function RawMessage({ text }) {
  return (
    <div className="raw-message" aria-label="管家消息原文">
      {text}
    </div>
  );
}

function AppHeader({ theme, onToggleTheme, viewLabel }) {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark">
          <img src="/assets/crewvane-mage.png" alt="" />
        </span>
        <strong>Crewvane</strong>
        <small>协航</small>
      </div>
      <div className="breadcrumb">
        <span>我的工作台</span>
        <ChevronRight size={13} />
        <strong>{viewLabel}</strong>
      </div>
      <div className="header-tools">
        <span className="prototype-badge">交互原型</span>
        <span className="concierge-online"><i />管家在线</span>
        <button
          className="icon-button"
          type="button"
          aria-label={theme === "dark" ? "切换浅色" : "切换深色"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </div>
    </header>
  );
}

function NavigationRail({ activeView, onChangeView, attentionCount }) {
  return (
    <nav className="nav-rail" aria-label="主导航">
      {navItems.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={activeView === id ? "active" : ""}
          type="button"
          title={label}
          aria-label={label}
          onClick={() => onChangeView(id)}
        >
          <span className="nav-icon">
            <Icon size={19} />
            {id === "attention" && attentionCount ? <b>{attentionCount}</b> : null}
          </span>
          <small>{label}</small>
        </button>
      ))}
      <span className="nav-spacer" />
      <button type="button" aria-label="设置" title="设置">
        <span className="nav-icon"><Settings2 size={19} /></span>
        <small>设置</small>
      </button>
    </nav>
  );
}

function StatusPill({ status, compact = false }) {
  return (
    <span className={`status-pill ${status.tone}${compact ? " compact" : ""}`}>
      <i />
      {status.label}
    </span>
  );
}

function GoalList({ goals, activeView, selectedId, onOpen }) {
  const [query, setQuery] = useState("");
  const visibleGoals = useMemo(() => {
    const scopedGoals = goals.filter((goal) =>
      activeView === "attention" ? goal.status.attention : true,
    );
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return scopedGoals;
    return scopedGoals.filter((goal) =>
      `${goal.title} ${goal.context} ${goal.status.label}`
        .toLocaleLowerCase("zh-CN")
        .includes(normalized),
    );
  }, [activeView, goals, query]);

  const heading = activeView === "all" ? "全部目标" : "注意力";
  const label = activeView === "all" ? "所有事项" : "需要你关注";

  return (
    <aside className="goal-list">
      <div className="goal-list-heading">
        <div>
          <span className="eyebrow">{activeView === "all" ? "ALL GOALS" : "ATTENTION"}</span>
          <h1>{heading}</h1>
        </div>
        <span>{visibleGoals.length}</span>
      </div>
      <label className="search-box">
        <Search size={15} />
        <input
          aria-label="搜索目标"
          placeholder="搜索目标"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="list-label">{label}</div>
      <div className="goal-list-items">
        {visibleGoals.map((goal) => (
          <button
            key={goal.id}
            type="button"
            className={selectedId === goal.id ? "goal-list-item selected" : "goal-list-item"}
            onClick={() => onOpen(goal.id)}
          >
            <span className={`goal-mark ${goal.status.tone}`} />
            <span className="goal-list-copy">
              <strong>{goal.title}</strong>
              <small>{goal.context} · {goal.updatedAt}</small>
            </span>
            <StatusPill status={goal.status} compact />
            <ArrowRight className="goal-arrow" size={14} />
          </button>
        ))}
        {!visibleGoals.length ? (
          <p className="empty-list">
            {query ? "没有匹配的目标" : "这里已经清空，可以专心做下一件事。"}
          </p>
        ) : null}
      </div>
      <div className="list-note">
        <span><Bot size={16} /></span>
        <p>
          <strong>只和管家对话</strong>
          <small>消息原样到达；后续由管家继续协调。</small>
        </p>
      </div>
    </aside>
  );
}

function Overview({ goals, onOpen }) {
  const attention = goals.filter((goal) => goal.status.attention);
  const lead = attention[0] ?? goals[0];
  const rest = attention.slice(1);

  return (
    <main className="overview">
      <section className="overview-hero">
        <span className="eyebrow">ATTENTION, NOT MANAGEMENT</span>
        <h2>看一条交接，<br />决定下一步。</h2>
        <p>Agent 的信息保持原样。状态只回答“为什么找你”，操作只提供当前能做的事。</p>
      </section>

      {lead ? (
        <button className="focus-card" type="button" onClick={() => onOpen(lead.id)}>
          <span className="focus-mark"><MessageCircle size={20} /></span>
          <span className="focus-copy">
            <span className="focus-kicker">
              <StatusPill status={lead.status} compact />
              <small>{lead.updatedAt} 更新</small>
            </span>
            <strong>{lead.title}</strong>
            <p>{lead.context} · 管家已经把需要判断的内容放在这里。</p>
          </span>
          <span className="focus-action">查看交接 <ArrowUpRight size={15} /></span>
        </button>
      ) : null}

      <div className="overview-grid">
        {rest.map((goal) => (
          <button key={goal.id} type="button" onClick={() => onOpen(goal.id)}>
            <span className={`overview-state ${goal.status.tone}`}>
              <Clock3 size={16} />
            </span>
            <span>
              <StatusPill status={goal.status} compact />
              <strong>{goal.title}</strong>
              <p>{goal.context} · {goal.updatedAt}</p>
            </span>
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>

      <div className="focus-rule">
        <span><Target size={15} /></span>
        <p><strong>注意力不是收件箱</strong>目标进入这里，只因为现在确实需要你看一眼。</p>
      </div>
    </main>
  );
}

function ActionReceipt({ receipt }) {
  return (
    <div className="action-receipt" role="status">
      <span><Check size={17} /></span>
      <p>
        <strong>{receipt.title}</strong>
        <small>{receipt.detail}</small>
      </p>
    </div>
  );
}

function ReplyComposer({
  id,
  value,
  placeholder,
  label,
  submitLabel,
  onChange,
  onSubmit,
  onCancel,
}) {
  return (
    <form className="reply-form" onSubmit={onSubmit}>
      <label htmlFor={`reply-${id}`}>{label}</label>
      <div className="reply-box">
        <textarea
          id={`reply-${id}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoFocus
        />
        <button type="button" className="attach-button" aria-label="添加图片或文件">
          <Paperclip size={17} />
        </button>
      </div>
      <div className="inline-actions">
        <button className="text-button" type="button" onClick={onCancel}>
          取消
        </button>
        <span>回复只会发给管家</span>
        <button className="primary-button" type="submit" disabled={!value.trim()}>
          <Send size={15} /> {submitLabel}
        </button>
      </div>
    </form>
  );
}

function HandoffModal({
  goal,
  open,
  onOpenChange,
  theme,
  reply,
  onReplyChange,
  receipt,
  onReceipt,
  onStatusChange,
  onNotify,
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [replyOpen, setReplyOpen] = useState(goal.statusKey === "reply");
  const [returnMode, setReturnMode] = useState(false);

  useEffect(() => {
    setHistoryOpen(false);
    setReplyOpen(goal.statusKey === "reply");
    setReturnMode(false);
  }, [goal.id]);

  function sendReply(event) {
    event.preventDefault();
    const value = reply.trim();
    if (!value) return;

    if (returnMode) {
      onStatusChange(goal.id, "handedOff");
      onReceipt(goal.id, {
        title: "已退回给管家",
        detail: "你的原话已送达。管家会带着修改意见交给负责人，结果回来后会重新进入注意力。",
      });
      setReturnMode(false);
      setReplyOpen(false);
      onReplyChange("");
      return;
    }

    onReceipt(goal.id, {
      title: "已交给管家",
      detail: "你的原话已经写回目标，状态保持不变；后续由管家明确更新。",
    });
    setReplyOpen(false);
    onReplyChange("");
  }

  function acceptReview() {
    onStatusChange(goal.id, "approved");
    onReceipt(goal.id, {
      title: "验收已记录",
      detail: "管家会收尾这个目标。你无需再回来修改状态。",
    });
    setReplyOpen(false);
    setReturnMode(false);
  }

  function openReply(mode = false) {
    setReturnMode(mode);
    setReplyOpen(true);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="handoff-modal" data-theme={theme}>
          <Dialog.Title className="sr-only">目标详情：{goal.title}</Dialog.Title>
          <Dialog.Description className="sr-only">
            管家发送的原始消息、附件，以及由当前状态决定的处理操作。
          </Dialog.Description>

          <header className="modal-header">
            <div className="modal-origin">
              <span><Sparkles size={15} /></span>
              <p>
                <small>管家交接</small>
                <strong>{goal.context}</strong>
              </p>
            </div>
            <div className="modal-header-actions">
              <StatusPill status={goal.status} />
              <button
                className="icon-button"
                type="button"
                aria-label="关闭目标详情"
                onClick={() => onOpenChange(false)}
              >
                <X size={17} />
              </button>
            </div>
          </header>

          <div className="modal-scroll">
            <article className="modal-content">
              <header className="goal-heading">
                <span className="goal-context">{goal.updatedAt} 更新</span>
                <h2>{goal.title}</h2>
              </header>

              <section className="handoff-message">
                <div className="message-meta">
                  <span><Bot size={15} /></span>
                  <strong>管家发来一段消息</strong>
                  <small>{goal.updatedAt}</small>
                </div>
                <RawMessage text={goal.message} />
              </section>

              {goal.attachments.length ? (
                <section className="attachment-section" aria-label="附件">
                  <div className="section-label">
                    <span>附件</span>
                    <small>{goal.attachments.length}</small>
                  </div>
                  <div className="attachment-list">
                    {goal.attachments.map((attachment) => (
                      <button
                        type="button"
                        key={attachment.name}
                        onClick={() => onNotify(`${attachment.name} · 原型中展示打开行为`)}
                      >
                        <span className="file-mark"><FileText size={17} /></span>
                        <span>
                          <strong>{attachment.name}</strong>
                          <small>{attachment.detail}</small>
                        </span>
                        <ArrowUpRight size={14} />
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {goal.history.length ? (
                <section className="history-section">
                  <button
                    className="history-toggle"
                    type="button"
                    onClick={() => setHistoryOpen(!historyOpen)}
                    aria-expanded={historyOpen}
                  >
                    <Clock3 size={14} />
                    <span>此前消息</span>
                    <small>{goal.history.length} 条</small>
                    <ChevronDown className={historyOpen ? "open" : ""} size={14} />
                  </button>
                  {historyOpen ? (
                    <div className="history-items">
                      {goal.history.map((item) => (
                        <div key={`${item.author}-${item.time}-${item.text}`}>
                          <span>{item.author}</span>
                          <small>{item.time}</small>
                          <p>{item.text}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </article>
          </div>

          <footer className="action-dock">
            {receipt ? (
              <div className="receipt-row">
                <ActionReceipt receipt={receipt} />
                <button className="text-button" type="button" onClick={() => onOpenChange(false)}>
                  关闭
                </button>
              </div>
            ) : goal.status.tone === "reply" || replyOpen ? (
              <ReplyComposer
                id={goal.id}
                value={reply}
                placeholder={
                  returnMode
                    ? "说说哪里需要修改，管家会转交负责人"
                    : goal.statusKey === "review"
                      ? "有疑问？直接问管家"
                      : "告诉管家你的想法，不必固定格式"
                }
                label={returnMode ? "退回原因" : "回复管家"}
                submitLabel={returnMode ? "退回并交给管家" : "交给管家"}
                onChange={onReplyChange}
                onSubmit={sendReply}
                onCancel={() => {
                  setReplyOpen(false);
                  setReturnMode(false);
                  onReplyChange("");
                }}
              />
            ) : goal.status.tone === "review" ? (
              <div className="decision-row">
                <div>
                  <span className="action-kicker">等待你的验收</span>
                  <strong>确认后由管家收尾，有问题也可以直接说明。</strong>
                </div>
                <div className="decision-buttons">
                  <button className="secondary-button" type="button" onClick={() => openReply(true)}>
                    退回修改
                  </button>
                  <button className="primary-button" type="button" onClick={acceptReview}>
                    <Check size={16} /> 验收通过
                  </button>
                </div>
                <button className="ask-link" type="button" onClick={() => openReply(false)}>
                  有疑问，问管家 <ArrowRight size={13} />
                </button>
              </div>
            ) : goal.status.tone === "waiting" ? (
              <div className="quiet-row">
                <span className="quiet-icon"><Clock3 size={18} /></span>
                <div>
                  <strong>现在不用处理</strong>
                  <small>管家会在有新结果时把这件事重新带回来。</small>
                </div>
                <button className="secondary-button" type="button" onClick={() => openReply(false)}>
                  有进展，告诉管家
                </button>
              </div>
            ) : goal.status.tone === "blocked" ? (
              <div className="decision-row">
                <div>
                  <span className="action-kicker">需要你到现场完成一次操作</span>
                  <strong>Herdr 会话仍在运行，处理完可以直接回来告诉管家。</strong>
                </div>
                <div className="decision-buttons">
                  <button className="secondary-button" type="button" onClick={() => openReply(false)}>
                    告诉管家
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      onNotify("已请求打开 Herdr 工作现场");
                    }}
                  >
                    <CircleAlert size={16} /> 打开工作现场
                  </button>
                </div>
              </div>
            ) : goal.status.tone === "done" ? (
              <div className="quiet-row done">
                <span className="quiet-icon"><Check size={18} /></span>
                <div>
                  <strong>这个目标已经结束</strong>
                  <small>成果和消息会保留在这里，供以后回看。</small>
                </div>
                <button className="secondary-button" type="button" onClick={() => openReply(false)}>
                  补充说明
                </button>
              </div>
            ) : (
              <div className="quiet-row">
                <span className="quiet-icon"><Bot size={18} /></span>
                <div>
                  <strong>管家正在处理</strong>
                  <small>只有真正需要你时才回到注意力。</small>
                </div>
                <button className="secondary-button" type="button" onClick={() => openReply(false)}>
                  给管家留言
                </button>
              </div>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function App() {
  const [theme, setTheme] = useState("dark");
  const [activeView, setActiveView] = useState("attention");
  const [selectedId, setSelectedId] = useState("login");
  const [open, setOpen] = useState(true);
  const [statusKeys, setStatusKeys] = useState(() =>
    Object.fromEntries(initialGoals.map((goal) => [goal.id, goal.statusKey])),
  );
  const [replies, setReplies] = useState({});
  const [receipts, setReceipts] = useState({});
  const [toast, setToast] = useState("");

  const goals = useMemo(
    () =>
      initialGoals.map((goal) => {
        const statusKey = statusKeys[goal.id] ?? goal.statusKey;
        return resolveGoal({ ...goal, statusKey });
      }),
    [statusKeys],
  );
  const goal = goals.find((item) => item.id === selectedId) ?? goals[0];
  const attentionCount = goals.filter((item) => item.status.attention).length;

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function openGoal(id) {
    setSelectedId(id);
    setOpen(true);
  }

  function changeView(view) {
    setActiveView(view);
  }

  const viewLabel = activeView === "all" ? "全部目标" : "注意力";

  return (
    <div className="prototype-root" data-theme={theme}>
      <AppHeader
        theme={theme}
        viewLabel={viewLabel}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      />
      <div className="app-shell">
        <NavigationRail
          activeView={activeView}
          attentionCount={attentionCount}
          onChangeView={changeView}
        />
        <GoalList
          goals={goals}
          activeView={activeView}
          selectedId={selectedId}
          onOpen={openGoal}
        />
        <Overview goals={goals} onOpen={openGoal} />
      </div>
      <HandoffModal
        goal={goal}
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setReceipts((current) => {
              const next = { ...current };
              delete next[selectedId];
              return next;
            });
          }
        }}
        theme={theme}
        reply={replies[goal.id] ?? ""}
        onReplyChange={(value) => setReplies((current) => ({ ...current, [goal.id]: value }))}
        receipt={receipts[goal.id]}
        onReceipt={(id, value) => setReceipts((current) => ({ ...current, [id]: value }))}
        onStatusChange={(id, value) =>
          setStatusKeys((current) => ({ ...current, [id]: value }))
        }
        onNotify={setToast}
      />
      {toast ? (
        <div className="prototype-toast" role="status">
          <Check size={15} />
          {toast}
        </div>
      ) : null}
    </div>
  );
}
