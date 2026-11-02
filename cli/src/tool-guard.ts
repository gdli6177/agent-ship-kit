import { fileURLToPath } from "node:url";
import { basename, join, relative, resolve } from "node:path";
import { parseContractPaths, checkPaths } from "./paths.js";
import { contractRoles } from "./roles.js";
import { readEvents } from "./storage.js";
import { actorIdentity } from "./authority.js";
import { field } from "./records.js";
import { optionalText, ownedDirectory, requiredSources } from "./team.js";
import { withLock } from "./storage.js";
import { writeFile } from "node:fs/promises";

export type GuardedTool = { tool: "shell"; argv: string[] } | { tool: "read" | "write"; path: string; content?: string };
const captainCommands = new Set(["team context", "intake add", "intake list", "intake claim", "intake update", "role list", "role show", "status", "status decisions", "slice start", "slice open", "slice update", "inbox add", "inbox list", "notify dry-run", "notify run", "check", "doctor", "learning extract", "learning review", "correction add", "handbook propose", "authority status"]);
function cliWords(argv: string[]): string[] | null {
  if (argv[0] === "agent-ship") return argv.slice(1);
  const runner = fileURLToPath(new URL("../bin/agent-ship.js", import.meta.url));
  if (argv[0] === process.execPath && argv[1] === runner) return argv.slice(2);
  return null;
}
export async function guardTool(root: string, input: GuardedTool, repo = root) {
  const actor = await actorIdentity(root);
  const refuse = (reason: string) => ({ allowed: false, actor: actor.ref, role: actor.role, reason });
  if (["unconfigured", "unbound", "unknown", "retired"].includes(actor.role)) return refuse("Configure authority and bind the authenticated actor in the host before enabling this hook.");
  if (!input || !["shell", "read", "write"].includes(input.tool)) return refuse("Unknown normalized tool event");
  if (actor.role === "captain") {
    const budget = await withLock(join(root, ".agent-ship"), async () => {
      const file = join(root, ".agent-ship/captain-state.json");
      const raw = await optionalText(file);
      const state = raw ? JSON.parse(raw) as { turn_started_at: string; tool_calls: number; captain_busy_until?: string } : { turn_started_at: new Date().toISOString(), tool_calls: 0 };
      if (Date.now() - Date.parse(state.turn_started_at) > 120000 || state.tool_calls >= 12) return false;
      state.tool_calls++; await writeFile(file, JSON.stringify(state)); return true;
    });
    if (!budget) return refuse("Captain turn budget reached; return the decision list and delegate investigation. Start the next human-facing turn with captain heartbeat.");
  }
  if (input.tool === "shell") {
    if (!Array.isArray(input.argv) || !input.argv.length || input.argv.some(arg => typeof arg !== "string" || /[\r\n\0]/.test(arg))) return refuse("Shell tool requires normalized argv; never eval a command string.");
    const words = cliWords(input.argv);
    if (actor.role === "human") return { allowed: true, actor: actor.ref, role: actor.role, reason: "Trusted human channel; host's own authorization still applies." };
    if (words) {
      for (let i = 0; i < words.length; i++) {
        const word = words[i]!;
        const selected = word === "--root" ? words[i + 1] : word.startsWith("--root=") ? word.slice(7) : undefined;
        if (selected && resolve(selected) !== resolve(root)) return refuse("Tool command cannot switch to another authority root");
      }
      const positional = words.filter(word => !word.startsWith("--"));
      const command = [positional[0], positional[1]].filter(Boolean).join(" ");
      const group = positional[0] ?? "";
      if (["authority", "limits"].includes(group) && command !== "authority status") return refuse("Only the registered human manages authority or limits.");
      if (command === "contract freeze" || command === "inbox decide") return refuse("Freezing and final decisions require the registered human channel.");
      if (command === "notify run" && actor.role !== "captain") return refuse("Only the captain may contact the human; write an inbox item instead.");
      if (command === "notify run" && actor.role === "captain") {
        for (const [flag, file] of [["policy", "notify.policy.md"], ["allowlist", "notify.allowlist.json"]]) {
          const values = words.flatMap((word, index) => word === `--${flag}` ? [words[index + 1]] : word.startsWith(`--${flag}=`) ? [word.slice(flag!.length + 3)] : []);
          if (values.length !== 1 || !values[0] || resolve(repo, values[0]) !== join(resolve(root), ".agent-ship", file!)) return refuse("Captain notification must use the protected state-root policy and allowlist; artifacts cannot supply executable policy.");
        }
      }
      if (actor.role === "captain" && !(captainCommands.has(command) || captainCommands.has(group))) return refuse("Command is outside the captain whitelist; delegate to owner/scout/worker.");
      return { allowed: true, actor: actor.ref, role: actor.role, reason: "CLI command passes role gate; the subcommand still validates lane and approval." };
    }
    if (actor.role === "captain") return refuse("Captain cannot run repository shell commands, tests or builds; delegate.");
    if (["bash", "sh", "zsh", "fish", "sudo"].includes(basename(input.argv[0]!))) return refuse("Pass direct argv; shell interpreters bypass the command boundary.");
    if (basename(input.argv[0]!) === "git" && input.argv.some(word => ["push", "merge", "reset", "clean", "tag"].includes(word))) return refuse("Workers/owners cannot publish, merge or rewrite Git state.");
    if (["scout", "verifier"].includes(actor.role) && basename(input.argv[0]!) === "git" && !["status", "diff", "show", "log", "rev-parse"].includes(input.argv[1] ?? "")) return refuse("Read-only role cannot mutate Git state.");
    return { allowed: true, actor: actor.ref, role: actor.role, reason: "Host sandbox, frozen acceptance and path guards remain required for non-captain execution." };
  }
  if (typeof input.path !== "string") return refuse("File tools require a path");
  let target: string;
  try { target = await ownedDirectory(repo, resolve(repo, input.path)); } catch { return refuse("Path is outside this checkout or is sensitive"); }
  const path = relative(resolve(repo), target).replaceAll("\\", "/");
  const artifact = /^\.agent-ship\/(proposals|contracts|packets)\//.test(path);
  if (input.tool === "write") {
    if (actor.role === "human") return { allowed: true, actor: actor.ref, role: actor.role, reason: "Trusted human channel; CLI receipts must be refreshed after protected edits." };
    if (["scout", "verifier"].includes(actor.role)) return refuse("Read-only role cannot write files");
    if (/^\.agent-ship\/(authority\.json|limits\.json|notify\.policy\.md|notify\.allowlist\.json|approvals)/.test(path)) return refuse("Protected policy must use its registered-human CLI command");
    if (path.startsWith(".agent-ship/contracts/")) {
      const previous = await optionalText(target);
      if (field(previous ?? "", "Status") === "frozen" || field(input.content ?? "", "Status") === "frozen") return refuse("Use human contract freeze; frozen contracts cannot be rewritten");
    }
    if (actor.role === "owner" && artifact) {
      const existing = await optionalText(target);
      const recorded = field(existing ?? "", "Lane"), requested = field(input.content ?? "", "Lane");
      if ((recorded && recorded !== actor.lane) || (requested && requested !== actor.lane) || (!recorded && !requested)) return refuse("Owner artifact must identify its own lane");
    }
    if (actor.role === "worker") {
      const dispatch = (await readEvents(root)).filter(event => event.type === "worker_dispatched" && event.worker_ref === actor.ref).at(-1);
      const active = await (await import("./watchdog.js")).activeSlices(root);
      if (!dispatch || !active.some(slice => slice.source_task_id === dispatch.source_task_id) || resolve(String(dispatch.repo_root)) !== resolve(repo)) return refuse("Worker may only write its recorded execution checkout");
      const markdown = await optionalText(join(root, `.agent-ship/contracts/${dispatch.contract_id}.md`));
      if (!markdown) return refuse("Frozen worker contract is missing");
      const paths = parseContractPaths(markdown);
      const roles = await contractRoles(root, markdown, String(dispatch.slice_id));
      paths.forbidden.push(...roles.flatMap(role => role.card.forbidden_paths));
      if (checkPaths([path], paths).length) return refuse("Write is outside the worker's contract/role paths");
    }
    if (actor.role === "captain" && !artifact) return refuse("Captain writes only proposal/contract/packet artifacts; delegate other work");
    if (actor.role === "owner" && !artifact) return refuse("Owner delivers through inbox/artifacts; workers implement source changes");
    return { allowed: true, actor: actor.ref, role: actor.role, reason: "Artifact or worker write; host must still enforce the assigned lane/contract paths." };
  }
  if (actor.role === "captain") {
    const sources = await requiredSources(root);
    const metadata = artifact || ["AGENTS.md", "agent-ship.team.json", ".agent-ship/inbox.jsonl", ".agent-ship/intake.jsonl"].includes(path) || sources.includes(target);
    if (!metadata) return refuse("Captain consumes scout/owner summaries and standing rules, not repository source scans");
  }
  return { allowed: true, actor: actor.ref, role: actor.role, reason: "Read stays in this checkout and respects the role boundary." };
}
