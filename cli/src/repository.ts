import { execFile } from "node:child_process";
import { access, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function gitOutput(root: string, args: string[]): Promise<string> {
  try { return (await exec("git", args, { cwd: root })).stdout; }
  catch (error) {
    throw new Error((error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : "git failed"));
  }
}
export async function repositoryRoot(path: string, requireRoot = false): Promise<string> {
  const requested = await realpath(resolve(path));
  const root = await realpath((await gitOutput(requested, ["rev-parse", "--show-toplevel"])).trim());
  if (requireRoot && requested !== root) throw new Error(`not a Git checkout root: ${requested}; refusing to use parent repository ${root}`);
  return root;
}
export async function gitPath(root: string, name: string): Promise<string> {
  const path = (await gitOutput(root, ["rev-parse", "--git-path", name])).trim();
  return isAbsolute(path) ? path : resolve(root, path);
}
export async function baseCommit(root: string, base?: string): Promise<string> {
  for (const ref of base ? [base] : ["main", "master"]) {
    if (ref.startsWith("-")) throw new Error("base must be a Git ref, not an option");
    try { return (await gitOutput(root, ["rev-parse", "--verify", `${ref}^{commit}`])).trim(); }
    catch (error) { if (base) throw error; }
  }
  throw new Error("no main or master branch; pass --base");
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
}

/** Git diff does not enter nested repositories. Reject scopes it cannot verify. */
export async function assertSingleRepository(root: string, patterns: string[]): Promise<void> {
  async function inspect(path: string): Promise<void> {
    if (path !== root && await exists(join(path, ".git"))) {
      throw new Error(`nested Git repository ${path}; use --repo and paths relative to that repository`);
    }
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    for (const entry of entries) {
      // Dependencies and Git internals cannot be contract source paths.
      if (entry.isSymbolicLink() && await exists(join(path, entry.name, ".git"))) throw new Error(`nested Git repository ${join(path, entry.name)}; use --repo`);
      if (entry.isDirectory() && ![".git", "node_modules", ".crewvane"].includes(entry.name)) await inspect(join(path, entry.name));
    }
  }
  for (const pattern of patterns) {
    if (isAbsolute(pattern) || pattern.split("/").includes("..")) throw new Error("contract paths must be repository-relative");
    const rawPrefix = pattern.split(/[*?]/)[0] ?? "";
    const prefix = /[*?]/.test(pattern) && !rawPrefix.endsWith("/") ? dirname(rawPrefix || ".") : rawPrefix;
    const target = resolve(root, prefix);
    const fromRoot = relative(root, target);
    if (fromRoot === ".." || fromRoot.startsWith("../")) throw new Error("contract paths must stay in the repository");
    let ancestor = root;
    for (const part of relative(root, target).split("/").filter(Boolean)) {
      ancestor = join(ancestor, part);
      if (await exists(join(ancestor, ".git"))) throw new Error(`nested Git repository ${ancestor}; use --repo and repository-relative paths`);
    }
    await inspect(target);
  }
}
