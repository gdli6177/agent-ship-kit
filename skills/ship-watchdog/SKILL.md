---
name: ship-watchdog
description: >-
  Slash command /ship-watchdog. The skill name is ship-watchdog, matching
  that command, so hosts that support skills load this file when the human
  types /ship-watchdog. A timer runs the deterministic crewvane watchdog
  CLI. It files a blocked inbox item only when a slice is stalled or
  drifting. The captain does not run this loop. Also use when installing or
  removing the local cron or launchd timer.
---

# ship-watchdog

The watchdog is a deterministic check. It does not call a model. A timer runs
it. The captain (the LLM) is involved only after the check files a `blocked`
item because something is wrong. `limits.example.json` is
`$HOME/.crewvane/current/templates/limits.example.json`.

## Lifecycle

1. Dispatch runs `crewvane slice start` when a slice opens. If that is the
   first queued or running slice, the command installs a local timer.
2. The timer runs `crewvane watchdog` every five minutes. On Linux and WSL,
   `watchdog install` adds one marked block with `crontab -l | … | crontab -`.
   Other crontab lines stay. On macOS it writes the plist to
   `~/Library/LaunchAgents` and runs `launchctl bootstrap gui/$UID`.
   `watchdog uninstall` removes only that entry (`bootout` on macOS).
   `--dry-run` prints the entry and does not register it. A copy of the cron
   line and plist is saved only after registration succeeds, under `~/.config/crewvane/` (or
   `CREWVANE_TIMER_HOME`), and is never committed. If registration fails,
   slice start refuses admission unless --allow-untimed explicitly selects manual supervision.
   An orchestrator scheduler or the owner's assistant routine can run the
   same CLI instead of the timer.
3. Each run reads `.crewvane/events.jsonl` first. If no slice is `queued` or
   `running`, it retains an installed timer and exits; explicit uninstall removes it. It does not call `check` and it
   does not file an inbox item.
4. Otherwise it compares the latest `worker_progress` heartbeat and the last
   git commit time on the slice branch with `stale_minutes`, and it runs
   `crewvane check`. A miss files one `blocked` item (`stalled` or `drift`).
   That inbox item is the only handoff to the captain.

Run these in the project directory. Use `crewvane` on `PATH`. If that command is not found, use `node $HOME/.crewvane/current/cli/bin/crewvane.js` with the same arguments.

```bash
crewvane watchdog install
crewvane watchdog
crewvane watchdog uninstall
crewvane status --stale
```

The registered cron line looks like:

```cron
# crewvane-watchdog-begin <slug>
*/5 * * * * <node> <kit>/cli/bin/crewvane.js watchdog --root <project>
# crewvane-watchdog-end <slug>
```

`watchdog install` inserts that block. You do not paste it yourself. `watchdog uninstall` deletes that block and leaves every other crontab line. On macOS the same command bootstraps `~/Library/LaunchAgents/com.crewvane.watchdog.<slug>.plist`, and uninstall runs `launchctl bootout` and deletes that plist.

`--stale-minutes` overrides `.crewvane/limits.json`. If that file is
missing, the window is 30 minutes. Shape:

```json
{ "stale_minutes": 30, "speculative": false, "global_max_parallel": 3 }
```

See `templates/limits.example.json`.

## 注册与运行健康

`watchdog status` 分别返回 registered、healthy（true/false/null）、runs、
last_exit_code、last_run_at、last_success_at 与 warning。launchd 读取真实 job
运行结果；cron 无回执时必须保持 unknown，不能把标记行存在说成执行成功。
`watchdog doctor` 检查 node、tsx、CLI 与 plist 一致性。超过 15 分钟没有完成
记录也会提示。slice start / resume 在注册失败或已知运行失败时拒绝执行；只有
显式选择 `--allow-untimed` 才可人工监督。备份仅在注册成功后写入，不作注册证据。
空闲时保留定时器，离开项目显式 uninstall。

## What it reads

`.crewvane/events.jsonl` holds `worker_dispatched` and `worker_progress`
events (`events/schema.json`). A slice still `queued` or `running` is stale
when the latest heartbeat is older than the window. `created_at` on the
dispatch counts until the first heartbeat. A failing `crewvane check` for
that contract is drift, not a silent stall.

## What it files

A `blocked` inbox item with `reason` `stalled` or `drift`, priority `high`,
and the same `contract_id`, `slice_id`, and `thread_refs` as the slice. The
summary stays within 280 characters and names the next hop. It does not file
a second item when one is already open for that task.

The captain tells the owner and routes the decision. It does not start doing
the worker's edit to "unstick" the slice.
