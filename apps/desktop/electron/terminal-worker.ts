import { spawn, type IPty } from "node-pty";

// Native PTY code stays out of Electron's main and sandboxed renderer processes.
const port = (process as unknown as {
  parentPort: {
    on(event: "message", listener: (event: { data: any }) => void): void;
    postMessage(data: unknown): void;
  };
}).parentPort;
let terminal: IPty | undefined;
port.on("message", ({ data }) => {
  try {
    if (data.type === "start" && !terminal) {
      terminal = spawn(data.executable, ["session", "attach", data.session], {
        name: "xterm-256color",
        cols: 120, rows: 32, cwd: data.cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", HERDR_SESSION: data.session },
      });
      terminal.onData((text) => port.postMessage({ type: "data", data: text }));
      terminal.onExit(({ exitCode }) => {
        terminal = undefined;
        port.postMessage({ type: "exit", exitCode });
        process.exit(0);
      });
      port.postMessage({ type: "ready" });
    } else if (data.type === "write") {
      terminal?.write(data.data);
    } else if (data.type === "resize") {
      terminal?.resize(data.cols, data.rows);
    } else if (data.type === "stop") {
      terminal?.kill();
      process.exit(0);
    }
  } catch (error) {
    port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
