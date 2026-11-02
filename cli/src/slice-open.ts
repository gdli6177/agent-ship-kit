import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { gitOutput, repositoryRoot } from "./repository.js";
import { setupProject } from "./setup.js";
import { startSlice, preflightSlice, type SliceStartInput, updateSlice } from "./watchdog.js";
import { safeId } from "./records.js";
import { checkContract } from "./check.js";

/** Deterministic preparation only: the adapter must still spawn the real worker. */
export async function openSlice(root: string, input: SliceStartInput) {
  if (!input.repoRoot) throw new Error("slice open requires --repo for an independent checkout");
  safeId(input.sourceTaskId);
  await preflightSlice(root, input);
  const packet = join(root, `.agent-ship/packets/${input.sourceTaskId}.md`);
  if (await stat(packet).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("packet already exists; choose a new task id");
  const repo = resolve(input.repoRoot);
  const branch = input.branch ?? `ship/${input.contractId}/${input.sliceId}`;
  if (branch.startsWith("-")) throw new Error("branch must be a ref, not an option");
  const exists = await stat(repo).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
  if (!exists) {
    const branchExists = await gitOutput(root, ["rev-parse", "--verify", `${branch}^{commit}`]).then(() => true, () => false);
    await gitOutput(root, branchExists ? ["worktree", "add", repo, branch] : ["worktree", "add", "-b", branch, repo, input.base ?? "main"]);
  }
  if (await repositoryRoot(repo, true) !== repo || (await gitOutput(repo, ["branch", "--show-current"])).trim() !== branch) throw new Error("existing execution checkout must already be on the requested branch; no automatic checkout/reset");
  const setup = await setupProject(repo, { stateRoot: root });
  if (!setup.ok) throw new Error(`execution setup failed: ${setup.checks.filter(check => !check.ok).map(check => check.detail).join("; ")}; checkout retained at ${repo}`);
  const admission = await startSlice(root, { ...input, repoRoot: repo, branch });
  try {
    const check = await checkContract(root, input.contractId, { repoRoot: repo, sliceId: input.sliceId });
    if (!check.ok) throw new Error("slice preparation check failed; no worker was spawned");
    await mkdir(join(root, ".agent-ship/packets"), { recursive: true });
    await writeFile(packet, `# Review packet\nStatus: awaiting worker and independent verifier\nContract: ${input.contractId}\nLane: ${admission.lane_id}\nOwner: ${admission.owner_ref ?? "legacy"}\nRole: ${admission.role.id}\nRepository: ${repo}\nBranch: ${branch}\n\n## Verification\nNot yet run by an independent verifier.\n`, { flag: "wx" });
    return { ...admission, repo_root: repo, branch, packet, check, spawn_required: true };
  } catch (error) {
    await updateSlice(root, input.sourceTaskId, "failed", "Preparation failed before adapter spawn; inspect retained checkout and packet.");
    throw error;
  }
}
