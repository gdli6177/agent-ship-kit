import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CREWVANE_HERDR_PLUGIN_ID, HerdrPlugin } from "../electron/herdr-plugin.ts";

test("ships a version-matched Herdr plugin manifest", async () => {
  const source = resolve("herdr-plugin"), manifest = await readFile(join(source, "herdr-plugin.toml"), "utf8"),
    appVersion = JSON.parse(await readFile(resolve("package.json"), "utf8")).version as string;
  assert.match(manifest, new RegExp(`^id = "${CREWVANE_HERDR_PLUGIN_ID.replaceAll(".", "\\.")}"$`, "m"));
  assert.match(manifest, new RegExp(`^version = "${appVersion.replaceAll(".", "\\.")}"$`, "m"));
  assert.match(manifest, /id = "attention"/);
  assert.match(manifest, /id = "new-goal"/);
  assert.match(manifest, /id = "concierge"/);
  assert.match(manifest, /command = \["\/bin\/sh", "new-goal\.sh"\]/);
  assert.match(manifest, /command = \["\/bin\/sh", "focus-concierge\.sh"\]/);
  assert.match(manifest, /on = "pane\.agent_status_changed"/);
  assert.match(manifest, /on = "pane\.exited"/);
  assert.match(manifest, /on = "pane\.closed"/);
  assert.match(manifest, /on = "pane\.moved"/);
  assert.match(manifest, /on = "tab\.closed"/);
  assert.match(manifest, /on = "workspace\.closed"/);
  assert.match(manifest, /min_herdr_version = "0\.9\.5"/);
});

test("deploys the bundled plugin and links it automatically once", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-herdr-plugin-"));
  const source = resolve("herdr-plugin"), sourceCopy = join(root, "source"),
    install = join(root, "userData/herdr-plugin"),
    appVersion = JSON.parse(await readFile(resolve("package.json"), "utf8")).version as string;
  await cp(source, sourceCopy, { recursive: true });
  const calls: string[][] = [];
  let linked = false;
  const runner = async (_executable: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "plugin" && args[1] === "list") {
      return { stdout: JSON.stringify({ result: { plugins: linked ? [{
        plugin_id: CREWVANE_HERDR_PLUGIN_ID, version: appVersion, enabled: true, plugin_root: install,
      }] : [] } }), stderr: "" };
    }
    if (args[0] === "plugin" && args[1] === "link") {
      linked = true;
      return { stdout: JSON.stringify({ result: { plugin: {
        plugin_id: CREWVANE_HERDR_PLUGIN_ID, version: appVersion, enabled: true, plugin_root: install,
      } } }), stderr: "" };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  try {
    const plugin = new HerdrPlugin(sourceCopy, install, appVersion, {}, runner);
    const first = await plugin.ensure("/tmp/herdr");
    assert.equal(first.phase, "ready");
    assert.equal(first.installed, true);
    assert.equal(calls.filter(args => args[1] === "link").length, 1);
    const copied = await readFile(join(install, "herdr-plugin.toml"), "utf8");
    assert.match(copied, /Crewvane/);
    const marker = JSON.parse(await readFile(join(install, ".crewvane-owned.json"), "utf8"));
    assert.equal(marker.pluginId, CREWVANE_HERDR_PLUGIN_ID);

    const second = await plugin.ensure("/tmp/herdr");
    assert.equal(second.phase, "ready");
    assert.equal(calls.filter(args => args[1] === "link").length, 1);
    const stableCheck = plugin.ensure("/tmp/herdr");
    assert.equal(plugin.status().phase, "ready", "a no-change refresh must not flap back to installing");
    await stableCheck;

    // Editing any bundled script, including action launchers, must
    // re-register the local plugin without requiring an app version bump.
    await writeFile(join(sourceCopy, "open-pane.sh"), "\n# changed\n", { flag: "a" });
    const third = await plugin.ensure("/tmp/herdr");
    assert.equal(third.phase, "ready");
    assert.equal(calls.filter(args => args[1] === "link").length, 2);
    await writeFile(join(sourceCopy, "focus-concierge.sh"), "\n# changed\n", { flag: "a" });
    const fourth = await plugin.ensure("/tmp/herdr");
    assert.equal(fourth.phase, "ready");
    assert.equal(calls.filter(args => args[1] === "link").length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
