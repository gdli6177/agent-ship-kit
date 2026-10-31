import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const RULES_START = "<!-- agent-ship:rules:start -->";
export const RULES_END = "<!-- agent-ship:rules:end -->";
export const HOOK_START = "# agent-ship-hook-start";
export const HOOK_END = "# agent-ship-hook-end";
export const EXCLUDE_START = "# agent-ship-exclude-start";
export const EXCLUDE_END = "# agent-ship-exclude-end";
export const GITIGNORE_START = "# agent-ship-gitignore-start";
export const GITIGNORE_END = "# agent-ship-gitignore-end";

const LOCAL_PATTERNS = [".agent-ship/", ".env*", "*.storage-state.json"];

export function kitRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export const RULES_BLOCK = `${RULES_START}
## agent-ship rules

These rules stay in force for every agent in this checkout. \`/ship-setup\` rewrites this block in place; it does not append a second copy. Default setup is local to this clone and does not change a shared ignore file.

- Talk to the human only as the captain. Do not ask the human to open a worker session.
- Do not spawn a worker until the human freezes the contract.
- Edit only Allowed paths on the frozen contract. Never touch Forbidden paths.
- At most 3 workers may be queued or running across all contracts.
- A separate read-only verifier must agree before a \`needs_review\` inbox item is filed. The verifier does not see the worker chat.
- Only the human merges or ships. Do not merge to main or master and do not deploy to production.
- Never read, write, or repeat passwords, cookies, or storageState contents.
- Use the \`/ship-*\` commands: \`/ship-setup\`, \`/ship-inbox\`, \`/ship-review\`, \`/ship-contract\`, \`/ship-dispatch\`, \`/ship-notify\`, \`/ship-e2e\`. A review notification deep-links \`/ship-review <id>\`.

人只和船长说话。合同要人冻结。禁止路径不能碰。同时最多 3 个工人。独立核验通过后才进收件箱。合并和发布只由人做。不碰密码。命令用 /ship-*。
${RULES_END}
`;

export interface SetupAction {
  path: string;
  action: "created" | "updated" | "unchanged" | "chained" | "removed" | "restored";
}

export interface SetupCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SetupReport {
  ok: boolean;
  root: string;
  shared: boolean;
  uninstalled: boolean;
  actions: SetupAction[];
  checks: SetupCheck[];
}

