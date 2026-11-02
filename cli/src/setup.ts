import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gitPath, repositoryRoot } from "./repository.js";
import { withLock } from "./storage.js";
import { initializeTeam, requiredSources } from "./team.js";

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

- In the captain conversation you are a router, not an executor. Talk to the human, draft contracts, dispatch, route, and record. The captain does not edit product code or run long tasks. A worker explicitly assigned a frozen slice executes only that slice; a verifier remains read-only.
- One human-facing captain; each independent demand has a temporary owner and lane. Read the installed kit's docs/owner-lanes.md before managing parallel demands. Owners coordinate scouts/workers/verifiers and return artifacts; they never become another captain.
- Do not block waiting on a worker. Keep accepting new requests while workers run. The captain consumes scout summaries and decision lists; delegate repository inspection, tests, builds and Git work.
- For multiple demands use \`intake add --text "<request>" --project <id>\`, then \`intake claim <id> --by <owner-ref> --lane <lane>\`. Keep exactly one current proposal per lane, never one global proposal across all demands. Resolve ambiguous short instructions to the intended lane before acting.
- The trusted host binds authenticated actors, registers human/captain with \`authority init\`, installs the normalized pre-tool adapter and resets captain heartbeat once per human-facing turn. Never select another actor, rewrite authority/limits, reset your own turn budget, or bypass the hook. CLI receipts are application guards; the host must protect identity and filesystem policy.
- Only the registered human channel may \`contract freeze\`, \`inbox decide\` or \`limits set\`. Only the captain may execute \`notify run\`. Owners/workers return inbox/artifacts; roles/templates are portable, live instances are temporary.
- Before dispatch request a scout card (conclusion, affected paths, acceptance commands, risks, evidence). Select each slice's role; missing/malformed role cards block dispatch. Role forbidden paths add to contract forbidden paths and never widen allowed scope.
- Follow-ups on a subscribed thread go to the owning worker. You handle new or unowned events and cross-slice coordination.
- Legacy single-lane execution requests, including 继续、接管、收口、上测试、上线、你来做, start with \`agent-ship intake --text "<request>"\`. Read-only investigation may clarify a plan; no product edits, long tests, CI execution or dispatch before acceptance. Present the proposal promptly; do not stretch investigation into execution.
- Before execution run \`agent-ship guard\`. No frozen contract means STOP: show the registered proposal and ask for acceptance. \`intake --direct\` requires the human's explicit direct-execution instruction, allowed/forbidden scope and acceptance; never infer it from "continue". It does not modify hard rules.
- Do not spawn a worker until the human freezes the contract.
- Edit only Allowed paths on the frozen contract. Never touch Forbidden paths. Workers do the edits.
- Read \`.agent-ship/hard-rules.json\` before dispatch or review. \`hook\` and \`contract_forbidden\` rules fail the local check with their rule id. Promote a repeated review note only after the human agrees. Never copy a secret into a rule.
- At most 3 workers may be queued or running across all contracts.
- A separate read-only verifier must agree before a \`needs_review\` inbox item is filed. The verifier does not see the worker chat.
- On session start run \`agent-ship doctor\` and \`agent-ship team context --auto --project <project-id>\`. Read every required source body; paths and digests are a receipt, not proof of reading. Active lessons are bounded soft guidance; owner rules remain authoritative.
- Capture human corrections immediately with \`correction add\`, even before dispatch: one-time facts use event, reusable behavior uses lesson, definitions use handbook. Supply explicit project/team scope, evidence and when/action. Do not copy credentials. Reusable signals only create candidates; a maintainer must activate them. At wrap-up run \`learning extract\` and \`learning review\`, record none/candidate with a reason. Never edit handbook or hard rules automatically.
- Check \`watchdog status\` and \`watchdog doctor\` after dispatch. Reject failed registration/runtime; \`--allow-untimed\` is only for explicitly chosen manual supervision. A registered job is not proof that a worker is healthy.
- After independent verification, the captain records \`agent-ship lesson check\` with none/candidate, a reason and the verifier reference. Routine work may produce none. Candidates require evidence, scope, reuse value and deduplication before activation.
- Only the human merges or ships. Do not merge to main or master and do not deploy to production.
- Never read, write, or repeat passwords, cookies, or storageState contents.
- Manage the workflow for the human: new requests → ship-contract; explicit acceptance of the just-presented plan plus “start” → trusted human freeze, then ship-dispatch; progress questions → real adapter status and inbox; result review/decisions → ship-inbox. Resolve ids and next steps yourself. Ask only about material ambiguity, scope, permissions or human decisions, not routine mechanics. Never treat silence or casual acknowledgement as approval.
- A clear “按这个方案开始 / Start with this plan” may freeze and authorize dispatch only when the exact presented proposal is unambiguous. Record its id, accepted text, human and time first. No repeated dispatch command is needed; freeze-only approval does not authorize starting.
- Restore existing contracts, inbox and actual worker status on a new conversation; do not duplicate dispatch. A setup report or task record does not prove worker execution is available.
- Each \`/ship-*\` command is an optional shortcut to the skill without the slash. Prefer natural language; do not make the human remember the sequence. Resolve skill files below under the installed kit at \`$HOME/.agent-ship-kit/current/\` (or the actual manual clone), not relative to this project. Deterministic steps call the \`agent-ship\` CLI.
  - \`/ship-setup\` → \`skills/ship-setup/SKILL.md\` → \`agent-ship setup\`
  - \`/ship-contract\` → \`skills/ship-contract/SKILL.md\`
  - \`/ship-dispatch\` → \`skills/ship-dispatch/SKILL.md\` → \`agent-ship slice start\`
  - \`/ship-inbox\` → \`skills/ship-inbox/SKILL.md\` → \`agent-ship inbox list --sort priority\`, then \`agent-ship inbox decide\`
  - \`/ship-inbox <id>\` jumps to that open item. Notify deep-links use this form.
  - \`/ship-notify\` → \`skills/ship-notify/SKILL.md\` → \`agent-ship notify dry-run\` or \`notify run\`
  - \`/ship-e2e\` → \`skills/ship-e2e/SKILL.md\`
  - \`/ship-watchdog\` → \`skills/ship-watchdog/SKILL.md\` → \`agent-ship watchdog\` (independent of the captain; a timer runs it)
- Speculative drafts stay off unless \`.agent-ship/limits.json\` sets \`"speculative": true\`. Even then, do not dispatch or edit code without a frozen contract, and only show the owner a draft that has evidence.

人直接提需求、问进度和审结果，船长自行衔接技能并保管编号。明确“按这个方案开始”可确认刚展示的唯一方案并开工，不要求背命令。合同要人确认，禁止路径不能碰，同时最多 3 个工人；独立核验后才待审。反复的审阅意见在人同意后才能收成本地硬规则。船长不改产品代码，合并和发布只由人做，不碰密码。
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
  rules_auto_loaded?: boolean;
  warnings?: string[];
}

export interface SetupOptions {
  shared?: boolean;
  uninstall?: boolean;
  purge?: boolean;
  stateRoot?: string;
  handbook?: string;
  lessons?: string;
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

/** Left behind after uninstall so a kept `.agent-ship/` directory stays untracked. */
export const KEPT_EXCLUDE_BLOCK = `${EXCLUDE_START}\n.agent-ship/\n${EXCLUDE_END}`;

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
  const value = await tryGit(root, ["config", "--get", "core.hooksPath"]);
  return value !== null && value.trim() !== "";
}

function hookScript(kind: "pre-commit" | "pre-push"): string {
  if (kind === "pre-commit") {
    return `#!/bin/sh
