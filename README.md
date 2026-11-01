**English** | [简体中文](README.zh-CN.md)

# agent-ship-kit

Start with [Quick Start](#quick-start). Configuration details: [team handbooks and bounded learning](docs/team-and-learning.md); execution isolation: [multiple repositories and worktrees](docs/workspace-parallel.md).

agent-ship-kit is the acceptance-and-attention layer for parallel AI coding-agent delivery. A person talks to one captain from intake through ship. Workers are spawned on demand, one slice per frozen contract, and are not a standing roster. The kit sits on Herdr, Orca, Multica, or any other orchestrator through thin adapters, and it also works with no orchestrator at all. It does not schedule the fleet, does not merge to main, and does not deploy to production. The captain prepares a proposal, the human freezes the contract, workers return evidence, and the human accepts that evidence before anything ships.

Status: v0. Skills, templates, an event schema, adapter notes, and a local inbox / notify CLI.

## Quick Start

Walk through one request: add an “unfinished only” filter to a task list. Each text block below is an example message to send to your agent. Use the proposal, contract and task ids your captain actually returns.

Install → choose a captain → set up the project → propose → freeze → dispatch → review evidence.

### 1. Ask your current agent to install the kit

Have a working agent host, Node.js 20+, npm and an existing Git project. Use macOS, Linux or WSL on Windows. Send:

```text
Read the installation instructions at https://github.com/gdli6177/agent-ship-kit and install the kit.
Check Node.js 20+ and npm, and read the installer before running it.
Explicitly select the correct --agent codex, --agent claude or --agent cursor for my current host.
If you cannot identify the host, ask me first; do not install into another host's directory.
Only install the CLI and skills at this step. Do not initialize a project or edit product code.
Run agent-ship --help, report the skill path, and tell me whether the session needs reloading.
```

Expect a successful CLI check and the skill directory for your host. Reload skills or start a fresh session as your host requires if the current conversation does not see them yet. For manual installation, see [Install](#install).

### 2. Designate one project conversation as the captain

The team lead is called the captain here. It is a role you assign to an agent, not a separate program that appears after installation. Open your target project and one main conversation. You might name it “Task list · captain”. Send:

```text
Act as this project's agent-ship-kit captain. I will submit requests and review deliveries here.
Read the existing project rules and the installed ship-setup, ship-contract, ship-dispatch and ship-inbox skills.
Explain whether you can create independent worker sessions, inspect their status and collect results,
and which execution mechanism you intend to use. Do not edit product code or dispatch yet.
```

This conversation handles proposals, dispatch and the review inbox. Workers are created for tasks. Installing the CLI does not supply a worker runtime: execution needs your host's subagent/session capabilities or a connected orchestrator. See [Adapters](adapters/README.md).

### 3. Initialize this project with the captain

To adopt a shared team handbook, send in the same conversation:

```text
/ship-setup
Run shared setup for this project: agent-ship setup --shared.
Reference an existing handbook, or create the starter handbook if none exists.
Preserve existing rules and hooks, and list the files actually changed.
```

Expect a successful setup report, `agent-ship.team.json` and a created or referenced handbook. Shared files can be versioned; runtime records stay in local `.agent-ship/`. Review new shared files before committing them through your project's usual process.

For a personal trial, request plain `agent-ship setup` instead. It installs local integration without creating a shared handbook. Resolve any existing hook configuration conflict before proceeding.

### 4. Submit your first request and review the proposal

```text
/ship-contract
Add an “unfinished only” filter to this project's task list.
Turning it off must preserve the existing list behavior. Leave login, billing and deployment outside the scope.
Inspect the current implementation and propose the scope, acceptance checks and slices. Do not start work yet.
```

Expect one proposal card: goal, non-goals, allowed/forbidden paths, acceptance checks and slices. The captain loads applicable project rules and relevant lessons. You can still revise it, for example: “The filter does not need to persist after a page refresh.”

### 5. Explicitly freeze the agreed proposal

If the returned proposal id is `proposal_todo_filter`, send:

```text
Freeze proposal_todo_filter. Create the contract from its current text without expanding the scope.
```

Expect a contract id, frozen-by identity, timestamp and acceptance conditions. No dispatch happens before freeze. A later scope expansion needs a revised proposal and another freeze. “Looks roughly right” is insufficient. Replace the example id with your actual id.

### 6. Ask the captain to start execution

If the contract id is `contract_todo_filter`:

```text
/ship-dispatch
Start contract_todo_filter. Confirm that the execution mechanism works, prepare isolated branches or worktrees,
and pass the admission checks before spawning workers. Report the real task ids, worker references and branches.
Run independent verification before filing completed work in the inbox.
```

Expect real worker references and execution locations. You can then ask for progress in the main conversation. `slice start` only records and reserves work; success does not prove a worker process has started.

If the host cannot create and collect independent sessions, stop at “execution integration needed” and connect a mechanism using the [generic adapter](adapters/generic.md). A host with native session capabilities can work without an orchestrator account. If task packets need manual transfer, explicitly describe that manual workflow rather than claiming automatic parallel execution.

### 7. Resolve mid-task decisions in the same conversation

The captain presents blocked or needs_approval items. If a worker needs to change a shared component outside the agreed scope, reply:

```text
Explain the impact and alternatives first. If the scope must expand, draft a revised proposal
and wait for me to freeze it before continuing.
```

After an in-scope decision the captain resumes the same task; changed scope returns to proposal review. Ordinary reviews are pull by default. Do not assume push notifications are configured when you leave; ask for progress or open the inbox when you return.

### 8. Inspect evidence, then accept or request changes

```text
/ship-inbox
```

The captain shows one compact card at a time: change, contract and branch, evidence, unverified checks and remaining risks. Ask to expand a report or show a screenshot when that evidence exists. Then reply:

| Your reply | Next action |
| --- | --- |
| `pass` | Record accept and close that review item. |
| `changes: when the filter is on, a task should disappear immediately after I complete it.` | Return to the original task, then verify and review again. |
| `reject: cancel this request.` | End the task. |

The captain and verifier handle the pre-review learning check. Routine work may produce none; you do not need a new lesson for every delivery. Candidates do not automatically become team rules. After accepting evidence, merge and release through your normal project process.

### Continue your daily work

**Another request:** start again with `/ship-contract` in the same main conversation. You may discuss another proposal while work is running. Dispatch only independent, eligible tasks; exceeding the parallel cap does not start another worker.

```text
Open a separate request: add CSV export to the task list. Propose it first.
Check whether it overlaps the filter work, and explain the isolation or execution order.
```

**Another project:** designate a captain and run setup for that project. For one captain across repositories, explicitly separate the shared state root from execution repositories using the [multi-repository/worktree guide](docs/workspace-parallel.md).

**A new conversation:** open the original project, assign the captain role, and ask it to read existing contracts, runtime records and inbox, verify actual worker status, and restore the progress view without duplicate dispatch. Records alone do not prove old workers are still running.

**Unrecognized commands:** check the installed skill directory. If slash commands are not routed, ask the agent to read `~/.agent-ship-kit/current/skills/<skill-name>/SKILL.md` and follow it. If the CLI is not on PATH, check it with `node "$HOME/.agent-ship-kit/current/cli/bin/agent-ship.js" --help`.

**Version mismatch:** the installer defaults to main, which contains merged features only. When reviewing this guide on a feature branch, install that `--ref` to use its new commands.

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

One command. It does not clone the repo, does not use sudo, and does not modify any project. It downloads the kit into `~/.agent-ship-kit/<ref>` (default `main`) and points the `~/.agent-ship-kit/current` symlink at that directory. It installs the `agent-ship` command in `~/.local/bin`, and copies the seven skills into each agent skill directory it finds (`~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills`). Skills and the shim use `current`, so a later `--ref` does not change those paths.

```bash
curl -fsSL https://raw.githubusercontent.com/gdli6177/agent-ship-kit/main/install.sh | bash
```

Node.js 20 or newer. No API keys. If `~/.local/bin` is not on `PATH`, the installer prints the line to add. Re-run the same command to upgrade. Pin a tag with `--ref` or `AGENT_SHIP_REF`:

```bash
curl -fsSL https://raw.githubusercontent.com/gdli6177/agent-ship-kit/main/install.sh | bash -s -- --ref v0.1.0
```

`--agent cursor|claude|codex|all` chooses skill directories. `--target <dir>` copies skills only there. A branch name may contain slashes (`feature/foo`); the directory is `feature__foo`. Installing a different ref removes the previous ref directory. `--uninstall` removes the shim, the skill directories this installer copied, and the whole `~/.agent-ship-kit` directory:

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
npm install
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
