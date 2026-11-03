import { readFile } from "node:fs/promises";
import {
  migrateLegacy,
  uninstallLegacy,
} from "../../packages/core/src/index.js";
import {
  Orchestrator,
  WorkspaceService,
  type ServiceCommand,
} from "../../packages/orchestrator/src/index.js";
import type { Io } from "./cli.js";
export async function workspaceCommand(
  argv: string[],
  io: Io,
): Promise<number | null> {
  if (!["workspace", "legacy", "migrate"].includes(argv[0] ?? "")) return null;
  const value = (name: string) => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return undefined;
    const v = argv[index + 1];
    if (!v || v.startsWith("--")) throw new Error(`--${name} needs a value`);
    return v;
  };
  const root = value("root") ?? process.cwd(),
    dryRun = argv.includes("--dry-run");
  const print = (v: unknown) => io.stdout(`${JSON.stringify(v, null, 2)}\n`);
  try {
    const known = new Set([
      "--root",
      "--project",
      "--home",
      "--input",
      "--probe",
      "--dry-run",
      "--until-idle",
    ]);
    for (let i = 1; i < argv.length; i++)
      if (argv[i]!.startsWith("--")) {
        const flag = argv[i]!;
        if (!known.has(flag)) throw new Error(`unknown flag ${flag}`);
        if (!["--dry-run", "--until-idle"].includes(flag)) i++;
      }
    if (argv[0] === "legacy" && argv[1] === "uninstall") {
      print(
        await uninstallLegacy({
          home: value("home"),
          project: value("project"),
          dryRun,
        }),
      );
      return 0;
    }
    if (argv[0] === "migrate") {
      const project = value("project");
      if (!project) throw new Error("migrate requires --project");
      print(await migrateLegacy(project, dryRun));
      return 0;
    }
    if (argv[0] !== "workspace") throw new Error("unknown legacy command");
    const service = new WorkspaceService(root);
    if (argv[1] === "status") {
      print(await service.execute({ type: "snapshot" }));
      return 0;
    }
    if (argv[1] === "scan") {
      print(await service.execute({ type: "scan", probe: value("probe") }));
      return 0;
    }
    if (argv[1] === "apply") {
      const input = value("input");
      if (!input) throw new Error("workspace apply requires --input");
      print(
        await service.execute(
          JSON.parse(await readFile(input, "utf8")) as ServiceCommand,
        ),
      );
      return 0;
    }
    if (argv[1] === "run") {
      const scheduler = new Orchestrator(root);
      let stop = false;
      const stopHandler = () => {
        stop = true;
      };
      process.once("SIGINT", stopHandler);
      process.once("SIGTERM", stopHandler);
      try {
        await scheduler.start();
        if (argv.includes("--until-idle")) await scheduler.runUntilIdle();
        else {
          io.stdout("Crewvane scheduler running\n");
          while (!stop) {
            await scheduler.tick();
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      } finally {
        await scheduler.stop();
        process.removeListener("SIGINT", stopHandler);
        process.removeListener("SIGTERM", stopHandler);
      }
      print(await service.execute({ type: "snapshot" }));
      return 0;
    }
    throw new Error(
      "usage: crewvane workspace status|scan|apply --input FILE|run [--until-idle]",
    );
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
}
