import { useEffect, useState } from "react";
import { KeyRound, LockKeyhole, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { WorkspaceState } from "../../../packages/core/src/index.js";
import { api } from "./api.js";
import { Button, Input } from "./ui.js";

// The utility polls durable state; request an immediate refresh for this page.
const emitWorkspaceChange = () => window.dispatchEvent(new Event("crewvane:workspace-changed"));

export function CredentialsPage({ state, projectId }: { state: WorkspaceState; projectId: string }) {
  const project = state.projects.find(p => p.id === projectId);
  const [available, setAvailable] = useState<boolean>();
  const [label, setLabel] = useState("");
  const [variable, setVariable] = useState("E2E_PASSWORD");
  const [checkIndex, setCheckIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = async () => {
    try { setAvailable((await api.vaultStatus()).available); }
    catch { setAvailable(false); }
  };
  useEffect(() => { void refresh(); }, []);
  if (!project) return <div className="empty"><KeyRound size={28} /><h2>为测试准备凭据</h2><p>先选择一个项目，分别管理它的测试账号与密钥。</p></div>;
  const references = project.credentials ?? [];
  const usages = (state.credentialAccess ?? []).filter(entry => state.tasks.some(task => task.id === entry.taskId && task.projectId === projectId));
  return <div className="credentials-page">
    <div className="page-heading"><span className="eyebrow">TEST CREDENTIALS</span><h1>让测试拿到恰好的权限。</h1><p>保存测试账号与密钥。只交给你授权的验证命令，团队对话中使用名称引用。</p></div>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="knowledge-notice" role="status">{notice}</p>}
    <section className="panel vault-status"><LockKeyhole size={20} /><div><strong>系统安全存储</strong><p>{available === undefined ? "检测中…" : available ? "系统钥匙串加密 · 凭据值不会写入工作区记录" : "暂不可用，请解锁系统钥匙串后重新检测"}</p></div><Button type="button" onClick={() => void refresh()}><RefreshCw size={14} />重新检测</Button></section>
    <section className="panel credential-form"><h2><Plus size={17} />保存测试凭据</h2><form onSubmit={event => {
      event.preventDefault();
      const valueInput = event.currentTarget.elements.namedItem("credential-value") as HTMLInputElement;
      const value = valueInput.value;
      valueInput.value = "";
      setBusy(true); setError(""); setNotice("");
      void api.saveCredential({ projectId, label: label.trim(), env: variable.trim(), checkIndex, value }).then(() => {
        emitWorkspaceChange();
        setLabel(""); setNotice("已安全保存。在项目授权中选择此凭据后，指定的验证命令即可使用。");
      }).catch(() => setError("未能保存测试凭据。请检查名称、环境变量与系统安全存储后重试。")).finally(() => setBusy(false));
    }}>
      <div className="form-row"><label>凭据名称<Input aria-label="凭据名称" required value={label} onChange={event => setLabel(event.target.value)} placeholder="测试用户密码" /></label><label>环境变量<Input aria-label="凭据环境变量" required value={variable} onChange={event => setVariable(event.target.value)} placeholder="E2E_PASSWORD" /></label></div>
      <label>仅供这条验证命令使用<select aria-label="凭据验证命令" value={checkIndex} onChange={event => setCheckIndex(Number(event.target.value))}>{project.checks.map((check, index) => <option key={index} value={index}>{check.join(" ")}</option>)}</select></label>
      <label>账号、密码或密钥<input aria-label="凭据值" type="password" name="credential-value" required autoComplete="new-password" maxLength={16000} /></label>
      <p className="muted">环境变量使用 E2E_ 前缀，例如 E2E_USERNAME、E2E_PASSWORD 或 E2E_API_KEY。保存后不提供明文查看入口。</p>
      <Button type="submit" className="primary" disabled={busy || !available}>{busy ? "正在安全保存…" : "保存凭据"}</Button>
    </form></section>
    <section className="panel credential-list"><div className="section-title"><h2>项目凭据</h2><small>{references.length} 项</small></div>{references.map(reference => {
      const authorized = !!project.grant && !project.grant.revokedAt && project.grant.credentials?.includes(reference.id);
      return <article key={reference.id}><KeyRound size={17} /><div><strong>{reference.label}</strong><small>{reference.env} · {project.checks[reference.checkIndex]?.join(" ")}</small><span className={`pill ${authorized ? "ready" : "detected"}`}>{authorized ? "已授权测试使用" : "尚未授权"}</span></div><span aria-label="已加密凭据">••••••••</span><Button type="button" aria-label={`移除${reference.label}`} disabled={busy || authorized} title={authorized ? "先在项目设置中撤销授权" : "移除凭据"} onClick={() => {
        setBusy(true); setError("");
        void api.removeCredential({ projectId, credentialId: reference.id }).then(emitWorkspaceChange).catch(() => setError("未能移除凭据，请先撤销相关项目授权。")).finally(() => setBusy(false));
      }}><Trash2 size={15} /></Button></article>;
    })}{!references.length && <div className="empty"><KeyRound size={23} /><p>尚未保存测试凭据。</p></div>}</section>
    {!!usages.length && <section className="panel credential-access"><h2>最近使用记录</h2>{usages.slice(-10).reverse().map((entry, index) => <div key={`${entry.at}-${index}`}><strong>{state.tasks.find(t => t.id === entry.taskId)?.title}</strong><small>{project.checks[entry.checkIndex]?.join(" ")} · {new Date(entry.at).toLocaleString()} · {entry.credentialIds.length} 项凭据</small></div>)}</section>}
  </div>;
}
