---
name: ship-watchdog
description: >-
  Slash command /ship-watchdog. The skill name is ship-watchdog, matching
  that command, so hosts that support skills load this file when the human
  types /ship-watchdog. A timer runs the deterministic agent-ship watchdog
  CLI. It files a blocked inbox item only when a slice is stalled or
  drifting. The captain does not run this loop. Also use when installing or
  removing the local cron or launchd timer.
---

# ship-watchdog

The watchdog is a deterministic check. It does not call a model. A timer runs
it. The captain (the LLM) is involved only after the check files a `blocked`
item because something is wrong.

## Lifecycle

1. Dispatch runs `agent-ship slice start` when a slice opens. If that is the
   first queued or running slice, the command installs a local timer.
2. The timer runs `agent-ship watchdog` every five minutes. Cron, launchd, an
   orchestrator scheduler, or the owner's assistant routine are all valid
   triggers. The files live under `~/.config/agent-ship/` (or
   `AGENT_SHIP_TIMER_HOME`). They are never committed.
3. Each run reads `.agent-ship/events.jsonl` first. If no slice is `queued` or
   `running`, it removes the timer and exits. It does not call `check` and it
   does not file an inbox item.
4. Otherwise it compares the latest `worker_progress` heartbeat and the last
   git commit time on the slice branch with `stale_minutes`, and it runs
   `agent-ship check`. A miss files one `blocked` item (`stalled` or `drift`).
   That inbox item is the only handoff to the captain.

```bash
cd cli
npm run agent-ship -- watchdog install --root ..
npm run agent-ship -- watchdog --root ..
npm run agent-ship -- watchdog uninstall --root ..
npm run agent-ship -- status --stale --root ..
```

Cron line, also written to `~/.config/agent-ship/cron.d/agent-ship-<slug>`:

```cron
*/5 * * * * cd <kit>/cli && <node> --import tsx src/cli.ts watchdog --root <project>
```

Paste that into `crontab -e`. The install command does not edit the system crontab for you.

launchd plist, written beside it under `launchd/`. On macOS, copy it into `~/Library/LaunchAgents/` and bootstrap it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-ship.watchdog.<slug>.plist
```

`watchdog uninstall` deletes the snippets under `~/.config/agent-ship/`. If you loaded the plist, boot it out and delete that copy too. Neither file belongs in the project repo.

`--stale-minutes` overrides `.agent-ship/limits.json`. If that file is
missing, the window is 30 minutes. Shape:

```json
{ "stale_minutes": 30, "speculative": false, "global_max_parallel": 3 }
```

See `templates/limits.example.json`.

## What it reads

`.agent-ship/events.jsonl` holds `worker_dispatched` and `worker_progress`
events (`events/schema.json`). A slice still `queued` or `running` is stale
when the latest heartbeat is older than the window. `created_at` on the
dispatch counts until the first heartbeat. A failing `agent-ship check` for
that contract is drift, not a silent stall.

## What it files

A `blocked` inbox item with `reason` `stalled` or `drift`, priority `high`,
and the same `contract_id`, `slice_id`, and `thread_refs` as the slice. The
summary stays within 280 characters and names the next hop. It does not file
a second item when one is already open for that task.

The captain tells the owner and routes the decision. It does not start doing
the worker's edit to "unstick" the slice.
