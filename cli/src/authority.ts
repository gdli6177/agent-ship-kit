import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { field, digest, laneId, safeId, safeText } from "./records.js";
import { parseContractPaths } from "./paths.js";
import { contractRoles } from "./roles.js";
import { sliceRows } from "./records.js";
import { nextSequence, readEvents, withLock } from "./storage.js";
import { optionalText, ownedDirectory } from "./team.js";

interface Approval { human: string; digest: string; approved_at: string }
interface Authority {
  version: 1;
  humans: string[];
  captain: string;
  limits_digest: string;
  approvals: Record<string, Approval>;
}
const policyFile = (root: string) => join(root, ".agent-ship/authority.json");
const limitsFile = (root: string) => join(root, ".agent-ship/limits.json");
async function limitsText(root: string) { return await optionalText(limitsFile(root)) ?? "absent:default-3"; }
export async function readAuthority(root: string): Promise<Authority | null> {
  const raw = await optionalText(policyFile(root));
  if (raw === null) return null;
  const value = JSON.parse(raw) as Authority;
  if (value.version !== 1 || !Array.isArray(value.humans) || !value.humans.length || value.humans.some(ref => typeof ref !== "string" || !ref.trim()) || typeof value.captain !== "string" || value.humans.includes(value.captain) || typeof value.limits_digest !== "string" || !value.approvals || Array.isArray(value.approvals) || typeof value.approvals !== "object") throw new Error("invalid authority policy");
  return value;
}
async function save(root: string, policy: Authority) {
  await ownedDirectory(root, policyFile(root));
  const temporary = `${policyFile(root)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, policyFile(root));
}
export async function initializeAuthority(root: string, human: string, captain: string) {
  human = safeText(human, "human ref", 120); captain = safeText(captain, "captain ref", 120);
  if (human === captain) throw new Error("human and captain identities must differ");
  return withLock(join(root, ".agent-ship"), async () => {
    const existing = await readAuthority(root);
    if (existing) {
      if (!existing.humans.includes(human) || existing.captain !== captain) throw new Error("authority already configured; bootstrap cannot replace registered identities");
      return { configured: true, unchanged: true, humans: existing.humans, captain };
    }
    const actor = process.env.AGENT_SHIP_ACTOR;
    if (actor && actor !== human) throw new Error("authority bootstrap belongs to the trusted human/operator channel");
    const events = await readEvents(root);
    if (events.some(event => event.owner_ref === human || event.worker_ref === human)) throw new Error("an existing owner/worker cannot be registered as the human");
    await save(root, { version: 1, humans: [human], captain, limits_digest: digest(await limitsText(root)), approvals: {} });
    return { configured: true, unchanged: false, humans: [human], captain, boundary: "Host must bind AGENT_SHIP_ACTOR to the authenticated session. Same-OS-user filesystem access is outside this CLI boundary." };
  });
}
export async function actorIdentity(root: string) {
  const policy = await readAuthority(root);
  const ref = process.env.AGENT_SHIP_ACTOR;
  if (!policy) return { ref: ref ?? null, role: "unconfigured", lane: null as string | null };
  if (!ref) return { ref: null, role: "unbound", lane: null as string | null };
  if (policy.humans.includes(ref)) return { ref, role: "human", lane: null as string | null };
  if (policy.captain === ref) return { ref, role: "captain", lane: null as string | null };
  const events = await readEvents(root);
  const ownership = events.filter(event => event.type === "intake_claimed" && event.owner_ref === ref);
  if (ownership.length) {
    const lane = typeof ownership.at(-1)?.lane_id === "string" ? String(ownership.at(-1)!.lane_id) : null;
    const rawQueue = await optionalText(join(root, ".agent-ship/intake.jsonl"));
    const queue = (rawQueue ?? "").split("\n").filter(Boolean).map(line => JSON.parse(line) as { lane_id?: string; state?: string });
    const latest = queue.filter(entry => entry.lane_id === lane).at(-1);
    if (!latest || !["done", "dropped"].includes(latest.state ?? "")) return { ref, role: "owner", lane };
    return { ref, role: "retired", lane };
  }
  const worker = events.filter(event => event.type === "worker_dispatched" && event.worker_ref === ref).at(-1);
  if (worker) return { ref, role: typeof worker.role_id === "string" && ["scout", "verifier"].includes(worker.role_id) ? worker.role_id : "worker", lane: typeof worker.lane_id === "string" ? worker.lane_id : "default" };
  return { ref, role: "unknown", lane: null as string | null };
}
export async function requireActor(root: string, allowed: string[], by?: string, lane?: string) {
  const actor = await actorIdentity(root);
  if (!allowed.includes(actor.role)) throw new Error(`actor ${actor.ref ?? "(unbound)"} is ${actor.role}; requires ${allowed.join("/")} through a host-bound identity`);
  if (by && actor.ref !== by) throw new Error("--by must match the host-bound actor; a name in text is not authorization");
  if (lane && !["human", "captain"].includes(actor.role) && actor.lane !== laneId(lane)) throw new Error("actor cannot act across lanes");
  return actor;
}
export async function authorityViolations(root: string, contract?: { id: string; markdown: string }): Promise<string[]> {
  const policy = await readAuthority(root);
  const lane = contract ? field(contract.markdown, "Lane") : "";
  if (!policy) return lane && lane !== "default" ? ["lane execution requires registered human/captain authority; run authority init through the trusted operator channel"] : [];
  const problems = [];
  if (digest(await limitsText(root)) !== policy.limits_digest) problems.push("limits.json differs from the human-approved fingerprint; restore it or use human limits set");
  if (contract) {
    const owner = field(contract.markdown, "Owner");
    const accepted = field(contract.markdown, "Accepted by"), frozen = field(contract.markdown, "Frozen by");
    if (!policy.humans.includes(accepted) || !policy.humans.includes(frozen)) problems.push("Accepted by and Frozen by must be registered humans");
    if (owner && (accepted === owner || frozen === owner)) problems.push("lane owner cannot freeze or accept its own contract");
    const approval = policy.approvals[contract.id];
    if (!approval || !policy.humans.includes(approval.human) || approval.human !== accepted || approval.human !== frozen || approval.digest !== digest(contract.markdown)) problems.push("contract has no matching human approval receipt, or changed after approval");
  }
  return problems;
}
export async function freezeContract(root: string, id: string, human: string, acceptedText: string) {
  safeId(id); safeText(human, "human", 120); acceptedText = safeText(acceptedText, "accepted text");
  await requireActor(root, ["human"], human);
  return withLock(join(root, ".agent-ship"), async () => {
    const policy = (await readAuthority(root))!;
    const path = join(root, `.agent-ship/contracts/${id}.md`);
    await ownedDirectory(root, path);
    let markdown = await readFile(path, "utf8");
    const owner = field(markdown, "Owner"), lane = field(markdown, "Lane");
    if (owner === human) throw new Error("lane owner cannot freeze its own contract");
    if (lane && lane !== "default") {
      safeId(lane);
      const claim = (await readEvents(root)).filter(event => event.type === "intake_claimed" && event.lane_id === lane).at(-1);
      if (!claim || claim.owner_ref !== owner) throw new Error("contract Lane/Owner must match its intake claim");
    }
    if (field(markdown, "Status") === "frozen") {
      const problems = await authorityViolations(root, { id, markdown });
      if (!problems.length && field(markdown, "Accepted text") === acceptedText) return { contract_id: id, unchanged: true, frozen_by: human };
      throw new Error("frozen contracts are immutable; prepare a new contract id");
    }
    const paths = parseContractPaths(markdown);
    if (!paths.allowed.length || !paths.forbidden.length) throw new Error("contract needs non-empty Allowed paths and Forbidden paths");
    if (!sliceRows(markdown).length || !field(markdown, "Proposal id")) throw new Error("contract needs slices and Proposal id");
    await contractRoles(root, markdown);
    const at = new Date().toISOString();
    for (const [name, value] of Object.entries({ Status: "frozen", "Frozen by": human, "Frozen at": at, "Accepted by": human, "Accepted at": at, "Accepted text": acceptedText })) {
      const pattern = new RegExp(`^${name}:.*$`, "m");
      markdown = pattern.test(markdown) ? markdown.replace(pattern, () => `${name}: ${value}`) : `${name}: ${value}\n${markdown}`;
    }
    policy.approvals[id] = { human, digest: digest(markdown), approved_at: at };
    await writeFile(path, markdown); await save(root, policy);
    return { contract_id: id, unchanged: false, frozen_by: human, approved_at: at };
  });
}
export async function setHumanLimits(root: string, human: string, cap: number) {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("parallel cap must be a positive integer");
  await requireActor(root, ["human"], human);
  return withLock(join(root, ".agent-ship"), async () => {
    const policy = (await readAuthority(root))!;
    const previous = await optionalText(limitsFile(root));
    const value = previous ? JSON.parse(previous) as Record<string, unknown> : {};
    const next = `${JSON.stringify({ ...value, global_max_parallel: cap }, null, 2)}\n`;
    await ownedDirectory(root, limitsFile(root));
    await writeFile(limitsFile(root), next);
    policy.limits_digest = digest(next); await save(root, policy);
    const sequence = await nextSequence(root);
    // Record structural provenance, not a claim of cryptographic human authentication.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(root, ".agent-ship/events.jsonl"), `${JSON.stringify({ id: `evt_limits_${sequence}`, sequence, type: "limits_approved", title: "Human concurrency decision", summary: `Global parallel cap set to ${cap}.`, source_task_id: "policy", approved_by: human, created_at: new Date().toISOString() })}\n`);
    return { global_max_parallel: cap, approved_by: human };
  });
}
export async function assertCaptainNotification(root: string) {
  await requireActor(root, ["captain"]);
}
export async function assertInboxActor(root: string, lane?: string, deciding = false) {
  if (!await readAuthority(root)) return;
  if (deciding) await requireActor(root, ["human"]);
  else await requireActor(root, ["human", "captain", "owner", "worker", "verifier"], undefined, lane);
}
