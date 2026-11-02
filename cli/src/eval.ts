import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { checkContract } from "./check.js";
import { parseAllowlist, parsePolicy, planNotification, type NotifyEvent } from "./notify.js";
import type { PathViolation } from "./paths.js";
import { kitRoot } from "./setup.js";

const execFileAsync = promisify(execFile);

const MAX_CASES = 40;
const MAX_BYTES = 256 * 1024;
const CHECKPOINT_ID = /^[A-Za-z0-9._-]+$/;

export interface EvalField {
  field: string;
  baseline: string;
  after: string;
  ok: boolean;
}

export interface EvalCaseReport {
  id: string;
  kind: string;
  ok: boolean;
  error?: string;
  fields: EvalField[];
}

export interface EvalReport {
  ok: boolean;
  name: string;
  fixture: string;
  passed: number;
  failed: number;
  cases: EvalCaseReport[];
}

interface CheckExpect {
  ok: boolean;
  mode?: "branch" | "staged";
  changed: string[];
  violations: Array<{ path: string; rule: "forbidden" | "outside_allowed"; pattern: string | null }>;
}

interface CheckCase {
  id: string;
  kind: "check";
  contract: string;
  contract_id: string;
  staged: boolean;
  base_files: Record<string, string>;
  head_files: Record<string, string>;
  expect: CheckExpect;
}

interface NotifyCase {
  id: string;
  kind: "notify";
  event: string;
  policy: string;
  allowlist: string;
  expect: { allow: boolean; reason: string; matched_rule?: string | null };
}

interface SkillCase {
  id: string;
  kind: "skill_text";
  file: string;
  includes: string[];
  excludes: string[];
}

interface E2eExpectRow {
  project: string;
  environment: string;
  auth_setup_includes: string;
  storage_state: string;
  smoke_includes: string;
}

interface E2eCase {
  id: string;
  kind: "e2e_index";
  file: string;
  rows: E2eExpectRow[];
}

type EvalCase = CheckCase | NotifyCase | SkillCase | E2eCase;

interface ParsedFixture {
  name: string;
  cases: EvalCase[];
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function relativeUnder(root: string, spec: string, label: string): string {
  if (typeof spec !== "string" || spec.trim() === "" || spec.includes("\0")) throw new Error(`${label} is empty`);
  if (isAbsolute(spec)) throw new Error(`${label} must be relative: ${spec}`);
  if (spec.split(/[\\/]+/).some((part) => part === "..")) throw new Error(`${label} escapes its root: ${spec}`);
  return resolve(root, spec);
}

function repoRelative(spec: string, label: string): string {
  const normalized = spec.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("-")) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  return normalized;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readCapped(path: string, label: string): Promise<string> {
  const raw = await readFile(path);
  if (raw.byteLength > MAX_BYTES) throw new Error(`${label} exceeds ${MAX_BYTES} bytes`);
  return raw.toString("utf8");
}

async function locate(fixtureDir: string, spec: string): Promise<string> {
  const inFixture = relativeUnder(fixtureDir, spec, "fixture path");
  if (await exists(inFixture)) return inFixture;
  const inKit = relativeUnder(kitRoot(), spec, "fixture path");
  if (await exists(inKit)) return inKit;
  throw new Error(`fixture input not found: ${spec}`);
}

function isViolationList(value: unknown[]): value is Array<{ path: string; rule: string; pattern: string | null }> {
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as { path?: unknown; rule?: unknown; pattern?: unknown };
    return typeof row.path === "string" && typeof row.rule === "string" && (row.pattern === null || typeof row.pattern === "string");
  });
}

