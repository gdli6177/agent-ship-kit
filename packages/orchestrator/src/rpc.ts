import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { redact } from "../../core/src/index.js";
// Wire payloads are validated by the adapter before becoming domain records.
export type Wire = Record<string, any>;
export class RpcProcess extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: Wire) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private stderr = "";
  private ended = false;
  constructor(
    executable: string,
    args: string[],
    cwd: string,
    readonly acp: boolean,
    readonly handleRequest: (method: string, params: Wire) => Promise<Wire>,
  ) {
    super();
    this.child = spawn(executable, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      env: { ...process.env, CREWVANE_AGENT: "1" },
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = redact((this.stderr + String(chunk)).slice(-4000));
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        if (line.length > 2_000_000)
          throw new Error("runtime message exceeds 2MB");
        if (!line.trimStart().startsWith("{")) return; // Some installed ACP servers emit startup diagnostics on stdout.
        const msg: Wire = JSON.parse(line);
        if (msg.method && msg.id !== undefined) {
          void this.handleRequest(msg.method, msg.params ?? {})
            .then((result) => this.send({ id: msg.id, result }))
            .catch((error) =>
              this.send({
                id: msg.id,
                error: { code: -32603, message: redact(String(error)) },
              }),
            );
        } else if (msg.method)
          this.emit("notification", msg.method, msg.params ?? {});
        else if (typeof msg.id === "number") {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error)
            pending.reject(
              new Error(redact(`${msg.error.message ?? "runtime error"}`)),
            );
          else pending.resolve(msg.result ?? {});
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.fail(
        new Error(`runtime exited (${code ?? signal}): ${this.stderr}`),
      );
      lines.close();
    });
  }
  get pid() {
    return this.child.pid ?? 0;
  }
  send(message: Wire) {
    if (!this.ended && this.child.stdin.writable)
      this.child.stdin.write(
        `${JSON.stringify(this.acp ? { jsonrpc: "2.0", ...message } : message)}\n`,
      );
  }
  notify(method: string, params: Wire) {
    this.send({ method, params });
  }
  request(method: string, params: Wire, timeout = 30_000): Promise<Wire> {
    if (this.ended)
      return Promise.reject(new Error("runtime connection is closed"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  private fail(error: Error) {
    if (this.ended) return;
    this.ended = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const exited = new Promise<void>((resolve) =>
      this.child.once("exit", () => resolve()),
    );
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (this.pid && process.platform !== "win32")
          process.kill(-this.pid, signal);
        else this.child.kill(signal);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    };
    kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          kill("SIGKILL");
          resolve();
        }, 2500);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (this.child.exitCode === null && this.child.signalCode === null)
      await Promise.race([
        exited,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error("runtime did not stop")),
            2000,
          ).unref(),
        ),
      ]);
  }
}
