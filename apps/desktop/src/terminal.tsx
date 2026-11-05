import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Grip, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { api } from "./api.js";
import "@xterm/xterm/css/xterm.css";

type TerminalGeometry = { x: number; y: number; width: number; height: number };
const geometryKey = "crewvane.terminal.geometry";
const minWidth = 480, minHeight = 260;
function savedGeometry(): TerminalGeometry | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(geometryKey) ?? "null") as Partial<TerminalGeometry> | null;
    if (
      value &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Number.isFinite(value.width) &&
      Number.isFinite(value.height)
    )
      return value as TerminalGeometry;
  } catch {
    // Invalid local layout falls back to the panel's responsive default.
  }
}
function boundedGeometry(input: TerminalGeometry): TerminalGeometry {
  const width = Math.min(Math.max(minWidth, input.width), Math.max(minWidth, window.innerWidth - 16));
  const height = Math.min(Math.max(minHeight, input.height), Math.max(minHeight, window.innerHeight - 16));
  return {
    x: Math.min(Math.max(8, input.x), Math.max(8, window.innerWidth - width - 8)),
    y: Math.min(Math.max(8, input.y), Math.max(8, window.innerHeight - height - 8)),
    width,
    height,
  };
}
export function HerdrTerminal({ session, title, theme, visible, onClose }: {
  session: string; title: string; theme: string; visible: boolean; onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [error, setError] = useState(""), [expanded, setExpanded] = useState(false);
  const [geometry, setGeometry] = useState<TerminalGeometry | undefined>(savedGeometry);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true, fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13, lineHeight: 1.25, scrollback: 3000,
      allowProposedApi: false, screenReaderMode: true, cols: 120, rows: 32, theme: terminalTheme(theme),
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const copyShortcut = (event.metaKey && key === "c") ||
        (event.ctrlKey && event.shiftKey && key === "c");
      const pasteShortcut = (event.metaKey && key === "v") ||
        (event.ctrlKey && event.shiftKey && key === "v");
      if (copyShortcut) {
        const selection = terminal.getSelection();
        if (!selection) return true;
        event.preventDefault();
        void api.writeClipboardText(selection).catch(report);
        return false;
      }
      if (pasteShortcut) {
        event.preventDefault();
        void api.readClipboardText().then(text => {
          if (text) terminal.paste(text);
        }).catch(report);
        return false;
      }
      return true;
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
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [expanded]);
  useEffect(() => {
    const resize = () => {
      setGeometry(current => current ? boundedGeometry(current) : current);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    if (expanded || event.button !== 0 || (event.target as HTMLElement).closest("button"))
      return;
    event.preventDefault();
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    setGeometry(boundedGeometry({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }));
    const move = (current: PointerEvent) => {
      setGeometry(boundedGeometry({
        x: rect.left + current.clientX - start.x,
        y: rect.top + current.clientY - start.y,
        width: rect.width,
        height: rect.height,
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setGeometry(current => {
        if (current) localStorage.setItem(geometryKey, JSON.stringify(current));
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }
  function beginResize(event: ReactPointerEvent<HTMLElement>) {
    if (expanded) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    const move = (current: PointerEvent) => {
      setGeometry(boundedGeometry({
        x: rect.left,
        y: rect.top,
        width: rect.width + current.clientX - start.x,
        height: rect.height + current.clientY - start.y,
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setGeometry(current => {
        if (current) localStorage.setItem(geometryKey, JSON.stringify(current));
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }
  return (
    <section
      className={`terminal-panel ${expanded ? "expanded" : ""} ${geometry ? "has-geometry" : ""} ${visible ? "" : "terminal-hidden"}`}
      style={!expanded && geometry ? {
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
      } : undefined}
      aria-label="Herdr 工作现场"
      aria-hidden={!visible}
      inert={!visible}
    >
      <header className="terminal-heading terminal-drag-handle" onPointerDown={beginDrag} onDoubleClick={() => setExpanded(value => !value)}>
        <div>
          <span className={`terminal-dot ${error ? "offline" : ""}`} />
          <strong>{title}</strong>
          <small>{title === "全局管家" ? "HERDR · 直聊由管家写回 App" : "HERDR · 会话持续保留"}</small>
        </div>
        <div>
          <button className="icon-button" aria-label={expanded ? "退出全屏现场" : "全屏显示现场"} title={expanded ? "退出全屏（Esc）" : "全屏显示"} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          <button className="secondary terminal-hide" title="隐藏面板，Agent 继续执行" onClick={onClose}><X size={15} />隐藏终端</button>
        </div>
      </header>
      {error && <div className="terminal-error" role="alert"><span>{error}</span><button className="secondary" onClick={async () => {
        try { await api.openHerdr(); setAttempt((value) => value + 1); }
        catch (reason) { setError(String(reason)); }
      }}><RefreshCw size={14} />重新连接</button></div>}
      <div className="terminal-surface" ref={container} />
      {!expanded && <span className="terminal-resize" aria-label="拖动调整现场大小" title="拖动调整大小" onPointerDown={beginResize}><Grip size={13} /></span>}
    </section>
  );
}
function terminalTheme(_theme: string) {
  // Herdr and CLI agents render their own ANSI palette. Keep their canvas dark
  // in both app themes so hard-coded light text remains readable.
  return { background: "#111420", foreground: "#dce1f0", cursor: "#b4a2ff", selectionBackground: "#383250" };
}