${HOOK_START}
root=$(git rev-parse --show-toplevel) || exit 1
contract=""
id_file="$root/.agent-ship/active-contract"
if [ -f "$root/.agent-ship/active-lane" ]; then
  lane=$(tr -d '\\r\\n' < "$root/.agent-ship/active-lane") || exit 1
  case "$lane" in
    ""|default) ;;
    *[!A-Za-z0-9_-]*) echo "agent-ship: invalid active lane" >&2; exit 1 ;;
    *) id_file="$root/.agent-ship/active-contract.$lane" ;;
  esac
fi
if [ -f "$id_file" ]; then
  contract=$(tr -d ' \\t\\r\\n' < "$id_file")
fi
state="$root"
if [ -f "$root/.agent-ship/state-root" ]; then
  state=$(tr -d '\\r\\n' < "$root/.agent-ship/state-root") || exit 1
  if [ -z "$state" ]; then
    state="$root"
  fi
fi
if [ -f "$root/.agent-ship/guard-required" ]; then
  kit=$(tr -d '\\r\\n' < "$root/.agent-ship/kit-root") || exit 1
  nodebin=$(tr -d '\\r\\n' < "$root/.agent-ship/node-bin") || exit 1
  (cd "$kit/cli" && "$nodebin" --import tsx src/cli.ts guard --staged --root "$state" --repo "$root") || exit $?