export interface SetupOptions {
  shared?: boolean;
  uninstall?: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureTrailingNewline(text: string): string {
  if (text === "") return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function replaceMarked(existing: string, start: string, end: string, block: string): string {
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (pattern.test(existing)) {
    return existing.replace(pattern, block.trimEnd());
  }
  const trimmed = existing.replace(/\s*$/, "");
  return `${trimmed}${trimmed ? "\n\n" : ""}${block.trimEnd()}\n`;
}

export function removeMarked(existing: string, start: string, end: string): { text: string; removed: boolean } {
  if (!existing.includes(start) || !existing.includes(end)) {
    return { text: existing, removed: false };
  }
  const pattern = new RegExp(`\\n?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
  let text = existing.replace(pattern, "\n");
  text = text.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
  return { text: ensureTrailingNewline(text.trimStart()), removed: true };
}

export function mergeAgents(existing: string | null): { text: string; action: SetupAction["action"] } {
  if (existing === null || existing.trim() === "") {
    return { text: `# AGENTS.md\n\n${RULES_BLOCK}\n`, action: "created" };
  }
  const next = ensureTrailingNewline(replaceMarked(existing, RULES_START, RULES_END, RULES_BLOCK));
  const current = ensureTrailingNewline(existing);
  return { text: next, action: current === next ? "unchanged" : existing.includes(RULES_START) ? "updated" : "updated" };
}

function ignoreBlock(start: string, end: string, extra: string[]): string {
  return `${start}\n${[...LOCAL_PATTERNS, ...extra].join("\n")}\n${end}`;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeText(path: string, next: string, previous: string | null): Promise<SetupAction["action"]> {
  const normalized = ensureTrailingNewline(next);
  if (previous === null) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, normalized);
    return "created";
  }
  if (ensureTrailingNewline(previous) === normalized) return "unchanged";
  await writeFile(path, normalized);
  return "updated";
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout;
}

async function tryGit(root: string, args: string[]): Promise<string | null> {
  try {
    return await git(root, args);
  } catch {
    return null;
  }
}

async function isGitRepo(root: string): Promise<boolean> {
  return (await tryGit(root, ["rev-parse", "--git-dir"])) !== null;
}

async function isTracked(root: string, rel: string): Promise<boolean> {
  const result = await tryGit(root, ["ls-files", "--error-unmatch", "--", rel]);
  return result !== null;
}

async function excludeFile(root: string): Promise<string> {
  const rel = (await git(root, ["rev-parse", "--git-path", "info/exclude"])).trim();
  return isAbsolute(rel) ? rel : join(root, rel);
}

async function hooksPathConfigured(root: string): Promise<boolean> {
  const value = await tryGit(root, ["config", "--local", "--get", "core.hooksPath"]);
  return value !== null && value.trim() !== "";
}

function hookScript(kind: "pre-commit" | "pre-push"): string {
  if (kind === "pre-commit") {
    return `#!/bin/sh
${HOOK_START}
root=$(git rev-parse --show-toplevel) || exit 1
id_file="$root/.agent-ship/active-contract"
if [ -f "$id_file" ]; then
  contract=$(tr -d ' \\t\\r\\n' < "$id_file")
  if [ -n "$contract" ]; then
    kit=$(tr -d '\\r\\n' < "$root/.agent-ship/kit-root") || exit 1
    nodebin=$(tr -d '\\r\\n' < "$root/.agent-ship/node-bin") || exit 1
    (cd "$kit/cli" && "$nodebin" --import tsx src/cli.ts check --staged --root "$root" --contract "$contract") || exit $?
  fi
fi
${HOOK_END}
chain="$0.agent-ship-chain"
if [ -f "$chain" ]; then
  if [ -x "$chain" ]; then
    exec "$chain" "$@"
  fi
  exec /bin/sh "$chain" "$@"
fi
exit 0
`;
  }
  return `#!/bin/sh
${HOOK_START}
input=$(cat)
case "\${AGENT_SHIP_ALLOW_PROTECTED_PUSH:-}" in
  1|true) ;;
  *)
    root=$(git rev-parse --show-toplevel) || exit 1
    extra=""
    if [ -f "$root/.agent-ship/protected-branches" ]; then
      extra=$(sed 's/#.*//' "$root/.agent-ship/protected-branches" | tr '\\n' ' ')
    fi
    status=0
    tmp="$root/.git/agent-ship-pre-push.$$"
    printf '%s\\n' "$input" > "$tmp"
    while read -r _local_ref _local_sha remote_ref _remote_sha; do
      [ -n "$remote_ref" ] || continue
      branch=\${remote_ref#refs/heads/}
      for name in main master $extra; do
        if [ "$name" = "$branch" ]; then
          status=1
          break
        fi
      done
      if [ "$status" -ne 0 ]; then
        break
      fi
    done < "$tmp"
    rm -f "$tmp"
    if [ "$status" -ne 0 ]; then
      echo "agent-ship: refusing push to a protected branch (main, master, or .agent-ship/protected-branches)." >&2
      echo "A human may override with AGENT_SHIP_ALLOW_PROTECTED_PUSH=1. The captain must not set it." >&2
      exit 1
    fi
    ;;
esac
${HOOK_END}
chain="$0.agent-ship-chain"
if [ -f "$chain" ]; then
  if [ -n "$input" ]; then
    printf '%s\\n' "$input" | {
      if [ -x "$chain" ]; then
        "$chain" "$@"
      else
        /bin/sh "$chain" "$@"
      fi
    }
    exit $?
  fi
  if [ -x "$chain" ]; then
    exec "$chain" "$@"
  fi
  exec /bin/sh "$chain" "$@"
fi
exit 0
`;
}

async function installHook(root: string, kind: "pre-commit" | "pre-push"): Promise<SetupAction> {
  const hookPath = join(root, ".git", "hooks", kind);
  const chainPath = `${hookPath}.agent-ship-chain`;
  const desired = hookScript(kind);
  const existing = await readOptional(hookPath);
  if (existing && !existing.includes(HOOK_START) && (await readOptional(chainPath)) === null) {
    await writeFile(chainPath, existing);
    try {
      const info = await stat(hookPath);
      await chmod(chainPath, info.mode);
    } catch {
      await chmod(chainPath, 0o755);
    }
    await writeFile(hookPath, desired);
    await chmod(hookPath, 0o755);
    return { path: `.git/hooks/${kind}`, action: "chained" };
  }
  const action = await writeText(hookPath, desired, existing?.includes(HOOK_START) ? existing : null);
  await chmod(hookPath, 0o755);
  return { path: `.git/hooks/${kind}`, action: existing === null ? "created" : action };
}

async function uninstallHook(root: string, kind: "pre-commit" | "pre-push"): Promise<SetupAction> {
  const hookPath = join(root, ".git", "hooks", kind);
  const chainPath = `${hookPath}.agent-ship-chain`;
  const existing = await readOptional(hookPath);
  if (!existing || !existing.includes(HOOK_START)) {
    return { path: `.git/hooks/${kind}`, action: "unchanged" };
  }
  const chain = await readOptional(chainPath);
  if (chain !== null) {
    await writeFile(hookPath, chain);
    await chmod(hookPath, 0o755);
    await rm(chainPath, { force: true });
    return { path: `.git/hooks/${kind}`, action: "restored" };
  }
  await rm(hookPath, { force: true });
  return { path: `.git/hooks/${kind}`, action: "removed" };
}

async function copyTemplate(kit: string, root: string, fromRel: string, toRel: string): Promise<SetupAction> {
  const to = join(root, toRel);
  const previous = await readOptional(to);
  if (previous !== null) return { path: toRel, action: "unchanged" };
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, await readFile(join(kit, fromRel)));
  return { path: toRel, action: "created" };
}

