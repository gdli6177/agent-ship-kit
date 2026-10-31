import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { checkPaths, parseContractPaths, type ContractPaths, type PathViolation } from "./paths.js";

const execFileAsync = promisify(execFile);

export interface CheckResult {
  ok: boolean;
  contract_id: string;
  contract_path: string;
  base: string | null;
  head: string | null;
  mode: "branch" | "staged";
  changed: string[];
  allowed: string[];
  forbidden: string[];
  violations: PathViolation[];
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
  return raw.split("\0").map((item) => item.trim()).filter(Boolean);
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
  const changed = splitPaths(await git(root, ["diff", "-z", "--name-only", `${base}...${head}`]));
  return { mode: "branch", base, head, changed };
}

export async function checkContract(
  root: string,
  contractId: string,
  options: { staged?: boolean; base?: string; head?: string } = {},
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
  const diff = await changedPaths(root, {
    staged: options.staged === true,
    base: options.base,
    head: options.head,
  });
  const violations = checkPaths(diff.changed, paths);
  return {
    ok: violations.length === 0,
    contract_id: contractId,
    contract_path: file,
    base: diff.base,
    head: diff.head,
    mode: diff.mode,
    changed: diff.changed,
    allowed: paths.allowed,
    forbidden: paths.forbidden,
    violations,
  };
}
