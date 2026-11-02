import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { featureViolationsInContract, type FeatureViolation } from "./features.js";
import { checkPaths, parseContractPaths, type ContractPaths, type PathViolation } from "./paths.js";
import { assertSingleRepository, repositoryRoot } from "./repository.js";
import { readEvents } from "./storage.js";

const execFileAsync = promisify(execFile);

export interface CheckResult {
  ok: boolean;
  contract_id: string;
  contract_path: string;
  repo_root: string;
  base: string | null;
  head: string | null;
  mode: "branch" | "staged";
  changed: string[];
  allowed: string[];
  forbidden: string[];
  violations: PathViolation[];
  /** Present only when a Features table exists and a referenced id is missing. */
  feature_violations?: FeatureViolation[];
}

const CONTRACT_ID = /^[A-Za-z0-9._-]+$/;

export function contractFile(root: string, contractId: string): string {
  if (!CONTRACT_ID.test(contractId)) {
    throw new Error("contract id must match [A-Za-z0-9._-]+");
  }
  return join(root, ".agent-ship", "contracts", `${contractId}.md`);
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error instanceof Error ? error.message : "git failed"));
  }
}

async function defaultBase(root: string): Promise<string> {
  for (const name of ["main", "master"]) {
    try {
      await git(root, ["rev-parse", "--verify", "--quiet", name]);
      return name;
    } catch {
      continue;
    }
  }
  throw new Error("no main or master branch; pass --base");
}

function splitPaths(raw: string): string[] {
  return raw.split("\0").filter(Boolean);
}

export async function changedPaths(
  root: string,
  options: { staged: boolean; base?: string; head?: string },
): Promise<{ mode: "branch" | "staged"; base: string | null; head: string | null; changed: string[] }> {
  if (options.staged) {
    const changed = splitPaths(await git(root, ["diff", "--cached", "-z", "--name-only"]));
    return { mode: "staged", base: null, head: null, changed };
  }
  const base = options.base ?? (await defaultBase(root));
  const head = options.head ?? "HEAD";
  if (base.startsWith("-") || head.startsWith("-")) throw new Error("base/head must be Git refs, not options");
  const changed = splitPaths(await git(root, ["diff", "-z", "--name-only", `${base}...${head}`]));
  return { mode: "branch", base, head, changed };
}

export async function checkContract(
  root: string,
  contractId: string,
  options: { staged?: boolean; base?: string; head?: string; repoRoot?: string; sliceId?: string } = {},
): Promise<CheckResult> {
  const file = contractFile(root, contractId);
  let markdown: string;
  try {
    markdown = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`contract not found: ${file}`);
    throw error;
  }
  const paths: ContractPaths = parseContractPaths(markdown);
  if (paths.allowed.length === 0) {
    throw new Error(`contract ${contractId} has no Allowed paths`);
  }
  const recorded = (await readEvents(root)).filter((event) => event.type === "worker_dispatched" && event.contract_id === contractId && typeof event.repo_root === "string").reverse();
  let targets = recorded;
  if (options.sliceId) {
    targets = targets.filter((event) => event.slice_id === options.sliceId);
    if (recorded.length && !targets.length) throw new Error(`no dispatched slice ${options.sliceId} in contract ${contractId}`);
  }
  const explicitRepo = options.repoRoot ? await repositoryRoot(options.repoRoot, true) : undefined;
  if (explicitRepo) targets = targets.filter((event) => event.repo_root === explicitRepo);
  if (options.head) {
    const matched = targets.filter((event) => event.branch === options.head);
    if (matched.length) targets = matched;
  }
  const repos = [...new Set(targets.map((event) => String(event.repo_root)))];
  if (!explicitRepo && repos.length > 1) throw new Error("contract spans repositories; pass --repo and --slice/--head for each check");
  const repo = await repositoryRoot(explicitRepo ?? repos[0] ?? root, Boolean(explicitRepo || repos[0]));
  const branches = [...new Set(targets.map((event) => String(event.branch)))];
  if (!options.staged && !options.head && branches.length > 1) throw new Error("contract spans branches; pass --slice or --head for each check");
  const target = targets[0];
  await assertSingleRepository(repo, paths.allowed);
  const diff = await changedPaths(repo, {
    staged: options.staged === true,
    base: options.base ?? (typeof target?.base_ref === "string" ? target.base_ref : undefined),
    head: options.head ?? (!options.staged ? branches[0] : undefined),
  });
  const violations = checkPaths(diff.changed, paths);
  const featureViolations = await featureViolationsInContract(root, markdown);
  return {
    ok: violations.length === 0 && featureViolations.length === 0,
    contract_id: contractId,
    contract_path: file,
    repo_root: repo,
    base: diff.base,
    head: diff.head,
    mode: diff.mode,
    changed: diff.changed,
    allowed: paths.allowed,
    forbidden: paths.forbidden,
    violations,
    ...(featureViolations.length > 0 ? { feature_violations: featureViolations } : {}),
  };
}