function trivialAgents(text: string): boolean {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "").replace(/#\s*AGENTS\.md/g, "").trim();
  return stripped === "";
}

async function applyRules(root: string, shared: boolean): Promise<SetupAction[]> {
  const actions: SetupAction[] = [];
  const agentsPath = join(root, "AGENTS.md");
  const tracked = await isTracked(root, "AGENTS.md");
  if (!shared && tracked) {
    const localPath = join(root, ".agent-ship", "AGENTS.local.md");
    const previous = await readOptional(localPath);
    const action = await writeText(localPath, `${RULES_BLOCK}\n`, previous);
    actions.push({
      path: ".agent-ship/AGENTS.local.md",
      action: previous === null ? "created" : action,
    });
    actions.push({
      path: "AGENTS.md",
      action: "unchanged",
    });
    return actions;
  }
  const previous = await readOptional(agentsPath);
  const merged = mergeAgents(previous);
  const action = await writeText(agentsPath, merged.text, previous);
  actions.push({ path: "AGENTS.md", action: previous === null ? "created" : action });
  return actions;
}

async function applyExclude(root: string, includeAgents: boolean): Promise<SetupAction> {
  const path = await excludeFile(root);
  const previous = await readOptional(path);
  const block = ignoreBlock(EXCLUDE_START, EXCLUDE_END, includeAgents ? ["AGENTS.md"] : []);
  const next = ensureTrailingNewline(replaceMarked(previous ?? "", EXCLUDE_START, EXCLUDE_END, block));
  const action = await writeText(path, next, previous);
  return { path: ".git/info/exclude", action: previous === null ? "created" : action };
}

async function applySharedIgnore(root: string): Promise<SetupAction> {
  const path = join(root, ".gitignore");
  const previous = await readOptional(path);
  const block = ignoreBlock(GITIGNORE_START, GITIGNORE_END, []);
  const next = ensureTrailingNewline(replaceMarked(previous ?? "", GITIGNORE_START, GITIGNORE_END, block));
  const action = await writeText(path, next, previous);
  return { path: ".gitignore", action: previous === null ? "created" : action };
}

