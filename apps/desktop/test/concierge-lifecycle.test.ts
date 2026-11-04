import test from "node:test";
import assert from "node:assert/strict";
import {
  openPersistedConcierge,
  refreshConciergeIfSafe,
} from "../electron/concierge-lifecycle.ts";
import { ConciergeBlockedError } from "../electron/herdr.ts";

const reference = {
  session: "crewvane-test",
  workspaceId: "w1",
  tabId: "w1:t1",
  paneId: "w1:p1",
  agent: "concierge",
  launchPolicy: "control-plane-v1" as const,
};
const at = new Date().toISOString();

test("an existing blocked concierge opens its real scene without preparing or prompting", async () => {
  const calls: string[] = [];
  const opened = await openPersistedConcierge({
    reference,
    prepare: async () => {
      calls.push("prepare");
      return reference;
    },
    open: async (current) => {
      calls.push(`open:${current.tabId}`);
    },
  });
  assert.equal(opened, reference);
  assert.deepEqual(calls, ["open:w1:t1"]);
});

test("only idle and done concierges receive an identity refresh", async () => {
  for (const state of ["working", "blocked", "unknown"] as const) {
    let refreshed = false;
    const result = await refreshConciergeIfSafe({
      reference,
      live: { state, checkedAt: at, reachable: true },
      alreadyRefreshed: false,
      refresh: async () => { refreshed = true; },
    });
    assert.equal(result, "deferred");
    assert.equal(refreshed, false);
  }
  for (const state of ["idle", "done"] as const) {
    let refreshed = false;
    const result = await refreshConciergeIfSafe({
      reference,
      live: { state, checkedAt: at, reachable: true },
      alreadyRefreshed: false,
      refresh: async () => { refreshed = true; },
    });
    assert.equal(result, "refreshed");
    assert.equal(refreshed, true);
  }
});

test("a concierge that becomes blocked during refresh is preserved", async () => {
  const result = await refreshConciergeIfSafe({
    reference,
    live: { state: "idle", checkedAt: at, reachable: true },
    alreadyRefreshed: false,
    refresh: async () => { throw new ConciergeBlockedError(); },
  });
  assert.equal(result, "blocked");
});

test("missing or stale persisted scenes are prepared once, then opened", async () => {
  const calls: string[] = [];
  const opened = await openPersistedConcierge({
    reference,
    prepare: async () => {
      calls.push("prepare");
      return { ...reference, tabId: "w1:t2", paneId: "w1:p2" };
    },
    open: async (current) => {
      calls.push(`open:${current.tabId}`);
      if (current.tabId === "w1:t1") throw new Error("invalid_tab");
    },
  });
  assert.equal(opened.tabId, "w1:t2");
  assert.deepEqual(calls, ["open:w1:t1", "prepare", "open:w1:t2"]);
});
