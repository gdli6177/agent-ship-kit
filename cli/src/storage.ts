import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

export async function readEvents(root: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try { raw = await readFile(join(root, ".agent-ship", "events.jsonl"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw.split("\n").filter((line) => line.trim()).map((line, index) => {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid event at line ${index + 1}`);
    return value as Record<string, unknown>;
  });
}

/** A shared state directory serializes admission across processes, repos and worktrees.
 * Never steal a stale lock: after a crash, an owner must inspect it before removal.
 */
export async function withLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true });
  const lock = join(await realpath(directory), ".agent-ship-lock");
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`state is locked: ${lock}; inspect the owning process before removing a stale lock`);
      await setTimeout(20);
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true }); }
}

/** Called while holding the shared state lock; orders events with equal timestamps. */
export async function nextSequence(root: string): Promise<number> {
  const file = join(root, ".agent-ship", "sequence");
  let previous = 0;
  try { previous = Number(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!Number.isSafeInteger(previous) || previous < 0) throw new Error("invalid state sequence");
  await writeFile(file, String(previous + 1));
  return previous + 1;
}
