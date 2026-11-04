import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { api } from "./api.js";
import "@xterm/xterm/css/xterm.css";

export function HerdrTerminal({ session, title, theme, visible, onClose }: {
  session: string; title: string; theme: string; visible: boolean; onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [error, setError] = useState(""), [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true, fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13, lineHeight: 1.25, scrollback: 3000,
      allowProposedApi: false, screenReaderMode: true, cols: 120, rows: 32, theme: terminalTheme(theme),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current!);
    term.current = terminal;
    let active = true, hydrated = false, queued: { data: string; sequence: number }[] = [];
    const report = (reason: unknown) => { if (active) setError(String(reason).replace(/^Error: /, "")); };
    const resize = () => {
      if (!active || !hydrated || !container.current?.clientWidth || !container.current.clientHeight) return;
      fit.fit();
      void api.resizeTerminal(session, terminal.cols, terminal.rows).catch(report);
    };
    const unsubscribe = api.subscribe((event) => {
      if (event.session !== session) return;
      if (event.type === "terminal-data") {
        if (hydrated) terminal.write(event.data);
        else queued.push({ data: event.data, sequence: event.sequence });
      }
      if (event.type === "terminal-exit") setError(event.error || "终端连接已断开。目标和会话记录仍然保留，可重新连接。");
    });
    setError("");
    void api.terminalSnapshot().then((snapshot) => {
      if (!active) return;
      if (!snapshot || snapshot.session !== session) throw new Error("当前工作区没有已连接的 Herdr 终端");
      terminal.resize(snapshot.cols, snapshot.rows);
      terminal.write(snapshot.data, () => {
        if (!active) return;
        for (const chunk of queued) if (chunk.sequence > snapshot.sequence) terminal.write(chunk.data);
        queued = [];
        hydrated = true;
        if (!snapshot.running) report(snapshot.error || "终端已断开，请重新连接");
        resize();
        if (visibleRef.current) terminal.focus();
      });
    }).catch(report);
    const input = terminal.onData((data) => { void api.writeTerminal(session, data).catch(report); });
    const observer = new ResizeObserver(resize);
    observer.observe(container.current!);
    return () => {
      active = false;
      observer.disconnect(); unsubscribe(); input.dispose(); terminal.dispose();
      term.current = undefined;
    };
    // Theme is updated in-place below so changing it never reconnects a session.
  }, [session, attempt]);
  useEffect(() => { if (term.current) term.current.options.theme = terminalTheme(theme); }, [theme]);
  useEffect(() => { if (visible) term.current?.focus(); else term.current?.blur(); }, [visible]);
  return (
    <section className={`terminal-panel ${expanded ? "expanded" : ""} ${visible ? "" : "terminal-hidden"}`} aria-label="Herdr 工作现场" aria-hidden={!visible} inert={!visible}>
      <header className="terminal-heading">
        <div>
          <span className={`terminal-dot ${error ? "offline" : ""}`} />
          <strong>{title}</strong>
          <small>{title === "全局管家" ? "HERDR · 直聊由管家写回 App" : "HERDR · 会话持续保留"}</small>
        </div>
        <div>
          <button className="icon-button" aria-label={expanded ? "还原现场面板" : "展开现场面板"} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          <button className="secondary terminal-hide" title="隐藏面板，Agent 继续执行" onClick={onClose}><X size={15} />隐藏终端</button>
        </div>
      </header>
      {error && <div className="terminal-error" role="alert"><span>{error}</span><button className="secondary" onClick={async () => {
        try { await api.openHerdr(); setAttempt((value) => value + 1); }
        catch (reason) { setError(String(reason)); }
      }}><RefreshCw size={14} />重新连接</button></div>}
      <div className="terminal-surface" ref={container} />
    </section>
  );
}
function terminalTheme(_theme: string) {
  // Herdr and CLI agents render their own ANSI palette. Keep their canvas dark
  // in both app themes so hard-coded light text remains readable.
  return { background: "#111420", foreground: "#dce1f0", cursor: "#b4a2ff", selectionBackground: "#383250" };
}
