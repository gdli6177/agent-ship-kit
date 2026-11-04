import { appendFile, mkdir, readFile, realpath, rename, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { nextSequence, withLock } from "./storage.js";
import type { WorkspaceState } from "./types.js";
import { defaultProjectPolicy, initialState, newId } from "./model.js";
import { decisionMarkdown } from "./governance.js";
export { initialState, newId } from "./model.js";
export function validateState(value: unknown): WorkspaceState {
  const state = value as WorkspaceState;
  if (!state || state.version !== 2 || !Array.isArray(state.goals) || !Array.isArray(state.projects) || !Array.isArray(state.workflows) || !state.concierge)
    throw new Error("不支持的工作区状态版本。请打开一个新的 Crewvane 0.4 工作区。");
  state.decisions ??= [];
  for (const project of state.projects) project.policy ??= defaultProjectPolicy();
  return state;
}
async function writeAtomic(path: string, body: string) {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}
export class WorkspaceStore {
  constructor(readonly root: string) {}
  private async directory() {
    const owner = await realpath(this.root), path = join(owner, ".crewvane");
    await mkdir(path, { recursive: true });
    if ((await lstat(path)).isSymbolicLink()) throw new Error("状态目录不能是符号链接");
    return path;
  }
  async read(): Promise<WorkspaceState> {
    const directory = await this.directory();
    try { return validateState(JSON.parse(await readFile(join(directory, "state.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState();
      if (error instanceof SyntaxError) throw new Error("工作区状态无法读取，请保留原文件并检查 state.json。");
      throw error;
    }
  }
  async update<T>(reason: string, action: (state: WorkspaceState) => T | Promise<T>): Promise<T> {
    const directory = await this.directory();
    return withLock(directory, async () => {
      const state = await this.read(), before = JSON.stringify(state), result = await action(state);
      if (before === JSON.stringify(state)) return result;
      const temporary = join(directory, `.state-${process.pid}-${randomUUID()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, join(directory, "state.json"));
      await Promise.all([
        writeAtomic(join(directory, "decisions.md"), decisionMarkdown(state.decisions, "approved")),
        writeAtomic(join(directory, "rejected.md"), decisionMarkdown(state.decisions, "rejected")),
      ]);
      await appendFile(join(directory, "events.jsonl"), `${JSON.stringify({ id: newId("evt"), type: "workspace_changed", sequence: await nextSequence(this.root), created_at: new Date().toISOString(), title: reason, source_task_id: "workspace", state })}\n`, { mode: 0o600 });
      return result;
    });
  }
}
