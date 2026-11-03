import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { RefreshCw, TerminalSquare, X } from "lucide-react";
import { api, type TerminalBackend } from "./api.js";
import "@xterm/xterm/css/xterm.css";

export function TerminalDrawer({
  open,
  close,
  workspace,
  cwd,
  theme,
}: {
  open: boolean;
  close: () => void;
  workspace?: string;
  cwd?: string;
  theme: "light" | "dark";
}) {
  const [terminalElement, setTerminalElement] =
      useState<HTMLDivElement | null>(null),
    terminal = useRef<Terminal | null>(null),
    fit = useRef<FitAddon | null>(null),
    session = useRef<string | undefined>(undefined),
    [backends, setBackends] = useState<TerminalBackend[]>([]),
    [backend, setBackend] = useState(""),
    [generation, setGeneration] = useState(0),
    [status, setStatus] = useState("未连接"),
    [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    void api
      .terminalBackends()
      .then((items) => {
        setBackends(items);
        const current = items.find((item) => item.id === backend);
        if (current?.status !== "ready") {
          const preferred = items.find(
            (item) => item.id === "herdr" && item.status === "ready",
          );
          setBackend(
            preferred?.id ??
              items.find((item) => item.status === "ready")?.id ??
              "",
          );
        }
      })
      .catch((reason) => setError(String(reason).replace(/^Error: /, "")));
  }, [open, workspace]);

  useEffect(() => {
    if (!open || !terminalElement || !backend || !workspace) return;
    const instance = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme:
        theme === "dark"
          ? {
              background: "#0d1118",
              foreground: "#dce3ee",
              cursor: "#5aa2ff",
              selectionBackground: "#29527c",
              black: "#111820",
              brightBlack: "#7c8a9e",
            }
          : {
              background: "#f8fafc",
              foreground: "#192230",
              cursor: "#1669e8",
              selectionBackground: "#c8dcff",
              black: "#1f2937",
              brightBlack: "#64748b",
            },
    });
    const fitAddon = new FitAddon();
    instance.loadAddon(fitAddon);
    instance.open(terminalElement);
    fitAddon.fit();
    instance.focus();
    terminal.current = instance;
    fit.current = fitAddon;
    let disposed = false;
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "terminal.data" && event.id === session.current)
        instance.write(event.data);
      if (event.type === "terminal.exit" && event.id === session.current) {
        session.current = undefined;
        setStatus(
          event.exitCode === 0 ? "会话已结束" : `会话退出 (${event.exitCode})`,
        );
        instance.write(
          `\r\n\x1b[38;2;133;147;166m[进程已退出，退出码 ${event.exitCode}]\x1b[0m\r\n`,
        );
      }
    });
    const input = instance.onData((data) => {
      if (session.current) void api.terminalWrite(session.current, data);
    });
    const observer = new ResizeObserver(() => {
      fit.current?.fit();
      if (session.current)
        void api.terminalResize(
          session.current,
          terminal.current?.cols ?? 80,
          terminal.current?.rows ?? 24,
        );
    });
    observer.observe(terminalElement);
    setStatus("正在启动…");
    setError("");
    void api
      .terminalStart({
        backend,
        cwd,
        cols: instance.cols,
        rows: instance.rows,
      })
      .then(({ id }) => {
        if (disposed) {
          void api.terminalStop(id);
          return;
        }
        session.current = id;
        setStatus(
          backends.find((item) => item.id === backend)?.name ?? backend,
        );
      })
      .catch((reason) => {
        setStatus("启动失败");
        setError(String(reason).replace(/^Error: /, ""));
      });
    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      unsubscribe();
      if (session.current) void api.terminalStop(session.current);
      session.current = undefined;
      instance.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, [open, backend, workspace, cwd, theme, generation, terminalElement]);

  const active = backends.find((item) => item.id === backend);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-backdrop" />
        <Dialog.Content
          className="terminal-drawer"
          aria-describedby={undefined}
        >
          <div className="drawer-head">
            <div className="drawer-title">
              <span className="drawer-icon">
                <TerminalSquare size={18} />
              </span>
              <div>
                <Dialog.Title>执行终端</Dialog.Title>
                <small>{status}</small>
              </div>
            </div>
            <div className="terminal-controls">
              <label>
                <select
                  aria-label="终端后端"
                  title="终端后端"
                  value={backend}
                  onChange={(event) => setBackend(event.target.value)}
                >
                  {backends.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={item.status !== "ready"}
                    >
                      {item.name}
                      {item.status === "ready" ? "" : " · 未安装"}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="drawer-icon-btn"
                aria-label="重启终端"
                title="重启终端"
                onClick={() => setGeneration((current) => current + 1)}
              >
                <RefreshCw size={16} />
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="drawer-icon-btn"
                  aria-label="关闭终端"
                >
                  <X size={18} />
                </button>
              </Dialog.Close>
            </div>
          </div>
          <p className="terminal-boundary">
            <strong>此终端用于观察与接管，Agent 协作由 Crewvane 协议完成。</strong>
            <span>安装 Herdr 后优先使用；未安装时回退到 Shell 或 runtime CLI。</span>
          </p>
          {active && (
            <p className="terminal-note" title={active.reason}>
              {active.reason}
            </p>
          )}
          {error && <div className="terminal-error">{error}</div>}
          <div
            ref={setTerminalElement}
            className="terminal-surface"
            aria-label="交互式终端"
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
