import { spawn } from "node:child_process";
import { assertDirectArgv } from "./notify.js";

export interface ProcessIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

/**
 * Start an allowlisted argv. shell is false on purpose: the parent does not
 * interpret metacharacters, expand variables, or run a second command.
 */
export function executeArgv(argv: readonly string[], io: ProcessIo): Promise<number> {
  assertDirectArgv(argv);
  const program = argv[0];
  if (program === undefined) return Promise.reject(new Error("empty argv"));
  return new Promise((resolve, reject) => {
    const child = spawn(program, argv.slice(1), { shell: false });
    child.stdout.on("data", (chunk: Buffer) => {
      io.stdout(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      io.stderr(chunk.toString());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
