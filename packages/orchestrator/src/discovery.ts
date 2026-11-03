import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type {
  RuntimeCapabilities,
  RuntimeId,
  RuntimeInfo,
  RuntimeProtocol,
} from "../../core/src/index.js";

export interface RuntimeDefinition {
  id: RuntimeId;
  name: string;
  commands: string[];
  apps: string[];
  protocol: RuntimeProtocol;
  launchArgs: string[];
  interactiveArgs: string[];
}

interface RuntimeManifest {
  version: 1;
  runtimes: RuntimeDefinition[];
}

export const builtinRuntimeDefinitions: RuntimeDefinition[] = [
  {
    id: "omp",
    name: "Oh My Pi",
    commands: ["omp"],
    apps: [],
    protocol: "acp",
    launchArgs: ["acp"],
    interactiveArgs: [],
  },
  {
    id: "codex",
    name: "Codex",
    commands: ["codex"],
    apps: ["Codex.app"],
    protocol: "codex-app-server",
    launchArgs: ["app-server", "--listen", "stdio://"],
    interactiveArgs: [],
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    commands: ["dsh"],
    apps: ["DeepSeek Harness.app"],
    protocol: "acp",
    launchArgs: ["--profile", "acp"],
    interactiveArgs: [],
  },
  {
    id: "cursor",
    name: "Cursor",
    // The IDE launcher named `cursor` is not the Agent CLI. Do not treat it as
    // dispatchable until the separate `cursor-agent` executable is installed.
    commands: ["cursor-agent"],
    apps: ["Cursor.app"],
    protocol: "none",
    launchArgs: [],
    interactiveArgs: [],
  },
  {
    id: "qoder",
    name: "Qoder",
    commands: ["qoder", "qodercli"],
    apps: ["Qoder.app"],
    protocol: "none",
    launchArgs: [],
    interactiveArgs: [],
  },
];

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const commandPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const appPattern = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]*\.app$/;

function stringList(
  value: unknown,
  field: string,
  pattern?: RegExp,
  limit = 20,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    value.some(
      (v) =>
        typeof v !== "string" ||
        !v ||
        v.length > 256 ||
        /[\0\r\n]/.test(v) ||
        (pattern && !pattern.test(v)),
    )
  )
    throw new Error(`invalid runtime manifest field ${field}`);
  return value;
}

function validateDefinition(value: unknown): RuntimeDefinition {
  if (!value || typeof value !== "object")
    throw new Error("invalid runtime manifest entry");
  const item = value as Record<string, unknown>,
    id = item.id,
    name = item.name,
    protocol = item.protocol;
  if (typeof id !== "string" || !idPattern.test(id))
    throw new Error("invalid runtime id");
  if (typeof name !== "string" || !name.trim() || name.length > 100)
    throw new Error(`invalid runtime name for ${id}`);
  if (protocol !== "acp" && protocol !== "codex-app-server")
    throw new Error(
      `runtime ${id} must declare acp or codex-app-server protocol`,
    );
  return {
    id,
    name: name.trim(),
    commands: stringList(item.commands, `${id}.commands`, commandPattern, 8),
    apps: stringList(item.apps, `${id}.apps`, appPattern, 8),
    protocol,
    launchArgs: stringList(item.launchArgs, `${id}.launchArgs`),
    interactiveArgs: stringList(
      item.interactiveArgs,
      `${id}.interactiveArgs`,
    ),
  };
}

/**
 * Loads a small, shell-free runtime manifest from the workspace root. The
 * manifest declares executable names and protocol argv; it never stores
 * credentials or a raw shell command.
 */
export async function loadRuntimeDefinitions(
  root?: string,
): Promise<RuntimeDefinition[]> {
  const definitions = builtinRuntimeDefinitions.map((item) => ({
    ...item,
    commands: [...item.commands],
    apps: [...item.apps],
    launchArgs: [...item.launchArgs],
    interactiveArgs: [...item.interactiveArgs],
  }));
  if (!root) return definitions;
  const path = join(root, "crewvane.runtimes.json");
  const info = await lstat(path).catch(() => undefined);
  if (!info) return definitions;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("crewvane.runtimes.json must be a regular file");
  if (info.size > 64 * 1024)
    throw new Error("crewvane.runtimes.json exceeds 64 KB");
  let manifest: RuntimeManifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8")) as RuntimeManifest;
  } catch (error) {
    throw new Error(
      `invalid crewvane.runtimes.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !manifest ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.runtimes) ||
    manifest.runtimes.length > 32
  )
    throw new Error("invalid crewvane.runtimes.json schema");
  const ids = new Set(definitions.map((definition) => definition.id));
  for (const raw of manifest.runtimes) {
    const definition = validateDefinition(raw);
    if (ids.has(definition.id))
      throw new Error(`runtime is already registered: ${definition.id}`);
    ids.add(definition.id);
    definitions.push(definition);
  }
  return definitions;
}

function capabilities(
  protocol: RuntimeProtocol,
  interactiveTerminal: boolean,
): RuntimeCapabilities {
  const dispatch = protocol !== "none";
  return {
    dispatch,
    stream: dispatch,
    cancel: dispatch,
    resume: dispatch,
    modelDiscovery: dispatch,
    interactiveTerminal,
  };
}

async function executableInPath(command: string, dirs: string[]) {
  for (const dir of dirs) {
    const path = join(dir, command);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return await realpath(path);
    } catch {
      /* absent candidate */
    }
  }
}

async function applicationInPath(app: string) {
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    const path = join(dir, app);
    if ((await stat(path).catch(() => null))?.isDirectory()) return path;
  }
}

export async function discoverRuntimes(root?: string): Promise<RuntimeInfo[]> {
  const home = homedir(),
    dirs = [
      ...new Set([
        ...(process.env.PATH ?? "").split(delimiter),
        join(home, ".local/bin"),
        join(home, ".bun/bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        join(home, ".cursor/bin"),
        join(home, ".qoder/bin"),
      ]),
    ].filter(Boolean),
    definitions = await loadRuntimeDefinitions(root);
  return Promise.all(
    definitions.map(async (definition): Promise<RuntimeInfo> => {
      let executable: string | undefined;
      for (const command of definition.commands) {
        executable = await executableInPath(command, dirs);
        if (executable) break;
      }
      let application: string | undefined;
      for (const app of definition.apps) {
        application = await applicationInPath(app);
        if (application) break;
      }
      if (definition.id === "dsh" && !executable && application) {
        const bundled = join(
          application,
          "Contents/Resources/runtime/cli/bin/dsh",
        );
        try {
          await access(bundled, constants.X_OK);
          executable = bundled;
        } catch {
          /* no bundled CLI */
        }
      }
      const found = Boolean(executable || application),
        dispatchable = definition.protocol !== "none";
      return {
        id: definition.id,
        name: definition.name,
        executable,
        application,
        protocol: definition.protocol,
        launchArgs: definition.launchArgs,
        interactiveArgs: definition.interactiveArgs,
        capabilities: capabilities(definition.protocol, Boolean(executable)),
        status: found
          ? dispatchable
            ? "detected"
            : "discovery_only"
          : "missing",
        models: [],
        reason: !found
          ? "未找到可执行程序"
          : !dispatchable
            ? "已发现应用，但未找到支持 ACP 或 Codex App Server 的 Agent CLI"
            : executable
              ? "尚未通过连接测试"
              : "找到应用，但未找到可执行 CLI",
      };
    }),
  );
}
