**English** | [简体中文](README.zh-CN.md)

# agent-ship-kit

agent-ship-kit is the acceptance-and-attention layer for parallel AI coding-agent delivery. A person talks to one captain from intake through ship. Workers are spawned on demand, one slice per frozen contract, and are not a standing roster. The kit sits on Herdr, Orca, Multica, or any other orchestrator through thin adapters, and it also works with no orchestrator at all. It does not schedule the fleet, does not merge to main, and does not deploy to production. The captain prepares a proposal, the human freezes the contract, workers return evidence, and the human accepts that evidence before anything ships.

Status: v0. Skills, templates, an event schema, adapter notes, and a local inbox / notify CLI.

## What you get

| Piece | Role |
| --- | --- |
| [skills/](skills/) | One skill per slash command. The skill name is the command: `/ship-inbox` loads `ship-inbox`. |
| [templates/](templates/) | Proposal, contract, review packet, workflow, E2E login index, notify policy |
| [adapters/](adapters/) | `spawn` / `status` / `collect` plus Herdr, Orca, and Multica notes |
| [events/schema.json](events/schema.json) | `needs_review`, `blocked`, `needs_approval`, and the related events |
| [cli/](cli/) | `setup`, `check`, inbox, `notify dry-run`, `notify run` |

The product definition in Chinese is [docs/PRODUCT.md](docs/PRODUCT.md). Event, adapter, and notify behavior is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

Clone the repo and copy the seven skills into the captain agent's skill directory. On Cursor that directory is `~/.cursor/skills`:

```bash
git clone https://github.com/gdli6177/agent-ship-kit.git
cd agent-ship-kit
mkdir -p ~/.cursor/skills
cp -R skills/ship-setup skills/ship-watchdog skills/ship-contract skills/ship-dispatch skills/ship-inbox skills/ship-notify skills/ship-e2e ~/.cursor/skills/
```

For another agent, copy those same seven directories into that agent's skill path. Each directory contains a `SKILL.md`. The CLI is optional and stays in this repo; it is not installed into the skill directory.

```bash
cd cli
npm install
```

Node 20 or newer. No API keys.

## Commands the owner uses

These names are for the captain thread. They do not depend on a forge.

| Command | What the captain does |
| --- | --- |
| `/ship-setup` | `agent-ship setup` in this clone only. Hooks go in `.git/hooks` and chain to any hook already there. Ignore rules go in `.git/info/exclude`, not the shared `.gitignore`. `--shared` opts into a committed ignore block and a shared `AGENTS.md` rules section. `--uninstall` removes the hooks and the rules block but keeps `.agent-ship/` excluded. `--uninstall --purge` deletes that directory too. Setup never sets `core.hooksPath`. |
| `/ship-contract` | Draft one proposal, then a frozen contract after the human says so. |
| `/ship-dispatch` | Spawn workers for a frozen contract. Does not edit code itself. |
| `/ship-inbox` | List open items by priority, then review one at a time (contract, evidence, risks). The owner replies `pass`, `changes` plus a reason, or `reject`. |
| `/ship-inbox <id>` | Jump straight to that item. Notify messages use this deep link. The first view is a compact card (summary ≤ 280 characters plus the recall chain). |
| `/ship-notify` | Dry-run or send an allowlisted notification. |
| `/ship-e2e` | Shared login and smoke tests. Production stays read-only. |
| `/ship-watchdog` | Not the captain. `watchdog install` registers a user timer: Linux/WSL writes a marked crontab line; macOS writes `~/Library/LaunchAgents` and runs `launchctl bootstrap`. The check reads heartbeats, commits on the slice branch only, and `check`. It files `blocked` only when something is wrong. With no running slice it exits and removes that timer. |

## How a slash command runs

Each command is one skill. The name in the skill file matches the command without the slash, so `/ship-inbox` loads `skills/ship-inbox/SKILL.md` on Cursor, Claude Code, and other hosts that route slash commands to skills. The skill tells the agent what to do and calls the `agent-ship` CLI for anything deterministic (inbox, check, notify, watchdog). The CLI subcommands are still named `inbox`, `notify`, `check`, `setup`, `watchdog`, and `slice`. Typing `/ship-inbox` does not rename those.

**No skill support.** The resident rules block that `agent-ship setup` writes into `AGENTS.md` maps each command to a file. Follow that file:

| Command | Follow |
| --- | --- |
| `/ship-setup` | `skills/ship-setup/SKILL.md` |
| `/ship-contract` | `skills/ship-contract/SKILL.md` |
| `/ship-dispatch` | `skills/ship-dispatch/SKILL.md` |
| `/ship-inbox` | `skills/ship-inbox/SKILL.md` |
| `/ship-notify` | `skills/ship-notify/SKILL.md` |
| `/ship-e2e` | `skills/ship-e2e/SKILL.md` |
| `/ship-watchdog` | `skills/ship-watchdog/SKILL.md` |