async function selfCheck(root: string, shared: boolean, rulesInAgents: boolean): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];
  const rulesFile = rulesInAgents ? join(root, "AGENTS.md") : join(root, ".agent-ship", "AGENTS.local.md");
  const rules = (await readOptional(rulesFile)) ?? "";
  const starts = rules.split(RULES_START).length - 1;
  checks.push({
    name: "agents-rules",
    ok: starts === 1 && rules.includes(RULES_END),
    detail: rulesInAgents ? "AGENTS.md" : ".agent-ship/AGENTS.local.md",
  });
  if (shared) {
    const ignore = (await readOptional(join(root, ".gitignore"))) ?? "";
    checks.push({
      name: "shared-gitignore",
      ok: ignore.includes(GITIGNORE_START) && LOCAL_PATTERNS.every((line) => ignore.includes(line)),
      detail: "patterns in .gitignore",
    });
  } else {
    const exclude = (await readOptional(await excludeFile(root))) ?? "";
    const patterns = [...LOCAL_PATTERNS, ...(rulesInAgents ? ["AGENTS.md"] : [])];
    checks.push({
      name: "local-exclude",
      ok: exclude.includes(EXCLUDE_START) && patterns.every((line) => exclude.includes(line)),
      detail: "patterns in .git/info/exclude",
    });
    const gitignore = (await readOptional(join(root, ".gitignore"))) ?? "";
    checks.push({
      name: "gitignore-not-used",
      ok: !gitignore.includes(GITIGNORE_START),
      detail: "local setup does not write a shared ignore block",
    });
  }
  const indexOk = (await readOptional(join(root, ".agent-ship", "e2e", "index.md"))) !== null;
  checks.push({ name: "e2e-index", ok: indexOk, detail: indexOk ? "present" : "missing" });
  const policyOk = (await readOptional(join(root, ".agent-ship", "notify.policy.md"))) !== null;
  const allowOk = (await readOptional(join(root, ".agent-ship", "notify.allowlist.json"))) !== null;
  checks.push({ name: "notify-templates", ok: policyOk && allowOk, detail: "local copies" });
  for (const kind of ["pre-commit", "pre-push"]) {
    const text = await readOptional(join(root, ".git", "hooks", kind));
    checks.push({
      name: `hook-${kind}`,
      ok: text !== null && text.includes(HOOK_START) && !text.includes("core.hooksPath"),
      detail: ".git/hooks only",
    });
  }
  const hooksPath = await hooksPathConfigured(root);
  checks.push({
    name: "hooks-path",
    ok: !hooksPath,
    detail: hooksPath ? "core.hooksPath is set" : "core.hooksPath unset",
  });
  return checks;
}

export async function setupProject(root: string, options: SetupOptions = {}): Promise<SetupReport> {
  if (options.uninstall) return uninstallProject(root);
  const shared = options.shared === true;
  const kit = kitRoot();
  const actions: SetupAction[] = [];
  if (!(await isGitRepo(root))) {
    return {
      ok: false,
      root,
      shared,
      uninstalled: false,
      actions,
      checks: [{ name: "git", ok: false, detail: "not a git repository; setup does not set core.hooksPath" }],
    };
  }

  await mkdir(join(root, ".agent-ship", "proposals"), { recursive: true });
  await mkdir(join(root, ".agent-ship", "contracts"), { recursive: true });
  await mkdir(join(root, ".agent-ship", "packets"), { recursive: true });
  await mkdir(join(root, ".agent-ship", "e2e"), { recursive: true });
  for (const dir of ["proposals", "contracts", "packets"]) {
    const rel = `.agent-ship/${dir}/.gitkeep`;
    const previous = await readOptional(join(root, rel));
    if (previous === null) {
      await writeFile(join(root, rel), "");
      actions.push({ path: rel, action: "created" });
    } else {
      actions.push({ path: rel, action: "unchanged" });
    }
  }

  actions.push(await copyTemplate(kit, root, "templates/notify.policy.example.md", ".agent-ship/notify.policy.md"));
  actions.push(
    await copyTemplate(kit, root, "templates/notify.allowlist.example.json", ".agent-ship/notify.allowlist.json"),
  );
  actions.push(await copyTemplate(kit, root, "templates/e2e.md", ".agent-ship/e2e/index.md"));

  actions.push(...(await applyRules(root, shared)));

  if (shared) {
    actions.push(await applySharedIgnore(root));
  } else {
    const agentsText = (await readOptional(join(root, "AGENTS.md"))) ?? "";
    const includeAgents = agentsText.includes(RULES_START) && !(await isTracked(root, "AGENTS.md"));
    actions.push(await applyExclude(root, includeAgents));
  }

  await writeFile(join(root, ".agent-ship", "kit-root"), `${kit}\n`);
  await writeFile(join(root, ".agent-ship", "node-bin"), `${process.execPath}\n`);
  actions.push({ path: ".agent-ship/kit-root", action: "updated" });
  actions.push({ path: ".agent-ship/node-bin", action: "updated" });

  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  actions.push(await installHook(root, "pre-commit"));
  actions.push(await installHook(root, "pre-push"));

  const inAgents = ((await readOptional(join(root, "AGENTS.md"))) ?? "").includes(RULES_START);
  const checks = await selfCheck(root, shared, inAgents);
  return {
    ok: checks.every((check) => check.ok),
    root,
    shared,
    uninstalled: false,
    actions,
    checks,
  };
}

