# agent-ship CLI

第一次使用先看 [Quick Start（中文）](../README.zh-CN.md#quick-start) 或 [English](../README.md#quick-start)：一次接入后直接提需求，由船长管理流程，命令是可选快捷方式。

`setup --shared` 初始化或引用团队手册；普通 setup 只建立本地引用。
`team context --tag <tag>` 返回必读资料引用和有限经验摘要。
`lesson add/review/search/show/check/pending` 提供候选准入、评审、检索和交付检查。
完整命令与边界见[团队手册和经验回流](../docs/team-and-learning.md)。

多仓库和 Git worktree 使用共享 `--root` 保存合同、运行状态和 inbox，
使用 `--repo` 指定执行 checkout。`setup --root <checkout> --state-root <shared-root>`
为每个工作树安装门禁。完整示例和适配器派工顺序见[工作空间接入说明](../docs/workspace-parallel.md)。

`slice start` 在启动工人前预留名额，检查冻结合同、切片和两层并行上限。
适配器用 `slice update --source-task-id <id> --status <status> [--worker <ref>]` 回传状态。
人要求修改后的恢复也走 update，重新检查预算。

Local inbox and notify for the captain. Node 20 or newer. The only
dependency is `tsx`, used to run TypeScript directly. `package.json` exposes
the `agent-ship` bin. After the root `install.sh` run, that command is on
`PATH` and the project directory is the default root. If `agent-ship` is not
on `PATH`, use `node $HOME/.agent-ship-kit/current/cli/bin/agent-ship.js`.

This CLI appends JSONL under `.agent-ship/`. `notify dry-run` prints a plan.
`notify run` starts an allowlisted argv with no shell. It does not merge or
deploy.

## Setup

```bash
cd cli
npm install
```

## Setup

`setup` and `init` are the same command. Default mode touches only this clone: `.git/hooks` (chaining any hook that was already there) and `.git/info/exclude`. It does not edit `.gitignore` and it does not set `core.hooksPath`.

```bash
agent-ship setup
agent-ship setup --shared
agent-ship setup --uninstall
```

`--shared` writes a marked block in `.gitignore` and merges the rules into `AGENTS.md` even when that file is tracked. Hooks remain uncommitted. `--uninstall` restores a chained hook and removes the rules block. Data under `.agent-ship/` is kept, and `.git/info/exclude` keeps a single `.agent-ship/` line so the directory does not show up as untracked. `--uninstall --purge` deletes `.agent-ship/` and that exclude line.

## Watchdog

```bash
agent-ship watchdog
agent-ship status --stale
```

Deterministic. No model. Reads heartbeats in `.agent-ship/events.jsonl`, the last commit time on the slice branch, and `check`. Files a `blocked` item only when a slice is stalled or drifting. If nothing is `queued` or `running`, it exits immediately and deletes the local timer.

```bash
agent-ship slice start --contract contract_auth --slice auth \
  --source-task-id task_1 --title "Auth slice" --summary "Opened."
agent-ship watchdog install
agent-ship watchdog uninstall
```

`slice start` records `worker_dispatched` on branch `ship/<contract>/<slice>` unless `--branch` is set, and registers the timer when a slice is open. On Linux and WSL, `watchdog install` adds a marked block to the user crontab. On macOS it writes `~/Library/LaunchAgents` and runs `launchctl bootstrap`. `--dry-run` does not register. Tests can point `AGENT_SHIP_CRONTAB_CMD` at a fake `crontab` and `AGENT_SHIP_TIMER_HOME` at a throwaway directory. If registration fails, the command prints a warning. `watchdog` and `inbox list` also warn when slices are running and the timer is not active. An orchestrator scheduler or an assistant routine can run `watchdog` instead of the timer. Staleness uses heartbeats and commits on the slice branch only.

## Check

```bash
agent-ship check --contract contract_auth --base main
```

Prints JSON and exits 1 when a path is forbidden, outside Allowed paths, or matched by a `hook` / `contract_forbidden` hard rule. The violation includes `rule_id`. `--staged` checks the index. `--hard-rules` checks hard rules without a contract, which is what pre-commit runs when no active contract is set and `.agent-ship/hard-rules.json` exists. No forge and no CI are required. A project may also run this command in CI; that is an extra, not the enforcement.

## Hard rules

```bash
agent-ship promote --kind hook --glob ".env*" \
  --message "Do not commit env files." \
  --source "Do not commit env files."

agent-ship inbox decide evt_<id> changes_requested \
  --note "Do not commit env files." \
  --promote hook --glob ".env*" --tag no-env
```

Rules live in `.agent-ship/hard-rules.json` on this clone. `--promote` defaults to `none`. A repeated `--tag` or an identical `changes_requested` note prints `suggest promote` on stderr and does not write a rule until you pass `--promote` or `promote`. Secret-shaped text is rejected and not stored. `command_hint` is recorded for the verifier and is not executed. `verify` rules show up as `checklist` and do not fail the path check by themselves.

Use `agent-ship eval --fixture cli/test/eval-fixtures/verifier-gates` when changing `ship-*` skills or check/verifier gates: it prints a before/after checkpoint report and exits non-zero on regression.

## Commands

Run these in the project directory. The inbox is `.agent-ship/inbox.jsonl` there.

```bash
agent-ship inbox add \
  --title "Auth middleware ready" \
  --summary "Contract checks passed on the slice branch." \
  --priority high \
  --source-task-id task_auth_mw \
  --evidence https://ci.example/runs/1001 \
  --pr https://example.com/pull/12 \
  --path .agent-ship/packets/task_auth_mw.md

agent-ship inbox list
agent-ship inbox list --all --json

agent-ship inbox decide evt_<id> accept --note "Evidence matches."

agent-ship notify dry-run --latest \
  --policy "$HOME/.agent-ship-kit/current/templates/notify.policy.example.md" \
  --allowlist "$HOME/.agent-ship-kit/current/templates/notify.allowlist.example.json"
```

`inbox add` defaults to `needs_review`. `--type blocked` and
`--type needs_approval` are the mid-task inbox. `inbox list` shows open items
only; `--all` includes `review_decided` rows. `inbox decide` appends the
decision and the item drops off the open list.

`notify dry-run` prints a plan with `executed: false` and exits 0 even when
`allow` is false. A normal review matches no push rule (pull). A high review
with evidence matches `high priority page`. A high review with no evidence
URLs is not paged.

`notify run` uses the same flags. It executes the argv only when `allow` is
true, with `shell: false`. A refusal exits 1 and starts nothing. `--action`
is the captain's reading of the policy's free-text section; the allowlist
still applies.

Pass `--event file.json` instead of `--latest` to plan a specific event.
`--help` prints the flag list.

## Safety

- Allowlist patterns are argv templates. See `docs/ARCHITECTURE.md`.
- Shell metacharacters, shells, and `sudo` are rejected.
- `$VARS` are not expanded, so secrets are not pulled from the environment.
- A high-priority `needs_review` with no `--evidence` is still stored, the CLI warns on stderr, and notify refuses to page it.
- `blocked` and `needs_approval` may notify without evidence URLs. The example action is `multica issue create --assignee me ...`, not `multica *`.

## Tests

```bash
cd cli
npm test
npm run typecheck
```

`npm test` uses `node:test` via `tsx`. The tests cover the open inbox,
`inbox decide`, the pull-by-default policy, the empty-evidence refusal, and
`notify run` against an allowlisted argv (no shell).