fi
rules="$state/.agent-ship/hard-rules.json"
if [ -n "$contract" ] || [ -f "$rules" ]; then
  kit=$(tr -d '\\r\\n' < "$root/.agent-ship/kit-root") || exit 1
  nodebin=$(tr -d '\\r\\n' < "$root/.agent-ship/node-bin") || exit 1
  if [ -n "$contract" ]; then
    (cd "$kit/cli" && "$nodebin" --import tsx src/cli.ts check --staged --root "$state" --repo "$root" --contract "$contract") || exit $?
  else
    (cd "$kit/cli" && "$nodebin" --import tsx src/cli.ts check --staged --root "$state" --repo "$root" --hard-rules) || exit $?
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
    tmp=$(git rev-parse --git-path "agent-ship-pre-push.$$") || exit 1
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
  const hookPath = await gitPath(root, `hooks/${kind}`);
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
  const hookPath = await gitPath(root, `hooks/${kind}`);
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

/** Worktrees share hooks, but activation and state pointers belong to each checkout. */
async function manageHooks(root: string, uninstall: boolean): Promise<{ actions: SetupAction[]; retained: boolean }> {
  const hooks = dirname(await gitPath(root, "hooks/pre-commit"));
  return withLock(hooks, async () => {
    const registry = join(hooks, "agent-ship-roots.json");
    const raw = await readOptional(registry);
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("invalid agent-ship hook registry");
    const roots = new Set<string>(value);
    if (uninstall) roots.delete(root); else roots.add(root);
    if (uninstall && roots.size > 0) {
      await writeFile(registry, JSON.stringify([...roots]));
      return { actions: [], retained: true };
    }
    const actions: SetupAction[] = [];
    for (const kind of ["pre-commit", "pre-push"] as const) actions.push(await (uninstall ? uninstallHook(root, kind) : installHook(root, kind)));
    if (uninstall) await rm(registry, { force: true });
    else await writeFile(registry, JSON.stringify([...roots]));
    return { actions, retained: false };
  });
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
  if (shared) {
    const localPath = join(root, ".agent-ship/AGENTS.local.md");
    const local = await readOptional(localPath);
    if (local?.includes(RULES_START)) {
      const retained = removeMarked(local, RULES_START, RULES_END).text;
      if (retained.trim()) { await writeText(localPath, retained, local); actions.push({ path: ".agent-ship/AGENTS.local.md", action: "updated" }); }
      else { await rm(localPath); actions.push({ path: ".agent-ship/AGENTS.local.md", action: "removed" }); }
    }
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

async function selfCheck(root: string, shared: boolean, rulesInAgents: boolean, gitignoreBefore: string | null): Promise<SetupCheck[]> {
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
    const patterns = [...LOCAL_PATTERNS, ...(rulesInAgents && !(await isTracked(root, "AGENTS.md")) ? ["AGENTS.md"] : [])];
    checks.push({
      name: "local-exclude",
      ok: exclude.includes(EXCLUDE_START) && patterns.every((line) => exclude.includes(line)),
      detail: "patterns in .git/info/exclude",
    });
    const gitignore = (await readOptional(join(root, ".gitignore"))) ?? "";
    checks.push({
      name: "gitignore-not-used",
      ok: gitignore === (gitignoreBefore ?? ""),
      detail: "local setup preserves the existing shared ignore file, including inherited blocks",
    });
  }
  const indexOk = (await readOptional(join(root, ".agent-ship", "e2e", "index.md"))) !== null;
  checks.push({ name: "e2e-index", ok: indexOk, detail: indexOk ? "present" : "missing" });
  const policyOk = (await readOptional(join(root, ".agent-ship", "notify.policy.md"))) !== null;
  const allowOk = (await readOptional(join(root, ".agent-ship", "notify.allowlist.json"))) !== null;
  checks.push({ name: "notify-templates", ok: policyOk && allowOk, detail: "local copies" });
  for (const kind of ["pre-commit", "pre-push"]) {
    const text = await readOptional(await gitPath(root, `hooks/${kind}`));
    checks.push({
      name: `hook-${kind}`,
      ok: text !== null && text.includes(HOOK_START) && !text.includes("core.hooksPath"),
      detail: "Git-resolved hooks directory",
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

  // A subdirectory resolves to this worktree's top-level, not another linked worktree.
  root = await repositoryRoot(root);
  if (await hooksPathConfigured(root)) {
    return { ok: false, root, shared, uninstalled: false, actions: [], checks: [{ name: "hooks-path", ok: false, detail: "core.hooksPath is set; compose agent-ship with the owner hook before setup (no files changed)" }] };
  }
  if (options.uninstall || options.purge) return uninstallProject(root, options.purge === true);
  const gitignoreBefore = await readOptional(join(root, ".gitignore"));
  const stateRoot = options.stateRoot ? await repositoryRoot(resolve(options.stateRoot), true) : root;

  actions.push(...await initializeTeam(root, { shared, kit, handbook: options.handbook, lessons: options.lessons }));
  await requiredSources(root);

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
  await writeFile(join(root, ".agent-ship", "state-root"), `${stateRoot}\n`);
  actions.push({ path: ".agent-ship/kit-root", action: "updated" });
  actions.push({ path: ".agent-ship/node-bin", action: "updated" });

  await writeFile(join(root, ".agent-ship/guard-required"), "1\n");
  actions.push(...(await manageHooks(root, false)).actions);

  const inAgents = ((await readOptional(join(root, "AGENTS.md"))) ?? "").includes(RULES_START);
  const checks = await selfCheck(root, shared, inAgents, gitignoreBefore);
  return {
    ok: checks.every((check) => check.ok),
    root,
    shared,
    uninstalled: false,
    actions,
    checks,
    rules_auto_loaded: inAgents,
    warnings: inAgents ? [] : ["Rules are in .agent-ship/AGENTS.local.md and are not automatically loaded by the host. Read it explicitly in this session; use setup --shared only with shared-adoption authorization, or configure the host bridge yourself."],
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function uninstallProject(root: string, purge: boolean): Promise<SetupReport> {
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
  const hookRemoval = await manageHooks(root, true);
  actions.push(...hookRemoval.actions);

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

  const dataDir = join(root, ".agent-ship");
  if (purge && (await directoryExists(dataDir))) {
    await rm(dataDir, { recursive: true, force: true });
    actions.push({ path: ".agent-ship/", action: "removed" });
  }

  try {
    const excludePath = await excludeFile(root);
    const exclude = await readOptional(excludePath);
    if (hookRemoval.retained) {
      // info/exclude is shared too: keep the other worktrees' protections.
    } else if (purge || !(await directoryExists(dataDir))) {
      if (exclude && exclude.includes(EXCLUDE_START)) {
        const removed = removeMarked(exclude, EXCLUDE_START, EXCLUDE_END);
        await writeText(excludePath, removed.text, exclude);
        actions.push({ path: ".git/info/exclude", action: "updated" });
      }
    } else {
      const next = ensureTrailingNewline(replaceMarked(exclude ?? "", EXCLUDE_START, EXCLUDE_END, KEPT_EXCLUDE_BLOCK));
      const action = await writeText(excludePath, next, exclude);
      actions.push({ path: ".git/info/exclude", action: exclude === null ? "created" : action });
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

  if (!purge) {
    await rm(join(root, ".agent-ship", "kit-root"), { force: true });
    await rm(join(root, ".agent-ship", "node-bin"), { force: true });
    await rm(join(root, ".agent-ship", "state-root"), { force: true });
    await rm(join(root, ".agent-ship", "active-contract"), { force: true });
    await rm(join(root, ".agent-ship", "guard-required"), { force: true });
  }

  const hooksPath = await hooksPathConfigured(root);
  const pre = await readOptional(await gitPath(root, "hooks/pre-commit"));
  const push = await readOptional(await gitPath(root, "hooks/pre-push"));
  const agentsAfter = (await readOptional(agentsPath)) ?? "";
  const checks: SetupCheck[] = [
    {
      name: "hooks-removed",
      ok: hookRemoval.retained || (!(pre ?? "").includes(HOOK_START) && !(push ?? "").includes(HOOK_END)),
      detail: hookRemoval.retained ? "shared hooks retained for other checkouts" : "agent-ship hooks cleared; chained hooks restored when present",
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
    {
      name: "kept-data",
      ok: purge
        ? !(await directoryExists(dataDir))
        : !(await directoryExists(dataDir)) ||
          ((await readOptional(await excludeFile(root).catch(() => ""))) ?? "").includes(".agent-ship/"),
      detail: purge ? "directory removed" : "kept directory stays excluded",
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
