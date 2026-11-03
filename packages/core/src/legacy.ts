import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { inside, safePath, assertHumanHost } from "./authority.js";
import { withLock } from "./storage.js";
const exec = promisify(execFile);
const OLD = ".agent-ship";
async function text(path: string) {
  try {
    if (!(await lstat(path)).isFile())
      throw new Error(`refusing non-regular file: ${path}`);
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
async function exists(path: string) {
  return !!(await lstat(path).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  }));
}
async function idle(project: string) {
  const raw = await text(join(project, OLD, "events.jsonl"));
  const tasks = new Map<string, string>();
  for (const row of (raw ?? "").split("\n").filter(Boolean)) {
    const e = JSON.parse(row);
    if (["worker_dispatched", "worker_progress"].includes(e.type))
      tasks.set(e.source_task_id, e.status ?? "running");
  }
  if (
    [...tasks.values()].some((s) =>
      [
        "running",
        "queued",
        "blocked",
        "needs_approval",
        "needs_review",
        "reserved",
      ].includes(s),
    )
  )
    throw new Error(
      "legacy work is active; collect or stop it with the old installation before cleanup/migration",
    );
}
interface Cleanup {
  path: string;
  action: "remove" | "restore" | "edit" | "keep";
  reason: string;
}
export async function uninstallLegacy(options: {
  home?: string;
  project?: string;
  dryRun?: boolean;
}) {
  assertHumanHost();
  const home = await realpath(options.home ?? homedir()),
    kitHome = join(home, ".agent-ship-kit");
  const actions: Cleanup[] = [],
    mutations: (() => Promise<unknown>)[] = [];
  const record = (
    path: string,
    action: Cleanup["action"],
    reason: string,
    run?: () => Promise<unknown>,
  ) => {
    actions.push({ path, action, reason });
    if (run) mutations.push(run);
  };
  // A user-level uninstall must not strand a live project whose known timer points at this kit.
  for (const name of await readdir(join(home, "Library/LaunchAgents")).catch(
    () => [],
  )) {
    if (!/^com\.agent-ship\.watchdog\.[a-f0-9]{16}\.plist$/.test(name))
      continue;
    const body = await text(join(home, "Library/LaunchAgents", name));
    const source = /<string>--root<\/string>\s*<string>([^<]+)<\/string>/.exec(
      body ?? "",
    )?.[1];
    if (source)
      await idle(
        source
          .replaceAll("&amp;", "&")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&quot;", '"'),
      );
  }
  const manifest = await text(join(kitHome, "manifest"));
  if (manifest?.startsWith("# agent-ship-kit-manifest\n")) {
    const lines = manifest.split("\n"),
      kit = lines.find((s) => s.startsWith("kit="))?.slice(4);
    for (const line of lines.filter((l) => l.startsWith("shim="))) {
      const rawShim = resolve(line.slice(5));
      const shim = join(
        await realpath(dirname(rawShim)).catch(() => dirname(rawShim)),
        basename(rawShim),
      );
      if (!inside(home, shim)) {
        record(shim, "keep", "outside selected home");
        continue;
      }
      const body = await text(shim);
      if (!body) continue;
      if (
        body.includes("# agent-ship-kit-shim\n") &&
        body.includes(".agent-ship-kit/current/cli/bin/agent-ship.js")
      )
        record(shim, "remove", "owned legacy shim", async () => {
          if ((await text(shim)) !== body)
            throw new Error(`shim changed during uninstall: ${shim}`);
          await rm(shim);
        });
      else record(shim, "keep", "shim ownership not confirmed");
    }
    for (const line of lines.filter((l) => l.startsWith("skill="))) {
      const rawPath = resolve(line.slice(6)),
        path = join(
          await realpath(dirname(rawPath)).catch(() => dirname(rawPath)),
          basename(rawPath),
        ),
        name = basename(path);
      if (
        !inside(home, path) ||
        !/^ship-(setup|watchdog|contract|dispatch|inbox|notify|e2e)$/.test(
          name,
        ) ||
        !kit ||
        !inside(kitHome, kit)
      ) {
        record(path, "keep", "skill ownership not confirmed");
        continue;
      }
      if (!(await exists(path))) continue;
      if (
        (await treeDigest(path)) ===
        (await treeDigest(join(kit, "skills", name)).catch(() => ""))
      )
        record(path, "remove", "matches installed legacy skill", () =>
          rm(path, { recursive: true }),
        );
      else record(path, "keep", "modified or unknown skill");
    }
    record(
      kitHome,
      "keep",
      "legacy source archive retained; only confirmed integration files are removed",
    );
  } else record(kitHome, "keep", "no trusted legacy manifest");
  if (options.project) {
    const project = await realpath(options.project);
    await idle(project);
    const hookRoot = (
      await exec("git", ["rev-parse", "--git-path", "hooks"], { cwd: project })
    ).stdout.trim();
    for (const name of ["pre-commit", "pre-push"]) {
      const hook = resolve(project, hookRoot, name),
        chain = `${hook}.agent-ship-chain`,
        body = await text(hook);
      if (
        !body?.includes("# agent-ship-hook-start") ||
        !body.includes("# agent-ship-hook-end")
      ) {
        if (body?.includes("agent-ship"))
          record(hook, "keep", "unrecognized hook");
        continue;
      }
      const start = body.indexOf("# agent-ship-hook-start"),
        end =
          body.indexOf("# agent-ship-hook-end") +
          "# agent-ship-hook-end".length;
      const prefix = body.slice(0, start).trim(),
        suffix = body.slice(end).trim();
      if (
        (prefix && prefix !== "#!/bin/sh") ||
        (suffix &&
          !/^chain="\$0\.agent-ship-chain"\nif \[ -f "\$chain" \]; then[\s\S]*\nexit 0$/.test(
            suffix,
          ))
      ) {
        record(hook, "keep", "owner content outside the managed hook block");
        continue;
      }
      if (await exists(chain))
        record(hook, "restore", "restore chained owner hook", async () => {
          await rm(hook);
          await rename(chain, hook);
        });
      else record(hook, "remove", "owned legacy hook", () => rm(hook));
    }
    for (const [name, start, end] of [
      [
        "AGENTS.md",
        "<!-- agent-ship:rules:start -->",
        "<!-- agent-ship:rules:end -->",
      ],
      [
        ".gitignore",
        "# agent-ship-gitignore-start",
        "# agent-ship-gitignore-end",
      ],
    ]) {
      const path = join(project, name!),
        body = await text(path);
      if (!body?.includes(start!)) continue;
      const a = body.indexOf(start!),
        b = body.indexOf(end!, a);
      if (b < a || body.indexOf(start!, a + start!.length) !== -1) {
        record(path, "keep", "ambiguous managed block");
        continue;
      }
      record(path, "edit", "remove managed block, preserve owner content", () =>
        writeFile(
          path,
          body.slice(0, a) + body.slice(b + end!.length).replace(/^\r?\n/, ""),
        ),
      );
    }
    // Per-project launchd labels are deterministic in v0.2. Never match by process name.
    const hash = createHash("sha256")
      .update(project)
      .digest("hex")
      .slice(0, 16);
    const label = `com.agent-ship.watchdog.${hash}`;
    const plist = join(home, "Library", "LaunchAgents", `${label}.plist`),
      body = await text(plist);
    if (body?.includes(project) && body.includes("agent-ship"))
      record(plist, "remove", "owned legacy timer", async () => {
        if (process.platform === "darwin")
          await exec("launchctl", [
            "bootout",
            `gui/${process.getuid?.()}`,
            plist,
          ]).catch(() => undefined);
        await rm(plist);
      });
  }
  if (!options.dryRun) for (const mutate of mutations) await mutate();
  return { dry_run: !!options.dryRun, actions };
}
async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string, relative: string) {
    const st = await lstat(path);
    if (st.isSymbolicLink() || !safePath(relative))
      throw new Error(`unsafe legacy source ${path}`);
    if (st.isDirectory())
      for (const name of (await readdir(path)).sort())
        await visit(join(path, name), `${relative}/${name}`);
    else if (st.isFile()) {
      hash.update(relative);
      hash.update(await readFile(path));
    } else throw new Error(`unsupported legacy file ${path}`);
  }
  await visit(root, "");
  return hash.digest("hex");
}
export async function migrateLegacy(projectPath: string, dryRun = false) {
  assertHumanHost();
  const project = await realpath(projectPath),
    old = join(project, OLD),
    target = join(project, ".crewvane");
  if (!(await exists(old)))
    return { migrated: false, unchanged: true, reason: "no legacy state" };
  await idle(project);
  const fingerprint = await treeDigest(old);
  const marker = await text(join(target, "legacy-migration.json"));
  if (marker) {
    const receipt = JSON.parse(marker);
    if (receipt.fingerprint !== fingerprint)
      throw new Error(
        "legacy state changed after migration; reconcile explicitly",
      );
    return { migrated: true, unchanged: true, ...receipt };
  }
  if (await exists(target))
    throw new Error("destination state already exists; refusing to overwrite");
  const backup = join(project, `.crewvane-backup-${fingerprint.slice(0, 12)}`),
    stage = join(project, ".crewvane-migrating");
  if (dryRun)
    return {
      dry_run: true,
      source: old,
      target,
      backup,
      fingerprint,
      grant: null,
    };
  return withLock(old, async () => {
    await idle(project);
    if ((await exists(stage)) || (await exists(backup)))
      throw new Error(
        "migration recovery files exist; inspect backup/staging before retrying",
      );
    await mkdir(backup, { recursive: false });
    // Keep original records byte-for-byte. A failure leaves a recoverable backup and the old state intact.
    await cp(old, join(backup, "state"), {
      recursive: true,
      filter: (source) =>
        !source.includes(".crewvane-lock") &&
        !source.includes(".agent-ship-lock"),
    });
    const oldConfig = await text(join(project, "agent-ship.team.json"));
    if (oldConfig !== null)
      await writeFile(join(backup, "agent-ship.team.json"), oldConfig);
    await mkdir(stage);
    async function convert(source: string, destination: string) {
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (
          entry.name === ".crewvane-lock" ||
          entry.name === ".agent-ship-lock"
        )
          continue;
        const src = join(source, entry.name),
          dst = join(destination, entry.name);
        if (entry.isDirectory()) {
          await mkdir(dst);
          await convert(src, dst);
        } else if (entry.isFile()) {
          let body = await readFile(src, "utf8");
          body = body
            .replaceAll(".agent-ship", ".crewvane")
            .replaceAll("agent-ship.team.json", "crewvane.team.json");
          // Do not carry old dispatch authority into the new human-grant model.
          if (entry.name === "authority.json") {
            await writeFile(join(backup, "authority-not-imported.json"), body);
            continue;
          }
          if (entry.name.endsWith(".json")) JSON.parse(body);
          if (entry.name.endsWith(".jsonl"))
            for (const line of body.split("\n").filter(Boolean))
              JSON.parse(line);
          await writeFile(dst, body, { mode: 0o600 });
        } else throw new Error(`unsupported migration source ${src}`);
      }
    }
    await convert(old, stage);
    if (
      oldConfig !== null &&
      (await exists(join(project, "crewvane.team.json")))
    )
      throw new Error("new team config exists; refusing to overwrite");
    const receipt = {
      fingerprint,
      backup,
      source: old,
      migratedAt: new Date().toISOString(),
      grant: null,
    };
    await writeFile(
      join(stage, "legacy-migration.json"),
      JSON.stringify(receipt, null, 2),
    );
    if (oldConfig !== null)
      await writeFile(
        join(project, "crewvane.team.json"),
        oldConfig.replaceAll(".agent-ship", ".crewvane"),
        { flag: "wx" },
      );
    await rename(stage, target);
    return { migrated: true, unchanged: false, ...receipt };
  });
}
