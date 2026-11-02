import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkContract, checkHardRules, contractFile } from "./check.js";
import { checkPaths, parseContractPaths } from "./paths.js";
import { containsSecret } from "./hard-rules.js";
import { gitOutput, gitPath, repositoryRoot } from "./repository.js";
import { nextSequence, withLock } from "./storage.js";
import { optionalText } from "./team.js";

export function safeText(value: string, name: string, max = 1000): string {
  const result = value.trim();
  if (!result || result.length > max || /[\r\n\0]/.test(result)) throw new Error(`invalid ${name}: use single-line text up to ${max} characters`);
  if (containsSecret(result)) throw new Error(`${name} looks like a secret; refusing to store it`);
  return result;
}
export function safeId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)) throw new Error("invalid id");
  return id;
}
export async function writeEvent(root: string, payload: Record<string, unknown>) {
  return withLock(join(root, ".agent-ship"), async () => {
    const sequence = await nextSequence(root);
    const event = { ...payload, id: `evt_${payload.type}_${sequence}`, sequence, created_at: new Date().toISOString() };
    await appendFile(join(root, ".agent-ship/events.jsonl"), `${JSON.stringify(event)}\n`);
    return event;
  });
}
function pathList(paths: string[]): string[] {
  return paths.map(path => {
    safeText(path, "path", 240);
    if (path.startsWith("/") || path.split("/").includes("..") || path.startsWith(".git/") || path.includes("`")) throw new Error("scope paths must be repository-relative globs");
    return path;
  });
}
export async function intake(root: string, input: { text: string; id?: string; direct?: boolean; allowed?: string[]; forbidden?: string[]; acceptedBy?: string; acceptedText?: string }) {
  root = await repositoryRoot(root);
  const request = safeText(input.text, "request");
  const id = safeId(input.id ?? `proposal_${createHash("sha256").update(request).digest("hex").slice(0, 12)}`);
  const directory = join(root, ".agent-ship/proposals");
  const file = join(directory, `${id}.md`);
  const allowed = pathList(input.allowed ?? []), forbidden = pathList(input.forbidden ?? []);
  if (input.direct && (!allowed.length || !forbidden.length || !input.acceptedBy || !input.acceptedText)) throw new Error("--direct requires --allowed, --forbidden, --accepted-by and --accepted-text recording explicit human authorization");
  const acceptedBy = input.direct ? safeText(input.acceptedBy!, "accepted-by", 120) : "";
  const acceptedText = input.direct ? safeText(input.acceptedText!, "accepted-text") : "";
  return withLock(join(root, ".agent-ship"), async () => {
    await mkdir(directory, { recursive: true });
    const previous = await optionalText(file);
    if (previous && !previous.includes(`Request: ${request}\n`)) throw new Error("proposal id already has a different request; use a new id");
    if (!previous) await writeFile(file, `# Proposal\nProposal id: ${id}\nStatus: draft\nCreated at: ${new Date().toISOString()}\nRequest: ${request}\n\n## Allowed paths\n${allowed.map(p => `- ${p}`).join("\n")}\n\n## Forbidden paths\n${forbidden.map(p => `- ${p}`).join("\n")}\n\n## Acceptance\n- Describe observable completion before freezing.\n\n## Risks / Open questions\n- Resolve consequential questions with the human.\n`, { flag: "wx" });
    let contract: string | null = null;
    if (input.direct) {
      contract = `direct_${id}`;
      const contractPath = contractFile(root, contract);
      const existing = await optionalText(contractPath);
      if (existing) {
        const paths = parseContractPaths(existing);
        if (JSON.stringify(paths.allowed) !== JSON.stringify(allowed) || JSON.stringify(paths.forbidden) !== JSON.stringify(forbidden) || !existing.includes(`Accepted text: ${acceptedText}\n`) || !existing.includes(`Accepted by: ${acceptedBy}\n`)) throw new Error("direct contract already exists with different authorization; use a new id");
      } else {
        const at = new Date().toISOString();
        await mkdir(join(root, ".agent-ship/contracts"), { recursive: true });
        await writeFile(contractPath, `# Explicit direct contract\nStatus: frozen\nFrozen by: ${acceptedBy}\nFrozen at: ${at}\nProposal id: ${id}\nAccepted by: ${acceptedBy}\nAccepted at: ${at}\nAccepted text: ${acceptedText}\n## Allowed paths\n${allowed.map(p => `- ${p}`).join("\n")}\n## Forbidden paths\n${forbidden.map(p => `- ${p}`).join("\n")}\n## Acceptance\n- ${request}\n## Slices\n| direct | Explicit human scope | Acceptance passes |\n`, { flag: "wx" });
      }
      await writeFile(join(root, ".agent-ship/active-contract"), `${contract}\n`);
    }
    await writeFile(join(root, ".agent-ship/active-proposal"), `${id}\n`);
    if (!previous) {
      const sequence = await nextSequence(root);
      await appendFile(join(root, ".agent-ship/events.jsonl"), `${JSON.stringify({ id: `evt_intake_${sequence}`, sequence, type: "proposal_ready", title: "Request registered", summary: request.slice(0, 280), request, proposal_id: id, source_task_id: id, created_at: new Date().toISOString() })}\n`);
    }
    return { proposal_id: id, path: file, status: input.direct ? "frozen" : "draft", contract_id: contract, unchanged: previous !== null, next: input.direct ? "Explicit direct scope recorded; run guard before execution." : "Read-only investigation only; present the plan and wait for explicit acceptance." };
  });
}

