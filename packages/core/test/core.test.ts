import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceStore,
  builtinWorkflows,
  migrateLegacy,
  pathAllowed,
  uninstallLegacy,
  validateWorkflow,
  type DelegationGrant,
} from "../src/index.js";
const exec = promisify(execFile);
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "crewvane-core-")));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("separate processes append one ordered shared state without losing updates", () =>
  fixture(async (root) => {
    const store = new WorkspaceStore(root);
    await store.read();
    const module = new URL("../src/store.ts", import.meta.url).href;
    const file = join(root, "increment.mts");
    await writeFile(
      file,
      `import {WorkspaceStore} from ${JSON.stringify(module)}; const store=new WorkspaceStore(${JSON.stringify(root)}); for(let i=0;i<5;i++) await store.update('increment',s=>{s.maxParallel++});`,
    );
    const tsx = new URL(
      "../../../node_modules/tsx/dist/loader.mjs",
      import.meta.url,
    ).pathname;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        exec(process.execPath, ["--import", tsx, file]),
      ),
    );
    assert.equal((await store.read()).maxParallel, 23);
    const rows = (await readFile(join(root, ".crewvane/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    assert.deepEqual(
      rows.map((r) => r.sequence),
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    await store.update("no change", () => false);
    assert.equal(
      (await readFile(join(root, ".crewvane/events.jsonl"), "utf8"))
        .trim()
        .split("\n").length,
      20,
    );
  }));
test("custom workflows require independent verification and valid artifacts/rework targets", () => {
  const [template] = builtinWorkflows();
  validateWorkflow(template!, []);
  const noVerifier = structuredClone(template!);
  noVerifier.stages.pop();
  assert.throws(() => validateWorkflow(noVerifier, []), /verification/);
  const invalidInput = structuredClone(template!);
  invalidInput.stages[0]!.inputs = ["unknown"];
  assert.throws(() => validateWorkflow(invalidInput, []), /inputs/);
  const invalidReturn = structuredClone(template!);
  invalidReturn.stages[2]!.returnTo = "future";
  assert.throws(() => validateWorkflow(invalidReturn, []), /returnTo/);
  const missingModel = structuredClone(template!);
  missingModel.stages[0]!.profile = "nope";
  assert.throws(() => validateWorkflow(missingModel, []), /profile/);
});
test("path grants reject forbidden, sensitive, absolute and parent paths", () => {
  const grant = {
    allowedPaths: ["src/**", "README.md"],
    forbiddenPaths: ["src/private/**"],
  } as DelegationGrant;
  assert.equal(pathAllowed(grant, "src/app.ts"), true);
  for (const path of [
    "src/private/a.ts",
    "src/.env.local",
    "../src/app.ts",
    "/src/app.ts",
    "unrelated.txt",
    "src/cookies.json",
  ])
    assert.equal(pathAllowed(grant, path), false, path);
});
test("migration backs up original records, blocks active work, validates, and never imports authority", () =>
  fixture(async (root) => {
    const old = join(root, ".agent-ship");
    await mkdir(old);
    const event = {
      type: "worker_dispatched",
      source_task_id: "old",
      status: "running",
    };
    await writeFile(join(old, "events.jsonl"), JSON.stringify(event) + "\n");
    await assert.rejects(migrateLegacy(root, true), /active/);
    await writeFile(
      join(old, "events.jsonl"),
      JSON.stringify({
        ...event,
        status: "completed",
        note: ".agent-ship/packets/old.md",
      }) + "\n",
    );
    await writeFile(
      join(old, "authority.json"),
      '{"humans":["old-human"],"captain":"old-captain"}',
    );
    await writeFile(
      join(root, "agent-ship.team.json"),
      '{"lessons":".agent-ship/lessons"}',
    );
    const dry = await migrateLegacy(root, true);
    assert.equal(dry.dry_run, true);
    await assert.rejects(readFile(join(root, ".crewvane/events.jsonl")));
    const migrated = await migrateLegacy(root);
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.grant, null);
    await assert.rejects(readFile(join(root, ".crewvane/authority.json")));
    const original = await readFile(join(old, "events.jsonl"), "utf8");
    assert.equal(
      await readFile(join(migrated.backup!, "state/events.jsonl"), "utf8"),
      original,
    );
    assert.match(
      await readFile(join(root, ".crewvane/events.jsonl"), "utf8"),
      /\.crewvane\/packets/,
    );
    assert.equal((await migrateLegacy(root)).unchanged, true);
    await writeFile(join(old, "new.md"), "new source");
    await assert.rejects(migrateLegacy(root), /changed after migration/);
  }));
test("migration refuses symlink sources and never follows them", () =>
  fixture(async (root) => {
    await mkdir(join(root, ".agent-ship"));
    await writeFile(join(root, "outside.md"), "owner data");
    await symlink(join(root, "outside.md"), join(root, ".agent-ship/file.md"));
    await assert.rejects(migrateLegacy(root), /unsafe/);
    assert.equal(
      await readFile(join(root, "outside.md"), "utf8"),
      "owner data",
    );
  }));
test("legacy uninstall removes only confirmed files and restores the owner hook", () =>
  fixture(async (root) => {
    const home = join(root, "home"),
      project = join(root, "project"),
      kit = join(home, ".agent-ship-kit/main"),
      skill = join(home, ".cursor/skills/ship-setup"),
      shim = join(home, ".local/bin/agent-ship");
    await mkdir(kit, { recursive: true });
    await mkdir(skill, { recursive: true });
    await mkdir(join(kit, "skills/ship-setup"), { recursive: true });
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await writeFile(join(kit, "skills/ship-setup/SKILL.md"), "legacy");
    await writeFile(join(skill, "SKILL.md"), "owner modification");
    await writeFile(
      shim,
      '#!/bin/sh\n# agent-ship-kit-shim\nexec ~/.agent-ship-kit/current/cli/bin/agent-ship.js "$@"\n',
    );
    await writeFile(
      join(home, ".agent-ship-kit/manifest"),
      `# agent-ship-kit-manifest\nkit=${kit}\nshim=${shim}\nskill=${skill}\n`,
    );
    await mkdir(project);
    await exec("git", ["init", "-b", "main"], { cwd: project });
    await writeFile(
      join(project, ".git/hooks/pre-commit"),
      "# agent-ship-hook-start\nmanaged\n# agent-ship-hook-end\n",
    );
    await writeFile(
      join(project, ".git/hooks/pre-commit.agent-ship-chain"),
      "owner hook\n",
    );
    const dry = await uninstallLegacy({ home, project, dryRun: true });
    assert.ok(dry.actions.some((a) => a.path === skill && a.action === "keep"));
    await readFile(shim);
    await uninstallLegacy({ home, project });
    await assert.rejects(readFile(shim));
    assert.equal(
      await readFile(join(skill, "SKILL.md"), "utf8"),
      "owner modification",
    );
    assert.equal(
      await readFile(join(project, ".git/hooks/pre-commit"), "utf8"),
      "owner hook\n",
    );
    await uninstallLegacy({ home, project });
  }));
