import type { HerdrReference, LivePresence } from "../../../packages/core/src/types.js";
import { ConciergeBlockedError } from "./herdr.js";

export type ConciergeRefreshResult = "refreshed" | "deferred" | "blocked";

export function hasConciergeSite(reference?: HerdrReference): boolean {
  return Boolean(reference?.tabId || reference?.agent);
}

export function canRefreshConcierge(live: LivePresence): boolean {
  return live.state === "idle" || live.state === "done";
}

export async function refreshConciergeIfSafe(input: {
  reference: HerdrReference;
  live: LivePresence;
  alreadyRefreshed: boolean;
  refresh: (reference: HerdrReference) => Promise<void>;
}): Promise<ConciergeRefreshResult> {
  if (input.alreadyRefreshed || !canRefreshConcierge(input.live))
    return "deferred";
  try {
    await input.refresh(input.reference);
    return "refreshed";
  } catch (error) {
    if (error instanceof ConciergeBlockedError) return "blocked";
    throw error;
  }
}

export async function openPersistedConcierge(input: {
  reference?: HerdrReference;
  prepare: () => Promise<HerdrReference>;
  open: (reference: HerdrReference) => Promise<void>;
}): Promise<HerdrReference> {
  if (hasConciergeSite(input.reference)) {
    try {
      await input.open(input.reference!);
      return input.reference!;
    } catch (error) {
      if (!/not_found|invalid_tab|unknown_tab|invalid_pane|unknown_pane/.test(String(error)))
        throw error;
    }
  }
  const prepared = await input.prepare();
  await input.open(prepared);
  return prepared;
}
