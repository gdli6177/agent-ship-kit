import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pidAlive, readLockOwner, withLock } from "../src/storage.js";

test("state and hook locks record the owner, reclaim a dead pid, and name a live one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewvane-lock-"));
  const previous = process.env.CREWVANE_LOCK_TIMEOUT_MS;
  process.env.CREWVANE_LOCK_TIMEOUT_MS = "80";
  const lock = join(dir, ".crewvane-lock");
  try {
    await withLock(dir, async () => {
      const owner = await readLockOwner(lock);
      assert.equal(owner?.pid, process.pid);
      assert.equal(owner?.hostname, hostname());
      assert.match(owner?.started_at ?? "", /^\d{4}-/);
      assert.match(owner?.cmd ?? "", /node|tsx|storage\.test/);
    });
    await assert.rejects(readFile(join(lock, "owner.json"), "utf8"));

    const dead = 2_000_000_001;
    assert.equal(pidAlive(dead), false);
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({ pid: dead, hostname: hostname(), started_at: "2020-01-01T00:00:00Z", cmd: "stale" })}\n`);
    let reclaimed = false;
    await withLock(dir, async () => {
      reclaimed = true;
    });
    assert.equal(reclaimed, true);

    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid, hostname: hostname(), started_at: "2020-01-01T00:00:00Z", cmd: "alive-test" })}\n`);
    await assert.rejects(withLock(dir, async () => undefined), /owner pid \d+ on .+ cmd alive-test; pid is alive[\s\S]*rm -rf /);
    await rm(lock, { recursive: true, force: true });

    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), `${JSON.stringify({ pid: dead, hostname: "other-host", started_at: "2020-01-01T00:00:00Z", cmd: "remote" })}\n`);
    await assert.rejects(withLock(dir, async () => undefined), /pid liveness not checked \(different host\)[\s\S]*rm -rf /);
    assert.equal((await readLockOwner(lock))?.hostname, "other-host");
  } finally {
    if (previous === undefined) delete process.env.CREWVANE_LOCK_TIMEOUT_MS;
    else process.env.CREWVANE_LOCK_TIMEOUT_MS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
