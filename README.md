# agent-ship-kit

agent-ship-kit is the acceptance-and-attention layer for parallel AI coding-agent delivery. A person talks to one captain from intake through ship. Workers are spawned on demand, one slice per frozen contract, and are not a standing roster. The kit sits on Herdr, Orca, Multica, or any other orchestrator through thin adapters, and it also works with no orchestrator at all. It does not schedule the fleet, does not merge to main, and does not deploy to production. The captain prepares a proposal, the human freezes the contract, workers return evidence, and the human accepts that evidence before anything ships.

Status: v0. Skills, templates, an event schema, adapter notes, and a local inbox / notify CLI.

## What you get

| Piece | Role |
| --- | --- |
| [skills/](skills/) | Captain commands: `/ship-setup`, `/ship-inbox`, `/ship-review`, plus contract, dispatch, notify, e2e |
| [templates/](templates/) | Proposal, contract, review packet, workflow, E2E login index, notify policy |
| [adapters/](adapters/) | `spawn` / `status` / `collect` plus Herdr, Orca, and Multica notes |
| [events/schema.json](events/schema.json) | `needs_review`, `blocked`, `needs_approval`, and the related events |
| [cli/](cli/) | `setup`, `check`, inbox, `notify dry-run`, `notify run` |

The product definition in Chinese is [docs/PRODUCT.md](docs/PRODUCT.md). Event, adapter, and notify behavior is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

Clone the repo and copy the six skills into the captain agent's skill directory. On Cursor that directory is `~/.cursor/skills`:

```bash
git clone https://github.com/gdli6177/agent-ship-kit.git
cd agent-ship-kit
mkdir -p ~/.cursor/skills
cp -R skills/ship-setup skills/ship-contract skills/ship-dispatch skills/ship-review skills/ship-notify skills/ship-e2e ~/.cursor/skills/
```

For another agent, copy those same six directories into that agent's skill path. Each directory contains a `SKILL.md`. The CLI is optional and stays in this repo; it is not installed into the skill directory.

```bash
cd cli
npm install
```

Node 20 or newer. No API keys.

## Commands the owner uses

These names are for the captain thread. They do not depend on a forge.

| Command | What the captain does |
| --- | --- |
| `/ship-setup` | `agent-ship setup` in this clone only. Hooks go in `.git/hooks` and chain to any hook already there. Ignore rules go in `.git/info/exclude`, not the shared `.gitignore`. `--shared` opts into a committed ignore block and a shared `AGENTS.md` rules section. `--uninstall` removes the hooks and the rules block. Setup never sets `core.hooksPath`. |
| `/ship-inbox` | List open inbox items, high priority first. |
| `/ship-review` | One open item at a time: contract, evidence, verifier, risks. The owner replies `pass`, `changes` plus a reason, or `reject`. |
| `/ship-review <id>` | Jump to that item. Notify messages include this deep link. |

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
skills/ship-review/SKILL.md
skills/ship-notify/SKILL.md
skills/ship-e2e/SKILL.md
skills/ship-setup/SKILL.md
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
cli/src/types.ts
cli/test/
.agent-ship/.gitkeep
```

## 中文

agent-ship-kit 是并行 AI 编程交付的验收与注意力层。人从进需求到交付只和一位船长说话；工人不预先组队，而是在合同冻结后按切片按需生成。讨论方案时船长一直只摆一张卡，每轮写明改了什么。所有合同同时跑着的工人默认不超过 3 个。它可以接在 Herdr、Orca、Multica 或任何编排器之上，也可以不接编排器。它不是编排器，不会自动合并到 main，也不会部署到生产。

工人做到一半要拍板或卡住时，只回给船长，收件箱用 `blocked` / `needs_approval`。人用 `inbox decide` 答复，不用打开工人会话。普通待审默认拉取，不推送；高优先级没有证据 URL 不会呼叫。`notify run` 只在允许列表通过后按 argv 执行，不经过 shell。登录冒烟每个项目一份 `auth.setup.ts`，会话文件 gitignore；生产只读，密码留在密码管理器或本机环境变量里，不进 git、技能或对话。

人在船长线程里用这些命令：`/ship-setup` 只初始化当前克隆（钩子在 `.git/hooks`，忽略规则在 `.git/info/exclude`，不改共享 `.gitignore`，不设置 `core.hooksPath`；`--shared` 才写给其他开发者；`--uninstall` 卸掉钩子和规则块）、`/ship-inbox` 看未决项、`/ship-review` 一次审一条，通知里的深链是 `/ship-review <id>`。工人报完成之后先过独立只读核验，再进收件箱。改冻结合同要新开合同号并重新冻结，不受影响的已完成工作保留。

安装：克隆本仓库，把 `skills/` 下的 `ship-setup`、`ship-contract`、`ship-dispatch`、`ship-review`、`ship-notify`、`ship-e2e` 拷进船长代理的 skill 目录（Cursor 为 `~/.cursor/skills`）。不依赖 Multica 的最短路径是上面的 Quickstart。产品边界见 [docs/PRODUCT.md](docs/PRODUCT.md)，交付流程见 [templates/workflow.md](templates/workflow.md)，登录索引见 [templates/e2e.md](templates/e2e.md)。

## License

[MIT](LICENSE)
