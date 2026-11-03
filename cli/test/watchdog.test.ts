import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { listInbox } from "../src/inbox.js";
import { cronFile, eventsFile, installWatchdogTimer, launchdFile, runWatchdog, startSlice, uninstallWatchdogTimer } from "../src/watchdog.js";

const exec = promisify(execFile);

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

async function useFakeCrontab(timerHome: string): Promise<() => void> {
  const file = join(timerHome, "crontab.txt");
  const cmd = join(timerHome, "crontab.mjs");
  await writeFile(
    cmd,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const store = process.env.CREWVANE_CRONTAB_FILE;
const args = process.argv.slice(2);
if (args.includes("-l")) {
  if (!existsSync(store)) {
    process.stderr.write("no crontab for user\\n");
    process.exit(1);
  }
  process.stdout.write(readFileSync(store, "utf8"));
  process.exit(0);
}
if (args.includes("-")) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  writeFileSync(store, Buffer.concat(chunks));
  process.exit(0);
}
process.exit(2);
`,
  );
  await chmod(cmd, 0o755);
  const prevCmd = process.env.CREWVANE_CRONTAB_CMD;
  const prevFile = process.env.CREWVANE_CRONTAB_FILE;
  const prevPlatform = process.env.CREWVANE_TIMER_PLATFORM;
  process.env.CREWVANE_CRONTAB_CMD = cmd;
  process.env.CREWVANE_CRONTAB_FILE = file;
  process.env.CREWVANE_TIMER_PLATFORM = "cron";
  return () => {
    if (prevCmd === undefined) delete process.env.CREWVANE_CRONTAB_CMD;
    else process.env.CREWVANE_CRONTAB_CMD = prevCmd;
    if (prevFile === undefined) delete process.env.CREWVANE_CRONTAB_FILE;
    else process.env.CREWVANE_CRONTAB_FILE = prevFile;
    if (prevPlatform === undefined) delete process.env.CREWVANE_TIMER_PLATFORM;
    else process.env.CREWVANE_TIMER_PLATFORM = prevPlatform;
  };
}

test("watchdog is a no-op with no active slices and retains its timer until explicit uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-noop-"));
  const timerHome = await mkdtemp(join(tmpdir(), "crewvane-timer-"));
  const previous = process.env.CREWVANE_TIMER_HOME;
  process.env.CREWVANE_TIMER_HOME = timerHome;
  const restoreCron = await useFakeCrontab(timerHome);
  try {
    const installed = await installWatchdogTimer(root);
    assert.equal(installed.action, "created");
    assert.match(await readFile(installed.cron_file, "utf8"), /watchdog --root/);
    assert.match(await readFile(installed.launchd_file, "utf8"), /StartInterval/);
    assert.equal(installed.cron_file.startsWith(root), false);

    const report = await runWatchdog(root, { checkDrift: false });
    assert.equal(report.noop, true);
    assert.equal(report.checked, 0);
    assert.deepEqual(report.flagged, []);
    assert.equal(report.timer, "unchanged");
    await readFile(cronFile(root), "utf8");
    await readFile(launchdFile(root), "utf8");
    assert.equal((await listInbox(root, { openOnly: true })).length, 0);

    const again = await uninstallWatchdogTimer(root);
    assert.equal(again.action, "removed");
  } finally {
    if (previous === undefined) delete process.env.CREWVANE_TIMER_HOME;
    else process.env.CREWVANE_TIMER_HOME = previous;
    restoreCron();
    await rm(root, { recursive: true, force: true });
    await rm(timerHome, { recursive: true, force: true });
  }
});

test("crontab install keeps other lines and dry-run does not register", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-cron-"));
  const timerHome = await mkdtemp(join(tmpdir(), "crewvane-timer-"));
  const previous = process.env.CREWVANE_TIMER_HOME;
  process.env.CREWVANE_TIMER_HOME = timerHome;
  const restoreCron = await useFakeCrontab(timerHome);
  const store = process.env.CREWVANE_CRONTAB_FILE ?? "";
  try {
    await writeFile(store, "0 1 * * * echo keep-me\n");
    const preview = await installWatchdogTimer(root, { dryRun: true });
    assert.equal(preview.dry_run, true);
    assert.equal(preview.registered, false);
    assert.equal(await readFile(store, "utf8"), "0 1 * * * echo keep-me\n");

    const installed = await installWatchdogTimer(root);
    assert.equal(installed.registered, true);
    const once = await readFile(store, "utf8");
    assert.match(once, /echo keep-me/);
    assert.equal(once.split("crewvane-watchdog-begin").length - 1, 1);
    await installWatchdogTimer(root);
    assert.equal((await readFile(store, "utf8")).split("crewvane-watchdog-begin").length - 1, 1);

    const removed = await uninstallWatchdogTimer(root);
    assert.equal(removed.action, "removed");
    const after = await readFile(store, "utf8");
    assert.match(after, /echo keep-me/);
    assert.equal(after.includes("crewvane-watchdog-begin"), false);
  } finally {
    if (previous === undefined) delete process.env.CREWVANE_TIMER_HOME;
    else process.env.CREWVANE_TIMER_HOME = previous;
    restoreCron();
    await rm(root, { recursive: true, force: true });
    await rm(timerHome, { recursive: true, force: true });
  }
});

test("the first slice installs the local timer and a fresh commit is progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-slice-"));
  const timerHome = await mkdtemp(join(tmpdir(), "crewvane-timer-"));
  const previous = process.env.CREWVANE_TIMER_HOME;
  process.env.CREWVANE_TIMER_HOME = timerHome;
  const restoreCron = await useFakeCrontab(timerHome);
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "README.md"), "base\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    await exec("git", ["commit", "-m", "base"], { cwd: root });
    await mkdir(join(root, ".crewvane", "contracts"), { recursive: true });
    await writeFile(join(root, ".crewvane", "contracts", "contract_auth.md"), "Status: frozen\nFrozen by: Test human\nFrozen at: 2026-10-31T10:00:00Z\n## Allowed paths\n- src/**\n## Forbidden paths\n- secrets/**\n## Slices\nmax_parallel: 3\n| auth | slice | checks |\n| other | slice | checks |\n");
    const started = await startSlice(root, {
      title: "Auth slice",
      summary: "Opened.",
      sourceTaskId: "task_commit",
      contractId: "contract_auth",
      sliceId: "auth",
      branch: "main",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(started.active, 1);
    assert.equal(started.timer.action, "created");
    const second = await startSlice(root, {
      title: "Auth slice again",
      summary: "Still open.",
      sourceTaskId: "task_commit_2",
      contractId: "contract_auth",
      sliceId: "other",
      branch: "main",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(second.timer.action, "unchanged");
    const report = await runWatchdog(root, { staleMinutes: 30, checkDrift: false });
    assert.equal(report.noop, false);
    assert.equal(report.flagged.length, 0);
    assert.equal((await listInbox(root, { openOnly: true })).length, 0);
  } finally {
    if (previous === undefined) delete process.env.CREWVANE_TIMER_HOME;
    else process.env.CREWVANE_TIMER_HOME = previous;
    restoreCron();
    await rm(root, { recursive: true, force: true });
    await rm(timerHome, { recursive: true, force: true });
  }
});

test("a recent commit on another branch does not reset staleness", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-other-"));
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "README.md"), "base\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    await exec("git", ["commit", "-m", "base"], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
    });
    await exec("git", ["checkout", "-b", "ship/contract_auth/auth"], { cwd: root });
    await writeFile(join(root, "slice.txt"), "old slice\n");
    await exec("git", ["add", "slice.txt"], { cwd: root });
    await exec("git", ["commit", "-m", "slice"], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
    });
    await exec("git", ["checkout", "main"], { cwd: root });
    await writeFile(join(root, "other.txt"), "fresh elsewhere\n");
    await exec("git", ["add", "other.txt"], { cwd: root });
    await exec("git", ["commit", "-m", "other"], { cwd: root });
    await mkdir(join(root, ".crewvane"), { recursive: true });
    await writeFile(
      eventsFile(root),
      line({
        id: "evt_disp_other",
        type: "worker_dispatched",
        title: "Auth slice",
        summary: "Dispatched.",
        created_at: old,
        source_task_id: "task_other",
        contract_id: "contract_auth",
        slice_id: "auth",
        branch: "ship/contract_auth/auth",
        status: "running",
      }),
    );
    const report = await runWatchdog(root, { staleMinutes: 30, checkDrift: false });
    assert.equal(report.flagged.length, 1);
    assert.equal(report.flagged[0]?.reason, "stalled");
    assert.equal(report.flagged[0]?.source_task_id, "task_other");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog flags a slice with no heartbeat and ignores a fresh one", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-watch-"));
  const now = new Date("2026-10-31T18:00:00.000Z");
  const staleAt = "2026-10-31T16:00:00.000Z";
  const freshAt = "2026-10-31T17:50:00.000Z";
  try {
    await mkdir(join(root, ".crewvane"), { recursive: true });
    await writeFile(
      eventsFile(root),
      line({
        id: "evt_disp_old",
        type: "worker_dispatched",
        title: "Auth slice",
        summary: "Dispatched.",
        created_at: staleAt,
        source_task_id: "task_old",
        contract_id: "contract_auth",
        slice_id: "auth",
        status: "running",
        thread_refs: { pr: "https://example.com/pull/3" },
      }) +
        line({
          id: "evt_disp_new",
          type: "worker_dispatched",
          title: "Billing slice",
          summary: "Dispatched.",
          created_at: staleAt,
          source_task_id: "task_fresh",
          contract_id: "contract_bill",
          slice_id: "billing",
          status: "running",
        }) +
        line({
          id: "evt_beat",
          type: "worker_progress",
          title: "Billing heartbeat",
          summary: "Still on the slice.",
          created_at: freshAt,
          source_task_id: "task_fresh",
          contract_id: "contract_bill",
          slice_id: "billing",
        }),
    );

    const report = await runWatchdog(root, { now, staleMinutes: 30, checkDrift: false });
    assert.equal(report.checked, 2);
    assert.equal(report.flagged.length, 1);
    assert.equal(report.flagged[0]?.source_task_id, "task_old");
    assert.equal(report.flagged[0]?.reason, "stalled");
    assert.equal(report.flagged[0]?.already_open, false);

    const open = await listInbox(root, { openOnly: true });
    assert.equal(open.length, 1);
    assert.equal(open[0]?.type, "blocked");
    assert.equal(open[0]?.reason, "stalled");
    assert.equal(open[0]?.contract_id, "contract_auth");
    assert.equal(open[0]?.thread_refs?.pr, "https://example.com/pull/3");
    assert.ok((open[0]?.summary.length ?? 0) <= 280);

    const again = await runWatchdog(root, { now, staleMinutes: 30, checkDrift: false });
    assert.equal(again.checked, 1); // The blocked task is paused; only the fresh task remains running.
    assert.equal(again.flagged.length, 0);
    assert.equal((await listInbox(root, { openOnly: true })).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog flags drift when the contract check fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-drift-"));
  const now = new Date();
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await mkdir(join(root, ".crewvane", "contracts"), { recursive: true });
    await writeFile(join(root, "README.md"), "base\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    await exec("git", ["commit", "-m", "base"], { cwd: root });
    await writeFile(
      join(root, ".crewvane", "contracts", "contract_auth.md"),
      "# Contract\n\n## Allowed paths\n\n- src/**\n\n## Forbidden paths\n\n- secrets/**\n",
    );
    await exec("git", ["checkout", "-b", "ship/contract_auth/auth"], { cwd: root });
    await mkdir(join(root, "secrets"), { recursive: true });
    await writeFile(join(root, "secrets", "token.txt"), "nope\n");
    await exec("git", ["add", "secrets/token.txt"], { cwd: root });
    await exec("git", ["commit", "-m", "drift"], { cwd: root });
    const created = now.toISOString();
    await writeFile(
      eventsFile(root),
      line({
        id: "evt_disp_drift",
        type: "worker_dispatched",
        title: "Auth slice",
        summary: "Dispatched.",
        created_at: created,
        source_task_id: "task_drift",
        contract_id: "contract_auth",
        slice_id: "auth",
        status: "running",
      }),
    );
    const report = await runWatchdog(root, { now, staleMinutes: 30 });
    assert.equal(report.flagged.length, 1);
    assert.equal(report.flagged[0]?.reason, "drift");
    const open = await listInbox(root, { openOnly: true });
    const filed = open[0];
    assert.equal(filed?.type, "blocked");
    if (filed?.type === "blocked") assert.equal(filed.reason, "drift");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("limits.json can set the stale window", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-limits-"));
  try {
    await mkdir(join(root, ".crewvane"), { recursive: true });
    await writeFile(join(root, ".crewvane", "limits.json"), JSON.stringify({ stale_minutes: 5, speculative: false }));
    const created = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await writeFile(
      eventsFile(root),
      line({
        id: "evt_disp_limit",
        type: "worker_dispatched",
        title: "Short lease",
        summary: "Dispatched.",
        created_at: created,
        source_task_id: "task_limit",
        contract_id: "contract_auth",
        slice_id: "auth",
        status: "running",
      }),
    );
    const report = await runWatchdog(root, { checkDrift: false });
    assert.equal(report.stale_minutes, 5);
    assert.equal(report.flagged[0]?.reason, "stalled");
    const raw = await readFile(eventsFile(root), "utf8");
    assert.match(raw, /worker_dispatched/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