function display(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "(missing)";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return value.replace(/\s+/g, " ");
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    if (isViolationList(value)) {
      return value.map((item) => `${item.path} ${item.rule}${item.pattern ? `:${item.pattern}` : ""}`).join(", ");
    }
    if (value.every((item) => typeof item === "string")) return value.join(", ");
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function compareField(field: string, baseline: unknown, after: unknown): EvalField {
  const ok = isDeepStrictEqual(baseline, after);
  return { field, baseline: display(baseline), after: ok ? display(baseline) : display(after), ok };
}

function parseViolations(value: unknown, label: string): CheckExpect["violations"] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    const row = asObject(item, `${label}[${index}]`);
    const rule = asString(row.rule, `${label}[${index}].rule`);
    if (rule !== "forbidden" && rule !== "outside_allowed") {
      throw new Error(`${label}[${index}].rule must be forbidden or outside_allowed`);
    }
    const pattern = row.pattern;
    if (pattern !== null && typeof pattern !== "string") throw new Error(`${label}[${index}].pattern must be a string or null`);
    return { path: asString(row.path, `${label}[${index}].path`), rule, pattern };
  });
}

function parseStringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const obj = asObject(value, label);
  const files: Record<string, string> = {};
  for (const [path, body] of Object.entries(obj)) {
    if (typeof body !== "string") throw new Error(`${label}.${path} must be a string`);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error(`${label}.${path} exceeds ${MAX_BYTES} bytes`);
    files[repoRelative(path, `${label}.${path}`)] = body;
  }
  return files;
}

function parseCheckExpect(value: unknown, label: string): CheckExpect {
  const expect = asObject(value, label);
  const mode = expect.mode;
  if (mode !== undefined && mode !== "branch" && mode !== "staged") {
    throw new Error(`${label}.mode must be branch or staged`);
  }
  return {
    ok: asBoolean(expect.ok, `${label}.ok`),
    ...(mode === undefined ? {} : { mode }),
    changed: asStringArray(expect.changed, `${label}.changed`),
    violations: parseViolations(expect.violations, `${label}.violations`),
  };
}

function parseE2eRows(value: unknown, label: string): E2eExpectRow[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  return value.map((item, index) => {
    const row = asObject(item, `${label}[${index}]`);
    return {
      project: asString(row.project, `${label}[${index}].project`),
      environment: asString(row.environment, `${label}[${index}].environment`),
      auth_setup_includes: asString(row.auth_setup_includes, `${label}[${index}].auth_setup_includes`),
      storage_state: asString(row.storage_state, `${label}[${index}].storage_state`),
      smoke_includes: asString(row.smoke_includes, `${label}[${index}].smoke_includes`),
    };
  });
}

function parseCase(value: unknown, index: number): EvalCase {
  const row = asObject(value, `cases[${index}]`);
  const id = asString(row.id, `cases[${index}].id`);
  if (!CHECKPOINT_ID.test(id)) throw new Error(`cases[${index}].id must match [A-Za-z0-9._-]+`);
  const kind = asString(row.kind, `cases[${index}].kind`);
  if (kind === "check") {
    const head = parseStringMap(row.head_files, `cases[${index}].head_files`);
    if (Object.keys(head).length === 0) throw new Error(`cases[${index}].head_files must name at least one file`);
    return {
      id,
      kind,
      contract: asString(row.contract, `cases[${index}].contract`),
      contract_id: asString(row.contract_id, `cases[${index}].contract_id`),
      staged: row.staged === undefined ? false : asBoolean(row.staged, `cases[${index}].staged`),
      base_files: parseStringMap(row.base_files, `cases[${index}].base_files`),
      head_files: head,
      expect: parseCheckExpect(row.expect, `cases[${index}].expect`),
    };
  }
  if (kind === "notify") {
    const expect = asObject(row.expect, `cases[${index}].expect`);
    const matched = expect.matched_rule;
    if (matched !== undefined && matched !== null && typeof matched !== "string") {
      throw new Error(`cases[${index}].expect.matched_rule must be a string or null`);
    }
    return {
      id,
      kind,
      event: asString(row.event, `cases[${index}].event`),
      policy: asString(row.policy, `cases[${index}].policy`),
      allowlist: asString(row.allowlist, `cases[${index}].allowlist`),
      expect: {
        allow: asBoolean(expect.allow, `cases[${index}].expect.allow`),
        reason: asString(expect.reason, `cases[${index}].expect.reason`),
        ...(matched === undefined ? {} : { matched_rule: matched }),
      },
    };
  }
  if (kind === "skill_text") {
    const expect = asObject(row.expect, `cases[${index}].expect`);
    const includes = expect.includes === undefined ? [] : asStringArray(expect.includes, `cases[${index}].expect.includes`);
    const excludes = expect.excludes === undefined ? [] : asStringArray(expect.excludes, `cases[${index}].expect.excludes`);
    if (includes.length === 0 && excludes.length === 0) {
      throw new Error(`cases[${index}] skill_text needs includes or excludes`);
    }
    return { id, kind, file: asString(row.file, `cases[${index}].file`), includes, excludes };
  }
  if (kind === "e2e_index") {
    const expect = asObject(row.expect, `cases[${index}].expect`);
    return { id, kind, file: asString(row.file, `cases[${index}].file`), rows: parseE2eRows(expect.rows, `cases[${index}].expect.rows`) };
  }
  throw new Error(`unknown checkpoint kind: ${kind}`);
}

