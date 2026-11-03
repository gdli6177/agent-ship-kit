import { pathAllowed, type DelegationGrant } from "../../core/src/index.js";
export interface WorkerAssignment {
  goal: string;
  paths: string[];
}
export function parseAssignments(
  raw: string,
  count: number,
  grant: DelegationGrant,
): WorkerAssignment[] {
  const assignments: unknown = JSON.parse(raw),
    seen = new Set<string>();
  if (!Array.isArray(assignments) || assignments.length !== count)
    throw new Error("lead must allocate exactly one assignment per worker");
  for (const assignment of assignments) {
    if (
      !assignment ||
      typeof assignment.goal !== "string" ||
      !assignment.goal.trim() ||
      !Array.isArray(assignment.paths) ||
      !assignment.paths.length
    )
      throw new Error("invalid worker assignment");
    for (const path of assignment.paths) {
      if (
        typeof path !== "string" ||
        /[*?\[\]]/.test(path) ||
        !pathAllowed(grant, path)
      )
        throw new Error(
          "worker assignments require explicit authorized file paths",
        );
      const key = path.toLowerCase();
      if (seen.has(key)) throw new Error("parallel worker file scopes overlap");
      seen.add(key);
    }
  }
  return assignments;
}
