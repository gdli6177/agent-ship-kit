import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("watchdog is a no-op with no active slices and removes its timer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ship-noop-"));
  const timerHome = await mkdtemp(join(tmpdir(), "agent-ship-timer-"));
  const previous = process.env.AGENT_SHIP_TIMER_HOME;
  process.env.AGENT_SHIP_TIMER_HOME = timerHome;
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
    assert.equal(report.timer, "removed");
    await assert.rejects(readFile(cronFile(root), "utf8"));
    await assert.rejects(readFile(launchdFile(root), "utf8"));
    assert.equal((await listInbox(root, { openOnly: true })).length, 0);

    const again = await uninstallWatchdogTimer(root);
    assert.equal(again.action, "absent");
  } finally {
    if (previous === undefined) delete process.env.AGENT_SHIP_TIMER_HOME;
    else process.env.AGENT_SHIP_TIMER_HOME = previous;
    await rm(root, { recursive: true, force: true });
    await rm(timerHome, { recursive: true, force: true });
  }
});

test("the first slice installs the local timer and a fresh commit is progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ship-slice-"));
  const timerHome = await mkdtemp(join(tmpdir(), "agent-ship-timer-"));
  const previous = process.env.AGENT_SHIP_TIMER_HOME;
  process.env.AGENT_SHIP_TIMER_HOME = timerHome;
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, "README.md"), "base\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    await exec("git", ["commit", "-m", "base"], { cwd: root });
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
    if (previous === undefined) delete process.env.AGENT_SHIP_TIMER_HOME;
    else process.env.AGENT_SHIP_TIMER_HOME = previous;
    await rm(root, { recursive: true, force: true });
    await rm(timerHome, { recursive: true, force: true });
  }
});

test("watchdog flags a slice with no heartbeat and ignores a fresh one", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ship-watch-"));
  const now = new Date("2026-10-31T18:00:00.000Z");
  const staleAt = "2026-10-31T16:00:00.000Z";
  const freshAt = "2026-10-31T17:50:00.000Z";
  try {
    await mkdir(join(root, ".agent-ship"), { recursive: true });
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
    assert.equal(again.flagged[0]?.already_open, true);
    assert.equal((await listInbox(root, { openOnly: true })).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog flags drift when the contract check fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ship-drift-"));
  const now = new Date();
  try {
    await exec("git", ["init", "-b", "main"], { cwd: root });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await exec("git", ["config", "user.name", "Test"], { cwd: root });
    await mkdir(join(root, ".agent-ship", "contracts"), { recursive: true });
    await writeFile(join(root, "README.md"), "base\n");
    await exec("git", ["add", "README.md"], { cwd: root });
    await exec("git", ["commit", "-m", "base"], { cwd: root });
    await writeFile(
      join(root, ".agent-ship", "contracts", "contract_auth.md"),
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
  const root = await mkdtemp(join(tmpdir(), "agent-ship-limits-"));
  try {
    await mkdir(join(root, ".agent-ship"), { recursive: true });
    await writeFile(join(root, ".agent-ship", "limits.json"), JSON.stringify({ stale_minutes: 5, speculative: false }));
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
