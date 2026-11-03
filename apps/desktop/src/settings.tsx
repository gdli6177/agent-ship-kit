import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Download,
  LoaderCircle,
  Network,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { api, type HerdrStatus } from "./api.js";
import { Button } from "./ui.js";

export function SettingsPage() {
  const [herdr, setHerdr] = useState<HerdrStatus>(),
    [loading, setLoading] = useState(true),
    [installing, setInstalling] = useState(false),
    [error, setError] = useState(""),
    [output, setOutput] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setHerdr(await api.herdrStatus());
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const install = async () => {
    setInstalling(true);
    setError("");
    try {
      const result = await api.installHerdr();
      setHerdr(result);
      setOutput(result.output);
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    } finally {
      setLoading(false);
      setInstalling(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="page-heading settings-heading">
        <span className="eyebrow">SETTINGS &amp; INTEGRATIONS</span>
        <h1>把可选工具接进来。</h1>
        <p>
          Crewvane 负责调度与协作协议。终端和 Herdr
          只扩展人工观察与接管能力，不影响团队能否协作。
        </p>
      </div>

      <section className="integration-card">
        <span className="integration-icon">
          <SquareTerminal size={24} />
        </span>
        <div className="integration-copy">
          <div className="integration-title">
            <div>
              <small>推荐终端底座 · 可选</small>
              <h2>Herdr</h2>
            </div>
            {loading ? (
              <span className="integration-status checking">
                <LoaderCircle className="spin" size={15} />
                正在检测
              </span>
            ) : herdr?.installed ? (
              <span className="integration-status installed">
                <CheckCircle2 size={15} />
                已安装
              </span>
            ) : (
              <span className="integration-status missing">未安装</span>
            )}
          </div>
          <p>
            用于在持久终端工作区中观察、切换和接管 coding agent
            会话。安装后自动成为终端首选后端；未安装时回退到本地 Shell，Crewvane
            仍通过自己的任务状态和结构化协议运行多 Agent 协作。
          </p>
          <div className="integration-metadata">
            <span>
              <small>状态</small>
              <code>
                {herdr?.version ??
                  (herdr?.installed ? "版本未知" : "不影响派工")}
              </code>
            </span>
            <span>
              <small>安装方式</small>
              <code>Homebrew · 推荐</code>
            </span>
          </div>
          {error && <div className="integration-error">{error}</div>}
          {output && <pre className="integration-output">{output}</pre>}
          <div className="integration-actions">
            {herdr?.installed ? (
              <Button type="button" onClick={() => void refresh()}>
                <RefreshCw size={15} />
                重新检测
              </Button>
            ) : (
              <Button
                type="button"
                className="primary"
                disabled={installing || !herdr?.installAvailable}
                onClick={() => void install()}
              >
                {installing ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Download size={15} />
                )}
                {installing ? "正在安装…" : "安装 Herdr"}
              </Button>
            )}
            {!herdr?.installAvailable && !loading && !herdr?.installed && (
              <code className="install-command">brew install herdr</code>
            )}
            <button
              type="button"
              className="text-link"
              onClick={() => void api.openHerdrDocs()}
            >
              查看 Herdr 文档
            </button>
          </div>
        </div>
      </section>

      <section className="architecture-card">
        <div className="section-kicker">通信边界</div>
        <h2>协作不依赖 Herdr。</h2>
        <div className="architecture-flow">
          <article>
            <span>
              <ShieldCheck size={19} />
            </span>
            <div>
              <strong>Crewvane 调度核心</strong>
              <small>必选 · 持久任务、授权、升级、证据与决定账本</small>
            </div>
          </article>
          <i />
          <article>
            <span>
              <Network size={19} />
            </span>
            <div>
              <strong>结构化 Agent 协议</strong>
              <small>必选 · ACP / Codex App Server 下发与回传</small>
            </div>
          </article>
          <i />
          <article>
            <span>
              <SquareTerminal size={19} />
            </span>
            <div>
              <strong>终端观察层</strong>
              <small>可选 · Shell、runtime CLI 或 Herdr 会话</small>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
