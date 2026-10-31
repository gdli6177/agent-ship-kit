import { readFile } from "node:fs/promises";

/**
 * Deterministic notify planner.
 * This module classifies an action against a policy and an allowlist.
 * It does not start a process, expand environment variables, or read secrets.
 */

export interface NotifyEvent {
  id: string;
  type: string;
  title?: string;
  summary?: string;
  priority?: string;
  source_task_id?: string;
  evidence_urls?: string[];
}

export interface NotifyRule {
  name: string;
  when: Record<string, string>;
  action: string;
  note: string | null;
}

export interface Allowlist {
  patterns: string[];
}

export interface NotifyPlan {
  mode: "dry-run";
  executed: false;
  event_id: string;
  matched_rule: string | null;
  action: string | null;
  argv: string[] | null;
  allow: boolean;
  reason:
    | "no_matching_rule"
    | "shell_metacharacter"
    | "shell_interpreter"
    | "empty_action"
    | "missing_evidence"
    | "not_allowlisted"
    | "allowlisted";
  pattern: string | null;
  note: string | null;
}

const WHEN_KEYS = new Set(["type", "priority", "source_task_id", "evidence_urls"]);
const EVIDENCE_CONDITIONS = new Set(["nonempty", "empty"]);

/** Characters that would matter if a shell interpreted the action. */
const SHELL_META = /[;&|`$<>\\\n\r\0]/;

/** Programs whose job is to run some other command. */
const SHELL_PROGRAMS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "eval",
  "busybox",
  "sudo",
]);

/** Interpreters that become arbitrary code execution once a pattern contains *. */
const WILDCARD_INTERPRETERS = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
]);

interface DraftRule {
  name: string;
  when: Record<string, string>;
  action?: string;
  note: string | null;
}

export function programBase(token: string): string {
  const parts = token.split(/[/\\]/);
  const base = parts[parts.length - 1] ?? token;
  return base.toLowerCase();
}

export function parsePolicy(markdown: string): NotifyRule[] {
  const rules: NotifyRule[] = [];
  let current: DraftRule | null = null;

  const flush = () => {
    if (!current) return;
    const draft = current;
    current = null;
    if (!draft.action) throw new Error(`rule "${draft.name}" is missing action`);
    if (Object.keys(draft.when).length === 0) {
      throw new Error(`rule "${draft.name}" needs at least one when. condition`);
    }
    rules.push({
      name: draft.name,
      when: draft.when,
      action: draft.action,
      note: draft.note,
    });
  };

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = /^##\s+Rule:\s*(.+)$/.exec(line);
    if (heading) {
      flush();
      const name = heading[1]?.trim() ?? "";
      if (!name) throw new Error("rule heading is empty");
      current = { name, when: {}, note: null };
      continue;
    }
    if (!current) continue;
    const stripped = line.replace(/^[-*]\s+/, "");
    const field = /^(when\.[a-z_]+|action|note):\s*(.*)$/.exec(stripped);
    if (!field) continue;
    const key = field[1];
    const value = field[2]?.trim() ?? "";
    if (!key) continue;
    if (!value) throw new Error(`rule "${current.name}" has an empty ${key}`);
    if (key === "action") {
      current.action = value;
      continue;
    }
    if (key === "note") {
      current.note = value;
      continue;
    }
    const whenKey = key.slice("when.".length);
    if (!WHEN_KEYS.has(whenKey)) {
      throw new Error(`rule "${current.name}" has unknown condition ${key}`);
    }
    if (whenKey === "evidence_urls" && !EVIDENCE_CONDITIONS.has(value)) {
      throw new Error(`rule "${current.name}" when.evidence_urls must be nonempty or empty`);
    }
    current.when[whenKey] = value;
  }

  flush();
  if (rules.length === 0) throw new Error("policy has no ## Rule: blocks");
  return rules;
}

export function validatePattern(pattern: string): void {
  if (SHELL_META.test(pattern)) {
    throw new Error(`allowlist pattern contains shell syntax: ${pattern}`);
  }
  const parts = pattern.trim().split(/\s+/).filter(Boolean);
  const program = parts[0];
  if (!program) throw new Error("allowlist pattern is empty");
  if (program.includes("*")) {
    throw new Error(`allowlist pattern must start with a literal program name: ${pattern}`);
  }
  if (!/^[A-Za-z0-9._+/-]+$/.test(program)) {
    throw new Error(`allowlist program name is not literal: ${program}`);
  }
  const base = programBase(program);
  if (SHELL_PROGRAMS.has(base)) {
    throw new Error(`allowlist refuses shell or sudo program: ${program}`);
  }
  let hasWildcard = false;
  for (const part of parts) {
    const stars = [...part].filter((character) => character === "*").length;
    if (stars > 1) throw new Error(`allowlist token has more than one *: ${part}`);
    if (stars === 1 && !part.endsWith("*")) {
      throw new Error(`allowlist * must be a whole token or a token suffix: ${part}`);
    }
    if (part.endsWith("*") && part !== "*" && part.length < 2) {
      throw new Error(`allowlist prefix is empty: ${pattern}`);
    }
    if (stars === 1) hasWildcard = true;
  }
  if (hasWildcard && WILDCARD_INTERPRETERS.has(base)) {
    throw new Error(`allowlist refuses a wildcard for interpreter: ${program}`);
  }
}

export function parseAllowlist(raw: string): Allowlist {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("allowlist is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("allowlist must be a JSON object");
  }
  const patterns = (parsed as { patterns?: unknown }).patterns;
  if (!Array.isArray(patterns)) {
    throw new Error("allowlist must be an object with a patterns array");
  }
  if (patterns.length === 0) throw new Error("allowlist patterns must not be empty");
  const compiled: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") throw new Error("allowlist patterns must be strings");
    validatePattern(pattern);
    compiled.push(pattern);
  }
  return { patterns: compiled };
}

export function matchPattern(argv: string[], pattern: string): boolean {
  const parts = pattern.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    if (part === undefined) return false;
    const isLast = partIndex === parts.length - 1;
    if (part === "*") {
      if (isLast) return index < argv.length;
      if (index >= argv.length) return false;
      index += 1;
      continue;
    }
    if (part.endsWith("*")) {
      const token = argv[index];
      if (token === undefined || !token.startsWith(part.slice(0, -1))) return false;
      index += 1;
      continue;
    }
    if (argv[index] !== part) return false;
    index += 1;
  }
  return index === argv.length;
}

function evidenceNonEmpty(event: NotifyEvent): boolean {
  return Array.isArray(event.evidence_urls) && event.evidence_urls.length > 0;
}

function conditionMatches(event: NotifyEvent, key: string, expected: string): boolean {
  if (key === "evidence_urls") {
    return expected === "nonempty" ? evidenceNonEmpty(event) : !evidenceNonEmpty(event);
  }
  const actual = (event as unknown as Record<string, unknown>)[key];
  return actual === expected;
}

/** High-priority paging requires evidence. blocked and needs_approval may still push. */
export function refusesHighPriorityPage(event: NotifyEvent): boolean {
  if (event.priority !== "high") return false;
  if (event.type === "blocked" || event.type === "needs_approval") return false;
  return !evidenceNonEmpty(event);
}

export function assertDirectArgv(argv: readonly string[]): void {
  const program = argv[0];
  if (!program) throw new Error("empty argv");
  for (const token of argv) {
    if (SHELL_META.test(token)) throw new Error("shell_metacharacter");
  }
  if (SHELL_PROGRAMS.has(programBase(program))) throw new Error("shell_interpreter");
}

function unmatched(eventId: string): NotifyPlan {
  return {
    mode: "dry-run",
    executed: false,
    event_id: eventId,
    matched_rule: null,
    action: null,
    argv: null,
    allow: false,
    reason: "no_matching_rule",
    pattern: null,
    note: null,
  };
}

export function planNotification(
  event: NotifyEvent,
  rules: NotifyRule[],
  allowlist: Allowlist,
  actionOverride?: string,
): NotifyPlan {
  const rule =
    actionOverride !== undefined
      ? {
          name: "captain action",
          when: {},
          action: actionOverride,
          note: "Planned from the policy free-text section. The allowlist still applies.",
        }
      : rules.find((candidate) =>
          Object.entries(candidate.when).every(([key, expected]) => conditionMatches(event, key, expected)),
        );
  if (!rule) return unmatched(event.id);

  const plan: NotifyPlan = {
    ...unmatched(event.id),
    matched_rule: rule.name,
    action: rule.action,
    note: rule.note,
    reason: "not_allowlisted",
  };

  if (refusesHighPriorityPage(event)) {
    plan.reason = "missing_evidence";
    return plan;
  }

  if (SHELL_META.test(rule.action)) {
    plan.reason = "shell_metacharacter";
    return plan;
  }

  const argv = rule.action.trim().split(/\s+/).filter(Boolean);
  const program = argv[0];
  if (!program) {
    plan.reason = "empty_action";
    return plan;
  }
  plan.argv = argv;
  if (SHELL_PROGRAMS.has(programBase(program))) {
    plan.reason = "shell_interpreter";
    return plan;
  }

  const pattern = allowlist.patterns.find((candidate) => matchPattern(argv, candidate)) ?? null;
  if (!pattern) {
    plan.reason = "not_allowlisted";
    return plan;
  }
  plan.pattern = pattern;
  plan.allow = true;
  plan.reason = "allowlisted";
  return plan;
}

export async function loadPolicyFile(path: string): Promise<NotifyRule[]> {
  return parsePolicy(await readFile(path, "utf8"));
}

export async function loadAllowlistFile(path: string): Promise<Allowlist> {
  return parseAllowlist(await readFile(path, "utf8"));
}
