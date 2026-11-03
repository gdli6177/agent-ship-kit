import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAuthority, requireActor } from "./authority.js";
import { intake } from "./intake.js";
import { digest, field, laneId, safeId, safeText } from "./records.js";
import { nextSequence, readEvents, withLock } from "./storage.js";
import { optionalText } from "./team.js";
import { listInbox } from "./inbox.js";

export interface IntakeEntry {
  id: string; text: string; project: string; by: string | null; channel: string;
  state: "open" | "claimed" | "done" | "dropped";
  created_at: string; updated_at: string; owner_ref?: string; lane_id?: string; proposal_id?: string;
}
async function queueEvents(root: string): Promise<IntakeEntry[]> {
  const raw = await optionalText(join(root, ".crewvane/intake.jsonl"));
  return (raw ?? "").split("\n").filter(Boolean).map(line => JSON.parse(line) as IntakeEntry);
}
export async function intakeEntries(root: string, state?: string): Promise<IntakeEntry[]> {
  if (state && !["open", "claimed", "done", "dropped", "all"].includes(state)) throw new Error("invalid intake state");
  const entries = new Map<string, IntakeEntry>();
  for (const event of await queueEvents(root)) entries.set(event.id, event);
  return [...entries.values()].filter(entry => !state || state === "all" || entry.state === state);
}
export async function addIntake(root: string, input: { text: string; project: string; id?: string; by?: string; channel?: string }) {
  const text = safeText(input.text, "request"), project = safeText(input.project, "project", 120);
  const id = safeId(input.id ?? `intake_${digest(JSON.stringify([project, text])).slice(0, 16)}`);
  const by = input.by ? safeText(input.by, "intake source", 120) : null;
  const channel = input.channel ?? "cli";
  if (!["chat", "cli", "im", "agent", "ci"].includes(channel)) throw new Error("invalid intake channel");
  return withLock(join(root, ".crewvane"), async () => {
    const existing = (await intakeEntries(root)).find(entry => entry.id === id);
    if (existing) {
      if (existing.text !== text || existing.project !== project) throw new Error("intake id already has a different request/project");
      return { ...existing, unchanged: true };
    }
    const at = new Date().toISOString();
    const entry: IntakeEntry = { id, text, project, by, channel, state: "open", created_at: at, updated_at: at };
    await appendFile(join(root, ".crewvane/intake.jsonl"), `${JSON.stringify(entry)}\n`);
    return { ...entry, unchanged: false, next: "Queued for the captain; external channels do not answer or freeze." };
  });
}
export async function claimIntake(root: string, id: string, owner: string, requestedLane?: string) {
  safeId(id); owner = safeText(owner, "owner ref", 120);
  const authority = await readAuthority(root);
  if (authority) {
    const actor = await requireActor(root, ["captain", "owner"]);
    if (actor.role === "owner" && actor.ref !== owner) throw new Error("owner cannot claim on another owner's behalf");
    if (authority.humans.includes(owner) || authority.captain === owner) throw new Error("lane owner must be an independent temporary identity");
  }
  const record = await withLock(join(root, ".crewvane"), async () => {
    const entries = await intakeEntries(root);
    const current = entries.find(entry => entry.id === id);
    if (!current) throw new Error("intake entry not found");
    if (current.state !== "open" && current.state !== "claimed") throw new Error("closed intake cannot be claimed");
    if (current.state === "claimed") {
      if (current.owner_ref !== owner || (requestedLane && current.lane_id !== requestedLane)) throw new Error("intake is already claimed by another owner/lane");
      return current;
    }
    const lane = laneId(requestedLane ?? `lane_${digest(id).slice(0, 16)}`);
    if (lane === "default") throw new Error("queued intake uses a distinct named lane");
    if (entries.some(entry => entry.lane_id === lane)) throw new Error("lane already belongs to another intake");
    if (entries.some(entry => entry.owner_ref === owner)) throw new Error("one temporary owner session belongs to one lane");
    const entry: IntakeEntry = { ...current, state: "claimed", owner_ref: owner, lane_id: lane, proposal_id: `proposal_${digest(id).slice(0, 16)}`, updated_at: new Date().toISOString() };
    await appendFile(join(root, ".crewvane/intake.jsonl"), `${JSON.stringify(entry)}\n`);
    const sequence = await nextSequence(root);
    await appendFile(join(root, ".crewvane/events.jsonl"), `${JSON.stringify({ id: `evt_claim_${sequence}`, sequence, type: "intake_claimed", title: "Demand owner assigned", summary: "A temporary owner holds this lane; only the captain talks to the human.", source_task_id: id, lane_id: lane, owner_ref: owner, project_id: entry.project, created_at: entry.updated_at })}\n`);
    return entry;
  });
  // Idempotent recovery: a crash after claim can recreate its own draft without duplicate claims.
  const path = join(root, `.crewvane/proposals/${record.proposal_id}.md`);
  const existing = await optionalText(path);
  if (existing && (field(existing, "Lane") !== record.lane_id || field(existing, "Owner") !== owner)) throw new Error("claimed proposal has inconsistent lane ownership");
  // A repeated claim must not move a lane's pointer back to its first proposal.
  const proposal = existing ? { proposal_id: record.proposal_id, path, status: field(existing, "Status"), unchanged: true, lane_id: record.lane_id, owner_ref: owner } : await intake(root, { text: record.text, id: record.proposal_id, lane: record.lane_id, owner });
  return { ...record, proposal };
}
export async function transitionIntake(root: string, id: string, state: string) {
  safeId(id);
  if (state !== "done" && state !== "dropped") throw new Error("intake update supports done or dropped");
  if (await readAuthority(root)) await requireActor(root, ["human", "captain", "owner"]);
  return withLock(join(root, ".crewvane"), async () => {
    const current = (await intakeEntries(root)).find(entry => entry.id === id);
    if (!current) throw new Error("intake entry not found");
    if (await readAuthority(root)) await requireActor(root, ["human", "captain", "owner"], undefined, current.lane_id);
    if (current.state === state) return { ...current, unchanged: true };
    if (current.state === "done" || current.state === "dropped") throw new Error("closed intake cannot be rewritten");
    const active = (await readEvents(root)).filter(event => event.type === "worker_dispatched" && event.lane_id === current.lane_id);
    if (active.length) {
      const { activeSlices } = await import("./watchdog.js");
      if ((await activeSlices(root)).some(slice => active.some(event => event.source_task_id === slice.source_task_id))) throw new Error("stop/collect active lane workers before closing intake");
    }
    const entry = { ...current, state: state as IntakeEntry["state"], updated_at: new Date().toISOString() };
    await appendFile(join(root, ".crewvane/intake.jsonl"), `${JSON.stringify(entry)}\n`);
    return entry;
  });
}
export async function captainHeartbeat(root: string, busyUntil?: string) {
  if (await readAuthority(root)) await requireActor(root, ["captain"]);
  if (busyUntil && (!Number.isFinite(Date.parse(busyUntil)) || Date.parse(busyUntil) < Date.now())) throw new Error("busy-until must be a future ISO date");
  return withLock(join(root, ".crewvane"), async () => {
    const record = { captain_busy_until: busyUntil ?? null, turn_started_at: new Date().toISOString(), tool_calls: 0 };
    await writeFile(join(root, ".crewvane/captain-state.json"), JSON.stringify(record));
    return record;
  });
}
export async function briefStatus(root: string) {
  const entries = await intakeEntries(root);
  const events = await readEvents(root);
  const inbox = await listInbox(root, { openOnly: true });
  const slices = await (await import("./watchdog.js")).allSlices(root);
  const contracts: { id: string; lane: string; proposal: string; status: string }[] = [];
  for (const name of (await readdir(join(root, ".crewvane/contracts")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })).filter(name => name.endsWith(".md"))) {
    const markdown = await readFile(join(root, ".crewvane/contracts", name), "utf8");
    contracts.push({ id: name.slice(0, -3), lane: laneId(field(markdown, "Lane")), proposal: field(markdown, "Proposal id"), status: field(markdown, "Status") });
  }
  const drafts: { id: string; lane: string; owner: string; created_at: string }[] = [];
  for (const name of (await readdir(join(root, ".crewvane/proposals")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })).filter(name => name.endsWith(".md"))) {
    const markdown = await readFile(join(root, ".crewvane/proposals", name), "utf8");
    const lane = laneId(field(markdown, "Lane")), id = name.slice(0, -3);
    if (!entries.some(entry => entry.lane_id === lane && ["done", "dropped"].includes(entry.state)) && field(markdown, "Status") === "draft" && !contracts.some(contract => contract.proposal === id && contract.lane === lane && contract.status === "frozen")) drafts.push({ id, lane, owner: field(markdown, "Owner"), created_at: field(markdown, "Created at") });
  }
  const open = entries.filter(entry => entry.state === "open");
  const pending_human_components = { intake_open: open.length, draft_proposals: drafts.length, open_inbox: inbox.length };
  const lanes = entries.filter(entry => entry.lane_id).map(entry => {
    const lane = entry.lane_id!;
    const latest = events.filter(event => event.lane_id === lane).at(-1);
    const attention = inbox.filter(event => "lane_id" in event && event.lane_id === lane);
    const draft = drafts.find(proposal => proposal.lane === lane);
    const contract = contracts.find(contract => contract.lane === lane && contract.status === "frozen");
    const laneSlices = slices.filter(slice => slice.lane_id === lane);
    const running = laneSlices.some(slice => slice.status === "running" || slice.status === "queued");
    const phase = laneSlices.at(-1)?.status;
    const stage = entry.state === "done" || entry.state === "dropped" ? entry.state : attention[0]?.type ?? (running ? "running" : phase ?? (contract ? "frozen" : draft ? "draft" : "claimed"));
    const at = [entry.updated_at, String(latest?.created_at ?? ""), ...attention.map(item => item.created_at)].filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? entry.updated_at;
    return { lane_id: lane, intake_id: entry.id, owner_ref: entry.owner_ref, project: entry.project, stage, idle_minutes: Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000)), pending: attention.length + Number(!!draft) };
  });
  const raw = await optionalText(join(root, ".crewvane/captain-state.json"));
  const heartbeat = raw ? JSON.parse(raw) as { captain_busy_until?: string } : {};
  const captain_busy_until = heartbeat.captain_busy_until && Date.parse(heartbeat.captain_busy_until) > Date.now() ? heartbeat.captain_busy_until : null;
  const decisions = [
    ...open.map(entry => ({ id: entry.id, lane_id: null, conclusion: "Unclaimed demand", tradeoff: "Capacity and priority need routing", evidence: `.crewvane/intake.jsonl#${entry.id}`, suggestion: "Assign a temporary owner or drop explicitly" })),
    ...drafts.map(proposal => ({ id: proposal.id, lane_id: proposal.lane, conclusion: "Proposal awaits human scope decision", tradeoff: "Acceptance and allowed paths are not yet authorized", evidence: `.crewvane/proposals/${proposal.id}.md`, suggestion: "Captain compresses the scope and tradeoff; human freezes or revises" })),
    ...inbox.map(item => ({ id: item.id, lane_id: "lane_id" in item ? item.lane_id ?? null : null, conclusion: item.type, tradeoff: "Human review or escalation is pending", evidence: `.crewvane/inbox.jsonl#${item.id}`, suggestion: "Captain summarizes evidence and recommends a decision" })),
  ];
  return { pending_human: Object.values(pending_human_components).reduce((sum, n) => sum + n, 0), pending_human_components, intake_open: open.length, captain_busy_until, captain_available: !captain_busy_until, lanes, decision_list: decisions.slice(0, 20), decisions_omitted: Math.max(0, decisions.length - 20) };
}