function parseFixture(raw: unknown): ParsedFixture {
  const body = asObject(raw, "fixture");
  const name = asString(body.name, "fixture.name");
  if (!Array.isArray(body.cases) || body.cases.length === 0) throw new Error("fixture has no cases");
  if (body.cases.length > MAX_CASES) throw new Error(`fixture has more than ${MAX_CASES} cases`);
  const cases = body.cases.map((item, index) => parseCase(item, index));
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) throw new Error(`duplicate checkpoint id: ${item.id}`);
    seen.add(item.id);
  }
  return { name, cases };
}

async function git(root: string, args: string[]): Promise<void> {
  try {
    await execFileAsync("git", args, { cwd: root });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (error instanceof Error ? error.message : "git failed"));
  }
}

async function writeTree(root: string, files: Record<string, string>): Promise<string[]> {
  const paths = Object.keys(files).sort((left, right) => left.localeCompare(right));
  for (const rel of paths) {
    const body = files[rel];
    if (body === undefined) continue;
    const dest = join(root, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, body);
  }
  return paths;
}

function violationSnapshot(items: readonly PathViolation[]): CheckExpect["violations"] {
  return items
    .map((item) => ({ path: item.path, rule: item.rule, pattern: item.pattern }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule));
}

async function runCheckCase(fixtureDir: string, spec: CheckCase): Promise<EvalField[]> {
  if (!/^[A-Za-z0-9._-]+$/.test(spec.contract_id)) {
    throw new Error("contract id must match [A-Za-z0-9._-]+");
  }
  const root = await mkdtemp(join(tmpdir(), "agent-ship-eval-"));
  try {
    const contractPath = await locate(fixtureDir, spec.contract);
    const markdown = await readCapped(contractPath, spec.contract);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "eval@example.com"]);
    await git(root, ["config", "user.name", "Eval"]);
    const baseFiles = Object.keys(spec.base_files).length > 0 ? spec.base_files : { "README.md": "base\n" };
    const basePaths = await writeTree(root, baseFiles);
    await git(root, ["add", "-f", "--", ...basePaths]);
    await git(root, ["commit", "--no-verify", "-m", "base"]);
    if (!spec.staged) await git(root, ["checkout", "-b", "ship/eval/slice"]);
    const headPaths = await writeTree(root, spec.head_files);
    await git(root, ["add", "-f", "--", ...headPaths]);
    if (!spec.staged) await git(root, ["commit", "--no-verify", "-m", "slice"]);
    await mkdir(join(root, ".agent-ship", "contracts"), { recursive: true });
    await writeFile(join(root, ".agent-ship", "contracts", `${spec.contract_id}.md`), markdown);
    const result = await checkContract(root, spec.contract_id, spec.staged ? { staged: true } : { base: "main" });
    const actual = {
      ok: result.ok,
      mode: result.mode,
      changed: [...result.changed].sort((left, right) => left.localeCompare(right)),
      violations: violationSnapshot(result.violations),
    };
    const fields = [
      compareField("ok", spec.expect.ok, actual.ok),
      compareField("changed", spec.expect.changed, actual.changed),
      compareField("violations", spec.expect.violations, actual.violations),
    ];
    if (spec.expect.mode !== undefined) fields.splice(1, 0, compareField("mode", spec.expect.mode, actual.mode));
    return fields;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readEvent(path: string): Promise<NotifyEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readCapped(path, path));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`event file is not valid JSON: ${path}`);
    throw error;
  }
  const event = asObject(parsed, "event");
  if (typeof event.id !== "string" || event.id.trim() === "") throw new Error("event.id is required");
  if (typeof event.type !== "string" || event.type.trim() === "") throw new Error("event.type is required");
  if (event.evidence_urls !== undefined && !Array.isArray(event.evidence_urls)) {
    throw new Error("event.evidence_urls must be an array");
  }
  return event as unknown as NotifyEvent;
}

