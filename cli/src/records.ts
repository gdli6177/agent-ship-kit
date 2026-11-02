import { createHash } from "node:crypto";
import { containsSecret } from "./hard-rules.js";

export function safeText(value: string, name: string, max = 1000): string {
  const result = value.trim();
  if (!result || result.length > max || /[\r\n\0]/.test(result)) throw new Error(`invalid ${name}: use single-line text up to ${max} characters`);
  if (containsSecret(result)) throw new Error(`${name} looks like a secret; refusing to store it`);
  return result;
}
export function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new Error("invalid id");
  return value;
}
export function field(markdown: string, name: string): string {
  return new RegExp(`^${name}:[ \\t]*(.+)$`, "im").exec(markdown)?.[1]?.trim().replace(/^`|`$/g, "") ?? "";
}
export function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
export function laneId(value?: string): string { return value ? safeId(value) : "default"; }
export function pointer(name: string, lane?: string): string {
  const id = laneId(lane);
  return `.agent-ship/${name}${id === "default" ? "" : `.${id}`}`;
}
export function sliceRows(markdown: string): { id: string; role: string }[] {
  const section = markdown.split(/^##[ \t]+/m).find(part => /^Slices\b/i.test(part)) ?? "";
  const rows = section.split("\n").filter(line => line.trim().startsWith("|"))
    .map(line => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim().replace(/^`|`$/g, "")));
  const header = rows.find(row => /^(slice id|slice|id)$/i.test(row[0] ?? ""));
  const roleColumn = header?.findIndex(cell => /^role$/i.test(cell)) ?? -1;
  return rows.filter(row => row !== header && !/^[-: ]+$/.test(row[0] ?? "") && row[0])
    .map(row => ({ id: row[0]!, role: roleColumn >= 0 && row[roleColumn] ? row[roleColumn]! : "generic-worker" }));
}
