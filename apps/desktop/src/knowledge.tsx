import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, FileText, Search, Sparkles } from "lucide-react";
import { TextField } from "@radix-ui/themes";
import type { WorkspaceState } from "../../../packages/core/src/index.js";
import type { knowledgeLibrary } from "../../../packages/orchestrator/src/knowledge.js";
import { api } from "./api.js";
import { Button, Input, Modal } from "./ui.js";

type Library = Awaited<ReturnType<typeof knowledgeLibrary>>;
export function KnowledgePage({ state, projectId }: { state: WorkspaceState; projectId: string }) {
  const project = state.projects.find(p => p.id === projectId);
  const [library, setLibrary] = useState<Library>();
  const [query, setQuery] = useState("");
  const [handbook, setHandbook] = useState("");
  const [rules, setRules] = useState("");
  const [lessons, setLessons] = useState(".crewvane/lessons");
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<{ id: string; status: "active" | "retired" }>();
  const [note, setNote] = useState("");
  const loadedProject = useRef("");
  useEffect(() => {
    let disposed = false;
    if (!projectId) { setLibrary(undefined); return; }
    void api.command({ type: "knowledge.list", projectId, query }).then((data: Library) => {
      if (disposed) return;
      setLibrary(data);
      if (loadedProject.current !== projectId) {
        loadedProject.current = projectId;
        setHandbook(data.config?.handbook ?? "");
        setRules(data.config?.rules.join("\n") ?? "");
        setLessons(data.config?.lessons ?? ".crewvane/lessons");
      }
    }).catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [projectId, query, state.knowledgeRevision]);
  const execute = async (command: Parameters<typeof api.command>[0]) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await api.command(command);
      setLibrary(await api.command({ type: "knowledge.list", projectId, query }));
      return true;
    } catch (reason) { setError(String(reason).replace(/^Error: /, "")); return false; }
    finally { setBusy(false); }
  };
  if (!project) return <div className="empty"><BookOpen size={28} /><h2>为项目积累经验</h2><p>先选择一个项目，即可连接团队手册和可复用经验。</p></div>;
  const cards = library?.cards.filter(c => filter === "all" || (filter === "candidate" ? c.lesson.status === "candidate" || c.lesson.status === "needs_review" : c.lesson.status === filter)) ?? [];
  const completed = state.tasks.filter(t => t.projectId === projectId && t.status === "completed");
  return <div className="knowledge-page">
    <div className="page-heading"><span className="eyebrow">TEAM KNOWLEDGE</span><h1>让经验成为下一次的起点。</h1><p>连接团队手册。把经过验证的做法留下，交给下一个工人。</p></div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="knowledge-notice" role="status"><Check size={15} />{notice}</p>}
    <details className="panel knowledge-sources" open={!library?.config || undefined}>
      <summary><FileText size={17} /><strong>团队手册与必读材料</strong><span>{library?.config ? "已连接 · 查看配置" : "连接项目知识来源"}</span></summary>
      <form onSubmit={event => { event.preventDefault(); void execute({ type: "knowledge.configure", projectId,
        config: { handbook: handbook.trim() || null, rules: rules.split("\n").map(s => s.trim()).filter(Boolean), lessons: lessons.trim() } }).then(ok => { if (ok) setNotice("知识来源已保存。后续工序会加载必读材料，交付后自动提炼经验候选。"); }); }}>
        <label>团队手册路径<Input aria-label="团队手册路径" placeholder="docs/team/handbook.md，也支持外部 Markdown 路径" value={handbook} onChange={event => setHandbook(event.target.value)} /></label>
        <label>其他必读材料<textarea aria-label="其他必读材料" placeholder="每行一个 Markdown 路径" value={rules} onChange={event => setRules(event.target.value)} /></label>
        <label>经验保存位置<Input aria-label="经验保存位置" value={lessons} onChange={event => setLessons(event.target.value)} /></label>
        <p className="muted">沿用项目现有手册和经验格式。原手册保持只读，候选经你审核后才会用于后续任务。</p>
        <Button type="submit" className="primary" disabled={busy}>保存知识来源</Button>
      </form>
    </details>
    <div className="knowledge-toolbar">
      <label className="knowledge-search" htmlFor="knowledge-search-field"><Search size={16} /><TextField.Root id="knowledge-search-field" aria-label="搜索团队知识" placeholder="搜索适用条件、经验或标签…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label="经验状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部经验</option><option value="active">已纳入手册</option><option value="candidate">待审核</option><option value="retired">已停用</option></select>
    </div>
    <div className="knowledge-cards">
      {cards.map(({ lesson, source }) => <article key={lesson.id} className="panel knowledge-card">
        <div className="section-title"><span className={`pill ${lesson.status === "active" ? "ready" : "detected"}`}>{({ candidate: "待审核", active: "可复用", needs_review: "需要复核", retired: "已停用" })[lesson.status]}</span><small>{lesson.tags.join(" · ")}</small></div>
        <h2>{lesson.title}</h2><p>{lesson.summary}</p>
        <dl><dt>适用条件</dt><dd>{lesson.when}</dd><dt>执行方法</dt><dd>{lesson.action}</dd></dl>
        <details><summary>来源与证据</summary><small>{source}</small><p>{lesson.evidence.join("\n")}</p><small>来源任务：{lesson.source_task_id}{lesson.reviewed_by ? ` · 审核：${lesson.reviewed_by}` : ""}</small></details>
        <div className="knowledge-actions">{lesson.status !== "active" && <Button type="button" className="primary" onClick={() => { setReview({ id: lesson.id, status: "active" }); setNote(""); }}>审核并纳入</Button>}{lesson.status !== "retired" && <Button type="button" onClick={() => { setReview({ id: lesson.id, status: "retired" }); setNote(""); }}>停用</Button>}</div>
      </article>)}
      {!cards.length && <div className="empty"><BookOpen size={25} /><h2>{query ? "没有匹配的经验" : "团队的经验，从第一次交付开始"}</h2><p>{query ? "换个关键词，或查看全部经验。" : "连接知识来源后，交付任务会提炼经验候选。你也可以从已完成目标中手动提炼。"}</p></div>}
    </div>
    {!!completed.length && <section className="panel knowledge-deliveries"><h2><Sparkles size={17} />从已完成目标提炼</h2>{completed.slice(-10).reverse().map(task => <div key={task.id}><span><strong>{task.title}</strong><small>{task.learning?.outcome === "pending" ? "正在提炼…" : task.learning?.reason ?? "尚未提炼经验"}</small></span><Button type="button" disabled={busy || task.learning?.outcome === "pending"} onClick={() => void execute({ type: "knowledge.extract", taskId: task.id })}>{task.learning?.outcome === "failed" ? "重试提炼" : "提炼经验"}</Button></div>)}</section>}
    {review && <Modal title={review.status === "active" ? "审核这条经验" : "停用这条经验"} close={() => setReview(undefined)}><form onSubmit={event => { event.preventDefault(); void execute({ type: "knowledge.review", projectId, lessonId: review.id, status: review.status,
      by: project.grant?.approvedBy ?? "local-human", note }).then(ok => { if (ok) { setReview(undefined); setNotice("审核已记录，后续检索将使用更新后的状态。"); } }); }}><p className="muted">确认适用条件、执行方法和来源证据，留下这次判断。</p><label>审核说明<textarea required aria-label="审核说明" value={note} onChange={event => setNote(event.target.value)} /></label><Button type="submit" className="primary" disabled={busy}>确认{review.status === "active" ? "纳入" : "停用"}</Button></form></Modal>}
  </div>;
}