async function runNotifyCase(fixtureDir: string, spec: NotifyCase): Promise<EvalField[]> {
  const event = await readEvent(await locate(fixtureDir, spec.event));
  const rules = parsePolicy(await readCapped(await locate(fixtureDir, spec.policy), spec.policy));
  const allowlist = parseAllowlist(await readCapped(await locate(fixtureDir, spec.allowlist), spec.allowlist));
  const plan = planNotification(event, rules, allowlist);
  const fields = [
    compareField("allow", spec.expect.allow, plan.allow),
    compareField("reason", spec.expect.reason, plan.reason),
  ];
  if (spec.expect.matched_rule !== undefined) {
    fields.push(compareField("matched_rule", spec.expect.matched_rule, plan.matched_rule));
  }
  return fields;
}

async function runSkillCase(fixtureDir: string, spec: SkillCase): Promise<EvalField[]> {
  const text = await readCapped(await locate(fixtureDir, spec.file), spec.file);
  const missing = spec.includes.filter((phrase) => !text.includes(phrase));
  const hits = spec.excludes.filter((phrase) => text.includes(phrase));
  const fields: EvalField[] = [];
  if (spec.includes.length > 0) {
    fields.push({
      field: "includes",
      baseline: display(spec.includes),
      after: missing.length === 0 ? display(spec.includes) : `missing: ${missing.join(" | ")}`,
      ok: missing.length === 0,
    });
  }
  if (spec.excludes.length > 0) {
    fields.push({
      field: "excludes",
      baseline: display(spec.excludes),
      after: hits.length === 0 ? display(spec.excludes) : `hit: ${hits.join(" | ")}`,
      ok: hits.length === 0,
    });
  }
  return fields;
}

interface E2eRow {
  project: string;
  environment: string;
  auth_setup: string;
  storage_state: string;
  smoke: string;
}

function splitCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.replace(/`/g, "").replace(/\s+/g, " ").trim());
}

function columnKey(cell: string): keyof E2eRow | null {
  const lower = cell.toLowerCase();
  if (lower.includes("project")) return "project";
  if (lower.includes("environment")) return "environment";
  if (lower.includes("auth")) return "auth_setup";
  if (lower.includes("storage")) return "storage_state";
  if (lower.includes("smoke")) return "smoke";
  return null;
}

function parseE2eIndex(markdown: string): E2eRow[] {
  const lines = markdown.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("|"));
  const headerLine = lines[0];
  if (!headerLine) throw new Error("e2e index has no table");
  const header = splitCells(headerLine);
  const keys = header.map((cell) => columnKey(cell));
  const needed: Array<keyof E2eRow> = ["project", "environment", "auth_setup", "storage_state", "smoke"];
  for (const key of needed) {
    if (!keys.includes(key)) throw new Error(`e2e index is missing a ${key} column`);
  }
  const rows: E2eRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCells(line);
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const row: Partial<E2eRow> = {};
    keys.forEach((key, index) => {
      if (key) row[key] = cells[index] ?? "";
    });
    if (!row.project || !row.environment) continue;
    const full: E2eRow = {
      project: row.project,
      environment: row.environment,
      auth_setup: row.auth_setup ?? "",
      storage_state: row.storage_state ?? "",
      smoke: row.smoke ?? "",
    };
    if (rows.some((existing) => existing.project === full.project && existing.environment === full.environment)) {
      throw new Error(`e2e index repeats ${full.project}/${full.environment}`);
    }
    rows.push(full);
  }
  if (rows.length === 0) throw new Error("e2e index has no rows");
  return rows;
}

function rowText(row: E2eExpectRow): string {
  return `auth~${row.auth_setup_includes} storage=${row.storage_state} smoke~${row.smoke_includes}`;
}

function actualE2eRow(parsed: readonly E2eRow[], want: E2eExpectRow): E2eExpectRow {
  const found = parsed.find((row) => row.project === want.project && row.environment.toLowerCase() === want.environment.toLowerCase());
  if (!found) {
    return { ...want, auth_setup_includes: "(missing row)", storage_state: "(missing row)", smoke_includes: "(missing row)" };
  }
  const authOk = found.auth_setup.toLowerCase().includes(want.auth_setup_includes.toLowerCase());
  const smokeOk = found.smoke.toLowerCase().includes(want.smoke_includes.toLowerCase());
  return {
    project: found.project,
    environment: found.environment,
    auth_setup_includes: authOk ? want.auth_setup_includes : found.auth_setup,
    storage_state: found.storage_state,
    smoke_includes: smokeOk ? want.smoke_includes : found.smoke,
  };
}

async function runE2eCase(fixtureDir: string, spec: E2eCase): Promise<EvalField[]> {
  const parsed = parseE2eIndex(await readCapped(await locate(fixtureDir, spec.file), spec.file));
  return spec.rows.map((want) => {
    const actual = actualE2eRow(parsed, want);
    const ok = isDeepStrictEqual(want, actual);
    return { field: `${want.project}/${want.environment}`, baseline: rowText(want), after: ok ? rowText(want) : rowText(actual), ok };
  });
}

async function runCase(fixtureDir: string, spec: EvalCase): Promise<EvalCaseReport> {
  try {
    const fields =
      spec.kind === "check"
        ? await runCheckCase(fixtureDir, spec)
        : spec.kind === "notify"
          ? await runNotifyCase(fixtureDir, spec)
          : spec.kind === "skill_text"
            ? await runSkillCase(fixtureDir, spec)
            : await runE2eCase(fixtureDir, spec);
    return { id: spec.id, kind: spec.kind, ok: fields.every((field) => field.ok), fields };
  } catch (error) {
    return {
      id: spec.id,
      kind: spec.kind,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fields: [],
    };
  }
}

export async function runEvalFixture(fixtureDir: string): Promise<EvalReport> {
  const root = resolve(fixtureDir);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`fixture not found: ${root}`);
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`fixture must be a directory: ${root}`);
  const manifestPath = join(root, "fixture.json");
  if (!(await exists(manifestPath))) throw new Error(`fixture is missing fixture.json: ${root}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readCapped(manifestPath, "fixture.json"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`fixture.json is not valid JSON: ${manifestPath}`);
    throw error;
  }
  const fixture = parseFixture(parsed);
  const cases: EvalCaseReport[] = [];
  for (const spec of fixture.cases) cases.push(await runCase(root, spec));
  const failed = cases.filter((item) => !item.ok).length;
  return {
    ok: failed === 0,
    name: fixture.name,
    fixture: root,
    passed: cases.length - failed,
    failed,
    cases,
  };
}

export function formatEvalReport(report: EvalReport): string {
  const lines = [
    `eval ${report.name}  ${report.ok ? "ok" : "regression"}`,
    `fixture ${report.fixture}`,
    "vs baseline (expected checkpoints)",
    "",
  ];
  for (const item of report.cases) {
    lines.push(`${item.ok ? "PASS" : "FAIL"}  ${item.id}  ${item.kind}`);
    if (item.error) lines.push(`  error  ${item.error}`);
    for (const field of item.fields) {
      const mark = field.ok ? " " : "!";
      lines.push(`  ${mark} ${field.field.padEnd(20)} baseline=${field.baseline}  after=${field.after}`);
    }
  }
  lines.push("");
  lines.push(`${report.passed} passed, ${report.failed} failed`);
  lines.push("");
  return lines.join("\n");
}
