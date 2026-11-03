import { relative, resolve } from "node:path";
import {
  activeGrant,
  inside,
  pathAllowed,
  safePath,
  type PermissionRequest,
  type Project,
  type Role,
} from "../../core/src/index.js";
import type { Wire } from "./rpc.js";
// Permission receipts are one-shot. Unknown/opaque requests are denied and sent to the parent.
export function permissionAllowed(
  project: Project,
  role: Role,
  cwd: string,
  request: PermissionRequest,
): boolean {
  const grant = activeGrant(project),
    p = request.params as Wire;
  if (
    p.networkApprovalContext ||
    p.additionalPermissions ||
    p.permissions ||
    /permissions\/requestApproval/.test(request.method)
  )
    return false;
  const call = p.toolCall ?? p;
  const input = call.rawInput ?? call.input ?? {};
  const kind = /fileChange/.test(request.method)
    ? "edit"
    : /commandExecution/.test(request.method)
      ? "execute"
      : (call.kind ?? "");
  if (["captain", "lead"].includes(role)) return false;
  if (["read", "edit", "delete", "move"].includes(kind)) {
    if (["delete", "move"].includes(kind)) return false;
    const path = input.path ?? input.file_path ?? call.path ?? p.grantRoot;
    if (typeof path !== "string") return false;
    const actual = resolve(cwd, path),
      rel = relative(cwd, actual);
    if (!inside(cwd, actual) || !safePath(rel)) return false;
    return kind === "read"
      ? grant.actions.includes("read")
      : role === "worker" &&
          grant.actions.includes("write") &&
          pathAllowed(grant, rel);
  }
  if (kind === "execute") {
    let cmd = p.command ?? input.command ?? input.cmd;
    // Codex sends its exact shell wrapper. Unwrap only a single literal, quoted command.
    if (typeof cmd === "string") {
      const literal =
        /^(?:\/bin\/(?:zsh|bash|sh)|(?:zsh|bash|sh)) -l?c '([^'\n\r]*)'$/.exec(
          cmd,
        );
      if (literal) cmd = literal[1];
    }
    if (typeof cmd !== "string" || /[;&|`$<>\n\r\\]/.test(cmd)) return false;
    const requestedCwd = p.cwd ?? input.cwd;
    if (requestedCwd && resolve(cwd, requestedCwd) !== resolve(cwd))
      return false;
    const args = cmd.trim().split(/\s+/);
    if (
      grant.actions.includes("verify") &&
      project.checks.some(
        (check) =>
          check.length === args.length &&
          check.every((arg, index) => arg === args[index]),
      )
    )
      return true;
    if (
      args.some(
        (arg: string) =>
          arg.includes("..") || arg.startsWith("/") || !safePath(arg),
      )
    )
      return false;
    if (args[0] === "git")
      return (
        ["status", "diff", "log", "show", "ls-files", "rev-parse"].includes(
          args[1] ?? "",
        ) && !args.some((a: string) => /output|exec|ext-diff|textconv/.test(a))
      );
    return (
      grant.actions.includes("verify") &&
      project.checks.some(
        (check) =>
          check.length === args.length &&
          check.every((arg, index) => arg === args[index]),
      )
    );
  }
  return false;
}
