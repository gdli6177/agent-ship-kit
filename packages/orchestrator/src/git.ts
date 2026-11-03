import { spawn } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  activeGrant,
  inside,
  pathAllowed,
  redact,
  type Project,
  type Task,
} from "../../core/src/index.js";
import { maskTestSecrets } from "./credentials.js";
export async function command(
  argv: string[],
  cwd: string,
  options: {
    timeout?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    secrets?: string[];
  } = {},
): Promise<string> {
  if (
    !argv.length ||
    argv.some((a) => typeof a !== "string" || a.includes("\0"))
  )
    throw new Error("invalid command argv");
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env, ...options.env },
    });
    let output = "",
      stderr = "",
      settled = false,
      stoppedError: Error | undefined,
      killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const stop = (error: Error) => {
      if (stoppedError || settled) return;
      stoppedError = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2000);
    };
    const abort = () => stop(new Error("command cancelled"));
    const timer = setTimeout(
      () => stop(new Error(`command timed out: ${argv[0]}`)),
      options.timeout ?? 60_000,
    );
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      error ? reject(new Error(maskTestSecrets(redact(error.message), options.secrets ?? [])))
        : resolve(maskTestSecrets(redact(output.trim()), options.secrets ?? []));
    }
    child.stdout.on("data", (data: Buffer) => {
      output = (output + String(data)).slice(-100_000);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + String(data)).slice(-100_000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(
        stoppedError ??
          (code === 0
            ? undefined
            : new Error(
                `command failed (${code}): ${argv.slice(0, 3).join(" ")}\n${output.slice(-3000)}\n${stderr.slice(-3000)}`,
              )),
      ),
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
export const git = (cwd: string, ...args: string[]) =>
  command(["git", ...args], cwd);
export async function canonicalRepo(path: string) {
  const root = await realpath(path),
    top = await realpath(await git(root, "rev-parse", "--show-toplevel"));
  if (root !== top) throw new Error("select a Git repository root");
  return root;
}
export async function addWorktree(
  project: Project,
  path: string,
  branch: string,
  base: string,
) {
  await mkdir(join(path, ".."), { recursive: true });
  await git(project.path, "worktree", "add", "-b", branch, path, base);
  return realpath(path);
}
export async function changedPaths(cwd: string, base?: string) {
  const raw = base
    ? await git(cwd, "diff", "--name-only", "--no-renames", "-z", base, "--")
    : await git(
        cwd,
        "ls-files",
        "--modified",
        "--others",
        "--exclude-standard",
        "-z",
      );
  return [
    ...new Set(
      raw
        .split("\0")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
}
export async function assertScope(project: Project, cwd: string, base: string) {
  const grant = activeGrant(project),
    files = await changedPaths(cwd, base);
  for (const path of files) {
    if (!pathAllowed(grant, path))
      throw new Error(`change outside delegated scope: ${path}`);
    // Resolve real parents to prevent symlinked destinations escaping the checkout.
    let candidate = join(cwd, path);
    for (;;) {
      try {
        const actual = await realpath(candidate);
        if (!inside(cwd, actual))
          throw new Error(`path escapes checkout: ${path}`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = join(candidate, "..");
        if (parent === candidate) throw error;
        candidate = parent;
      }
    }
  }
  return files;
}
export async function commitChanges(
  project: Project,
  cwd: string,
  base: string,
  title: string,
) {
  await assertScope(project, cwd, base);
  const files = await changedPaths(cwd);
  for (const path of files)
    if (!pathAllowed(activeGrant(project), path))
      throw new Error(`uncommitted file outside delegated scope: ${path}`);
  if (files.length) {
    await git(cwd, "add", "--", ...files);
    await git(
      cwd,
      "-c",
      "user.name=Crewvane",
      "-c",
      "user.email=crewvane@localhost",
      "commit",
      "-m",
      title,
    );
  }
  await assertScope(project, cwd, base);
  return git(cwd, "rev-parse", "HEAD");
}
export async function publishPR(
  project: Project,
  task: Task,
  body: string,
  signal?: AbortSignal,
) {
  if (!activeGrant(project).actions.includes("publish_pr"))
    throw new Error("publish_pr is not authorized");
  if (
    !task.checkout ||
    !task.integrationHead ||
    (await git(task.checkout, "rev-parse", "HEAD")) !== task.integrationHead
  )
    throw new Error("verified head changed before publication");
  await assertScope(project, task.checkout, task.baseCommit!);
  const lookup = async () =>
    JSON.parse(
      await command(
        [
          "gh",
          "pr",
          "list",
          "--head",
          task.branch,
          "--state",
          "all",
          "--json",
          "url,headRefOid,state",
          "--limit",
          "100",
        ],
        project.path,
        { signal },
      ),
    ) as { url: string; headRefOid: string; state: string }[];
  const existing = await lookup();
  if (existing.length > 1)
    throw new Error("ambiguous PRs for integration branch");
  if (existing[0]) {
    if (existing[0].headRefOid !== task.integrationHead)
      throw new Error("existing PR head differs from verified head");
    return existing[0].url;
  }
  await command(
    ["git", "push", "origin", `${task.branch}:refs/heads/${task.branch}`],
    project.path,
    { signal },
  );
  const actualGit = await git(task.checkout, "rev-parse", "--absolute-git-dir");
  const file = join(actualGit, "crewvane-pr-body.md");
  await writeFile(file, redact(body), { mode: 0o600 });
  try {
    return await command(
      [
        "gh",
        "pr",
        "create",
        "--base",
        project.baseBranch,
        "--head",
        task.branch,
        "--title",
        task.title,
        "--body-file",
        file,
      ],
      project.path,
      { signal },
    );
  } catch (error) {
    const recovered = await lookup();
    if (recovered[0]?.headRefOid === task.integrationHead)
      return recovered[0].url;
    throw error;
  }
}