async function uninstallProject(root: string): Promise<SetupReport> {
  const actions: SetupAction[] = [];
  if (!(await isGitRepo(root))) {
    return {
      ok: false,
      root,
      shared: false,
      uninstalled: true,
      actions,
      checks: [{ name: "git", ok: false, detail: "not a git repository" }],
    };
  }
  actions.push(await uninstallHook(root, "pre-commit"));
  actions.push(await uninstallHook(root, "pre-push"));

  const agentsPath = join(root, "AGENTS.md");
  const agents = await readOptional(agentsPath);
  if (agents && agents.includes(RULES_START)) {
    const removed = removeMarked(agents, RULES_START, RULES_END);
    if (trivialAgents(removed.text)) {
      await rm(agentsPath, { force: true });
      actions.push({ path: "AGENTS.md", action: "removed" });
    } else {
      await writeText(agentsPath, removed.text, agents);
      actions.push({ path: "AGENTS.md", action: "updated" });
    }
  } else {
    actions.push({ path: "AGENTS.md", action: "unchanged" });
  }
  const localRules = join(root, ".agent-ship", "AGENTS.local.md");
  if ((await readOptional(localRules)) !== null) {
    await rm(localRules, { force: true });
    actions.push({ path: ".agent-ship/AGENTS.local.md", action: "removed" });
  }

  try {
    const excludePath = await excludeFile(root);
    const exclude = await readOptional(excludePath);
    if (exclude && exclude.includes(EXCLUDE_START)) {
      const removed = removeMarked(exclude, EXCLUDE_START, EXCLUDE_END);
      await writeText(excludePath, removed.text, exclude);
      actions.push({ path: ".git/info/exclude", action: "updated" });
    }
  } catch {
    actions.push({ path: ".git/info/exclude", action: "unchanged" });
  }

  const gitignorePath = join(root, ".gitignore");
  const gitignore = await readOptional(gitignorePath);
  if (gitignore && gitignore.includes(GITIGNORE_START)) {
    const removed = removeMarked(gitignore, GITIGNORE_START, GITIGNORE_END);
    if (removed.text.trim() === "") {
      await rm(gitignorePath, { force: true });
      actions.push({ path: ".gitignore", action: "removed" });
    } else {
      await writeText(gitignorePath, removed.text, gitignore);
      actions.push({ path: ".gitignore", action: "updated" });
    }
  }

  await rm(join(root, ".agent-ship", "kit-root"), { force: true });
  await rm(join(root, ".agent-ship", "node-bin"), { force: true });

  const hooksPath = await hooksPathConfigured(root);
  const pre = await readOptional(join(root, ".git", "hooks", "pre-commit"));
  const push = await readOptional(join(root, ".git", "hooks", "pre-push"));
  const agentsAfter = (await readOptional(agentsPath)) ?? "";
  const checks: SetupCheck[] = [
    {
      name: "hooks-removed",
      ok: !(pre ?? "").includes(HOOK_START) && !(push ?? "").includes(HOOK_END),
      detail: "agent-ship hooks cleared; chained hooks restored when present",
    },
    {
      name: "rules-removed",
      ok: !agentsAfter.includes(RULES_START) && (await readOptional(localRules)) === null,
      detail: "rules block removed",
    },
    {
      name: "hooks-path",
      ok: !hooksPath,
      detail: hooksPath ? "core.hooksPath is set" : "core.hooksPath unset",
    },
  ];
  return {
    ok: checks.every((check) => check.ok),
    root,
    shared: false,
    uninstalled: true,
    actions,
    checks,
  };
}