export async function guard(root: string, options: { repo?: string; contract?: string; staged?: boolean } = {}) {
  root = await repositoryRoot(root);
  const repo = await repositoryRoot(options.repo ?? root);
  const id = options.contract ?? (await optionalText(join(repo, ".agent-ship/active-contract")))?.trim();
  const proposal = (await optionalText(join(repo, ".agent-ship/active-proposal")))?.trim() ?? null;
  const problems: string[] = [];
  let changed: string[] = [];
  if (options.staged) changed = (await gitOutput(repo, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
  else {
    const entries = (await gitOutput(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0");
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      changed.push(entry.slice(3));
      if (/R|C/.test(entry.slice(0, 2))) { const original = entries[++i]; if (original) changed.push(original); }
    }
    changed = changed.filter(path => !path.startsWith(".agent-ship/"));
  }
  if (options.staged && !id) {
    const hard = await checkHardRules(root, { staged: true, repoRoot: repo });
    for (const violation of hard.violations) problems.push(`${violation.path}: ${violation.rule} ${"rule_id" in violation ? violation.rule_id : hard.hard_rule_ids.join(",")}`);
  }
  if (!id) problems.push("No frozen contract. Run agent-ship intake, present a plan and record explicit human acceptance before execution.");
  else {
    const markdown = await readFile(contractFile(root, id), "utf8");
    const field = (name: string) => new RegExp(`^${name}:[ \\t]*(.+)$`, "im").exec(markdown)?.[1]?.trim();
    const paths = parseContractPaths(markdown);
    if (proposal && field("Proposal id") !== proposal) problems.push("The active proposal has no matching frozen contract; do not reuse an older authorization.");
    if (field("Status") !== "frozen" || !field("Frozen by") || field("Frozen by")?.startsWith("<") || !Number.isFinite(Date.parse(field("Frozen at") ?? "")) || !paths.allowed.length || !paths.forbidden.length) problems.push("Contract must be frozen with human, time, allowed and forbidden paths.");
    for (const violation of checkPaths(changed, paths)) problems.push(`${violation.path}: ${violation.rule}`);
    if (options.staged) {
      const result = await checkContract(root, id, { staged: true, repoRoot: repo });
      if (!result.ok) problems.push("Staged contract or hard-rule check failed.");
    }
  }
  return { ok: problems.length === 0, contract_id: id ?? null, proposal_id: proposal, repo_root: repo, changed, problems };
}

export async function doctor(root: string, repo = root) {
  const execution = await guard(root, { repo });
  const findings: string[] = [];
  for (const kind of ["pre-commit", "pre-push"]) {
    const hook = await optionalText(await gitPath(repo, `hooks/${kind}`));
    if (!hook?.includes("# agent-ship-hook-start")) findings.push(`${kind} hook missing`);
  }
  if ((await gitOutput(repo, ["config", "--get", "core.hooksPath"]).catch(() => "")).trim()) findings.push("core.hooksPath overrides local hooks");
  if (await optionalText(join(repo, ".agent-ship/AGENTS.local.md"))) findings.push("Local rules are not automatically loaded; explicitly read .agent-ship/AGENTS.local.md or use setup --shared.");
  const proposals = [];
  for (const name of (await readdir(join(root, ".agent-ship/proposals")).catch(() => [])).filter(n => n.endsWith(".md"))) {
    const body = await optionalText(join(root, ".agent-ship/proposals", name));
    const created = /^Created at: (.+)$/m.exec(body ?? "")?.[1];
    proposals.push({ id: name.slice(0, -3), status: /^Status: (.+)$/m.exec(body ?? "")?.[1] ?? "unknown", age_minutes: created ? Math.floor((Date.now() - Date.parse(created)) / 60000) : null });
  }
  return { ok: findings.length === 0, execution, proposals, findings, boundary: "CLI and commit guard; tool-call enforcement requires a host pre-tool integration." };
}
