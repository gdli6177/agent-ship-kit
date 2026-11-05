import { utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";

export interface TerminalSnapshot {
  session: string;
  data: string;
  running: boolean;
  sequence: number;
  cols: number;
  rows: number;
  error?: string;
}
interface Connection extends TerminalSnapshot {
  process: UtilityProcess;
  ready: Promise<void>;
}
// One attachment per workspace. Hiding the terminal never stops its agents.
export class TerminalHost {
  private readonly connections = new Map<string, Connection>();
  constructor(private readonly emit: (event: unknown) => void,
    private environment: Record<string, string | undefined> = process.env) {}
  setEnvironment(environment: Record<string, string | undefined>) {
    this.environment = environment;
  }
  async attach(executable: string, session: string, cwd: string): Promise<TerminalSnapshot> {
    const previous = this.connections.get(session);
    if (previous?.running) {
      await previous.ready;
      return this.snapshot(session)!;
    }
    const child = utilityProcess.fork(join(__dirname, "terminal-worker.cjs"), [], {
      serviceName: "Crewvane Herdr terminal",
      stdio: "pipe",
      env: this.environment,
    });
    let resolve!: () => void, reject!: (reason: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const connection: Connection = { session, data: "", running: true, sequence: 0, cols: 120, rows: 32, process: child, ready };
    this.connections.set(session, connection);
    const timer = setTimeout(() => {
      connection.error = "应用内终端启动超时，请重试连接。";
      reject(new Error(connection.error));
      child.kill();
    }, 15_000);
    const exited = () => {
      clearTimeout(timer);
      connection.running = false;
      reject(new Error(connection.error ?? "Herdr 终端已断开，可重新连接；这不表示目标完成。"));
      this.emit({ type: "terminal-exit", session, error: connection.error });
    };
    child.on("spawn", () => child.postMessage({ type: "start", executable, session, cwd }));
    child.on("message", (message: any) => {
      if (message.type === "ready") { clearTimeout(timer); resolve(); }
      else if (message.type === "data" && typeof message.data === "string") {
        connection.data = (connection.data + message.data).slice(-512_000);
        connection.sequence++;
        this.emit({ type: "terminal-data", session, data: message.data, sequence: connection.sequence });
      } else if (message.type === "error") {
        connection.error = String(message.message);
        reject(new Error(connection.error));
        child.kill();
      }
    });
    child.on("exit", exited);
    // Observe stderr without piping native-process diagnostics into product UI.
    child.stderr?.on("data", () => {});
    await ready;
    return this.snapshot(session)!;
  }
  snapshot(session: string): TerminalSnapshot | undefined {
    const connection = this.connections.get(session);
    if (!connection) return undefined;
    return { session, data: connection.data, running: connection.running, error: connection.error, sequence: connection.sequence, cols: connection.cols, rows: connection.rows };
  }
  write(session: string, data: unknown) {
    if (typeof data !== "string" || data.length > 64_000) throw new Error("无效的终端输入");
    const connection = this.connections.get(session);
    if (!connection?.running) throw new Error("终端已断开，请重新连接");
    connection.process.postMessage({ type: "write", data });
  }
  resize(session: string, cols: unknown, rows: unknown) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 20 || Number(cols) > 500 || Number(rows) < 5 || Number(rows) > 250)
      throw new Error("无效的终端尺寸");
    const connection = this.connections.get(session);
    if (connection) {
      connection.cols = Number(cols); connection.rows = Number(rows);
      connection.process.postMessage({ type: "resize", cols, rows });
    }
  }
  dispose() {
    for (const connection of this.connections.values()) {
      if (connection.running) connection.process.kill();
    }
    this.connections.clear();
  }
}
