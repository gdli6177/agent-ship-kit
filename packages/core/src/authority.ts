import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  DelegationGrant,
  Project,
  Role,
  WorkspaceState,
  ExecutionProfile,
} from "./types.js";
export const MUST_ESCALATE = [
  "delete_data",
  "stop_service",
  "spend_money",
  "send_message",
  "product_direction",
  "rotate_secret",
  "change_permissions",
  "change_ship_policy",
] as const;
export function inside(root: string, path: string): boolean {
  const r = relative(resolve(root), resolve(path));
  return (
    r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`))
  );
}
export function safePath(path: string): boolean {
  return !/(^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.git|\.crewvane|\.ssh|\.aws|credentials?|secrets?|private-exports)(?:[/\\]|$)|(?:cookies?|storage[-_]?state)\.json$|\.(?:db|sqlite3?)$/i.test(
    path,
  );
}
export function validateGrant(
  grant: DelegationGrant,
  project: Project,
  profiles: ExecutionProfile[],
) {
  if (grant.credentials && (!Array.isArray(grant.credentials) || grant.credentials.length > 20 ||
    new Set(grant.credentials).size !== grant.credentials.length ||
    grant.credentials.some(id => !project.credentials?.some(reference => reference.id === id))))
    throw new Error("grant contains unknown credential references");
  if (
    grant.projectId !== project.id ||
    !grant.approvedBy?.trim() ||
    !Number.isFinite(Date.parse(grant.approvedAt))
  )
    throw new Error("invalid human delegation grant");
  if (
    !grant.profiles.length ||
    grant.profiles.some((id) => !profiles.some((p) => p.id === id))
  )
    throw new Error("grant has unknown profiles");
  if (
    !grant.actions.includes("read") ||
    grant.actions.some(
      (a) => !["read", "write", "verify", "publish_pr"].includes(a),
    )
  )
    throw new Error("invalid grant actions");
  if (
    !grant.allowedPaths.length ||
    grant.allowedPaths.some(
      (p) => !p || isAbsolute(p) || p.split(/[\\/]/).includes(".."),
    )
  )
    throw new Error("allowed paths must be project-relative");
  if (
    grant.forbiddenPaths.some(
      (p) => !p || isAbsolute(p) || p.split(/[\\/]/).includes(".."),
    )
  )
    throw new Error("invalid forbidden paths");
  if (
    !Number.isInteger(grant.maxParallel) ||
    grant.maxParallel < 1 ||
    grant.maxParallel > 8 ||
    !Number.isInteger(grant.maxTaskMinutes) ||
    grant.maxTaskMinutes < 1 ||
    grant.maxTaskMinutes > 240
  )
    throw new Error("invalid grant budget");
}
export function activeGrant(project: Project): DelegationGrant {
  if (!project.grant || project.grant.revokedAt)
    throw new Error("project requires a current human delegation grant");
  return project.grant;
}
export function pathAllowed(grant: DelegationGrant, path: string) {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || !safePath(path))
    return false;
  const match = (pattern: string) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", "\x00")
      .replaceAll("*", "[^/]*")
      .replaceAll("\x00", ".*");
    return (
      new RegExp(`^${escaped}$`).test(path) ||
      (pattern.endsWith("/") && path.startsWith(pattern))
    );
  };
  return !grant.forbiddenPaths.some(match) && grant.allowedPaths.some(match);
}
export function executionProfile(
  state: WorkspaceState,
  project: Project,
  role: Role,
  taskProfile?: string,
  stageProfile?: string,
) {
  const id =
    taskProfile ??
    stageProfile ??
    project.roles[role] ??
    project.defaultProfile ??
    state.defaultProfile;
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile || !activeGrant(project).profiles.includes(profile.id))
    throw new Error(`no authorized execution profile for ${role}`);
  return profile;
}
export function assertHumanHost() {
  if (process.env.CREWVANE_AGENT === "1")
    throw new Error("human settings are unavailable to agent processes");
}
