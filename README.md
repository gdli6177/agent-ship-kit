**English** | [简体中文](README.zh-CN.md)


v0.2: [reliability changes and trial](docs/reliability-v0.2.md).

# agent-ship-kit

Start with [Quick Start](#quick-start). Configuration details: [team handbooks and bounded learning](docs/team-and-learning.md); execution isolation: [multiple repositories and worktrees](docs/workspace-parallel.md).

agent-ship-kit is the acceptance-and-attention layer for parallel AI coding-agent delivery. A person talks to one captain from intake through ship. Workers are spawned on demand, one slice per frozen contract, and are not a standing roster. The kit sits on Herdr, Orca, Multica, or any other orchestrator through thin adapters, and it also works with no orchestrator at all. It does not schedule the fleet, does not merge to main, and does not deploy to production. The captain prepares a proposal, the human freezes the contract, workers return evidence, and the human accepts that evidence before anything ships.

Status: v0. Skills, templates, an event schema, adapter notes, and a local inbox / notify CLI.

## Quick Start

**Describe the goal, approve the plan, judge the result. The captain manages the steps and ids; slash commands are optional.**

### Once: ask your current agent to connect the project

Open your usual agent in the target Git project and send:

```text
Install and set up https://github.com/gdli6177/agent-ship-kit for this project.
Act as the captain and manage the workflow; I will describe what I need.
Create or reuse a shared team handbook and preserve existing project rules.
Inspect this host and its execution capabilities, then tell me whether we are ready.
```

The agent should read the installer and instructions, check Node.js 20+ and npm, select the current host's skills, run shared setup, and check whether it can create, inspect and collect independent workers and a verifier. Installation supports macOS, Linux and Windows WSL. Onboarding does not edit product code or start requirement work; changed shared files are listed for review.

**You do not need to find another team lead.** This main conversation is the captain. Expect a short “Ready; tell me what you want to build”, or a real blocker and the next action. Reload skills or start a new session if the host requires it; a fresh captain restores records and checks actual status without duplicate dispatch.

An installed CLI does not supply a worker runtime. The captain should discover execution gaps during onboarding rather than after asking you to approve work. See [Install](#install) and [Adapters](adapters/README.md) when details are needed.

### Daily: say what you want

```text
Add an “unfinished only” filter to the task list. Keep other behavior unchanged.
```

The captain inspects the implementation, reads applicable rules and bounded lessons, and proposes acceptance checks. It shows one short plan: what changes, what is affected and how completion will be judged. It resolves technical details itself and asks only questions that need your decision.

Revise the request if necessary. To approve the exact plan just shown and authorize work, reply:

```text
Start with this plan.
```

The captain records the explicit approval as a frozen contract, arranges isolated branches and real workers, and independently verifies results before review. You do not need to repeat proposal/contract ids or issue a dispatch command. If several plans could be meant, it asks which one. Silence, a casual “looks good” or the original request does not authorize starting.

Stay in the same conversation while tasks run:

| Say | The captain handles |
| --- | --- |
| `How is it going?` | Check real status; summarize progress, blockers and reviews. |
| `Open another request for CSV export.` | Propose separately, check overlap and determine parallel eligibility. |
| `Stop the previous task for now.` | Identify the target, stop it through the execution mechanism and record status. |

### At delivery: inspect the result and decide

Say “Show me the result.” The captain presents one short card: change, openable evidence, verification result and remaining risks. Reply:

```text
Pass.
```

Or:

```text
Changes: when the filter is on, a task should disappear immediately after I complete it.
```

The captain records your decision, returns corrections to the original task and verifies again. An expanded scope gets a revised proposal first. Internal checks, verifier repair loops and routine learning checks stay within the team; you do not need to maintain a lesson for every task. Plain `setup` sets `learning_required` to false. `--shared` sets it to true and removes a stale `.agent-ship/team.json`. Either value is valid in the team config. When the check is on, the independent verifier records `lesson check --outcome none` itself if there is nothing new to keep; that audit line is not a step for you. A managed dispatch also requires the contract's Accepted text, Accepted by, Accepted at, and Proposal id — the exact plan, who accepted it, and when — and the CLI refuses `slice start` when they are empty or the proposal id does not match. Merge and release through your normal project process.

Ordinary reviews are pull by default: ask for progress or results when you return. Continuous background execution and push notifications depend on the connected host and configuration; installation alone does not provide them.

### Details when you need them

`/ship-*` commands are optional shortcuts. The tables below are for troubleshooting and advanced use. See [team configuration and learning budgets](docs/team-and-learning.md) and [multi-repository/worktree isolation](docs/workspace-parallel.md). Installation defaults to main; ask the agent to use the matching `--ref` when reviewing an unmerged feature.

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

One command. It does not clone the repo, does not use sudo, and does not modify any project. It downloads the kit into `~/.agent-ship-kit/<ref>` (default `main`) and points the `~/.agent-ship-kit/current` symlink at that directory. It installs the `agent-ship` command in `~/.local/bin`, and copies the seven skills into each agent skill directory it finds (`~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.qoder/skills`, `~/.kiro/skills`, `~/.omp/agent/skills`, `~/.agents/skills`). Skills and the shim use `current`, so a later `--ref` does not change those paths.

```bash
curl -fsSL https://raw.githubusercontent.com/gdli6177/agent-ship-kit/main/install.sh | bash
```

Node.js 20 or newer. No API keys. If `~/.local/bin` is not on `PATH`, the installer prints the line to add. Re-run the same command to upgrade. Pin a tag with `--ref` or `AGENT_SHIP_REF`:

```bash
curl -fsSL https://raw.githubusercontent.com/gdli6177/agent-ship-kit/main/install.sh | bash -s -- --ref v0.1.0
```

`--agent cursor|claude|codex|qoder|kiro|omp|agents|all` chooses skill directories. `--target <dir>` copies skills only there. A branch name may contain slashes (`feature/foo`); the directory is `feature__foo`. Installing a different ref removes the previous ref directory. `--uninstall` removes the shim, the skill directories this installer copied, and the whole `~/.agent-ship-kit` directory:

```bash
curl -fsSL https://raw.githubusercontent.com/gdli6177/agent-ship-kit/main/install.sh | bash -s -- --uninstall
```

Windows: use WSL (Ubuntu), then run the command above inside it. Git Bash and MSYS are refused.

After installation, follow [Quick Start](#quick-start) to designate the project's captain conversation, then use `/ship-setup`.

### Manual clone

If you cannot use the installer, clone and copy the skills yourself:

```bash
git clone https://github.com/gdli6177/agent-ship-kit.git
cd agent-ship-kit
pnpm install
mkdir -p ~/.cursor/skills
cp -R skills/ship-setup skills/ship-watchdog skills/ship-contract skills/ship-dispatch skills/ship-inbox skills/ship-notify skills/ship-e2e ~/.cursor/skills/
```

From that checkout, `npx agent-ship` runs the CLI. The installer is what puts `agent-ship` on `PATH`.

## Commands the owner uses

These names are for the captain thread. They do not depend on a forge.

| Command | What the captain does |
| --- | --- |
| `/ship-setup` | `agent-ship setup` in this clone only. Hooks go in `.git/hooks` and chain to any hook already there. Ignore rules go in `.git/info/exclude`, not the shared `.gitignore`. `--shared` opts into a committed ignore block and a shared `AGENTS.md` rules section, team profile and handbook. `--uninstall` removes the hooks and the rules block but keeps `.agent-ship/` excluded. `--uninstall --purge` deletes that directory too. Setup never sets `core.hooksPath`. |
| `/ship-contract` | Draft one proposal, then a frozen contract after the human says so. |
| `/ship-dispatch` | Spawn workers for a frozen contract. Does not edit code itself. |
| `/ship-inbox` | List open items by priority, then review one at a time (contract, evidence, risks). The owner replies `pass`, `changes` plus a reason, or `reject`. |
| `/ship-inbox <id>` | Jump straight to that item. Notify messages use this deep link. The first view is a compact card (summary ≤ 280 characters plus the recall chain). |
| `/ship-notify` | Dry-run or send an allowlisted notification. |
| `/ship-e2e` | Shared login and smoke tests. Production stays read-only. |
| `/ship-watchdog` | Not the captain. `watchdog install` registers a user timer: Linux/WSL writes a marked crontab line; macOS writes `~/Library/LaunchAgents` and runs `launchctl bootstrap`. The check reads heartbeats, commits on the slice branch only, and `check`. It files `blocked` only when something is wrong. With no running slice it exits with noop and retains the timer until explicit uninstall. |

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

**Plain terminal.** After the installer, run `agent-ship` in the project directory. If the command is not on `PATH`, use `node $HOME/.agent-ship-kit/current/cli/bin/agent-ship.js`.

| Command | CLI |
| --- | --- |
| `/ship-setup` | `agent-ship setup` |
| `/ship-dispatch` | `agent-ship slice start --contract <id> --slice <id> --source-task-id <task> --title "..." --summary "..."` |
| `/ship-inbox` | `agent-ship inbox list --sort priority` |
| `/ship-inbox <id>` | `agent-ship inbox decide <id> accept\|changes_requested\|reject` |
| `/ship-notify` | `agent-ship notify dry-run --latest --policy .agent-ship/notify.policy.md --allowlist .agent-ship/notify.allowlist.json` |
| `/ship-watchdog` | `agent-ship watchdog` |

`/ship-contract` and `/ship-e2e` are procedures in their skill files. They do not have a single CLI subcommand. Path checks used while dispatching or reviewing are `agent-ship check --contract <id>`. `/ship-setup` writes the notify policy and allowlist into `.agent-ship/`. Before that, point `--policy` and `--allowlist` at `$HOME/.agent-ship-kit/current/templates/`.

The captain is a router. It does not edit code or run the long task, even when the change looks small, and it does not wait out a worker before taking the next request. Speculative drafts are off unless `.agent-ship/limits.json` sets `"speculative": true`, and even then nothing is dispatched without a frozen contract. A persistent runtime, compute/state split, and device daemons stay with the orchestrator.

`agent-ship check --contract <id>` diffs the branch against its base with plain git and fails when a changed path is forbidden or outside the allow list. The local pre-commit hook runs the same check on staged files for `.agent-ship/active-contract`. pre-push refuses `main` and `master` unless a human sets `AGENT_SHIP_ALLOW_PROTECTED_PUSH=1`. CI can run `check` too; that is optional and not required for the hooks.

Repeated review comments can become local hard rules. `agent-ship promote` (or `inbox decide ... changes_requested --promote hook|contract|verify`) appends `.agent-ship/hard-rules.json`. That file is gitignored with the rest of `.agent-ship/`. `hook` and `contract` rules fail `agent-ship check` and the local pre-commit hook with the rule id. `verify` rules are a checklist the verifier reads. `--promote` defaults to `none`, so an ordinary decision does not write a rule. Nothing here merges, deploys, or adds CI for other contributors.

```bash
agent-ship promote --kind hook --glob ".env*" \
  --message "Do not commit env files." \
  --source "Do not commit env files."
agent-ship check --hard-rules
```

`slice start` admits work only when the contract is frozen, `Frozen by` is a real name, `Frozen at` parses as a time, Forbidden paths is non-empty, the slice id is a row in the Slices table, and the branch already exists. The errors are `contract must record Frozen by`, `contract must record a valid Frozen at`, `contract needs non-empty Forbidden paths`, `slice <id> is not in the Slices table`, and `branch <name> does not exist in <repo>; create it first (git branch <name> <base>)`. Create the branch first. `.agent-ship/sequence` is the integer that orders events written in the same millisecond; do not edit it while a command holds the state lock. A lock directory `.agent-ship-lock` records `pid`, `hostname`, `started_at`, and `cmd`. A dead pid on this machine is reclaimed. Otherwise the error names the owner. Manual recovery is `rm -rf` on that lock directory after the owner has exited. See [docs/workspace-parallel.md](docs/workspace-parallel.md).

## Inbox and notification smoke test (no workers)

No orchestrator account, no `multica` binary, no webhook. The inbox is a JSONL file. The dry-run prints a plan and does not run it. A normal-priority item is pull: it stays on `inbox list` and matches no push rule. The high-priority example below has an evidence URL, so the plan is allowed and still not executed.

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

agent-ship notify dry-run --latest \
  --policy "$HOME/.agent-ship-kit/current/templates/notify.policy.example.md" \
  --allowlist "$HOME/.agent-ship-kit/current/templates/notify.allowlist.example.json"
```

Run that in the project directory. If `agent-ship` is not on `PATH`, call `node $HOME/.agent-ship-kit/current/cli/bin/agent-ship.js` instead.

Expect a `needs_review` event, then a plan whose `matched_rule` is `high priority page`, `allow` is true, and `executed` is false. Drop the `--evidence` flag and the same high item is not paged. `notify run` is opt-in and starts only an allowlisted argv, with no shell. `inbox decide <id> accept` writes `review_decided`; `inbox list` then hides that item.

Mid-task questions use `inbox add --type blocked` or `--type needs_approval`. The owner answers in this inbox. They do not open the worker session.

To do the same loop with a captain and no CLI, follow [templates/workflow.md](templates/workflow.md) and [adapters/generic.md](adapters/generic.md). `spawn` is one fresh agent session per frozen slice. Login and smoke tests are [templates/e2e.md](templates/e2e.md). Acceptance can name `feature:<id>` from that index's Features table; each id is an evidence row (kind `e2e`) pointing at the report, and `agent-ship check` rejects an id missing from the table when the table is present. The human stays in the captain thread.

## Tests

```bash
cd cli
pnpm test
pnpm typecheck
```

## Layout

```text
README.md
README.zh-CN.md
LICENSE
install.sh
package.json
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
cli/bin/agent-ship.js
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
