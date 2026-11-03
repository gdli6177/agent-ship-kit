import { appendFile, lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { nextSequence, readEvents, withLock } from "./storage.js";
import { initialState } from "./workflows.js";
import type { WorkspaceState } from "./types.js";
export const newId = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
export function redact(text: string): string {
  return text
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
      "[redacted]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|authorization|password)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
}
export class WorkspaceStore {
  constructor(readonly root: string) {}
  private async directory() {
    const owner = await realpath(this.root),
      path = join(owner, ".crewvane");
    await mkdir(path, { recursive: true });
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("state directory must not be a symlink");
    for (const name of ["events.jsonl", "sequence"]) {
      try {
        if (!(await lstat(join(path, name))).isFile())
          throw new Error(`invalid state file ${name}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return path;
  }
  async read(): Promise<WorkspaceState> {
    await this.directory();
    const event = (await readEvents(this.root))
      .filter((e) => e.type === "workspace_changed")
      .at(-1);
    if (!event) return initialState();
    const state = structuredClone(event.state) as WorkspaceState;
    if (
      state.version !== 1 ||
      !Array.isArray(state.tasks) ||
      !Array.isArray(state.projects)
    )
      throw new Error("unsupported workspace state");
    return state;
  }
  async update<T>(
    reason: string,
    action: (state: WorkspaceState) => T | Promise<T>,
  ): Promise<T> {
    const directory = await this.directory();
    return withLock(directory, async () => {
      const state = await this.read();
      const before = JSON.stringify(state);
      const result = await action(state);
      if (before === JSON.stringify(state)) return result;
      const event = {
        id: newId("evt"),
        type: "workspace_changed",
        sequence: await nextSequence(this.root),
        created_at: new Date().toISOString(),
        title: reason,
        source_task_id: "workspace",
        state,
      };
      // Each complete record is a single append; malformed/truncated logs fail closed.
      await appendFile(
        join(directory, "events.jsonl"),
        `${JSON.stringify(event)}\n`,
        { mode: 0o600 },
      );
      return result;
    });
  }
}
