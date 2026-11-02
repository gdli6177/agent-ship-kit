export interface PathViolation {
  path: string;
  rule: "forbidden" | "outside_allowed" | "hard_rule";
  pattern: string | null;
  rule_id?: string;
  kind?: "hook" | "contract_forbidden" | "verify_checklist";
  message?: string;
}

export interface ContractPaths {
  allowed: string[];
  forbidden: string[];
}

const ALLOWED_HEADING = /^##\s+Allowed paths\b/i;
const FORBIDDEN_HEADING = /^##\s+Forbidden paths\b/i;

function extractPathToken(item: string): string | null {
  const cleaned = item.replace(/`/g, "").trim();
  if (!cleaned || (cleaned.startsWith("<") && cleaned.endsWith(">"))) return null;
  const token = cleaned.split(/[\s,，、]/)[0]?.trim() ?? "";
  if (!token || token.startsWith("<")) return null;
  if (!/^[\w./@*?-]+$/.test(token)) return null;
  return token;
}

export function parseContractPaths(markdown: string): ContractPaths {
  const allowed: string[] = [];
  const forbidden: string[] = [];
  let section: "allowed" | "forbidden" | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      if (ALLOWED_HEADING.test(line)) section = "allowed";
      else if (FORBIDDEN_HEADING.test(line)) section = "forbidden";
      else section = null;
      continue;
    }
    if (!section) continue;
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (!bullet?.[1]) continue;
    const token = extractPathToken(bullet[1]);
    if (!token) continue;
    (section === "allowed" ? allowed : forbidden).push(token);
  }
  return { allowed, forbidden };
}

export function globToRegExp(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
        continue;
      }
      expression += ".*";
      index += 1;
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += character?.replace(/[.+^${}()|[\]\\]/g, "\\$&") ?? "";
  }
  expression += "$";
  return new RegExp(expression);
}

export function pathMatches(file: string, pattern: string): boolean {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const pat = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || !pat) return false;
  if (!/[*?]/.test(pat)) {
    return normalized === pat || normalized.startsWith(`${pat}/`);
  }
  return globToRegExp(pat).test(normalized);
}

export function checkPaths(files: readonly string[], paths: ContractPaths): PathViolation[] {
  const violations: PathViolation[] = [];
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized) continue;
    const forbiddenHit = paths.forbidden.find((pattern) => pathMatches(normalized, pattern));
    if (forbiddenHit) {
      violations.push({ path: normalized, rule: "forbidden", pattern: forbiddenHit });
      continue;
    }
    const allowedHit = paths.allowed.some((pattern) => pathMatches(normalized, pattern));
    if (!allowedHit) {
      violations.push({ path: normalized, rule: "outside_allowed", pattern: null });
    }
  }
  return violations;
}