**Plain terminal.** From `cli/` after `npm install`:

| Command | CLI |
| --- | --- |
| `/ship-setup` | `npm run agent-ship -- setup --root ..` |
| `/ship-dispatch` | `npm run agent-ship -- slice start --root .. --contract <id> --slice <id> --source-task-id <task> --title "..." --summary "..."` |
| `/ship-inbox` | `npm run agent-ship -- inbox list --root .. --sort priority` |
| `/ship-inbox <id>` | `npm run agent-ship -- inbox decide <id> accept\|changes_requested\|reject --root ..` |
| `/ship-notify` | `npm run agent-ship -- notify dry-run --root .. --latest --policy ../templates/notify.policy.example.md --allowlist ../templates/notify.allowlist.example.json` |
| `/ship-watchdog` | `npm run agent-ship -- watchdog --root ..` |

`/ship-contract` and `/ship-e2e` are procedures in their skill files. They do not have a single CLI subcommand. Path checks used while dispatching or reviewing are `npm run agent-ship -- check --root .. --contract <id>`.

The captain is a router. It does not edit code or run the long task, even when the change looks small, and it does not wait out a worker before taking the next request. Speculative drafts are off unless `.agent-ship/limits.json` sets `"speculative": true`, and even then nothing is dispatched without a frozen contract. A persistent runtime, compute/state split, and device daemons stay with the orchestrator.

`agent-ship check --contract <id>` diffs the branch against its base with plain git and fails when a changed path is forbidden or outside the allow list. The local pre-commit hook runs the same check on staged files for `.agent-ship/active-contract`. pre-push refuses `main` and `master` unless a human sets `AGENT_SHIP_ALLOW_PROTECTED_PUSH=1`. CI can run `check` too; that is optional and not required for the hooks.

## Quickstart without Multica

No orchestrator account, no `multica` binary, no webhook. The inbox is a JSONL file. The dry-run prints a plan and does not run it. A normal-priority item is pull: it stays on `inbox list` and matches no push rule. The high-priority example below has an evidence URL, so the plan is allowed and still not executed.

```bash
cd cli
npm install
npm run agent-ship -- inbox add --root .. \
  --title "Auth middleware ready" \
  --summary "Contract checks passed on the slice branch." \
  --priority high \
  --source-task-id task_auth_mw \
  --evidence https://ci.example/runs/1001 \
  --pr https://example.com/pull/12 \
  --path .agent-ship/packets/task_auth_mw.md

npm run agent-ship -- inbox list --root ..

npm run agent-ship -- notify dry-run --root .. --latest \
  --policy ../templates/notify.policy.example.md \
  --allowlist ../templates/notify.allowlist.example.json
```

Expect a `needs_review` event, then a plan whose `matched_rule` is `high priority page`, `allow` is true, and `executed` is false. Drop the `--evidence` flag and the same high item is not paged. `notify run` is opt-in and starts only an allowlisted argv, with no shell. `inbox decide <id> accept` writes `review_decided`; `inbox list` then hides that item.

Mid-task questions use `inbox add --type blocked` or `--type needs_approval`. The owner answers in this inbox. They do not open the worker session.

To do the same loop with a captain and no CLI, follow [templates/workflow.md](templates/workflow.md) and [adapters/generic.md](adapters/generic.md). `spawn` is one fresh agent session per frozen slice. Login and smoke tests are [templates/e2e.md](templates/e2e.md). The human stays in the captain thread.

## Tests

```bash
cd cli
npm test
npm run typecheck
```

## Layout

```text
README.md
README.zh-CN.md
LICENSE
docs/PRODUCT.md
docs/ARCHITECTURE.md
skills/ship-contract/SKILL.md
skills/ship-dispatch/SKILL.md
skills/ship-inbox/SKILL.md
skills/ship-notify/SKILL.md
skills/ship-e2e/SKILL.md
skills/ship-setup/SKILL.md
skills/ship-watchdog/SKILL.md
templates/limits.example.json
templates/proposal-card.md
templates/verifier-prompt.md
templates/contract-card.md
templates/review-packet.md
templates/workflow.md
templates/e2e.md
templates/e2e-testing.md
templates/notify.policy.example.md
templates/notify.allowlist.example.json
adapters/README.md
adapters/generic.md
adapters/herdr.md
adapters/orca.md
adapters/multica.md
events/schema.json
cli/package.json
cli/README.md
cli/src/cli.ts
cli/src/inbox.ts
cli/src/notify.ts
cli/src/run.ts
cli/src/check.ts
cli/src/paths.ts
cli/src/setup.ts
cli/src/watchdog.ts
cli/src/types.ts
cli/test/
.agent-ship/.gitkeep
```

## License

[MIT](LICENSE)
