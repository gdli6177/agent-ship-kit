import {
  Orchestrator,
  WorkspaceService,
  type ServiceCommand,
} from "../../../packages/orchestrator/src/index.js";
import { redact } from "../../../packages/core/src/index.js";
import { isAbsolute } from "node:path";
import { spawn as spawnPty, type IPty } from "node-pty";
const port = (
  process as unknown as {
    parentPort: {
      on(event: string, cb: (event: { data: any }) => void): void;
      postMessage(value: unknown): void;
    };
  }
).parentPort;
let service: WorkspaceService | undefined,
  scheduler: Orchestrator | undefined,
  busy = false,
  previous = "",
  stopped = false;
const terminals = new Map<string, IPty>();
const send = (data: unknown) => port.postMessage(data);
function closeTerminals() {
  for (const terminal of terminals.values()) {
    try {
      terminal.kill();
    } catch {
      /* process already exited */
    }
  }
  terminals.clear();
}
function validTerminalRequest(data: any): asserts data is {
  id: string;
  requestId: number;
  executable: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
} {
  if (
    !data ||
    typeof data.id !== "string" ||
    !/^term_[a-zA-Z0-9_-]{8,80}$/.test(data.id) ||
    !Number.isInteger(data.requestId) ||
    typeof data.executable !== "string" ||
    !isAbsolute(data.executable) ||
    !Array.isArray(data.args) ||
    data.args.length > 32 ||
    data.args.some(
      (arg: unknown) =>
        typeof arg !== "string" || arg.length > 512 || /[\0\r\n]/.test(arg),
    ) ||
    typeof data.cwd !== "string" ||
    !isAbsolute(data.cwd) ||
    !Number.isInteger(data.cols) ||
    data.cols < 20 ||
    data.cols > 400 ||
    !Number.isInteger(data.rows) ||
    data.rows < 5 ||
    data.rows > 200
  )
    throw new Error("invalid terminal request");
}
port.on("message", async ({ data }) => {
  try {
    if (data.type === "init") {
      closeTerminals();
      service = new WorkspaceService(data.root);
      scheduler = new Orchestrator(data.root);
      scheduler.on("runtime", (event) => send({ type: "runtime", event }));
      scheduler.on("attention", (event) => send({ type: "attention", event }));
      scheduler.on("diagnostic", (message) =>
        send({ type: "diagnostic", message }),
      );
      if (process.env.CREWVANE_TEST_SNAPSHOT_ONLY === "1") {
        scheduler = undefined;
      } else {
        try {
          await scheduler.start();
        } catch (error) {
          send({ type: "diagnostic", message: String(error) });
          scheduler = undefined;
        }
      }
      send({ type: "ready" });
    } else if (data.type === "terminal.start") {
      validTerminalRequest(data);
      if (terminals.has(data.id)) throw new Error("terminal already exists");
      const terminal = spawnPty(data.executable, data.args, {
        name: "xterm-256color",
        cols: data.cols,
        rows: data.rows,
        cwd: data.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          CREWVANE_AGENT: "1",
        },
      });
      terminals.set(data.id, terminal);
      terminal.onData((text) => send({ type: "terminal.data", id: data.id, data: text }));
      terminal.onExit(({ exitCode, signal }) => {
        terminals.delete(data.id);
        send({ type: "terminal.exit", id: data.id, exitCode, signal });
      });
      send({ type: "reply", id: data.requestId, result: { id: data.id, pid: terminal.pid } });
    } else if (data.type === "terminal.write") {
      const terminal = terminals.get(data.id);
      if (terminal && typeof data.data === "string" && data.data.length <= 64_000)
        terminal.write(data.data);
      send({ type: "reply", id: data.requestId, result: true });
    } else if (data.type === "terminal.resize") {
      const terminal = terminals.get(data.id);
      if (
        terminal &&
        Number.isInteger(data.cols) &&
        data.cols >= 20 &&
        data.cols <= 400 &&
        Number.isInteger(data.rows) &&
        data.rows >= 5 &&
        data.rows <= 200
      )
        terminal.resize(data.cols, data.rows);
      send({ type: "reply", id: data.requestId, result: true });
    } else if (data.type === "terminal.stop") {
      const terminal = terminals.get(data.id);
      terminals.delete(data.id);
      terminal?.kill();
      send({ type: "reply", id: data.requestId, result: true });
    } else if (data.type === "command") {
      if (!service) throw new Error("open a workspace first");
      const result = await service.execute(data.command as ServiceCommand);
      send({ type: "reply", id: data.id, result });
    } else if (data.type === "stop") {
      stopped = true;
      closeTerminals();
      await scheduler?.stop();
      send({ type: "stopped" });
    }
  } catch (error) {
    send({
      type: "reply",
      id: (data as any).requestId ?? (data as any).id,
      error: redact(String(error)),
    });
  }
});
setInterval(async () => {
  if (busy || !service || stopped) return;
  busy = true;
  try {
    await scheduler?.tick();
    const state = await service.store.read(),
      serialized = JSON.stringify(state);
    if (previous !== serialized) {
      previous = serialized;
      send({ type: "snapshot", state });
    }
  } catch (error) {
    send({ type: "diagnostic", message: redact(String(error)) });
  } finally {
    busy = false;
  }
}, 700);
