# agent-ship CLI

Local inbox and notify for the captain. Node 20 or newer. The only
dependency is `tsx`, used to run TypeScript directly. `package.json` exposes
the `agent-ship` bin. After the root `install.sh` run, that command is on
`PATH` and the project directory is the default root. The examples below are
for a checkout of this repo, run from `cli/`.

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
npm run agent-ship -- setup --root ..
npm run agent-ship -- setup --shared --root ..
npm run agent-ship -- setup --uninstall --root ..
```

`--shared` writes a marked block in `.gitignore` and merges the rules into `AGENTS.md` even when that file is tracked. Hooks remain uncommitted. `--uninstall` restores a chained hook and removes the rules block. Data under `.agent-ship/` is kept, and `.git/info/exclude` keeps a single `.agent-ship/` line so the directory does not show up as untracked. `--uninstall --purge` deletes `.agent-ship/` and that exclude line.

## Watchdog

```bash
npm run agent-ship -- watchdog --root ..
npm run agent-ship -- status --stale --root ..
```

Deterministic. No model. Reads heartbeats in `.agent-ship/events.jsonl`, the last commit time on the slice branch, and `check`. Files a `blocked` item only when a slice is stalled or drifting. If nothing is `queued` or `running`, it exits immediately and deletes the local timer.

```bash
npm run agent-ship -- slice start --root .. --contract contract_auth --slice auth \
  --source-task-id task_1 --title "Auth slice" --summary "Opened."
npm run agent-ship -- watchdog install --root ..
npm run agent-ship -- watchdog uninstall --root ..
```

`slice start` records `worker_dispatched` on branch `ship/<contract>/<slice>` unless `--branch` is set, and registers the timer when a slice is open. On Linux and WSL, `watchdog install` adds a marked block to the user crontab. On macOS it writes `~/Library/LaunchAgents` and runs `launchctl bootstrap`. `--dry-run` does not register. Tests can point `AGENT_SHIP_CRONTAB_CMD` at a fake `crontab` and `AGENT_SHIP_TIMER_HOME` at a throwaway directory. If registration fails, the command prints a warning. `watchdog` and `inbox list` also warn when slices are running and the timer is not active. An orchestrator scheduler or an assistant routine can run `watchdog` instead of the timer. Staleness uses heartbeats and commits on the slice branch only.

## Check

```bash
npm run agent-ship -- check --root .. --contract contract_auth --base main
```

Prints JSON and exits 1 when a path is forbidden or outside Allowed paths. `--staged` checks the index. No forge and no CI are required. A project may also run this command in CI; that is an extra, not the enforcement.

## Commands

Run from `cli/` so the example policy paths resolve. `--root ..` writes the
inbox at the repo's `.agent-ship/inbox.jsonl`.

```bash
npm run agent-ship -- inbox add --root .. \
  --title "Auth middleware ready" \
  --summary "Contract checks passed on the slice branch." \
  --priority high \
  --source-task-id task_auth_mw \
  --evidence https://ci.example/runs/1001 \
  --pr https://example.com/pull/12 \
  --path .agent-ship/packets/task_auth_mw.md

npm run agent-ship -- inbox list --root ..
npm run agent-ship -- inbox list --root .. --all --json

npm run agent-ship -- inbox decide evt_<id> accept --root .. --note "Evidence matches."

npm run agent-ship -- notify dry-run --root .. --latest \
  --policy ../templates/notify.policy.example.md \
  --allowlist ../templates/notify.allowlist.example.json
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
