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
item because something is wrong. `limits.example.json` is
`$HOME/.agent-ship-kit/current/templates/limits.example.json`.

## Lifecycle

1. Dispatch runs `agent-ship slice start` when a slice opens. If that is the
   first queued or running slice, the command installs a local timer.
2. The timer runs `agent-ship watchdog` every five minutes. On Linux and WSL,
   `watchdog install` adds one marked block with `crontab -l | … | crontab -`.
   Other crontab lines stay. On macOS it writes the plist to
   `~/Library/LaunchAgents` and runs `launchctl bootstrap gui/$UID`.
   `watchdog uninstall` removes only that entry (`bootout` on macOS).
   `--dry-run` prints the entry and does not register it. A copy of the cron
   line and plist is also saved under `~/.config/agent-ship/` (or
   `AGENT_SHIP_TIMER_HOME`) and is never committed. If registration fails, or
   the platform is neither Linux nor macOS, the command prints a warning.
   An orchestrator scheduler or the owner's assistant routine can run the
   same CLI instead of the timer.
3. Each run reads `.agent-ship/events.jsonl` first. If no slice is `queued` or
   `running`, it removes the timer and exits. It does not call `check` and it
   does not file an inbox item.
4. Otherwise it compares the latest `worker_progress` heartbeat and the last
   git commit time on the slice branch with `stale_minutes`, and it runs
   `agent-ship check`. A miss files one `blocked` item (`stalled` or `drift`).
   That inbox item is the only handoff to the captain.

Run these in the project directory. Use `agent-ship` on `PATH`. If that command is not found, use `"$HOME/.agent-ship-kit/current/cli/bin/agent-ship.js"` with the same arguments.

```bash
agent-ship watchdog install
agent-ship watchdog
agent-ship watchdog uninstall
agent-ship status --stale
```

The registered cron line looks like:

```cron
# agent-ship-watchdog-begin <slug>
*/5 * * * * cd <kit>/cli && <node> --import tsx src/cli.ts watchdog --root <project>
# agent-ship-watchdog-end <slug>
```

`watchdog install` inserts that block. You do not paste it yourself. `watchdog uninstall` deletes that block and leaves every other crontab line. On macOS the same command bootstraps `~/Library/LaunchAgents/com.agent-ship.watchdog.<slug>.plist`, and uninstall runs `launchctl bootout` and deletes that plist.

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
