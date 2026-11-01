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
| `/ship-watchdog` | Not the captain. A local timer runs `agent-ship watchdog` (heartbeat, last commit, path check). It files `blocked` only when something is wrong, and removes its timer when no slice is running. |

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

## 中文

agent-ship-kit 是并行 AI 编程交付的验收与注意力层。人从进需求到交付只和一位船长说话；工人不预先组队，而是在合同冻结后按切片按需生成。讨论方案时船长一直只摆一张卡，每轮写明改了什么。所有合同同时跑着的工人默认不超过 3 个。它可以接在 Herdr、Orca、Multica 或任何编排器之上，也可以不接编排器。它不是编排器，不会自动合并到 main，也不会部署到生产。

工人做到一半要拍板或卡住时，只回给船长，收件箱用 `blocked` / `needs_approval`。人用 `inbox decide` 答复，不用打开工人会话。普通待审默认拉取，不推送；高优先级没有证据 URL 不会呼叫。`notify run` 只在允许列表通过后按 argv 执行，不经过 shell。登录冒烟每个项目一份 `auth.setup.ts`，会话文件 gitignore；生产只读，密码留在密码管理器或本机环境变量里，不进 git、技能或对话。

船长只做路由：不改代码、不自己跑长任务、也不卡住等工人。已订阅线程上的后续消息直接给对应工人。`/ship-watchdog` 不是模型：定时器跑确定性检查（心跳、最近一次提交、路径检查），只有真的卡住或越界才写入收件箱，船长这时才介入。没有在跑的切片时它立刻退出，并卸掉本机定时器。第一条切片开始时 `slice start` 会装上这个定时器（cron 片段和 launchd plist 在 `~/.config/agent-ship/`，不进仓库）。`/ship-inbox` 先看不超过 280 字的卡片。推测草稿默认关闭。常驻云运行时、算力与状态分离、设备守护进程属于编排器，不在本工具里。

人在船长线程里用斜杠命令。每条命令对应一份技能，技能名就是命令名：`/ship-inbox` 会打开 `skills/ship-inbox/SKILL.md`（Cursor、Claude Code 以及同类宿主都按这个名字匹配）。`/ship-inbox` 不带编号时按优先级列出未决项，再逐条审（合同、证据、风险；回复 pass、changes 加原因、或 reject）。`/ship-inbox <id>` 直接跳到那一条，通知里的深链也是这个形式。确定性的步骤交给 `agent-ship` CLI，子命令仍然叫 `inbox`、`notify`、`check`、`setup`、`watchdog`、`slice`。

没有技能机制时，看 `agent-ship setup` 写进 `AGENTS.md` 的常驻规则：里面把 `/ship-setup`、`/ship-contract`、`/ship-dispatch`、`/ship-inbox`、`/ship-notify`、`/ship-e2e`、`/ship-watchdog` 分别指到 `skills/<同名>/SKILL.md`，照着做。纯终端则在 `cli/` 里跑对应命令：`setup`、`slice start`、`inbox list --sort priority`、`inbox decide <id> ...`、`notify dry-run`、`watchdog`。`/ship-contract` 和 `/ship-e2e` 是流程，没有单独的子命令。

`/ship-setup` 只初始化当前克隆（钩子在 `.git/hooks`，忽略规则在 `.git/info/exclude`，不改共享 `.gitignore`，不设置 `core.hooksPath`；`--shared` 才写给其他开发者；`--uninstall` 卸掉钩子和规则块但保留 `.agent-ship/` 的本地排除项，`--purge` 连目录一起删）。工人报完成之后先过独立只读核验，再进收件箱。改冻结合同要新开合同号并重新冻结，不受影响的已完成工作保留。

安装：克隆本仓库，把 `skills/` 下的 `ship-setup`、`ship-contract`、`ship-dispatch`、`ship-inbox`、`ship-notify`、`ship-e2e` 拷进船长代理的 skill 目录（Cursor 为 `~/.cursor/skills`）。不依赖 Multica 的最短路径是上面的 Quickstart。产品边界见 [docs/PRODUCT.md](docs/PRODUCT.md)，交付流程见 [templates/workflow.md](templates/workflow.md)，登录索引见 [templates/e2e.md](templates/e2e.md)。

## License

[MIT](LICENSE)
