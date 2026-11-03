import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { activeSlices, installWatchdogTimer, launchAgentsDir, projectSlug, timerIsActive, watchdogStatus } from "../src/watchdog.js";

const exec = promisify(execFile);
async function call(root: string, ...args: string[]) {
  let stdout = "", stderr = "";
  const code = await main([...args, "--root", root], { stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
  return { code, stdout, stderr };
}
test("failed registration leaves no dispatched slice or backup templates; explicit untimed retry is auditable", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ship-health-")));
  const original = { ...process.env };
  try {
    process.env.CREWVANE_TIMER_HOME = join(root, "home");
    process.env.CREWVANE_LAUNCH_AGENTS_DIR = join(root, "LaunchAgents");
    process.env.CREWVANE_TIMER_PLATFORM = "launchd";
    const command = join(root, "launchctl");
    await writeFile(command, "#!/bin/sh\necho 'registration failed' >&2\nexit 1\n"); await chmod(command, 0o755);
    process.env.CREWVANE_LAUNCHCTL_CMD = command;
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "baseline"], { cwd: root });
    assert.equal((await call(root, "setup")).code, 0);
    await writeFile(join(root, ".crewvane/contracts/c.md"), "Status: frozen\nFrozen by: Test human\nFrozen at: 2026-11-01T00:00:00Z\n## Allowed paths\n- allowed.txt\n## Forbidden paths\n- forbidden.txt\n## Slices\n| a | contract | pass |\n");
    const args = ["slice", "start", "--contract", "c", "--slice", "a", "--branch", "main", "--source-task-id", "t", "--title", "Task", "--summary", "Test dispatch."];
    const rejected = await call(root, ...args);
    assert.equal(rejected.code, 1, rejected.stdout);
    assert.match(rejected.stderr, /no slice was dispatched/);
    assert.equal((await activeSlices(root)).length, 0);
    const install = await installWatchdogTimer(root);
    assert.equal(install.registered, false);
    await assert.rejects(readFile(install.cron_file));
    await assert.rejects(readFile(install.launchd_file));
    const accepted = await call(root, ...args, "--allow-untimed");
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).monitored, false);
    assert.match(await readFile(join(root, ".crewvane/events.jsonl"), "utf8"), /"allow_untimed":true/);
  } finally { process.env = original; await rm(root, { recursive: true, force: true }); }
});

test("launchd health distinguishes presence, failed exit, never-run and stale completions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ship-launchd-health-"));
  const original = { ...process.env };
  try {
    process.env.CREWVANE_TIMER_HOME = root;
    process.env.CREWVANE_LAUNCH_AGENTS_DIR = join(root, "LaunchAgents");
    process.env.CREWVANE_TIMER_PLATFORM = "launchd";
    const command = join(root, "launchctl");
    process.env.CREWVANE_LAUNCHCTL_CMD = command;
    await writeFile(command, "#!/bin/sh\necho 'runs = 4'\necho 'last exit code = 7'\nexit 0\n"); await chmod(command, 0o755);
    await installWatchdogTimer(root);
    assert.equal((await stat(join(launchAgentsDir(), `com.crewvane.watchdog.${projectSlug(root)}.plist`))).mode & 0o777, 0o600);
    const failed = await watchdogStatus(root);
    assert.equal(failed.registered, true); assert.equal(failed.runs, 4); assert.equal(failed.last_exit_code, 7); assert.equal(failed.healthy, false);
    assert.equal(await timerIsActive(root), false);
    await writeFile(command, "#!/bin/sh\necho 'runs = 0'\nexit 0\n");
    const waiting = await watchdogStatus(root);
    assert.equal(waiting.healthy, null); assert.equal(waiting.last_exit_code, null); assert.match(waiting.warning!, /no successful/);
    await mkdir(join(root, ".crewvane"));
    await writeFile(command, "#!/bin/sh\necho 'runs = 2'\necho 'last exit code = 0'\nexit 0\n");
    await writeFile(join(root, ".crewvane/watchdog-health.json"), JSON.stringify({ last_run_at: "2000-01-01T00:00:00Z", last_success_at: "2000-01-01T00:00:00Z", last_exit_code: 0 }));
    assert.equal((await watchdogStatus(root)).healthy, false);
    await writeFile(join(launchAgentsDir(), `com.crewvane.watchdog.${projectSlug(root)}.plist`), "old runtime path");
    assert.match((await watchdogStatus(root)).warning!, /differs/);
  } finally { process.env = original; await rm(root, { recursive: true, force: true }); }
});
